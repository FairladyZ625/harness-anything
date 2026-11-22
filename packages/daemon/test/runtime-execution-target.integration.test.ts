// harness-test-tier: integration
import { codexFreshPermissionArgs } from "@harness-anything/kernel/internal/domain/runtime-instance-scheduling.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  CloudSandboxAttempt,
  CloudSandboxFrame,
  CloudSandboxResponse,
} from "@harness-anything/application/internal/commands/runtime-execution-target.ts";
import type { CloudSandboxTransport } from "@harness-anything/daemon";
import type { AgentDefinitionSnapshot } from "@harness-anything/kernel";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { waitForArrival, watchDirectoryArrival, watchFileArrival } from "../../../tools/fixtures/event-arrival.ts";
import { readDispatchStream } from "../src/daemon-host/dispatch-stream.ts";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import {
  runtimeExecutionActor,
  type RuntimeExecutionPrincipal,
} from "../src/daemon-host/runtime-execution-credential.ts";
import { createObservableCodexProviderScript, git, readProviderTrace } from "./fleet-remote-runtime-control.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";

const instanceId = "portable-provider";
const definition: AgentDefinitionSnapshot = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId,
  installationId: "installation-codex",
  kindId: "codex",
  providerId: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: null,
  endpointKind: "official",
  baseUrlHash: null,
  authMode: "api-key",
};

class MockCloudSandboxHost implements CloudSandboxTransport {
  partitioned = false;
  wrongStopReceipt = false;
  readonly startKeys = new Set<string>();
  readonly cancelKeys = new Set<string>();
  readonly steered: string[] = [];
  readonly attempts = new Map<
    string,
    {
      attempt: CloudSandboxAttempt;
      frames: CloudSandboxFrame[];
      stopped: boolean;
    }
  >();

  async request<M extends Parameters<CloudSandboxTransport["request"]>[0]>(
    method: M,
    params: Parameters<CloudSandboxTransport["request"]>[1],
    signal: AbortSignal,
  ): Promise<CloudSandboxResponse<M>> {
    signal.throwIfAborted();
    assert.ok(Number.isSafeInteger(params.deadline));
    const { attempt } = params;
    const stopped = { stopProof: "proven_stopped" as const, attempt, exitCode: null };
    if (this.partitioned) {
      if (method === "sandbox.cancel") {
        this.cancelKeys.add(params.idempotencyKey);
      }
      throw Object.assign(new Error("simulated transport unavailable"), { retryable: true });
    }
    let response: unknown;
    if (method === "sandbox.start" && "launch" in params) {
      this.startKeys.add(params.idempotencyKey);
      assert.ok(params.launch.prompt.includes("Runtime target contract"));
      assert.ok(!Object.hasOwn(params.launch, "env"));
      if (!this.attempts.has(attempt.dispatchId))
        this.attempts.set(attempt.dispatchId, {
          attempt,
          frames: [
            {
              sequence: 1,
              kind: "stdout",
              line: JSON.stringify({ type: "thread.started", thread_id: attempt.dispatchId }),
            },
          ],
          stopped: false,
        });
      response = { accepted: true };
    } else {
      const session = this.attempts.get(attempt.dispatchId);
      assert.ok(session);
      assert.deepEqual(attempt, session.attempt);
      if (method === "sandbox.steer" && "steer" in params) {
        const steer = params.steer;
        if (!session.frames.some((frame) => frame.kind === "steer" && frame.opId === steer.opId)) {
          this.steered.push(steer.prompt);
          session.frames.push({
            kind: "steer",
            sequence: session.frames.length + 1,
            opId: steer.opId,
            result: "applied",
          });
        }
        response = { accepted: true };
      } else if (method === "sandbox.read" && "after" in params) {
        response = {
          frames: session.frames.slice(params.after, params.after + params.limit),
          live: !session.stopped,
          ...(session.stopped ? { stopped } : {}),
        };
      } else if (method === "sandbox.cancel") {
        this.cancelKeys.add(params.idempotencyKey);
        if (this.wrongStopReceipt) {
          response = { ...stopped, attempt: { ...attempt, attempt: attempt.attempt + 1 } };
        } else {
          session.stopped = true;
          response = stopped;
        }
      } else assert.fail(`Unexpected sandbox method ${method}`);
    }
    return response as CloudSandboxResponse<M>;
  }
}

for (const kind of ["local", "cloud"] as const) {
  test(
    `runtime target ${kind} streams, steers, cancels and redispatches through the same repo-cell commands`,
    {
      timeout: 120_000,
      skip:
        kind === "local" && process.platform === "win32"
          ? "requires a native POSIX shebang runtime fixture"
          : undefined,
    },
    async (t) => {
      const rootDir = canonicalRoot(mkdtempSync(path.join(tmpdir(), `ha-runtime-target-${kind}-`)));
      t.after(() => rmSync(rootDir, { recursive: true, force: true }));
      const repoId = workspaceId(`runtime-target-${kind}`),
        taskId = `task-runtime-target-${kind}`,
        executionId = `execution-runtime-target-${kind}`,
        trace = path.join(rootDir, "trace.jsonl"),
        cloud = new MockCloudSandboxHost(),
        effect = "Runtime target contract steer",
        executablePath =
          kind === "local" ? createObservableCodexProviderScript(rootDir, "provider", trace, "provider-target") : "",
        binding = withPolicyGroup(
          { actor: { principal: { personId: `person-runtime-target-${kind}` }, executor: null }, source: "local" },
          "admin",
        );
      mkdirSync(path.join(rootDir, "harness"));
      writeFileSync(
        path.join(rootDir, "harness", "harness.yaml"),
        "schema: harness-anything/v1\nname: target\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
      );
      git(rootDir, "init", "-q");
      git(rootDir, "config", "user.name", "Runtime target fixture");
      git(rootDir, "config", "user.email", "runtime-target@example.invalid");
      git(rootDir, "add", "harness");
      git(rootDir, "commit", "-qm", "fixture");
      const openCell = () =>
        openBootstrappedRepoCell({
          repoId,
          rootDir,
          ownerId: "runtime-target",
          runtimeDaemonRoute: {
            userRoot: rootDir,
            daemonId: "runtime-target",
            endpoint: path.join(rootDir, "fixture.sock"),
          },
          ...(kind === "cloud"
            ? {
                cloudRuntime: {
                  instanceTargets: { [instanceId]: { hostId: "sandbox-host", version: "1.0.0" } },
                  request: (hostId, method, params, signal) => {
                    assert.equal(hostId, "sandbox-host");
                    return cloud.request(method, params, signal);
                  },
                },
              }
            : {}),
          runtimeInstances: () => [
            {
              schemaVersion: 2,
              instanceId,
              name: "Runtime target fixture",
              kindId: definition.kindId,
              installationId: definition.installationId,
              providerId: definition.providerId,
              models: [definition.model],
              defaultModel: definition.model,
              enabled: true,
              permissionMode: "workspace-write",
              codex: {},
              authMode: "api-key",
              authState: "configured",
              authReadiness: { status: "ready", code: null, hint: null },
              isolationState: "enforced",
            },
          ],
          prepareRuntimeLaunch: async (_id, request) => ({
            definition,
            protocolFamily: "codex-jsonl",
            installation: {
              installationId: definition.installationId,
              kindId: definition.kindId,
              executablePath,
              version: "1.0.0",
              observedAt: "2026-11-22T00:00:00.000Z",
            },
            executablePath,
            args: ["exec", "--json", ...codexFreshPermissionArgs["workspace-write"], "-"],
            env: { PATH: process.env.PATH },
            cwd: request.cwd,
            prompt: request.prompt,
          }),
        });
      let cell = await openCell();
      let sessionId: string | undefined;
      try {
        const task = await cell.run(
          { kind: "task-create", taskId, title: "Runtime target contract", presetId: "docs-task" },
          binding,
        );
        assert.equal(task.outcome, "applied", JSON.stringify(task));
        await waitForFixturePublication(cell, task.opId, binding);
        await realizeTaskPlanFixture(
          rootDir,
          String((task as Record<string, unknown>).packagePath),
          (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
          "Runtime target contract",
        );
        assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, binding)).outcome, "applied");
        const spawn = (dispatchKey: string) =>
          cell.spawnRuntime(
            {
              runtimeInstanceId: instanceId,
              cwd: { scope: "repo-root" },
              prompt: "Runtime target contract",
              taskId,
              dispatchKey,
            },
            binding,
          );
        const first = await spawn("target-first");
        sessionId = String(first.runtimeSessionId);
        const dispatchId = String(first.dispatchId);
        const waitUntil = <T>(read: () => T | null | Promise<T | null>) =>
          waitForArrival(read, watchDirectoryArrival(path.join(rootDir, ".harness")));
        const view = async () => {
          const lifecycle = await cell.readDispatchLifecycle({ by: "session", runtimeSessionId: sessionId! });
          return lifecycle.status === "ready" ? lifecycle.rows[0] : undefined;
        };
        await waitUntil(async () => {
          const stream = readDispatchStream(rootDir, dispatchId);
          return stream?.providerSessionId && (await view())?.policy.canSteer ? true : null;
        });
        assert.equal(
          readDispatchStream(rootDir, dispatchId)?.records.some((record) => record.kind === "provider_event"),
          true,
        );
        assert.equal((await view())?.attempt.executionTarget?.kind ?? "local", kind);
        t.diagnostic(`${kind} provider stream bound`);
        const steered = await cell.steerRuntime({ dispatchId, prompt: effect }, binding);
        assert.equal(steered.outcome, "applied", JSON.stringify(steered));
        if (kind === "cloud") {
          await waitUntil(() =>
            readDispatchStream(rootDir, dispatchId)?.records.some((record) => record.kind === "steer_resumed")
              ? true
              : null,
          );
          assert.deepEqual(cloud.steered, [effect]);
          assert.equal(readDispatchStream(rootDir, dispatchId)?.process, null);
        } else {
          const resumed = await waitForArrival(
            () => readProviderTrace(trace).find((entry) => entry.isResume) ?? null,
            watchFileArrival(trace),
          );
          assert.ok(
            resumed.prompt.includes(effect),
            `Native provider resumed without the steer prompt: ${JSON.stringify(resumed)}`,
          );
        }
        t.diagnostic(`${kind} provider applied the steer`);
        const cancel = () => cell.cancelRuntime({ runtimeSessionId: sessionId! }, binding);
        const stale: RuntimeExecutionPrincipal = {
          personId: binding.actor.principal.personId,
          repoId,
          dispatchId,
          runtimeSessionId: sessionId,
          taskId,
          executionId,
          role: "implementation",
          source: "local",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        };
        const lateSubmit = () =>
          cell.run(
            { kind: "task-submit", taskId, executionId },
            {
              ...binding,
              actor: runtimeExecutionActor(stale),
              executionPrincipal: stale,
            },
          );
        if (kind === "cloud") {
          cloud.partitioned = true;
          await assert.rejects(cancel(), { code: "stop_unconfirmed" });
          const held = await view();
          assert.equal(held?.attempt.stopProof, "unproven");
          assert.equal(held?.policy.capacityDisposition, "recovering");
          assert.equal(held?.policy.canWrite, false);
          assert.equal(held?.attempt.task?.leaseReleased, false);
          await assert.rejects(spawn("target-partitioned"), { code: "runtime_task_writer_conflict" });
          const during = await lateSubmit();
          assert.equal(during.code, "execution_credential_rejected", JSON.stringify(during));
          assert.equal(cloud.attempts.get(dispatchId)?.stopped, false);
          cloud.partitioned = false;
          cloud.wrongStopReceipt = true;
          await assert.rejects(cancel(), { code: "stop_unconfirmed" });
          assert.equal((await view())?.policy.capacityDisposition, "recovering");
          await cell.close();
          cloud.wrongStopReceipt = false;
          cell = await openCell();
          await cell.awaitRuntimeOutcome(sessionId);
          assert.equal(cloud.attempts.get(dispatchId)?.stopped, true);
          assert.equal(cloud.cancelKeys.size, 1);
          t.diagnostic(
            "Cloud partition and mismatched proof retained capacity. Restart reconciled the same cancellation key.",
          );
        } else {
          assert.equal((await cancel()).outcome, "applied");
          await cell.awaitRuntimeOutcome(sessionId);
        }
        const settled = await view();
        assert.equal(settled?.attempt.stopProof, "proven_stopped");
        assert.equal(settled?.attempt.outcome, "cancelled");
        assert.equal(settled?.attempt.task?.leaseReleased, true);
        const returned = await cell.run(
          { kind: "task-transition", taskId, status: "planned", reason: "Start the replacement execution" },
          binding,
        );
        assert.equal(returned.outcome, "applied", JSON.stringify(returned));
        const restarted = await cell.run({ kind: "task-start", taskId }, binding);
        assert.equal(restarted.outcome, "applied", JSON.stringify(restarted));
        assert.notEqual(restarted.executionId, executionId);
        const second = await spawn("target-second");
        assert.notEqual(second.runtimeSessionId, sessionId);
        const late = await lateSubmit();
        assert.equal(late.code, "execution_credential_rejected", JSON.stringify(late));
        sessionId = String(second.runtimeSessionId);
        assert.equal((await cancel()).outcome, "applied");
        sessionId = undefined;
      } finally {
        cloud.partitioned = false;
        cloud.wrongStopReceipt = false;
        if (sessionId) {
          try {
            await cell.cancelRuntime({ runtimeSessionId: sessionId }, binding);
          } catch (error) {
            t.diagnostic(`Fixture cleanup cancellation: ${String(error)}`);
          } finally {
            await cell.close();
          }
        } else await cell.close();
      }
    },
  );
}
