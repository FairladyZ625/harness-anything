// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection } from "@harness-anything/kernel";
import { appendRuntimeWorkerRecord } from "../src/dispatch-stream.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { createRealizedTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { definition, installation, initIngressRepo, rpc, eventuallyValue, git } from "./fixtures/runtime-ingress.ts";

test("a settled dispatch re-enters its unsubmitted execution as a same-principal handoff", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-spawn-handoff-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    executablePath = writeProviderExecutable(path.join(parent, "codex-stub.mjs"), "process.exit(0);\n"),
    repoId = "runtime-spawn-handoff",
    uid = process.getuid?.() ?? 0;
  initIngressRepo(root, uid);
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  registerDaemonRepo({
    canonicalRoot: root,
    repoId,
    userRoot,
    createConvenienceLinks: false,
  });
  const auth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: {
        ownerUid: uid,
        source: "unix-socket-filesystem-owner-boundary",
      },
    } as const,
    ingressDefinition = { ...definition, authMode: "subscription" as const },
    ingressInstallation = { ...installation, executablePath };
  let launchCount = 0;
  const exitListeners: ((code: number | null) => void)[] = [];
  const host = await openDaemonHost({
    daemonId: "runtime-spawn-handoff",
    userRoot,
    runtimeDiscover: () => [ingressInstallation],
    runtimeLaunch: () => {
      launchCount += 1;
      return {
        pid: 4310,
        onOutput: (listener) => {
          queueMicrotask(() =>
            listener(`${JSON.stringify({ type: "thread.started", thread_id: "provider-task-session" })}\n`),
          );
        },
        onErrorOutput: () => undefined,
        onExit: (listener) => {
          exitListeners.push(listener);
        },
        terminate: () => undefined,
      };
    },
  });
  await host.attachmentsSettled();
  const createReadyTask = async (taskId: string, title: string): Promise<void> => {
    await createRealizedTaskPlanFixture(
      root,
      async () => {
        const created = await host.run(repoId, { kind: "task-create", taskId, title }, auth);
        const publication = await host.run(
          repoId,
          { kind: "receipt-show", opId: created.opId, waitFor: ["git_verified", "worktree_visible"], timeoutMs: 5000 },
          auth,
        );
        assert.equal(publication.wait?.state, "satisfied", JSON.stringify(publication));
        return created;
      },
      (planPath) => host.run(repoId, { kind: "doc-submit", paths: [planPath] }, auth),
      title,
    );
  };
  try {
    host.runtimeInstance(
      "daemon.runtimeInstance.create",
      {
        instanceId: ingressDefinition.instanceId,
        name: "Codex Review",
        kindId: ingressDefinition.kindId,
        installationId: ingressDefinition.installationId,
        providerId: ingressDefinition.providerId,
        models: [ingressDefinition.model],
        permissionMode: "workspace-write",
        isolationState: "enforced",
        codex: { reasoningEffort: ingressDefinition.reasoningEffort, fast: ingressDefinition.fast },
        authMode: ingressDefinition.authMode,
      },
      auth,
    );
    const taskId = "task-runtime-handoff-rejoin";
    await createReadyTask(taskId, "Runtime handoff rejoin");
    const exitsBeforeFirst = exitListeners.length,
      first = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: ingressDefinition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Claim the execution, then settle.",
          taskId,
          idempotencyKey: "handoff-rejoin-first",
        },
      });
    assert.equal(first.outcome, "applied", JSON.stringify(first));
    const firstBinding = await eventuallyValue(
      async () =>
        makeTaskEventReader({ repoId, rootDir: root })
          .read()
          .events.find(
            (event) =>
              event.type === "runtime_session_task_bound" && event.payload.runtimeSessionId === first.runtimeSessionId,
          ) ?? null,
    );
    assert.equal(firstBinding?.type, "runtime_session_task_bound");
    if (firstBinding?.type !== "runtime_session_task_bound") throw new Error("missing first task binding");
    const executionId = firstBinding.payload.executionId,
      settledAt = "2026-09-14T00:00:00.000Z";
    // Drive the first dispatch to a durable settlement: provider frames, then process exit.
    for (const event of [
      { type: "thread.started", thread_id: "provider-handoff-rejoin" },
      { type: "item.completed", item: { id: "message-1", type: "agent_message", text: "first attempt done" } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ])
      appendRuntimeWorkerRecord(root, String(first.dispatchId), {
        kind: "provider_event",
        occurredAt: settledAt,
        event,
      });
    appendRuntimeWorkerRecord(root, String(first.dispatchId), {
      kind: "process_exit",
      occurredAt: settledAt,
      exitCode: 0,
      signal: null,
    });
    exitListeners[exitsBeforeFirst]!(0);
    await eventuallyValue(async () => {
      const events = makeTaskEventReader({ repoId, rootDir: root }).read().events;
      return events.some(
        (event) =>
          event.type === "runtime_session_outcome_observed" &&
          event.payload.runtimeSessionId === first.runtimeSessionId,
      ) &&
        events.some(
          (event) =>
            event.type === "lease_released" &&
            event.taskId === taskId &&
            event.payload.execution.executionId === executionId,
        )
        ? events
        : null;
    });
    const settledState = makeTaskProjection({
      rootDir: root,
      eventStore: makeTaskEventReader({ repoId, rootDir: root }),
    });
    try {
      const snapshot = settledState.read(taskId).snapshot;
      assert.equal(snapshot.lease, null, "a settled dispatch must release the execution lease");
      assert.deepEqual(
        snapshot.executions.map((execution) => ({ state: execution.state, submittedAt: execution.submittedAt })),
        [{ state: "active", submittedAt: null }],
        "the settled round keeps exactly one active, unsubmitted execution",
      );
    } finally {
      settledState.close();
    }
    // Negative control: in that state a different agent identity — a RuntimeSession holding an
    // unrelated task's execution — must not take over the unsubmitted execution.
    const outsiderTaskId = "task-runtime-handoff-outsider";
    await createReadyTask(outsiderTaskId, "Runtime handoff outsider");
    const outsider = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: ingressDefinition.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Hold an unrelated execution.",
        taskId: outsiderTaskId,
        idempotencyKey: "handoff-rejoin-outsider",
      },
    });
    assert.equal(outsider.outcome, "applied", JSON.stringify(outsider));
    await eventuallyValue(
      async () =>
        makeTaskEventReader({ repoId, rootDir: root })
          .read()
          .events.find(
            (event) =>
              event.type === "runtime_session_task_bound" &&
              event.payload.runtimeSessionId === outsider.runtimeSessionId,
          ) ?? null,
    );
    const launchesBeforeOutsiderClaim = launchCount,
      outsiderClaim = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: ingressDefinition.instanceId,
          cwd: { scope: "repo-root" },
          taskId,
          idempotencyKey: "handoff-rejoin-outsider-claim",
          executor: { kind: "agent", id: `runtime-session:${String(outsider.runtimeSessionId)}` },
        },
      });
    t.diagnostic(`outsider claim receipt=${JSON.stringify(outsiderClaim)}`);
    assert.equal(outsiderClaim.outcome, "op_rejected", JSON.stringify(outsiderClaim));
    assert.equal(outsiderClaim.code, "executor_binding_invalid", JSON.stringify(outsiderClaim));
    assert.equal(launchCount, launchesBeforeOutsiderClaim, "the rejected dispatch must not launch a provider");
    // The contract: the same principal redispatches and re-enters the same execution.
    const second = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: ingressDefinition.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Rejoin the execution as a new RuntimeSession.",
        taskId,
        idempotencyKey: "handoff-rejoin-second",
      },
    });
    assert.equal(second.outcome, "applied", JSON.stringify(second));
    const secondBinding = await eventuallyValue(
      async () =>
        makeTaskEventReader({ repoId, rootDir: root })
          .read()
          .events.find(
            (event) =>
              event.type === "runtime_session_task_bound" && event.payload.runtimeSessionId === second.runtimeSessionId,
          ) ?? null,
    );
    assert.equal(secondBinding?.type, "runtime_session_task_bound");
    if (secondBinding?.type !== "runtime_session_task_bound") throw new Error("missing second task binding");
    assert.equal(
      secondBinding.payload.executionId,
      executionId,
      "the handoff must re-enter the settled round's execution",
    );
    const events = makeTaskEventReader({ repoId, rootDir: root }).read().events,
      rejoin = events.find(
        (event) =>
          event.type === "execution_started" &&
          event.taskId === taskId &&
          event.payload.reason === "same_principal_reconnect",
      );
    assert.ok(rejoin, "the handoff must record execution_started with reason same_principal_reconnect");
    assert.equal(rejoin?.type, "execution_started");
    if (rejoin?.type === "execution_started") {
      assert.equal(rejoin.payload.execution.executionId, executionId);
      assert.deepEqual(rejoin.actor.executor, {
        kind: "agent",
        id: `runtime-session:${String(second.runtimeSessionId)}`,
      });
    }
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
