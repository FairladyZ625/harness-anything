// harness-test-tier: integration
import { waitForArrival, watchDirectoryArrival } from "../../../tools/fixtures/event-arrival.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDefinitionSnapshot } from "@harness-anything/kernel";
import { makeTaskEventReader } from "@harness-anything/storage";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { appendRuntimeWorkerRecord } from "../src/dispatch-stream.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiActionResult } from "../src/protocol/gui-result-validation.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const repoId = "task-dispatch-recovery",
  definition: AgentDefinitionSnapshot = {
    schema: "agent-definition-snapshot/v1",
    configVersion: 1,
    instanceId: "codex-recovery",
    installationId: "installation-codex",
    kindId: "codex",
    providerId: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    baseUrl: "https://api.example.test/",
    authMode: "api-key",
  },
  installation: RuntimeInstallationWitness = {
    installationId: definition.installationId,
    kindId: definition.kindId,
    executablePath: "/opt/witnessed/codex",
    version: "1.0.0",
    observedAt: "2026-11-07T00:00:00.000Z",
  };

type Launch = {
  readonly child: ReturnType<typeof spawn>;
  output: ((chunk: string, persisted?: boolean) => void) | null;
  exit: ((code: number | null) => void) | null;
};

/**
 * #4376: recovering a stopped worker was `ha task start` followed by a separate `ha agent run`.
 * The recovery fence replaces both with one compare-and-dispatch inside the runtime publication
 * write turn of a real RepoCell; every refusal below must leave the dispatch list unchanged.
 */
test("a stopped dispatch is recovered once through the fenced compare-and-dispatch", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-task-dispatch-recovery-")),
    launches: Launch[] = [];
  const eventually = (check: () => boolean | Promise<boolean>, ..._rest: unknown[]): Promise<void> =>
    waitForArrival(async () => ((await check()) ? true : null), watchDirectoryArrival(root));
  try {
    initRepo(root);
    const cell = await openBootstrappedRepoCell({
      repoId: workspaceId(repoId),
      rootDir: canonicalRoot(root),
      ownerId: repoId,
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon-user"),
        daemonId: repoId,
        endpoint: path.join(root, ".daemon-user", "daemon.sock"),
      },
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: definition.instanceId,
          name: "Codex Recovery",
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
      prepareRuntimeLaunch: async (_instanceId, request) => ({
        definition,
        installation,
        executablePath: installation.executablePath,
        args: ["exec", "--json", "-"],
        env: process.env,
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      runtimeLaunch: () => {
        const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
          detached: true,
          stdio: ["pipe", "ignore", "ignore"],
        });
        if (!child.pid) throw new Error("fixture worker child did not expose a pid");
        child.unref();
        const launch: Launch = { child, output: null, exit: null };
        launches.push(launch);
        return {
          pid: child.pid,
          onOutput: (listener) => {
            launch.output = listener;
          },
          onErrorOutput: () => undefined,
          onExit: (listener) => {
            launch.exit = listener;
          },
          terminate: () => stopFixtureGroup(child),
          terminateTree: async () => stopFixtureGroup(child),
        };
      },
    });
    try {
      const taskId = "task-dispatch-recovery",
        executionId = "execution-dispatch-recovery",
        ceo = withPolicyGroup(
          { actor: { principal: { personId: "person-ceo" }, executor: null }, source: "local" as const },
          "admin",
        ),
        outsider = withPolicyGroup(
          { actor: { principal: { personId: "person-outsider" }, executor: null }, source: "local" as const },
          "viewer",
        ),
        dispatches = () =>
          makeTaskEventReader({ repoId, rootDir: root })
            .read()
            .events.filter((event) => event.type === "runtime_dispatch_requested" && event.payload.taskId === taskId)
            .map((event) => String((event.payload as { dispatchId: string }).dispatchId)),
        revision = async () =>
          Number(JSON.parse(String((await cell.run({ kind: "task-show", taskId }, ceo)).evidence)).revision),
        spawnPayload = (dispatchKey: string, recovery?: Record<string, unknown>) => ({
          runtimeInstanceId: definition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Continue the stopped work",
          taskId,
          dispatchKey,
          ...(recovery ? { recovery } : {}),
        }),
        stopWorker = async (index: number, dispatchId: string, runtimeSessionId: string) => {
          const launch = launches[index]!,
            records = [
              { type: "thread.started", thread_id: `provider-recovery-${String(index)}` },
              { type: "item.completed", item: { id: "message", type: "agent_message", text: "stopping" } },
              { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
            ];
          for (const event of records)
            appendRuntimeWorkerRecord(root, dispatchId, {
              kind: "provider_event",
              occurredAt: "2026-11-07T12:00:00.000Z",
              event,
            });
          assert.ok(launch.output && launch.exit, "the runtime listeners attach before the provider exits");
          launch.output(records.map((event) => `${JSON.stringify(event)}\n`).join(""), true);
          appendRuntimeWorkerRecord(root, dispatchId, {
            kind: "process_exit",
            occurredAt: "2026-11-07T12:00:01.000Z",
            exitCode: 0,
            signal: null,
          });
          launch.exit(0);
          await outcomeObserved(runtimeSessionId);
        },
        // The worker process ends without any provider output reaching the daemon.
        vanishWorker = async (index: number, dispatchId: string, runtimeSessionId: string) => {
          const launch = launches[index]!;
          assert.ok(launch.exit, "the runtime exit listener attaches before the provider exits");
          appendRuntimeWorkerRecord(root, dispatchId, {
            kind: "process_exit",
            occurredAt: "2026-11-07T12:00:01.000Z",
            exitCode: 0,
            signal: null,
          });
          launch.exit(0);
          await outcomeObserved(runtimeSessionId);
        },
        outcomeObserved = async (runtimeSessionId: string) => {
          await eventually(async () => {
            const outcomeAccepted = makeTaskEventReader({ repoId, rootDir: root })
                .read()
                .events.some(
                  (event) =>
                    event.type === "runtime_session_outcome_observed" &&
                    event.payload.runtimeSessionId === runtimeSessionId,
                ),
              task = JSON.parse(String((await cell.run({ kind: "task-show", taskId }, ceo)).evidence));
            return outcomeAccepted && !task.lease;
          });
        };

      const created = await cell.run(
        { kind: "task-create", taskId, title: "Dispatch recovery", presetId: "docs-task" },
        ceo,
      );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await waitForFixturePublication(cell, created.opId, ceo);
      await realizeTaskPlanFixture(
        root,
        String((created as Record<string, unknown>).packagePath),
        (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, ceo),
        "Dispatch recovery",
      );
      assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, ceo)).outcome, "applied");
      const first = await cell.spawnRuntime(spawnPayload("first-dispatch"), ceo),
        firstDispatchId = String(first.dispatchId);
      assert.deepEqual(dispatches(), [firstDispatchId]);

      // A live source is not recoverable: its process still owns the execution.
      await assert.rejects(
        cell.spawnRuntime(
          spawnPayload("live-key", { dispatchId: firstDispatchId, executionId, expectedVersion: await revision() }),
          ceo,
        ),
        { code: "dispatch_recovery_source_live" },
      );
      await stopWorker(0, firstDispatchId, String(first.runtimeSessionId));
      const stoppedRevision = await revision();

      // The two-step path is gone: a second dispatch of the same execution must name the stopped one.
      await assert.rejects(cell.spawnRuntime(spawnPayload("plain-redispatch"), ceo), {
        code: "dispatch_recovery_fence_required",
      });
      await assert.rejects(
        cell.spawnRuntime(
          spawnPayload("stale-key", { dispatchId: firstDispatchId, executionId, expectedVersion: stoppedRevision - 1 }),
          ceo,
        ),
        (error: Error & { code?: string }) =>
          error.code === "dispatch_recovery_stale_revision" &&
          error.message.includes(`"revision":${String(stoppedRevision)}`),
      );
      await assert.rejects(
        cell.spawnRuntime(
          spawnPayload("execution-key", {
            dispatchId: firstDispatchId,
            executionId: "execution-elsewhere",
            expectedVersion: stoppedRevision,
          }),
          ceo,
        ),
        { code: "dispatch_recovery_execution_changed" },
      );
      await assert.rejects(
        cell.spawnRuntime(
          spawnPayload("source-key", {
            dispatchId: "dispatch_000000000000000000000000",
            executionId,
            expectedVersion: stoppedRevision,
          }),
          ceo,
        ),
        { code: "dispatch_recovery_source_mismatch" },
      );
      await assert.rejects(
        cell.spawnRuntime(
          spawnPayload("outsider-key", { dispatchId: firstDispatchId, executionId, expectedVersion: stoppedRevision }),
          outsider,
        ),
        { code: "authorization_denied" },
      );
      assert.deepEqual(dispatches(), [firstDispatchId], "every refusal leaves the dispatch list unchanged");

      const fence = { dispatchId: firstDispatchId, executionId, expectedVersion: stoppedRevision },
        recovered = await cell.spawnRuntime(spawnPayload("ceo-recovery-1", fence), ceo),
        recoveredDispatchId = String(recovered.dispatchId),
        recovery = recovered.recovery as Record<string, unknown>;
      assert.equal(recovery.schema, "task-dispatch-recovery/v1");
      assert.equal(recovery.sourceDispatchId, firstDispatchId);
      assert.equal(recovery.dispatchId, recoveredDispatchId);
      assert.equal(recovery.replayed, false);
      assert.deepEqual(dispatches(), [firstDispatchId, recoveredDispatchId]);
      const leased = JSON.parse(String((await cell.run({ kind: "task-show", taskId }, ceo)).evidence));
      assert.equal(leased.lease.executionId, executionId, "the recovery rejoins the same execution");
      assert.equal(leased.lease.actor.executor.id, `runtime-session:${String(recovered.runtimeSessionId)}`);

      // An unknown first receipt is retried with the same key: same dispatch, no second worker.
      const replayed = await cell.spawnRuntime(spawnPayload("ceo-recovery-1", fence), ceo);
      assert.equal(replayed.dispatchId, recoveredDispatchId);
      assert.equal(replayed.runtimeSessionId, recovered.runtimeSessionId);
      assert.equal((replayed.recovery as Record<string, unknown>).replayed, true);
      assert.deepEqual(dispatches(), [firstDispatchId, recoveredDispatchId]);
      // The replay answers with the original operation's durable receipt, and both receipts pass
      // the result validator the daemon's repo.agentRuntime.spawn RPC applies before replying.
      assert.equal(replayed.opId, recovered.opId, JSON.stringify(replayed));
      assert.equal(replayed.status, "accepted_durable", JSON.stringify(replayed));
      parseDaemonGuiActionResult("repo.agentRuntime.spawn", recovered);
      parseDaemonGuiActionResult("repo.agentRuntime.spawn", replayed);
      // The same key with a different request is a conflict, not a retry.
      await assert.rejects(
        cell.spawnRuntime(spawnPayload("ceo-recovery-1", { ...fence, executionId: "execution-elsewhere" }), ceo),
        { code: "idempotency_key_conflict" },
      );
      assert.deepEqual(dispatches(), [firstDispatchId, recoveredDispatchId]);

      // A second controller that still believes the first dispatch is the last one is refused even
      // after the recovered worker stops too: on main its plain `agent run` dispatched again.
      await stopWorker(1, recoveredDispatchId, String(recovered.runtimeSessionId));
      await assert.rejects(
        cell.spawnRuntime(
          spawnPayload("ceo-recovery-2", {
            dispatchId: firstDispatchId,
            executionId,
            expectedVersion: await revision(),
          }),
          ceo,
        ),
        (error: Error & { code?: string }) =>
          error.code === "dispatch_recovery_superseded" && error.message.includes(recoveredDispatchId),
      );
      assert.deepEqual(dispatches(), [firstDispatchId, recoveredDispatchId], "no double dispatch");

      // The task left `active` after the comparison was read: the recovery is refused.
      const parked = await cell.run(
        { kind: "task-transition", taskId, status: "blocked", reason: "Owner holds the task" },
        ceo,
      );
      assert.equal(parked.outcome, "applied", JSON.stringify(parked));
      await assert.rejects(
        cell.spawnRuntime(
          spawnPayload("ceo-recovery-3", {
            dispatchId: recoveredDispatchId,
            executionId,
            expectedVersion: await revision(),
          }),
          ceo,
        ),
        (error: Error & { code?: string }) =>
          error.code === "dispatch_recovery_task_changed" && error.message.includes('"status":"blocked"'),
      );
      assert.deepEqual(dispatches(), [firstDispatchId, recoveredDispatchId]);
      const resumed = await cell.run(
        { kind: "task-transition", taskId, status: "active", reason: "Owner released the hold" },
        ceo,
      );
      assert.equal(resumed.outcome, "applied", JSON.stringify(resumed));

      // A source whose end is not settled (its worker vanished without a provider result) is not
      // recoverable: "unknown" fails closed instead of guessing the worker stopped.
      const third = await cell.spawnRuntime(
          spawnPayload("ceo-recovery-4", {
            dispatchId: recoveredDispatchId,
            executionId,
            expectedVersion: await revision(),
          }),
          ceo,
        ),
        thirdDispatchId = String(third.dispatchId);
      await vanishWorker(2, thirdDispatchId, String(third.runtimeSessionId));
      await assert.rejects(
        cell.spawnRuntime(
          spawnPayload("ceo-recovery-5", {
            dispatchId: thirdDispatchId,
            executionId,
            expectedVersion: await revision(),
          }),
          ceo,
        ),
        (error: Error & { code?: string }) =>
          error.code === "dispatch_recovery_source_unsettled" && error.message.includes(thirdDispatchId),
      );
      assert.deepEqual(dispatches(), [firstDispatchId, recoveredDispatchId, thirdDispatchId]);
    } finally {
      await cell.close();
    }
  } finally {
    for (const launch of launches) stopFixtureGroup(launch.child);
    rmSync(root, { recursive: true, force: true });
  }
});

function stopFixtureGroup(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function initRepo(root: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
  git("init", "-q");
  git("config", "user.name", "Recovery Test");
  git("config", "user.email", "recovery@example.invalid");
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: task-dispatch-recovery\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    `${JSON.stringify({ schema: "harness-people/v1", people: [{ personId: "owner", displayName: "Owner", roles: ["owner"], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(4376) }] }], roles: [{ roleId: "owner", commandClasses: ["repo-read", "repo-write"] }] }, null, 2)}\n`,
  );
  git("add", "harness");
  git("commit", "-qm", "fixture");
}
