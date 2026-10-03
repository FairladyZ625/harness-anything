// harness-test-tier: integration
import { type AgentDefinitionSnapshot } from "@harness-anything/kernel";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { openDaemonHost } from "../src/daemon-host.ts";

import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { openFleetEdgeRuntime } from "../src/fleet-edge-runtime.ts";

import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { fleetFixture, git, initRepo, localAuthFixture } from "./fleet-runtime-recovery.fixtures.ts";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { eventually } from "./schedule-actions.fixtures.ts";
import { evidence } from "./task-surface.fixtures.ts";
const replicaQuota = 64 * 1024 * 1024;
test(
  "remote-edge dispatch serves the causal block fresh from the center, never its stale mirror",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetFixture(t, ["tasks/task-fleet-fleet"]);
    t.after(() => fixture.close());
    const center = await fixture.center(),
      edgeRoot = path.join(fixture.root, "causal-edge"),
      edgeUserRoot = path.join(fixture.root, "causal-edge-user"),
      viewRoot = path.join(fixture.root, "causal-edge-view"),
      uid = process.getuid?.() ?? 0,
      localAuth = {
        transportKind: "unix-socket",
        unixSocketOwnerBoundary: { ownerUid: uid, source: "unix-socket-filesystem-owner-boundary" },
      } as const;
    mkdirSync(path.join(edgeRoot, "harness"), { recursive: true });
    initRepo(edgeRoot);
    writeFileSync(
      path.join(edgeRoot, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: causal-edge\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    git(edgeRoot, "add", "harness");
    git(edgeRoot, "commit", "-qm", "edge harness");
    // The mirror is pulled BEFORE the causal neighborhood exists at the center,
    // so the decision, fact, and relations recorded below cannot be present in
    // any edge-local copy. If the provider prompt still carries them, the block
    // provably came from the center's canonical cut on this dispatch.
    await runFleetReplicaPullClient({
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
      viewRoot,
      diskQuotaBytes: replicaQuota,
    });
    applyFleetMirrorCut(viewRoot, fixture.subject.repoId, edgeRoot, "pull");
    // Relation writes are admitted against the canonical vertical's relation
    // direction registry, which reads the materialized declaration document —
    // migrate publishes it through the real write path.
    const vertical = await fixture.host.run(
      fixture.subject.repoId,
      { kind: "vertical-declaration-migrate" },
      localAuthFixture(),
    );
    assert.ok(vertical.outcome === "applied" || vertical.outcome === "no_changes", JSON.stringify(vertical));
    if (vertical.outcome === "applied")
      await waitForFleetPublication(fixture.host, fixture.subject.repoId, vertical.opId, localAuthFixture());
    const proposed = await fixture.host.run(
        fixture.subject.repoId,
        {
          kind: "decision-propose",
          jsonInput: JSON.stringify({
            title: "CENTERFRESH-ZQ decision",
            question: "Does the edge see post-pull center context?",
            riskTier: "low",
            urgency: "low",
            vertical: "software/coding",
            preset: "standard-task",
            decisionClass: "ordinary",
            appliesTo: { modules: ["daemon"], productLines: [] },
            chosen: [{ id: "CH1", text: "Serve the center cut over fleet reads", rationale: "Edge mirrors lag." }],
            rejected: [{ id: "RJ1", text: "Summarize the mirror", whyNot: "Stale markdown is not canonical." }],
            claims: [{ id: "C1", text: "Mirrors trail the center cut.", loadBearing: true }],
            fulfillments: [],
          }),
          body: "# CENTERFRESH-ZQ decision\n\nServe the center cut.\n",
        },
        localAuthFixture(),
      ),
      decisionId = String(evidence(proposed).decisionId);
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
    await waitForFleetPublication(fixture.host, fixture.subject.repoId, proposed.opId, localAuthFixture());
    const fact = await fixture.host.run(
      fixture.subject.repoId,
      {
        kind: "fact-record",
        factId: "F-C1EDFACE",
        statement: "CENTERFRESH-ZQ evidence recorded post-pull.",
        evidenceSource: "packages/daemon/src/fleet-edge-runtime.ts",
        confidence: "high",
        memoryClass: "semantic",
      },
      localAuthFixture(),
    );
    assert.equal(fact.outcome, "applied", JSON.stringify(fact));
    await waitForFleetPublication(fixture.host, fixture.subject.repoId, fact.opId, localAuthFixture());
    for (const [sourceRef, targetRef, relationType] of [
      [`decision/${decisionId}/CH1`, `task/${fixture.subject.taskId}`, "derives"],
      [`decision/${decisionId}/C1`, "fact/F-C1EDFACE", "evidenced-by"],
    ] as const) {
      const related = await fixture.host.run(
        fixture.subject.repoId,
        { kind: "relation-relate", sourceRef, targetRef, relationType, rationale: "Fixture edge.", expectedVersion: 0 },
        localAuthFixture(),
      );
      assert.equal(related.outcome, "applied", JSON.stringify(related));
      await waitForFleetPublication(fixture.host, fixture.subject.repoId, related.opId, localAuthFixture());
    }
    registerDaemonRepo({
      canonicalRoot: edgeRoot,
      repoId: fixture.subject.repoId,
      mode: "remote-edge",
      userRoot: edgeUserRoot,
      createConvenienceLinks: false,
    });
    const runtimeDefinition: AgentDefinitionSnapshot = {
        schema: "agent-definition-snapshot/v1",
        configVersion: 1,
        instanceId: "causal-edge-codex",
        installationId: "causal-edge-installation",
        kindId: "codex",
        providerId: "openai",
        model: "causal-edge-model",
        reasoningEffort: "high",
        baseUrl: null,
        authMode: "subscription",
      },
      runtimeInstallation: RuntimeInstallationWitness = {
        installationId: runtimeDefinition.installationId,
        kindId: runtimeDefinition.kindId,
        executablePath: "/usr/bin/true",
        version: "1.0.0",
        observedAt: "2026-08-23T00:00:00.000Z",
      },
      launchedPrompts: string[] = [];
    const edgeHost = await openDaemonHost({
      daemonId: "fleet-causal-edge",
      userRoot: edgeUserRoot,
      runtimeDiscover: () => [runtimeInstallation],
      runtimeLaunch: (prepared) => {
        launchedPrompts.push(prepared.prompt);
        let output: ((chunk: string) => void) | null = null,
          exit: ((code: number | null) => void) | null = null;
        return {
          pid: 91234 + launchedPrompts.length,
          onOutput: (listener) => {
            output = listener;
          },
          onErrorOutput: () => undefined,
          onExit: (listener) => {
            exit = listener;
            queueMicrotask(() => {
              output?.(
                `${JSON.stringify({ type: "thread.started", thread_id: "causal-edge-provider" })}\n${JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "edge done" } })}\n${JSON.stringify({ type: "turn.completed" })}\n`,
              );
              exit?.(0);
            });
          },
          terminate: () => undefined,
        };
      },
    });
    t.after(() => edgeHost.close());
    await edgeHost.attachmentsSettled();
    await edgeHost.runtimeInstance(
      "daemon.runtimeInstance.create",
      {
        instanceId: runtimeDefinition.instanceId,
        name: "Causal Edge Codex",
        kindId: runtimeDefinition.kindId,
        installationId: runtimeDefinition.installationId,
        providerId: runtimeDefinition.providerId,
        models: [runtimeDefinition.model],
        codex: { reasoningEffort: runtimeDefinition.reasoningEffort },
        authMode: runtimeDefinition.authMode,
      },
      localAuth,
    );
    const causalBlock = (prompt: string) =>
      /# Task Causal Context[\s\S]*?(?=\r?\n\r?\n|\r?\n# |\s*$)/u.exec(prompt)?.[0] ?? null;
    // Explicit-prompt dispatch: the center block must be prepended to the caller text.
    const explicit = await edgeHost.fleet.edgeRuntime(
      {
        host: "127.0.0.1",
        port: center.port,
        caPath: fixture.certFile,
        nodeId: fixture.subject.nodeId,
        credential: "machine-secret",
        repoId: fixture.subject.repoId,
        viewRoot,
        quotaBytes: replicaQuota,
        workspaceRoot: edgeRoot,
        method: "repo.agentRuntime.spawn",
        action: {
          runtimeInstanceId: runtimeDefinition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Explicit edge mission.",
          taskId: fixture.subject.taskId,
          idempotencyKey: "causal-edge-explicit",
        },
      },
      localAuth,
    );
    assert.equal(explicit.outcome, "applied", JSON.stringify(explicit));
    const explicitPrompt = launchedPrompts.at(-1);
    assert.ok(explicitPrompt !== undefined, "the provider launch captured no prompt");
    const explicitBlock = causalBlock(explicitPrompt);
    assert.ok(explicitBlock !== null, `no causal block in remote-edge prompt:\n${explicitPrompt}`);
    assert.match(explicitBlock, /CENTERFRESH-ZQ decision/u);
    assert.match(explicitBlock, /CENTERFRESH-ZQ evidence recorded post-pull\./u);
    assert.match(explicitBlock, /Refs: [^\s]/u);
    assert.doesNotMatch(explicitBlock, /ha graph/u, "the bare graph command word left the Refs tail");
    assert.ok(
      Buffer.byteLength(explicitBlock, "utf8") <= 500,
      `causal block is ${Buffer.byteLength(explicitBlock, "utf8")} bytes`,
    );
    // Wait for the first session to settle so the task lease frees, then prove
    // the task-bound (no explicit prompt) remote path carries the same block.
    const outcomeOf = async (runtimeSessionId: unknown) =>
      (
        await fixture.host.read(
          fixture.subject.repoId,
          "repo.agentRuntime.sessions.read",
          { runtimeSessionId },
          fixture.auth,
        )
      ).session.activity.outcome;
    assert.equal(await eventually(async () => (await outcomeOf(explicit.runtimeSessionId)) !== null), true);
    assert.equal(
      await outcomeOf(explicit.runtimeSessionId),
      "succeeded",
      JSON.stringify(fixture.runtimeArchiveReceipts),
    );
    const reclaimed = await fixture.host.run(
      fixture.subject.repoId,
      { kind: "task-start", taskId: fixture.subject.taskId, executionId: "execution-fleet-second" },
      fixture.auth,
    );
    assert.equal(reclaimed.outcome, "applied", JSON.stringify(reclaimed));
    const taskBound = await edgeHost.fleet.edgeRuntime(
      {
        host: "127.0.0.1",
        port: center.port,
        caPath: fixture.certFile,
        nodeId: fixture.subject.nodeId,
        credential: "machine-secret",
        repoId: fixture.subject.repoId,
        viewRoot,
        quotaBytes: replicaQuota,
        workspaceRoot: edgeRoot,
        method: "repo.agentRuntime.spawn",
        action: {
          runtimeInstanceId: runtimeDefinition.instanceId,
          cwd: { scope: "repo-root" },
          taskId: fixture.subject.taskId,
          idempotencyKey: "causal-edge-task-bound",
        },
      },
      localAuth,
    );
    assert.equal(taskBound.outcome, "applied", JSON.stringify(taskBound));
    const taskBoundBlock = causalBlock(launchedPrompts.at(-1) ?? "");
    assert.ok(taskBoundBlock !== null, "task-bound remote-edge dispatch lost the causal block");
    assert.match(taskBoundBlock, /CENTERFRESH-ZQ decision/u);
    // The second dispatch settles against the center too: teardown must not close the center under it.
    assert.equal(await eventually(async () => (await outcomeOf(taskBound.runtimeSessionId)) !== null), true);
  },
);
// Each damaged local mirror retains the preceding admission conditions. These are
// edge task-context assertions, independent of the center ingress scope checks.
for (const probe of [
  { name: "task absent", code: "task_read_failed", message: /Task context is unavailable/u },
  { name: "package absent", code: "runtime_task_package_unavailable", message: /exactly one/u },
  { name: "plan unreadable", code: "runtime_task_package_unavailable", message: /readable mirrored task plan/u },
  { name: "mission absent", code: "runtime_mission_unavailable", message: /no current mirrored mission/u },
  { name: "mission unreadable", code: "runtime_mission_unavailable", message: /is unreadable/u },
  { name: "mission empty", code: "runtime_mission_unavailable", message: /is empty/u },
  {
    name: "contract unreadable",
    code: "runtime_task_package_unavailable",
    message: /readable mirrored task contract/u,
  },
  { name: "contract unresolved", code: "runtime_task_package_unavailable", message: /scaffold is not resolvable/u },
]) {
  test(`edge task context rejects ${probe.name}`, { timeout: 60_000 }, async (t) => {
    const fixture = await fleetFixture(t, ["tasks/task-fleet-fleet"]);
    t.after(() => fixture.close());
    const missionLogical = "tasks/task-fleet-fleet/artifacts/missions/probe.md";
    mkdirSync(path.join(fixture.repo, "harness/tasks/task-fleet-fleet/artifacts/missions"), { recursive: true });
    writeFileSync(path.join(fixture.repo, "harness", missionLogical), "Run the probe.\n");
    const published = await fixture.host.run(
      fixture.subject.repoId,
      { kind: "doc-submit", paths: [missionLogical] },
      localAuthFixture(),
    );
    assert.equal(published.outcome, "applied", JSON.stringify(published));
    await waitForFleetPublication(fixture.host, fixture.subject.repoId, published.opId, localAuthFixture());
    const center = await fixture.center(),
      workspaceRoot = path.join(fixture.root, "counterexample-edge"),
      viewRoot = path.join(fixture.root, "counterexample-view");
    mkdirSync(path.join(workspaceRoot, "harness"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: counterexample-edge\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    await runFleetReplicaPullClient({
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
      viewRoot,
      diskQuotaBytes: replicaQuota,
    });
    applyFleetMirrorCut(viewRoot, fixture.subject.repoId, workspaceRoot, "pull");
    const packageRoot = path.join(workspaceRoot, "harness/tasks/task-fleet-fleet"),
      missionPath = path.join(packageRoot, "artifacts/missions/probe.md"),
      contractPath = path.join(packageRoot, "task-contract.json");
    assert.match(readFileSync(path.join(packageRoot, "task_plan.md"), "utf8"), /Fleet/u);
    assert.equal(readFileSync(missionPath, "utf8"), "Run the probe.\n");
    if (probe.name === "package absent") writeFileSync(path.join(packageRoot, "INDEX.md"), "task_id: another-task\n");
    if (probe.name === "plan unreadable") rmSync(path.join(packageRoot, "task_plan.md"));
    if (probe.name === "mission unreadable") rmSync(missionPath);
    if (probe.name === "mission empty") writeFileSync(missionPath, " \n");
    if (probe.name === "contract unreadable") writeFileSync(contractPath, "{");
    if (probe.name === "contract unresolved") writeFileSync(contractPath, JSON.stringify({ documents: [] }));
    // An absent mission is requested under a different name, preserving the
    // current manifest and every readable local file before that guard.
    const runtime = openFleetEdgeRuntime({
      request: {
        host: "127.0.0.1",
        port: center.port,
        caPath: fixture.certFile,
        nodeId: fixture.subject.nodeId,
        credential: "machine-secret",
        repoId: fixture.subject.repoId,
        viewRoot,
        quotaBytes: replicaQuota,
        workspaceRoot,
        method: "repo.agentRuntime.spawn",
        action: {},
      },
      daemonGeneration: 1,
      daemonRoute: {
        userRoot: path.join(fixture.root, "counterexample-user"),
        daemonId: "counterexample-edge",
        endpoint: path.join(fixture.root, "counterexample.sock"),
      },
      ports: {
        runtimeInstances: () => [],
        prepareWorkerGitEnvironment: async () => null,
        prepareRuntimeLaunch: async () => {
          throw new Error("rejected mirror must never launch");
        },
      },
    });
    fixture.track(() => runtime.close());
    await assert.rejects(
      runtime.run("repo.agentRuntime.spawn", {
        taskId: probe.name === "task absent" ? "task-other" : fixture.subject.taskId,
        missionName: probe.name === "mission absent" ? "missing" : "probe",
        runtimeInstanceId: "unavailable-instance",
        cwd: { scope: "repo-root" },
        idempotencyKey: "mirror-probe",
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, probe.code);
        assert.match((error as Error).message, probe.message);
        return true;
      },
    );
  });
}
test(
  "the center delivers the task's worktree binding and refuses a second node's dispatch while the lease is held",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    t.after(() => fixture.close());
    const { repoId, taskId } = fixture.subject;
    // dec_57370FF2021DADF04E3B21724D CH1: one read carries what the launching node needs from the center.
    const context = await fixture.host.read(repoId, "repo.tasks.runtimeContext.read", { taskId }, fixture.auth);
    assert.deepEqual(
      { schema: context.schema, taskId: context.taskId, worktree: context.worktree },
      {
        schema: "task-runtime-context-read/v1",
        taskId,
        worktree: { branch: taskId, path: `.worktrees/${taskId}` },
      },
    );
    await assert.rejects(
      fixture.host.read(repoId, "repo.tasks.causalContext.read" as never, { taskId }, fixture.auth),
      "the superseded read name is gone, not aliased",
    );
    // CH5: the fixture's node started the task and holds its lease; another node for the same
    // task, with its own execution, dispatches late.
    const late = {
        ...fixture.subject,
        nodeId: "node-two",
        viewId: "node-two_task-fleet",
        executionId: "execution-late",
      },
      idempotencyKey = "late-node-dispatch",
      hash = createHash("sha256").update(`${repoId}\0${idempotencyKey}`).digest("hex"),
      // The verdict's code, whichever way the ingress hands it back.
      dispatch = (assignment: typeof fixture.subject, role: string | null) =>
        fixture.host
          .runtimeIngress(
            repoId,
            {
              kind: "event",
              type: "runtime_dispatch_requested",
              opId: `runtime-spawn-${hash.slice(0, 32)}`,
              payload: {
                idempotencyKey,
                dispatchId: `dispatch_${hash.slice(0, 24)}`,
                runtimeSessionId: `runtime_${hash.slice(24, 48)}`,
                taskId: assignment.taskId,
                executionId: assignment.executionId,
              },
              dispatchContext: { role, taskId: assignment.taskId, executionId: assignment.executionId },
            },
            fixture.owners.auth(assignment),
          )
          .then(
            (receipt) => String(receipt.code ?? receipt.outcome),
            (error: unknown) => String((error as { readonly code?: unknown }).code),
          );
    assert.equal(await dispatch(late, null), "runtime_task_lease_required");
    // The lease binds both person and node; submitted reviewer admission is a separate path.
    assert.notEqual(await dispatch(fixture.subject, null), "runtime_task_lease_required");
    assert.equal(await dispatch(late, "reviewer"), "task_not_submitted");
  },
);
