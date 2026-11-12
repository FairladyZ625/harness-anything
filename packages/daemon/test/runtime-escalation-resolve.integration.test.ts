// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimeDefinitionSnapshotArtifact, sha256Text } from "@harness-anything/kernel";
import { makeTaskEventReader } from "@harness-anything/storage";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { waitForArrival, watchDirectoryArrival } from "../../../tools/fixtures/event-arrival.ts";
import { appendRuntimeWorkerRecord } from "../src/dispatch-stream.ts";
import { authenticateRuntimeExecutionCredential } from "../src/runtime-execution-credential.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { runtimeDispatchIdentity } from "../src/task-dispatch-recovery.ts";
import { fixtureRuntimeProcess } from "./fixtures/runtime-process.ts";
import { definition, installation, initIngressRepo } from "./fixtures/runtime-ingress.ts";
import { policyTestCenter, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";

for (const interrupted of [false, true])
  test(`self escalation resolves and redispatches${interrupted ? " after an interrupted resolution" : ""}`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-escalation-resolve-")),
      repoId = "escalation-resolve",
      taskId = "task-escalation-resolve",
      ceo = withPolicyGroup(
        { actor: { principal: { personId: "person-escalation" }, executor: null }, source: "local" as const },
        "admin",
      ),
      worker = fixtureRuntimeProcess(t);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    initIngressRepo(root, 0);
    let credential: string | undefined,
      continuedPrompt = "",
      cleanupStarted!: () => void,
      allowCleanup!: () => void;
    const cleaning = new Promise<void>((resolve) => (cleanupStarted = resolve)),
      cleanupAllowed = new Promise<void>((resolve) => (allowCleanup = resolve)),
      events = () => makeTaskEventReader({ rootDir: root, repoId }).read().events;
    let failResolution = interrupted;
    const options: Parameters<typeof openBootstrappedRepoCell>[0] = {
      repoId: workspaceId(repoId),
      rootDir: canonicalRoot(root),
      ownerId: repoId,
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon-user"),
        daemonId: repoId,
        endpoint: path.join(root, ".daemon-user", "daemon.sock"),
      },
      killpoint: (point) => {
        if (
          point === "after_store_commit" &&
          failResolution &&
          events().some(
            (event) =>
              event.type === "runtime_session_outcome_observed" && event.payload.reasonCode === "ruling_resolved",
          )
        ) {
          failResolution = false;
          throw new Error("injected interruption after ruling acceptance");
        }
      },
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: definition.instanceId,
          name: "Ruling worker",
          kindId: definition.kindId,
          installationId: definition.installationId,
          providerId: definition.providerId,
          models: [definition.model],
          defaultModel: definition.model,
          enabled: true,
          permissionMode: "workspace-write",
          codex: {},
          authMode: definition.authMode,
          authState: "configured",
          authReadiness: { status: "ready", code: null, hint: null },
          isolationState: "enforced",
        },
      ],
      prepareRuntimeLaunch: async (_instance, request) => ({
        definition,
        installation,
        executablePath: installation.executablePath,
        args: [],
        env: process.env,
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      runtimeLaunch: (prepared) => {
        credential = prepared.env.HARNESS_EXECUTION_CREDENTIAL;
        continuedPrompt = prepared.prompt;
        return {
          pid: worker.pid,
          onOutput: (listener) =>
            listener(`${JSON.stringify({ type: "thread.started", thread_id: "provider-ruling" })}\n`),
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          // A command child is still returning its response. Full cleanup belongs to the deferred writer turn.
          terminate: () => undefined,
          terminateTree: async () => {
            cleanupStarted();
            await cleanupAllowed;
            await worker.terminateTree();
          },
        };
      },
    };
    let cell = await openBootstrappedRepoCell(options);
    try {
      const created = await cell.run(
        { kind: "task-create", taskId, title: "Ruling resume", presetId: "docs-task" },
        ceo,
      );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await waitForFixturePublication(cell, created.opId, ceo);
      await realizeTaskPlanFixture(
        root,
        String((created as Record<string, unknown>).packagePath),
        (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, ceo),
        "Ruling resume",
      );
      assert.equal((await cell.run({ kind: "task-start", taskId }, ceo)).outcome, "applied");
      const spawned = await cell.spawnRuntime(
          {
            runtimeInstanceId: definition.instanceId,
            taskId,
            cwd: { scope: "repo-root" },
            prompt: "Ask the owner",
            dispatchKey: "first",
          },
          ceo,
        ),
        dispatchId = String(spawned.dispatchId),
        runtimeSessionId = String(spawned.runtimeSessionId);
      assert.ok(credential);
      const principal = await authenticateRuntimeExecutionCredential(await policyTestCenter(), credential);
      assert.ok(principal);
      const escalated = await cell.run(
        {
          kind: "task-escalate",
          taskId,
          question: "May I change this boundary?",
          options: ["Keep the boundary", "Change it"],
        },
        {
          ...ceo,
          actor: {
            principal: ceo.actor.principal,
            executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` },
          },
          executionPrincipal: principal,
        },
      );
      assert.equal(escalated.outcome, "applied", JSON.stringify(escalated));
      await cleaning;
      // A provider exit record is not an OS process-group stop proof.
      appendRuntimeWorkerRecord(root, dispatchId, { kind: "process_exit", exitCode: null, signal: "SIGTERM" });
      const observed = await cell.read("repo.agentRuntime.sessions.read", { runtimeSessionId });
      assert.equal(observed.session.liveness, "live", "the still-running group must not read as exited");
      const selfAnswer = "The worker cannot approve this answer.",
        selfRuling = cell.runtimeIngress(
          {
            kind: "event",
            type: "runtime_session_outcome_observed",
            opId: "worker-self-ruling",
            payload: {
              runtimeSessionId,
              dispatchId,
              outcome: "stopped",
              exitCode: null,
              reasonCode: "ruling_resolved",
              resultRef: `artifact:runtime-result/sha256/${sha256Text(selfAnswer)}`,
              result: {
                sha256: sha256Text(selfAnswer),
                size: Buffer.byteLength(selfAnswer),
                mediaType: "text/plain; charset=utf-8",
              },
            },
            resultBody: selfAnswer,
          },
          {
            ...ceo,
            executionPrincipal: principal,
            actor: {
              principal: ceo.actor.principal,
              executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` },
            },
          },
        );
      const resolving = cell.run(
        { kind: "task-escalation-resolve", taskId, dispatchId, answer: "Keep the boundary." },
        ceo,
      );
      // Give the competing command its own microtask turn while complete-tree cleanup is held.
      await new Promise<void>((resolve) => setImmediate(resolve));
      allowCleanup();
      const denied = await selfRuling;
      assert.equal(denied.outcome, "op_rejected", JSON.stringify(denied));
      assert.equal(denied.code, "execution_credential_rejected", JSON.stringify(denied));
      let resolved = await resolving;
      if (interrupted) {
        assert.notEqual(resolved.outcome, "applied", "the injected commit interruption must reach the caller");
        const accepted = events().findLast(
          (event) =>
            event.type === "runtime_session_outcome_observed" && event.payload.reasonCode === "ruling_resolved",
        );
        assert.ok(accepted, "the fault is after canonical ruling acceptance");
        const blocked = await cell.run({ kind: "task-show", taskId }, ceo);
        assert.equal(JSON.parse(String(blocked.evidence)).task.status, "blocked", "fault precedes Task recovery");
        await cell.close();
        cell = await openBootstrappedRepoCell(options);
        const beforeReplay = events().length;
        resolved = await cell.run(
          { kind: "task-escalation-resolve", taskId, dispatchId, answer: "Keep the boundary." },
          ceo,
        );
        assert.equal(events().length, beforeReplay + 1, "resume writes only the unfinished Task transition");
      }
      assert.equal(resolved.outcome, "applied", JSON.stringify(resolved));
      const beforeDuplicate = events().length,
        duplicate = await cell.run(
          { kind: "task-escalation-resolve", taskId, dispatchId, answer: "Keep the boundary." },
          ceo,
        );
      assert.equal(duplicate.outcome, "applied", JSON.stringify(duplicate));
      assert.equal(events().length, beforeDuplicate, "a completed answer is replayed without another write");
      const conflicting = await cell.run(
        { kind: "task-escalation-resolve", taskId, dispatchId, answer: "Change the boundary." },
        ceo,
      );
      assert.equal(conflicting.code, "invalid_escalation_resolution", "a recovered answer remains immutable");
      const outcomes = events().filter((event) => event.type === "runtime_session_outcome_observed");
      assert.equal(outcomes.length, 2, "the refused worker answer must not append an outcome");
      assert.equal(
        outcomes[1]!.payload.resultRef,
        outcomes[0]!.payload.resultRef,
        "owner resolution preserves the stopped attempt's result",
      );
      assert.deepEqual(
        outcomes[1]!.payload.runtimeMetrics,
        outcomes[0]!.payload.runtimeMetrics,
        "owner resolution preserves its usage evidence",
      );
      const lifecycle = await cell.readDispatchLifecycle({ by: "dispatch", dispatchIds: [dispatchId] });
      assert.equal(lifecycle.status, "ready");
      if (lifecycle.status === "ready") {
        assert.equal(lifecycle.rows[0]?.groupPhase, "closed");
        assert.equal(lifecycle.rows[0]?.policy.canResolveRuling, false);
      }
      const reblocked = await cell.run(
        { kind: "task-transition", taskId, status: "blocked", reason: "A later independent owner decision." },
        ceo,
      );
      assert.equal(reblocked.outcome, "applied", JSON.stringify(reblocked));
      const beforeOldAnswer = events().length;
      assert.equal(
        (await cell.run({ kind: "task-escalation-resolve", taskId, dispatchId, answer: "Keep the boundary." }, ceo))
          .outcome,
        "applied",
      );
      assert.equal(events().length, beforeOldAnswer, "an old answer cannot reopen a later owner block");
      const stillBlocked = await cell.run({ kind: "task-show", taskId }, ceo);
      assert.equal(JSON.parse(String(stillBlocked.evidence)).task.status, "blocked");
      assert.equal(
        (
          await cell.run(
            { kind: "task-transition", taskId, status: "planned", reason: "Owner clears the later decision." },
            ceo,
          )
        ).outcome,
        "applied",
      );
      const rejected = await Promise.allSettled([
        cell.spawnRuntime(
          {
            dispatchId,
            dispatchKey: "rejected-resume",
            taskId,
            runtimeInstanceId: definition.instanceId,
            prompt: "Resume under the answered execution",
          },
          ceo,
        ),
      ]);
      assert.equal(
        events().filter((event) => event.type === "runtime_dispatch_requested").length,
        1,
        "a rejected resume must not synthesize a dispatch without a RuntimeSession",
      );
      assert.equal(rejected[0]?.status, "rejected");
      if (rejected[0]?.status === "rejected") assert.equal(rejected[0].reason.code, "runtime_resume_binding_mismatch");
      const next = await cell.spawnRuntime(
        {
          runtimeInstanceId: definition.instanceId,
          taskId,
          cwd: { scope: "repo-root" },
          prompt: "Continue",
          dispatchKey: "after-answer",
        },
        ceo,
      );
      assert.equal(next.outcome, "applied", JSON.stringify(next));
      assert.match(continuedPrompt, /Owner answer to worker escalation .*Keep the boundary\./u);
      assert.equal(events().filter((event) => event.type === "runtime_dispatch_requested").length, 2);
      const status = await cell.run({ kind: "task-show", taskId }, ceo),
        snapshot = JSON.parse(String(status.evidence));
      assert.equal(status.revision, snapshot.revision, "the displayed revision is the mutation expected-version");
      await waitForArrival(async () => {
        const read = await cell.read("repo.agentRuntime.sessions.read", { runtimeSessionId });
        return read.session.activity.outcome === "stopped" ? true : null;
      }, watchDirectoryArrival(root));
    } finally {
      allowCleanup();
      await cell.close();
    }
  });

test("dispatch and session creation commit together and an invalid start publishes neither", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-dispatch-session-atomic-")),
    repoId = "dispatch-session-atomic";
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initIngressRepo(root, 0);
  const ceo = withPolicyGroup(
      { actor: { principal: { personId: "person-atomic" }, executor: null }, source: "local" as const },
      "admin",
    ),
    cell = await openBootstrappedRepoCell({
      repoId: workspaceId(repoId),
      rootDir: canonicalRoot(root),
      ownerId: repoId,
    });
  try {
    const artifact = runtimeDefinitionSnapshotArtifact(definition),
      ingress = (dispatchKey: string, launchGeneration: number) =>
        cell.runtimeIngress(
          {
            kind: "event",
            type: "runtime_dispatch_requested",
            opId: `atomic-${dispatchKey}`,
            payload: {
              ...runtimeDispatchIdentity(repoId, dispatchKey),
              instanceId: definition.instanceId,
              installationId: definition.installationId,
              kindId: definition.kindId,
              dispatchKey,
              definitionSnapshotRef: artifact.ref,
              definitionSnapshot: definition,
            },
            resultBody: artifact.body,
            dispatchContext: { role: null, taskId: null, executionId: null, launchGeneration },
          },
          ceo,
        ),
      dispatches = () =>
        makeTaskEventReader({ rootDir: root, repoId })
          .read()
          .events.filter((event) => event.type === "runtime_dispatch_requested");
    await assert.rejects(ingress("invalid", -1), { code: "invalid_runtime_event" });
    assert.deepEqual(dispatches(), [], "a refused start leaves no admitted dispatch");
    assert.equal((await ingress("valid", 1)).outcome, "applied");
    const id = runtimeDispatchIdentity(repoId, "valid").runtimeSessionId,
      session = await cell.read("repo.agentRuntime.sessions.read", { runtimeSessionId: id });
    assert.equal(session.session.runtimeSessionId, id);
    assert.equal(dispatches().length, 1);
  } finally {
    await cell.close();
  }
});
