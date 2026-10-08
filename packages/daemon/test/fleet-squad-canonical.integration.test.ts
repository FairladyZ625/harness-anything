// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";
import { recordHeadConfirmation } from "../src/fleet/replica-read-model.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";
import { daemonMethodAcceptsPayload } from "../src/protocol/daemon-protocol-rpc-validation.ts";
import { makeTaskEventReader, READ_MODEL_SCHEMA_GENERATION, sha256Text } from "@harness-anything/kernel";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { localAuthFixture } from "./fleet-tls-session.fixture.ts";
import {
  runFleetReplicaPullClient,
  runFleetRuntimeEventClient,
  readFleetRepositoryMetadataClient,
  runFleetUploadClient,
  runFleetTaskCommandClient,
} from "../src/fleet/edge.ts";

import { openDaemonHost } from "../src/daemon-host.ts";
import { latestSquadStates } from "../src/squad-run-state.ts";
import { appendRuntimeWorkerRecord } from "../src/dispatch-stream.ts";
import { squadRunObservation } from "../src/squad-observation.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";

test("owner edge Squad launch publishes a canonical run visible on another edge", { timeout: 180_000 }, async (t) => {
  const witness = {
    installationId: "squad-install",
    kindId: "codex",
    executablePath: "/usr/bin/true",
    version: "fixture",
    observedAt: new Date().toISOString(),
  };
  let now = new Date().toISOString();
  const f = await fleetNodeClaimFixture(t, undefined, undefined, () => now, undefined, false, {
    runtimeDiscover: () => [witness],
    runtimeLaunch: () => {
      throw new Error("Center must not launch Squad processes");
    },
  });
  const vertical = await f.host.run("lease-repo", { kind: "vertical-declaration-migrate" }, localAuthFixture());
  assert.equal(vertical.outcome, "applied", JSON.stringify(vertical));
  const schedule = await f.host.run(
    "lease-repo",
    {
      kind: "schedule-create",
      scheduleId: "s5c-offline-schedule",
      name: "Offline read witness",
      // The lease probe advances two days; this read-only witness must not add scheduler events.
      disabled: true,
      mode: "detect",
      cronExpression: "17 3 * * *",
      timezone: "UTC",
      builtinId: "ledger-backup",
      systemPresetId: "ledger-backup",
      mission: "Read the accepted schedule history from B.",
      idempotencyKey: "s5c-offline-schedule",
    },
    localAuthFixture(),
  );
  assert.equal(schedule.outcome, "applied", JSON.stringify(schedule));
  await f.host.runtimeInstance(
    "daemon.runtimeInstance.create",
    {
      instanceId: "center-codex",
      name: "Center declaration witness",
      kindId: "codex",
      installationId: "squad-install",
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription",
    },
    localAuthFixture(),
  );
  for (const id of ["squad-leader", "squad-worker"]) {
    const receipt = await f.host.run(
      "lease-repo",
      {
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id,
          name: id,
          instructions: "Perform the bounded Squad assignment.",
          runtimes: [{ type: "codex" }],
        },
      },
      localAuthFixture(),
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  }
  const installed = await f.host.run(
    "lease-repo",
    {
      kind: "squad-install",
      declaration: {
        schema: "squad-declaration/v1",
        id: "canonical-squad",
        name: "Canonical Squad",
        leader: "squad-leader",
        workers: ["squad-worker"],
        leaderTurnBudget: 4,
        roster: "# Squad\n\nCoordinate the workers and publish the synthesis at artifacts/reports/{squadRunId}.md.",
      },
    },
    localAuthFixture(),
  );
  assert.equal(installed.outcome, "applied", JSON.stringify(installed));
  const created = await f.command("node-one", { kind: "task-create", title: "Canonical Squad run" });
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  const taskId = String(created.receipt!.taskId);
  let launches = 0,
    kills = 0;
  const a = await fleetEdgeHostFixture(t, f, {
    name: "owner",
    runtimeDiscover: () => [
      {
        installationId: "squad-install",
        kindId: "codex",
        executablePath: "/usr/bin/true",
        version: "fixture",
        observedAt: new Date().toISOString(),
      },
    ],
    runtimeLaunch: () => {
      launches += 1;
      return {
        pid: 90210,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => {
          kills += 1;
        },
      };
    },
  });
  let successorLaunches = 0;
  const b = await fleetEdgeHostFixture(t, f, {
    name: "reader",
    nodeId: "node-two",
    runtimeDiscover: () => [witness],
    runtimeLaunch: () => {
      successorLaunches += 1;
      return {
        pid: 90211,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      };
    },
  });
  const instance = await a.host.runtimeInstance(
    "daemon.runtimeInstance.create",
    {
      instanceId: "squad-runtime",
      name: "Squad runtime",
      kindId: "codex",
      installationId: "squad-install",
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription",
    },
    localAuthFixture(),
  );
  assert.equal(instance.outcome, "applied", JSON.stringify(instance));
  const { schema: _schema, ...configuration } = a.config;
  const started = await a.host.fleet.edgeRuntime(
    {
      ...configuration,
      workspaceRoot: a.edgeRoot,
      method: "repo.squad.control",
      action: {
        kind: "squad-run",
        squadId: "canonical-squad",
        taskId,
        runtimeInstanceId: "squad-runtime",
        cwd: { scope: "repo-root" },
      },
    },
    localAuthFixture(),
  );
  assert.equal(started.outcome, "completed", JSON.stringify(started));
  assert.equal(launches, 1);
  assert.equal(successorLaunches, 0);
  const runId = String(started.squadRunId);
  const canonical = makeTaskEventReader({ repoId: "lease-repo", rootDir: f.repo }).read().events;
  const observed = canonical
    .filter((event) => event.schema === "agent-runtime-event/v1" && event.type === "runtime_squad_run_observed")
    .at(-1)!;
  assert.ok(observed, "real coordinator emitted an accepted observation");
  assert.equal(observed.payload.squadRunId, runId);
  assert.equal(observed.source && typeof observed.source === "object" ? observed.source.nodeId : null, "node-one");
  assert.equal(JSON.stringify(observed).includes(a.edgeRoot), false, "no machine path in public observation");
  assert.equal(
    observed.payload.mission,
    "Canonical Squad run",
    "publish the canonical task description, not the node execution prompt",
  );
  await f.host.replica("lease-repo").waitForCut(f.eventCount());
  await runFleetReplicaPullClient({ ...f.peer("node-two"), viewRoot: b.viewRoot, diskQuotaBytes: b.config.quotaBytes });
  const beforeReplay = f.eventCount();
  const replay = await runFleetRuntimeEventClient({
    ...f.peer("node-one"),
    eventType: observed.type,
    opId: observed.opId,
    payload: observed.payload,
  });
  assert.equal(replay.receipt.replayed, true);
  assert.equal(f.eventCount(), beforeReplay);
  await assert.rejects(
    runFleetRuntimeEventClient({
      ...f.peer("node-two"),
      eventType: observed.type,
      opId: observed.opId,
      payload: observed.payload,
    }),
    /owner|source|scope/iu,
  );
  const observation = (runRevision: number, extra: Record<string, unknown> = {}) =>
    runFleetRuntimeEventClient({
      ...f.peer("node-one"),
      eventType: observed.type,
      opId: `squad-observed-${runId}-${runRevision}`,
      payload: { ...observed.payload, runRevision, ...extra },
    });
  const acceptedCount = f.eventCount();
  f.owners.keycloak.revoke("person-one", "lease-repo", ["runtime-run"]);
  await assert.rejects(observation(3, { phase: "cancelled" }), /authorization|denied|permission/iu);
  assert.equal(f.eventCount(), acceptedCount);
  f.owners.keycloak.permit("person-one", "lease-repo", ["runtime-run"]);
  f.owners.reassign("node-one", "different-person");
  await assert.rejects(observation(3, { phase: "cancelled" }), /owner|scope/iu);
  f.owners.reassign("node-one", "person-one");
  await assert.rejects(
    observation(3, { ownerDispatchId: "dispatch_000000000000000000000000" }),
    /owner|scope|dispatch/iu,
  );
  await assert.rejects(
    runFleetRuntimeEventClient({
      ...f.peer("node-one"),
      repoId: "unregistered-repository",
      eventType: observed.type,
      opId: observed.opId,
      payload: observed.payload,
    }),
    /repo_unavailable|repository|registered|assigned|authorization/iu,
  );
  assert.equal(f.eventCount(), acceptedCount);
  const resultBody = "完整 leader 结果\n".repeat(6000),
    leaderSession = observed.payload.leaderTurns[0]!.runtimeSessionId!,
    resultRef = `artifact:runtime-result/sha256/${sha256Text(resultBody)}`;
  await runFleetRuntimeEventClient({
    ...f.peer("node-one"),
    eventType: "runtime_session_outcome_observed",
    opId: "squad-leader-complete-result",
    resultBody,
    payload: {
      runtimeSessionId: leaderSession,
      outcome: "succeeded",
      exitCode: 0,
      resultRef,
      result: {
        sha256: sha256Text(resultBody),
        size: Buffer.byteLength(resultBody),
        mediaType: "text/plain; charset=utf-8",
      },
    },
  });
  await observation(3);
  const afterThird = f.eventCount();
  await assert.rejects(observation(2), /stale|conflict/iu);
  await assert.rejects(observation(3, { error: "different payload" }), /conflict/iu);
  assert.equal(
    (
      await runFleetRuntimeEventClient({
        ...f.peer("node-one"),
        eventType: observed.type,
        opId: observed.opId,
        payload: observed.payload,
      })
    ).receipt.replayed,
    true,
  );
  assert.equal(f.eventCount(), afterThird, "old replay and rejected snapshots cannot change the cut");
  const childAction = {
    kind: "task-create",
    parentTaskId: taskId,
    squadRunId: runId,
    title: "Owned child",
    idempotencyKey: `${runId}:leader-1:worker-closeout`,
  };
  const foreignChild = await f.command("node-two", childAction);
  assert.notEqual(foreignChild.outcome, "applied", JSON.stringify(foreignChild));
  const child = await f.command("node-one", childAction);
  assert.equal(child.outcome, "applied", JSON.stringify(child));
  const heldRelease = await f.command("node-two", { kind: "task-release", taskId });
  assert.notEqual(heldRelease.outcome, "applied", "a live execution cannot be recovered merely by sharing a principal");
  now = new Date(Date.parse(now) + 2 * 86_400_000).toISOString();
  const released = await f.command("node-one", { kind: "task-release", taskId, reason: "Recover expired owner" });
  assert.equal(released.outcome, "applied", JSON.stringify(released));
  const planned = await f.host.run(
    "lease-repo",
    { kind: "task-transition", taskId, status: "planned", reason: "New iteration" },
    localAuthFixture(),
  );
  assert.equal(planned.outcome, "applied", JSON.stringify(planned));
  const successor = await f.command("node-two", { kind: "task-start", taskId });
  assert.equal(successor.outcome, "applied", JSON.stringify(successor));
  for (const action of [
    { ...childAction, idempotencyKey: `${runId}:late-child` },
    { kind: "task-start", taskId, executionId: observed.payload.executionId, squadRunId: runId },
    {
      kind: "task-release",
      taskId,
      executionId: observed.payload.executionId,
      squadRunId: runId,
      reason: "Late old owner",
    },
    {
      kind: "task-artifact-add",
      taskId,
      squadRunId: runId,
      destination: `artifacts/reports/${runId}.md`,
      content: "Late synthesis",
    },
  ]) {
    const denied =
      action.kind === "task-artifact-add"
        ? await (async () => {
            const { content, ...target } = action;
            const [artifact] = await runFleetUploadClient({
              ...f.peer("node-one"),
              changes: [{ path: String(target.destination), body: String(content) }],
            });
            return runFleetTaskCommandClient({
              ...f.peer("node-one"),
              taskId,
              action: target,
              artifact,
              waitMs: 5000,
              opId: "old-run-synthesis",
            });
          })()
        : await f.command("node-one", action);
    assert.notEqual(denied.outcome, "applied", JSON.stringify(denied));
    assert.match(JSON.stringify(denied), /execution_scope_mismatch/u);
  }
  const initialDispatch = canonical.find(
    (event) => event.type === "runtime_dispatch_requested" && event.payload.squadRun?.squadRunId === runId,
  )!;
  await assert.rejects(
    runFleetRuntimeEventClient({
      ...f.peer("node-one"),
      eventType: "runtime_dispatch_requested",
      opId: "obsolete-leader-continuation",
      dispatchContext: {
        role: initialDispatch.payload.role ?? null,
        taskId,
        executionId: observed.payload.executionId,
      },
      payload: {
        ...initialDispatch.payload,
        dispatchId: "dispatch_eeeeeeeeeeeeeeeeeeeeeeee",
        runtimeSessionId: "runtime-obsolete-continuation",
        idempotencyKey: "obsolete-leader-continuation",
        squadRun: { squadRunId: runId, ownerDispatchId: observed.payload.ownerDispatchId, turnId: "leader-2" },
      },
    }),
    /runtime_task_lease_required|execution_scope_mismatch/iu,
  );
  const bInstance = await b.host.runtimeInstance(
    "daemon.runtimeInstance.create",
    {
      instanceId: "successor-runtime",
      name: "Successor",
      kindId: "codex",
      installationId: "squad-install",
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription",
    },
    localAuthFixture(),
  );
  assert.equal(bInstance.outcome, "applied", JSON.stringify(bInstance));
  const { schema: _bSchema, ...bConfiguration } = b.config;
  const nextRun = await b.host.fleet.edgeRuntime(
    {
      ...bConfiguration,
      workspaceRoot: b.edgeRoot,
      method: "repo.squad.control",
      action: {
        kind: "squad-run",
        squadId: "canonical-squad",
        taskId,
        runtimeInstanceId: "successor-runtime",
        cwd: { scope: "repo-root" },
      },
    },
    localAuthFixture(),
  );
  assert.equal(nextRun.outcome, "completed", JSON.stringify(nextRun));
  assert.notEqual(nextRun.squadRunId, runId);
  assert.equal(successorLaunches, 1, "the old run is not a permanent task reservation against the successor node");
  assert.equal(
    latestSquadStates(a.edgeRoot).get(runId)?.phase,
    "leader_running",
    "B's new run does not pretend A's old process stopped",
  );
  await assert.rejects(observation(4), /execution|current/iu);
  const closeoutPayload = {
    phase: "cancelled",
    workerAttempts: [
      {
        attemptId: "worker-closeout",
        workerId: "squad-worker",
        leaderTurnId: "leader-1",
        taskId: String(child.receipt!.taskId),
        executionId: null,
        dispatchId: null,
        runtimeSessionId: null,
        rejection: "Stopped before dispatch",
        branch: null,
        baseSha: null,
      },
    ],
  };
  await observation(4, closeoutPayload);
  const closedChild = await f.host.run(
    "lease-repo",
    { kind: "task-show", taskId: String(child.receipt!.taskId) },
    localAuthFixture(),
  );
  assert.equal(
    JSON.parse(String(closedChild.evidence)).task.status,
    "cancelled",
    "center closes the owner's assignment",
  );
  const closeoutCut = f.eventCount();
  assert.equal((await observation(4, closeoutPayload)).receipt.replayed, true);
  assert.equal(f.eventCount(), closeoutCut, "terminal replay writes no second child cancellation");
  await assert.rejects(observation(5), /op_conflict/iu);
  await assert.rejects(
    observation(5, { phase: "cancelled", executionId: "different-execution" }),
    /execution|identity/iu,
  );
  assert.equal(
    (
      await runFleetRuntimeEventClient({
        ...f.peer("node-one"),
        eventType: observed.type,
        opId: observed.opId,
        payload: observed.payload,
      })
    ).receipt.replayed,
    true,
    "accepted op replays after the parent changes iteration",
  );
  const afterTerminal = await f.host.read(
    "lease-repo",
    "repo.tasks.runtimeContext.read",
    { taskId },
    localAuthFixture(),
  );
  assert.notEqual(
    afterTerminal.snapshot.lease?.executionId,
    observed.payload.executionId,
    "late terminal observation cannot release or replace the successor lease",
  );
  await f.host.replica("lease-repo").waitForCut(f.eventCount());
  await runFleetReplicaPullClient({ ...f.peer("node-two"), viewRoot: b.viewRoot, diskQuotaBytes: b.config.quotaBytes });
  const metadata = await readFleetRepositoryMetadataClient(f.peer("node-one")),
    authority = openPersistentWriterEpoch({ stateRoot: f.writerEpochStateRoot });
  try {
    assert.ok(authority.acquire("lease-repo").epoch > metadata.writerEpoch);
    await assert.rejects(observation(4, closeoutPayload), /writer_epoch_stale|writer epoch/iu);
  } finally {
    authority.close();
  }
  const beforeRestart = f.eventCount();
  await f.center.close();
  await f.closeHost(f.host);
  const restartedHost = await f.openHost(),
    restartedCenter = await f.openCenter(restartedHost, f.center.port);
  assert.equal((await observation(4, closeoutPayload)).receipt.replayed, true);
  assert.equal(
    f.eventCount(),
    beforeRestart,
    JSON.stringify(
      makeTaskEventReader({ repoId: "lease-repo", rootDir: f.repo })
        .read()
        .events.filter((event) => event.workspaceRevision > beforeRestart)
        .map((event) => ({ type: event.type, opId: event.opId, payload: event.payload })),
    ),
  );
  await restartedCenter.close();
  const { schema: _readerSchema, ...readerConfiguration } = b.config;
  await assert.rejects(
    b.host.fleet.edgeRuntime(
      {
        ...readerConfiguration,
        workspaceRoot: b.edgeRoot,
        method: "repo.squad.control",
        action: { kind: "squad-cancel", squadRunId: runId },
      },
      localAuthFixture(),
    ),
    /owner|control state/iu,
  );
  assert.equal(kills, 0, "querying node cannot cancel the owner's runtime");
  await assert.rejects(
    a.host.fleet.edgeRuntime(
      {
        ...configuration,
        workspaceRoot: a.edgeRoot,
        method: "repo.squad.control",
        action: { kind: "squad-cancel", squadRunId: runId },
      },
      localAuthFixture(),
    ),
    /cancel|publication|connect/iu,
  );
  assert.equal(kills, 1, "owner kill precedes any offline publication failure");
  const answer = await b.command({ kind: "squad-status", squadRunId: runId });
  assert.equal(answer.outcome, "applied", JSON.stringify(answer));
  assert.equal(answer.squadRunId, runId);
  assert.equal(answer.status, "cancelled");
  assert.equal(answer.runRevision, 4);
  assert.equal(
    (answer.leaderTurns as { resultText: string }[])[0]!.resultText,
    resultBody,
    "B reads the full accepted leader result without owner streams or center access",
  );
  assert.ok(answer.cut);
  const view = locateFleetMirrorView(b.viewRoot, "lease-repo")!;
  recordHeadConfirmation(
    view.viewDir,
    { revision: view.revision, headDigest: view.headDigest, schemaGeneration: READ_MODEL_SCHEMA_GENERATION },
    0,
  );
  const connections = t.mock.method(tls, "connect");
  syncBuiltinESMExports();
  const response = await b.rpc.handle({
    jsonrpc: "2.0",
    id: 1001,
    method: "repo.task.dispatches",
    params: { repo: { repoId: "lease-repo" }, payload: { taskId } },
  });
  assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response));
  const dispatches = parseDaemonGuiReadResult("repo.task.dispatches", response.result);
  assert.equal(connections.mock.callCount(), 0, "GUI read makes zero TLS calls to center");
  assert.equal(dispatches.freshness?.state, "stale");
  assert.match(dispatches.warning ?? "", /可能过期/u);
  assert.ok(dispatches.cut);
  assert.ok(dispatches.freshness);
  assert.equal(dispatches.dispatches.length, 2, "B reads both accepted runs while center is offline");
  assert.ok(dispatches.dispatches.some((row) => row.executionId === observed.payload.executionId));
  assert.ok(dispatches.dispatches.some((row) => row.executionId !== observed.payload.executionId));
  const offlineReads = [
    ["repo.tasks.list", {}],
    ["repo.works.index", {}],
    ["repo.workspace.summary.read", {}],
    ["repo.settings.read", {}],
    ["repo.projection.read", { name: "runtime-session-groups", groupBy: "task" }],
    ["repo.projection.read", { name: "schedule-plane" }],
    ["repo.projection.read", { name: "schedule-run-history", scheduleId: "s5c-offline-schedule" }],
    ["repo.agentRuntime.overview", { taskId }],
    ["repo.agentRuntime.sessions.read", { runtimeSessionId: leaderSession }],
    ["repo.agentRuntime.events.read", { runtimeSessionId: leaderSession, afterCursor: "lifecycle:0" }],
    ["repo.agentRuntime.tokenUsage", { range: "today" }],
    ["repo.agentRuntime.tokenUsageDetail", { agentId: "squad-leader", range: "today" }],
    ["repo.squad.runs.list", {}],
    ["repo.tasks.wip", {}],
    ["repo.squad.run.read", { squadRunId: runId }],
    ["repo.agent.entities.list", {}],
    ["repo.agent.entity.read", { agentId: "squad-leader" }],
    ["repo.squad.entities.list", {}],
    ["repo.squad.entity.read", { squadId: "canonical-squad" }],
    ["repo.decisions.list", { projection: "summary" }],
    ["repo.agenda.read", {}],
    ["repo.triadic.relationGraph", { facet: "edges" }],
    ["repo.triadic.relationGraph", { facet: "facts" }],
    ["repo.entity.kinds.read", {}],
    ["repo.entity.rows.read", {}],
    ["repo.vertical.declaration.read", {}],
    ["repo.tasks.completion.read", { taskId }],
    ["repo.tasks.document.read", { taskId, path: "task_plan.md" }],
    ["repo.gui.catalog.snapshot", {}],
    ["repo.workspace.scope.read", { rootTaskId: taskId }],
    ["repo.tasks.documents.list", { taskId }],
  ] as const;
  const readFailures: unknown[] = [];
  for (const [method, payload] of offlineReads) {
    const read = await b.rpc.handle({
      jsonrpc: "2.0",
      id: 1002,
      method,
      params: { repo: { repoId: "lease-repo" }, ...(daemonMethodAcceptsPayload(method) ? { payload } : {}) },
    });
    assert.ok(read && !Array.isArray(read) && "result" in read, JSON.stringify(read));
    if ((read.result as { ok?: boolean }).ok === false) {
      readFailures.push({ method, result: read.result });
      continue;
    }
    const data = parseDaemonGuiReadResult(method, read.result);
    assert.equal(data.freshness?.state, "stale", `${method}: ${JSON.stringify(data)}`);
    assert.equal(data.cut?.revision, view.revision, method);
  }
  assert.deepEqual(readFailures, [], JSON.stringify(readFailures, null, 2));
  await assert.rejects(b.host.read("lease-repo", "repo.fleet.overview.read", {}, localAuthFixture()), {
    code: "replica_unavailable",
  });
  t.diagnostic(
    `B offline GUI shared-query families=${offlineReads.length}; center Fleet operations explicitly unavailable`,
  );
  b.signIn("person-other");
  await assert.rejects(b.host.read("lease-repo", "repo.task.dispatches", { taskId }, localAuthFixture()), {
    code: "authorization_denied",
  });
  b.signIn("person-one");
  assert.equal(connections.mock.callCount(), 0, "all GUI read families make zero TLS calls to center");
  connections.mock.restore();
  syncBuiltinESMExports();
  t.diagnostic(
    `B GUI RPC offline dispatches=${dispatches.dispatches.length} freshness=${dispatches.freshness!.state} center TLS calls=0 owner mismatch=authorization_denied`,
  );
  assert.equal(launches, 1);
  t.diagnostic(`A launch -> canonical observation ${observed.workspaceRevision} -> B offline status ${runId}`);
  await a.host.close();
  const persisted = latestSquadStates(a.edgeRoot).get(runId)!;
  assert.ok(persisted);
  const pending = { ...persisted, revision: 5, phase: "cancelled" as const, error: "Owner recovered terminal report" };
  appendRuntimeWorkerRecord(a.edgeRoot, persisted.stateDispatchId!, {
    kind: "squad_run_state",
    squadRunId: runId,
    revision: 5,
    state: pending,
    observation: squadRunObservation(pending),
  });
  await f.closeHost(restartedHost);
  const recoveryHost = await f.openHost(),
    recoveryCenter = await f.openCenter(recoveryHost, f.center.port);
  const recoveryCut = recoveryHost.replica("lease-repo");
  recoveryCut.activate();
  const beforeRecovery = f.eventCount();
  const restoredOwner = await openDaemonHost({
    daemonId: "owner-daemon",
    userRoot: a.edgeUser,
    runtimeLaunch: () => {
      throw new Error("terminal recovery must not launch models");
    },
  });
  t.after(() => restoredOwner.close());
  await restoredOwner.attachmentsSettled();
  await recoveryCut.waitForCut(beforeRecovery + 1);
  const recovered = makeTaskEventReader({ repoId: "lease-repo", rootDir: f.repo }).read().events.at(-1)!;
  assert.equal(recovered.type, "runtime_squad_run_observed");
  assert.equal(recovered.payload.runRevision, 5);
  assert.equal(recovered.payload.phase, "cancelled");
  assert.equal(recovered.payload.executionId, observed.payload.executionId);
  await restoredOwner.close();
  await recoveryCenter.close();
  t.diagnostic(
    "owner daemon restart -> existing replica confirmation callback -> pending terminal revision5 accepted without a runtime request",
  );
});
