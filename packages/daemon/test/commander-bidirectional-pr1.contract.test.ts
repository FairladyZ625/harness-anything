// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type AgentDefinitionSnapshot } from "@harness-anything/kernel";
import type { RuntimeInstallationWitness, RuntimeInstanceSummary } from "../src/daemon-host/agent-runtime-instances.ts";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import {
  authenticateRuntimeExecutionCredential,
  type RuntimeExecutionPrincipal,
} from "../src/daemon-host/runtime-execution-credential.ts";
import {
  requireExecutionActionScope,
  requireExecutionRequestScope,
} from "../src/daemon-host/runtime-execution-scope.ts";
import { openDispatchStream } from "../src/daemon-host/dispatch-stream.ts";
import { steerRuntime } from "../src/daemon-host/runtime-spawn-control.ts";
import { consumeQueuedSteersAfterTurn, enqueueQueuedSteer } from "../src/daemon-host/runtime-queued-steer.ts";
import { createActiveRuntime } from "../src/daemon-host/runtime-spawn-active.ts";
import type { RuntimeSpawnerContext } from "../src/daemon-host/runtime-spawn-context.ts";
import { canonicalEventWritePlan, makeTaskEventStore, makeTaskProjection } from "@harness-anything/storage";
import { compileInboxEnqueuedEvent } from "@harness-anything/kernel/internal/domain/agent-runtime-event.ts";
import { policyTestCenter, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import {
  acceptedWorkDecision,
  openBootstrappedRepoCell as openRepoCell,
  setFixtureAgentBinding,
  waitForFixturePublication,
} from "./repo-settings.fixture.ts";
import { evidence } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { waitForDurableCondition } from "../../../tools/fixtures/event-arrival.ts";

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args]);
}

function initGitRepo(root: string): void {
  git(root, "init", "-q");
  git(root, "config", "user.name", "Commander PR1 Test");
  git(root, "config", "user.email", "commander-pr1@example.invalid");
  writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "base");
}

function makeAgyInstance(instanceId: string): RuntimeInstanceSummary {
  return {
    schemaVersion: 2,
    instanceId,
    name: `AGY ${instanceId}`,
    kindId: "agy",
    installationId: "installation-agy",
    providerId: "google",
    models: ["gemini-4-neon"],
    defaultModel: "gemini-4-neon",
    enabled: true,
    permissionMode: "bypass",
    authMode: "subscription",
    authState: "authenticated",
    authReadiness: { status: "ready", code: null, hint: null },
    isolationState: "operator-environment",
    configuration: {},
  };
}

function makeAgyDefinition(instanceId: string): AgentDefinitionSnapshot {
  return {
    schema: "agent-definition-snapshot/v1",
    configVersion: 1,
    instanceId,
    installationId: "installation-agy",
    kindId: "agy",
    providerId: "google",
    model: "gemini-4-neon",
    reasoningEffort: "high",
    endpointKind: "official",
    baseUrlHash: null,
    authMode: "subscription",
  };
}

const agyInstallation: RuntimeInstallationWitness = {
  installationId: "installation-agy",
  kindId: "agy",
  executablePath: process.execPath,
  version: "1.0.0",
  capabilities: ["structured_witness", "resume", "attach", "session_identity"],
  verifiedAt: "2026-11-27T00:00:00.000Z",
};

interface FakeTurnHandle {
  readonly index: number;
  readonly prompt: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly dispatchId: string;
  terminatedCount: number;
  emitOutput: (line: string) => void;
  finish: (code: number) => void;
}

function createFakeAgyController() {
  const turns: FakeTurnHandle[] = [];
  let nextPid = 910_000;
  const launcher = (
    prepared: {
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string | undefined>>;
      readonly prompt: string;
    },
    persistence: { readonly dispatchId: string },
  ) => {
    const pid = nextPid++;
    const outputListeners: ((chunk: string) => void)[] = [];
    const exitListeners: ((code: number | null) => void)[] = [];
    let exited = false;
    const handle: FakeTurnHandle = {
      index: turns.length,
      prompt: prepared.prompt,
      args: [...prepared.args],
      env: { ...prepared.env },
      dispatchId: persistence.dispatchId,
      terminatedCount: 0,
      emitOutput: (line: string) => {
        for (const listener of outputListeners) listener(`${line}\n`);
      },
      finish: (code: number) => {
        if (exited) return;
        exited = true;
        for (const listener of exitListeners) listener(code);
      },
    };
    turns.push(handle);
    return {
      pid,
      onOutput: (listener: (chunk: string) => void) => {
        outputListeners.push(listener);
      },
      onErrorOutput: () => undefined,
      onExit: (listener: (code: number | null) => void) => {
        exitListeners.push(listener);
      },
      terminate: () => {
        handle.terminatedCount += 1;
        handle.finish(null as unknown as number);
      },
      liveDescendantPids: async () => ({ available: true as const, pids: [] as const }),
    };
  };
  return { turns, launcher };
}

async function installAgent(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  owner: ReturnType<typeof withPolicyGroup>,
  id: string,
  role: "commander" | "worker" | "reviewer",
  instanceId: string,
): Promise<void> {
  setFixtureAgentBinding(cell.status().rootDir, id, instanceId);
  const res = await cell.run(
    {
      kind: "agent-install",
      declaration: {
        schema: "agent-declaration/v1",
        id,
        name: `Agent ${id}`,
        role,
        instructions: `Act as ${role}.`,
        runtimes: [{ type: "agy", model: "gemini-4-neon" }],
      },
    },
    owner,
  );
  assert.equal(res.outcome, "applied", JSON.stringify(res));
  await waitForFixturePublication(cell, res.opId, owner);
}

async function createTask(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  binding: ReturnType<typeof withPolicyGroup>,
  ownerForPlan: ReturnType<typeof withPolicyGroup>,
  input: {
    readonly title: string;
    readonly taskClass?: "work" | "task";
    readonly parentTaskId?: string;
    readonly decisionRef?: string;
  },
): Promise<string> {
  const res = await cell.run(
    {
      kind: "task-create",
      title: input.title,
      ...(input.taskClass ? { taskClass: input.taskClass } : {}),
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.decisionRef ? { decisionRef: input.decisionRef } : {}),
    },
    binding,
  );
  assert.equal(res.outcome, "applied", JSON.stringify(res));
  await waitForFixturePublication(cell, res.opId, binding);
  const packagePath = String((res as Record<string, unknown>).packagePath);
  await realizeTaskPlanFixture(cell.status().rootDir, packagePath, async (planPath: string) => {
    const submitted = await cell.run({ kind: "doc-submit", paths: [planPath] }, ownerForPlan);
    if (submitted.outcome === "applied") await waitForFixturePublication(cell, submitted.opId, ownerForPlan);
    return submitted;
  });
  return String((res as Record<string, unknown>).taskId ?? (evidence(res) as { readonly taskId: string }).taskId);
}

test(
  "E2E-1: bounded coordinator credential creates/dispatches direct children and rejects scope escape",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-pr1-e2e1-"));
    const repoId = workspaceId("pr1-e2e1");
    const owner = withPolicyGroup(
      { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" as const },
      "admin",
    );
    const fake = createFakeAgyController();
    let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      initGitRepo(root);
      cell = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(root),
        ownerId: "pr1-e2e1-owner",
        runtimeDaemonRoute: {
          userRoot: path.join(root, ".daemon-user-root"),
          daemonId: "pr1-e2e1",
          endpoint: path.join(root, ".daemon.sock"),
        },
        runtimeInstances: () => [makeAgyInstance("agy-main")],
        prepareRuntimeLaunch: (instanceId, request) => ({
          definition: makeAgyDefinition(instanceId),
          installation: agyInstallation,
          protocolFamily: "agy",
          executablePath: agyInstallation.executablePath,
          args: ["--output-format", "stream-json", "--model", "gemini-4-neon"],
          env: {},
          cwd: request.cwd,
          prompt: request.prompt,
        }),
        runtimeLaunch: fake.launcher as never,
      });
      await installAgent(cell, owner, "neon-commander", "commander", "agy-main");
      await installAgent(cell, owner, "sol-worker", "worker", "agy-main");

      const decisionRef = await acceptedWorkDecision(cell, owner, "pr1-e2e1");
      const work1 = await createTask(cell, owner, owner, { title: "Work 1", taskClass: "work", decisionRef });
      const work2 = await createTask(cell, owner, owner, { title: "Work 2", taskClass: "work", decisionRef });
      const parentTaskId = await createTask(cell, owner, owner, {
        title: "Parent Commander Task",
        parentTaskId: work1,
      });
      const unrelatedTaskId = await createTask(cell, owner, owner, { title: "Unrelated Task", parentTaskId: work2 });

      const spawned = await cell.spawnRuntime(
        {
          agentId: "neon-commander",
          taskId: parentTaskId,
          prompt: "Coordinate sub-packages.",
          dispatchKey: "e2e1-commander-dispatch",
        },
        owner,
      );
      assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
      const commanderSessionId = String(spawned.runtimeSessionId);
      const commanderDispatchId = String(spawned.dispatchId);

      const commanderCredential = fake.turns[0]?.env.HARNESS_EXECUTION_CREDENTIAL;
      assert.ok(commanderCredential, "commander dispatch must inject HARNESS_EXECUTION_CREDENTIAL");
      const persisted = await authenticateRuntimeExecutionCredential(await policyTestCenter(), commanderCredential);
      assert.equal(persisted.dispatchId, commanderDispatchId);
      assert.equal(persisted.role, "coordinator");
      assert.equal(persisted.taskId, parentTaskId);

      const coordinatorBinding = withPolicyGroup(
        {
          actor: {
            principal: { personId: "person-owner" },
            executor: { kind: "agent" as const, id: `runtime-session:${commanderSessionId}` },
          },
          source: "local" as const,
          executionPrincipal: persisted,
        },
        "admin",
      );

      // (a) Direct child task-create succeeds
      const child1 = await createTask(cell, coordinatorBinding, owner, {
        title: "Child Subtask A",
        parentTaskId,
      });
      const child2 = await createTask(cell, coordinatorBinding, owner, {
        title: "Child Subtask B",
        parentTaskId,
      });
      assert.ok(child1.startsWith("task_") && child2.startsWith("task_"));

      // (b) Direct child runtime-spawn, runtime-steer, and runtime-collect succeed
      const childSpawn1 = await cell.spawnRuntime(
        {
          agentId: "sol-worker",
          taskId: child1,
          prompt: "Implement subpackage A.",
          dispatchKey: "e2e1-child1",
        },
        coordinatorBinding,
      );
      assert.equal(childSpawn1.outcome, "applied", JSON.stringify(childSpawn1));

      const childSteer1 = await cell.steerRuntime(
        {
          taskId: child1,
          mode: "queue",
          prompt: "Keep API minimal.",
        },
        coordinatorBinding,
      );
      assert.equal(childSteer1.outcome, "queued", JSON.stringify(childSteer1));

      const childCollect = await cell.run({ kind: "runtime-collect", taskId: child1 }, coordinatorBinding);
      assert.equal(childCollect.outcome, "applied", JSON.stringify(childCollect));

      // (c) Own parent task runtime-report succeeds
      const parentReport = await cell.run(
        { kind: "runtime-report", taskId: parentTaskId, reportKind: "milestone", summary: "Dispatched child A/B" },
        coordinatorBinding,
      );
      assert.equal(parentReport.outcome, "applied", JSON.stringify(parentReport));

      // Negative controls: all must be rejected with execution_credential_rejected
      // (cell.run returns an op_rejected receipt; runtime control methods throw).
      const expectRejected = async (fn: () => Promise<unknown>, label: string) => {
        try {
          const res = (await fn()) as { readonly outcome?: unknown; readonly code?: unknown } | undefined;
          assert.equal(res?.outcome, "op_rejected", `expected op_rejected for ${label}, got: ${JSON.stringify(res)}`);
          assert.equal(
            res?.code,
            "execution_credential_rejected",
            `expected execution_credential_rejected for ${label}, got: ${JSON.stringify(res)}`,
          );
        } catch (error) {
          assert.equal(
            (error as { readonly code?: unknown }).code,
            "execution_credential_rejected",
            `expected execution_credential_rejected for ${label}, got: ${String(error)}`,
          );
        }
      };

      // Missing --parent on task-create
      await expectRejected(
        () =>
          cell!.run(
            {
              kind: "task-create",
              title: "Orphan task",
            },
            coordinatorBinding,
          ),
        "task-create without parentTaskId",
      );

      // Wrong parentTaskId (unrelated task / cross-work)
      await expectRejected(
        () =>
          cell!.run(
            {
              kind: "task-create",
              title: "Cross-work child",
              parentTaskId: unrelatedTaskId,
            },
            coordinatorBinding,
          ),
        "task-create under unrelated task",
      );

      // Runtime spawn on unrelated task
      await expectRejected(
        () =>
          cell!.spawnRuntime(
            {
              agentId: "sol-worker",
              taskId: unrelatedTaskId,
              prompt: "Unauthorized",
              dispatchKey: "e2e1-unauth-spawn",
            },
            coordinatorBinding,
          ),
        "runtime-spawn on unrelated task",
      );

      // Runtime steer on unrelated task
      await expectRejected(
        () =>
          cell!.steerRuntime(
            {
              taskId: unrelatedTaskId,
              mode: "queue",
              prompt: "Unauthorized steer",
            },
            coordinatorBinding,
          ),
        "runtime-steer on unrelated task",
      );

      // Runtime collect on unrelated task
      await expectRejected(
        () => cell!.run({ kind: "runtime-collect", taskId: unrelatedTaskId }, coordinatorBinding),
        "runtime-collect on unrelated task",
      );

      // Self-approval / completion / agent mutation / proven_stopped ruling bypass
      for (const forbidden of [
        { kind: "task-complete", taskId: parentTaskId },
        { kind: "task-review-consent", taskId: parentTaskId },
        { kind: "decision-accept", decisionId: decisionRef },
        { kind: "agent-install", declaration: {} },
        { kind: "squad-install", declaration: {} },
        { kind: "runtime-cancel", runtimeSessionId: String(childSpawn1.runtimeSessionId), ruling: "owner-abandon" },
      ]) {
        assert.throws(
          () => requireExecutionActionScope(persisted, forbidden as never),
          (error: unknown) => (error as { readonly code?: unknown }).code === "execution_credential_rejected",
          `coordinator must reject ${forbidden.kind}`,
        );
      }

      // Regression check: PR #4855 read-only sanitized allowlist remains intact
      const readOnlyPrincipal: RuntimeExecutionPrincipal = {
        personId: "person-owner",
        repoId,
        runtimeSessionId: "runtime_ro_1",
        dispatchId: "dispatch_ro_1",
        taskId: null,
        executionId: null,
        role: "read-only",
        source: "local",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
      assert.doesNotThrow(() =>
        requireExecutionRequestScope(readOnlyPrincipal, "daemon.runtimeInstance.list", {
          repo: { repoId },
          payload: { all: false },
        }),
      );
      assert.doesNotThrow(() =>
        requireExecutionRequestScope(readOnlyPrincipal, "repo.fleet.overview.read", {
          repo: { repoId },
          payload: {},
        }),
      );
    } finally {
      for (const turn of fake.turns) turn.finish(0);
      await cell?.close();
      removeTempRepository(root);
    }
  },
);

test(
  "E2E-2: agy queue steer returns queued without SIGINT and smoothly degrades into follow-up turn after turn end",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-pr1-e2e2-"));
    const repoId = workspaceId("pr1-e2e2");
    const owner = withPolicyGroup(
      { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" as const },
      "admin",
    );
    const fake = createFakeAgyController();
    let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      initGitRepo(root);
      cell = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(root),
        ownerId: "pr1-e2e2-owner",
        runtimeDaemonRoute: {
          userRoot: path.join(root, ".daemon-user-root"),
          daemonId: "pr1-e2e2",
          endpoint: path.join(root, ".daemon.sock"),
        },
        runtimeInstances: () => [makeAgyInstance("agy-main")],
        prepareRuntimeLaunch: (instanceId, request) => ({
          definition: makeAgyDefinition(instanceId),
          installation: agyInstallation,
          protocolFamily: "agy",
          executablePath: agyInstallation.executablePath,
          args: ["--output-format", "stream-json", "--model", "gemini-4-neon"],
          env: {},
          cwd: request.cwd,
          prompt: request.prompt,
        }),
        runtimeLaunch: fake.launcher as never,
      });
      await installAgent(cell, owner, "neon-commander", "commander", "agy-main");

      const decisionRef = await acceptedWorkDecision(cell, owner, "pr1-e2e2");
      const workId = await createTask(cell, owner, owner, { title: "Work E2E-2", taskClass: "work", decisionRef });
      const taskId = await createTask(cell, owner, owner, { title: "AGY Queue Steer Task", parentTaskId: workId });

      const turn1Spawn = await cell.spawnRuntime(
        {
          agentId: "neon-commander",
          taskId,
          prompt: "Initial turn: plan A and B.",
          dispatchKey: "e2e2-turn-1",
        },
        owner,
      );
      assert.equal(turn1Spawn.outcome, "applied", JSON.stringify(turn1Spawn));
      assert.equal(fake.turns.length, 1);
      const turn1 = fake.turns[0]!;
      turn1.emitOutput(JSON.stringify({ event: "init", conversation_id: "agy-conv-1" }));
      turn1.emitOutput(
        JSON.stringify({
          event: "result",
          result: { status: "SUCCESS", response: "Turn 1 analyzed subpackages A and B." },
        }),
      );

      // Steer agy with --mode auto: must transparently route to queue without SIGINT/terminate
      const steer1 = await cell.steerRuntime(
        {
          taskId,
          mode: "auto",
          prompt: "仅做子包 A，跳过 B",
        },
        owner,
      );
      assert.equal(steer1.ok, true, JSON.stringify(steer1));
      assert.equal(steer1.outcome, "queued", JSON.stringify(steer1));
      assert.equal(steer1.mode, "queue");
      assert.equal(steer1.inboxId, `task:${taskId}`);
      assert.equal(typeof steer1.inboxItemId, "string");
      assert.equal(turn1.terminatedCount, 0, "queue steer must never SIGINT or terminate the running agy process");

      // Enqueue a second steer during Turn 1: both must batch into a single Turn 2 (at most 1 active continuation)
      const steer2 = await cell.steerRuntime(
        {
          taskId,
          mode: "queue",
          prompt: "补充子包 A 的边界测试",
        },
        owner,
      );
      assert.equal(steer2.outcome, "queued", JSON.stringify(steer2));
      assert.notEqual(steer2.inboxItemId, steer1.inboxItemId);
      assert.equal(turn1.terminatedCount, 0);

      // Explicit --mode interrupt on agy (steerSupported=false) must refuse cleanly
      await assert.rejects(
        () => cell!.steerRuntime({ taskId, mode: "interrupt", prompt: "force interrupt" }, owner),
        (error: unknown) => (error as { readonly code?: unknown }).code === "runtime_steer_unsupported",
      );
      assert.equal(turn1.terminatedCount, 0);

      // Let Turn 1 exit naturally -> daemon must consume pending steers via smooth-degradation fresh Turn 2
      turn1.finish(0);

      await waitForDurableCondition(() => fake.turns.length === 2);
      const turn2 = fake.turns[1]!;
      assert.equal(turn1.terminatedCount, 0, "Turn 1 exited naturally with zero forced kills");
      assert.equal(
        turn2.args.includes("--conversation"),
        false,
        "agy smooth-degradation branch starts a fresh turn without --conversation resume flag",
      );
      assert.match(turn2.prompt, /Previous Turn Summary/u);
      assert.match(turn2.prompt, /Turn 1 analyzed subpackages A and B/u);
      assert.match(turn2.prompt, /仅做子包 A，跳过 B/u);
      assert.match(turn2.prompt, /补充子包 A 的边界测试/u);

      // Verify both inbox items transitioned to completed with Turn 2's dispatchId
      await waitForDurableCondition(async () => {
        const collect = await cell!.run({ kind: "runtime-collect", taskId }, owner);
        const data = evidence(collect) as {
          readonly inbox: readonly {
            readonly itemId: string;
            readonly status: string;
            readonly completedByDispatchId: string | null;
          }[];
        };
        const items = data.inbox.filter(
          (item) => item.itemId === steer1.inboxItemId || item.itemId === steer2.inboxItemId,
        );
        return (
          items.length === 2 &&
          items.every((item) => item.status === "completed" && item.completedByDispatchId === turn2.dispatchId)
        );
      });

      turn2.finish(0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(fake.turns.length, 2, "at most one continuation turn must launch for the drained inbox batch");
    } finally {
      for (const turn of fake.turns) turn.finish(0);
      await cell?.close();
      removeTempRepository(root);
    }
  },
);

test(
  "E2E-3: active runtime report + incremental runtime collect --since and --wait-event",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-pr1-e2e3-"));
    const repoId = workspaceId("pr1-e2e3");
    const owner = withPolicyGroup(
      { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" as const },
      "admin",
    );
    const fake = createFakeAgyController();
    let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      initGitRepo(root);
      cell = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(root),
        ownerId: "pr1-e2e3-owner",
        runtimeDaemonRoute: {
          userRoot: path.join(root, ".daemon-user-root"),
          daemonId: "pr1-e2e3",
          endpoint: path.join(root, ".daemon.sock"),
        },
        runtimeInstances: () => [makeAgyInstance("agy-main")],
        prepareRuntimeLaunch: (instanceId, request) => ({
          definition: makeAgyDefinition(instanceId),
          installation: agyInstallation,
          protocolFamily: "agy",
          executablePath: agyInstallation.executablePath,
          args: ["--output-format", "stream-json", "--model", "gemini-4-neon"],
          env: {},
          cwd: request.cwd,
          prompt: request.prompt,
        }),
        runtimeLaunch: fake.launcher as never,
      });
      await installAgent(cell, owner, "neon-commander", "commander", "agy-main");

      const decisionRef = await acceptedWorkDecision(cell, owner, "pr1-e2e3");
      const workId = await createTask(cell, owner, owner, { title: "Work E2E-3", taskClass: "work", decisionRef });
      const parentTaskId = await createTask(cell, owner, owner, {
        title: "Commander Active Task",
        parentTaskId: workId,
      });
      const childA = await createTask(cell, owner, owner, { title: "Subpackage A", parentTaskId });
      const childB = await createTask(cell, owner, owner, { title: "Subpackage B", parentTaskId });

      // Start Commander runtime and keep it alive (not exited) during report & collect
      const spawned = await cell.spawnRuntime(
        {
          agentId: "neon-commander",
          taskId: parentTaskId,
          prompt: "Run and report milestones.",
          dispatchKey: "e2e3-commander",
        },
        owner,
      );
      assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
      const sessionId = String(spawned.runtimeSessionId);
      const commanderCredential = fake.turns[0]?.env.HARNESS_EXECUTION_CREDENTIAL;
      assert.ok(commanderCredential, "commander dispatch must inject HARNESS_EXECUTION_CREDENTIAL");
      const persisted = await authenticateRuntimeExecutionCredential(await policyTestCenter(), commanderCredential);
      assert.equal(persisted.role, "coordinator");
      const commanderBinding = withPolicyGroup(
        {
          actor: {
            principal: { personId: "person-owner" },
            executor: { kind: "agent" as const, id: `runtime-session:${sessionId}` },
          },
          source: "local" as const,
          executionPrincipal: persisted,
        },
        "admin",
      );

      // Report 1 from running Commander
      const rep1 = await cell.run(
        { kind: "runtime-report", taskId: parentTaskId, reportKind: "milestone", summary: "子包 A 已提交" },
        commanderBinding,
      );
      assert.equal(rep1.outcome, "applied", JSON.stringify(rep1));
      const rep1Data = evidence(rep1) as { readonly inboxId: string; readonly inboxItemId: string };
      assert.equal(rep1Data.inboxId, `task:${workId}`, "parent report notifies parent task inbox");

      // Start childA so it holds an active lease, then emit a blocker report -> notifies parent task:<parentTaskId> inbox
      const startedChildA = await cell.run({ kind: "task-start", taskId: childA }, owner);
      assert.equal(startedChildA.outcome, "applied", JSON.stringify(startedChildA));
      const childRep = await cell.run(
        { kind: "runtime-report", taskId: childA, reportKind: "blocker", summary: "等待契约字段确认" },
        owner,
      );
      assert.equal(childRep.outcome, "applied", JSON.stringify(childRep));
      assert.equal((evidence(childRep) as { readonly inboxId: string }).inboxId, `task:${parentTaskId}`);

      // Non-blocking collect while Commander is still running
      const collect1 = await cell.run({ kind: "runtime-collect", taskId: parentTaskId }, owner);
      assert.equal(collect1.outcome, "applied", JSON.stringify(collect1));
      const snap1 = evidence(collect1) as {
        readonly schema: string;
        readonly nextSince: number;
        readonly reports: readonly { readonly kind: string; readonly summary: string }[];
        readonly inbox: readonly { readonly source: string; readonly lane: string; readonly summary: string }[];
        readonly children: readonly { readonly taskId: string; readonly title: string; readonly status: string }[];
      };
      assert.equal(snap1.schema, "runtime-collect/v1");
      assert.equal(snap1.reports.length, 1);
      assert.equal(snap1.reports[0]!.kind, "milestone");
      assert.equal(snap1.reports[0]!.summary, "子包 A 已提交");
      assert.ok(snap1.inbox.some((item) => item.source === "runtime_report" && item.lane === "blocker"));
      assert.deepEqual(snap1.children.map((c) => c.taskId).sort(), [childA, childB].sort());

      // Collect by runtimeSessionId + --since cursor returns 0 old events before new report
      const emptyDelta = evidence(
        await cell.run({ kind: "runtime-collect", runtimeSessionId: sessionId, since: snap1.nextSince }, owner),
      ) as { readonly reports: readonly unknown[]; readonly inbox: readonly unknown[] };
      assert.equal(emptyDelta.reports.length, 0);
      assert.equal(emptyDelta.inbox.length, 0);

      // --wait-event wakes immediately when Report 2 arrives while process is still alive
      const waitingPromise = cell.run(
        {
          kind: "runtime-collect",
          taskId: parentTaskId,
          since: snap1.nextSince,
          waitEvent: true,
          timeoutMs: 3_000,
        },
        owner,
      );
      const report2 = await cell.run(
        { kind: "runtime-report", taskId: parentTaskId, reportKind: "converged", summary: "子包 A/B 均已收口" },
        commanderBinding,
      );
      assert.equal(report2.outcome, "applied", JSON.stringify(report2));

      const collect2 = await waitingPromise;
      assert.equal(collect2.outcome, "applied", JSON.stringify(collect2));
      const snap2 = evidence(collect2) as {
        readonly reports: readonly { readonly kind: string; readonly summary: string }[];
        readonly nextSince: number;
      };
      assert.equal(snap2.reports.length, 1, "incremental --since returns only the newly arrived report");
      assert.equal(snap2.reports[0]!.kind, "converged");
      assert.equal(snap2.reports[0]!.summary, "子包 A/B 均已收口");
      assert.ok(snap2.nextSince > snap1.nextSince);
    } finally {
      for (const turn of fake.turns) turn.finish(0);
      await cell?.close();
      removeTempRepository(root);
    }
  },
);

test(
  "E2E-4 (F-4D8B1F60): reviewer queue steer is rejected before enqueue and residual reviewer-bound items never leak into rework worker",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-pr1-f4d8b1f60-"));
    const repoId = workspaceId("pr1-f4d8b1f60");
    const owner = withPolicyGroup(
      { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" as const },
      "admin",
    );
    const fake = createFakeAgyController();
    let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      initGitRepo(root);
      cell = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(root),
        ownerId: "pr1-f4d8b1f60-owner",
        runtimeDaemonRoute: {
          userRoot: path.join(root, ".daemon-user-root"),
          daemonId: "pr1-f4d8b1f60",
          endpoint: path.join(root, ".daemon.sock"),
        },
        runtimeInstances: () => [makeAgyInstance("agy-main")],
        prepareRuntimeLaunch: (instanceId, request) => ({
          definition: makeAgyDefinition(instanceId),
          installation: agyInstallation,
          protocolFamily: "agy",
          executablePath: agyInstallation.executablePath,
          args: ["--output-format", "stream-json", "--model", "gemini-4-neon"],
          env: {},
          cwd: request.cwd,
          prompt: request.prompt,
        }),
        runtimeLaunch: fake.launcher as never,
      });
      await installAgent(cell, owner, "sol-worker", "worker", "agy-main");

      const decisionRef = await acceptedWorkDecision(cell, owner, "pr1-f4d8b1f60");
      const workId = await createTask(cell, owner, owner, { title: "Work F-4D8B1F60", taskClass: "work", decisionRef });
      const taskId = await createTask(cell, owner, owner, { title: "Reviewer Isolation Task", parentTaskId: workId });

      // 1. Direct contract proof on active & stopped reviewer dispatch: --mode auto and --mode queue MUST be rejected before enqueue.
      const reviewerDispatchId = "dispatch_c10000000000000000000001",
        reviewerSessionId = "runtime_c10000000000000000000001";
      openDispatchStream(root, {
        dispatchId: reviewerDispatchId,
        runtimeSessionId: reviewerSessionId,
        taskId,
        executionId: "exe_review_1",
        instanceId: "agy-main",
        kindId: "agy",
        model: "gemini-4-neon",
        agentId: "closeout-reviewer",
        role: "reviewer",
        cwd: root,
        startedAt: "2026-11-27T00:00:00.000Z",
        binding: { actor: owner.actor, source: "local" },
      });

      const activeReviewer = createActiveRuntime({
        process: {
          pid: 980_001,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: () => undefined,
        },
        dispatchId: reviewerDispatchId,
        runtimeSessionId: reviewerSessionId,
        dispatchOpId: "op-disp-reviewer-1",
        instanceId: "agy-main",
        kindId: "agy",
        resolvedProviderDirectory: null,
        permissionMode: "read-only",
        agent: { id: "closeout-reviewer", name: "Closeout Reviewer" },
        role: "reviewer",
        delegatedBy: null,
        squadId: null,
        publicationOwner: "runtime",
        parentRuntimeSessionId: null,
        binding: { actor: owner.actor, source: "local" },
        task: { taskId, executionId: "exe_review_1", leaseVersion: 1 },
        decisionReviewTarget: null,
        schedule: null,
        cwd: root,
        prompt: "Review submission.",
        onExitCommand: null,
        model: "gemini-4-neon",
        reasoningEffort: null,
        fast: false,
        tokenLimit: null,
        stallTimeoutMs: 60_000,
        lastProgressAtMs: Date.now(),
        startedAt: "2026-11-27T00:00:00.000Z",
        stream: {} as never,
        resumeProviderSessionId: null,
        providerSessionId: null,
      });

      let reviewerAlive = true;
      const storeAppends: unknown[] = [];
      const reviewerCtx = {
        input: {
          repoId,
          rootDir: root,
          now: () => "2026-11-27T00:05:00.000Z",
          schedule: () => undefined,
          store: () => ({
            readHead: () => ({ revision: 10 }),
            append: (entry: unknown) => {
              storeAppends.push(entry);
              return { revision: 11 };
            },
          }),
          projection: () => ({
            readDispatchLifecycle: () => ({
              status: "ready" as const,
              watermark: 10,
              sourceRevision: 10,
              rows: [
                {
                  attempt: {
                    dispatchId: reviewerDispatchId,
                    runtimeSessionId: reviewerSessionId,
                    kindId: "agy",
                    phase: reviewerAlive ? "running" : "settled",
                    process: reviewerAlive ? "alive" : "exited",
                    stopProof: reviewerAlive ? "none" : "proven_stopped",
                    outcome: reviewerAlive ? null : "succeeded",
                    fence: { verified: true, owner: "local" },
                  },
                  policy: {
                    processAlive: reviewerAlive,
                    canSteer: false,
                    attemptSettled: !reviewerAlive,
                    groupSettled: !reviewerAlive,
                  },
                  controlLeafDispatchId: reviewerDispatchId,
                },
              ],
            }),
          }),
        },
        processes: new Map([[reviewerSessionId, activeReviewer]]),
        requiredRuntimeStore: () => ({
          readHead: () => ({ revision: 10 }),
          append: (entry: unknown) => {
            storeAppends.push(entry);
            return { revision: 11 };
          },
        }),
        requiredRuntimeProjection: () => ({
          readDispatchLifecycle: () => ({
            status: "ready" as const,
            watermark: 10,
            sourceRevision: 10,
            rows: [
              {
                attempt: {
                  dispatchId: reviewerDispatchId,
                  runtimeSessionId: reviewerSessionId,
                  kindId: "agy",
                  phase: reviewerAlive ? "running" : "settled",
                  process: reviewerAlive ? "alive" : "exited",
                  stopProof: reviewerAlive ? "none" : "proven_stopped",
                  outcome: reviewerAlive ? null : "succeeded",
                  fence: { verified: true, owner: "local" },
                },
                policy: {
                  processAlive: reviewerAlive,
                  canSteer: false,
                  attemptSettled: !reviewerAlive,
                  groupSettled: !reviewerAlive,
                },
                controlLeafDispatchId: reviewerDispatchId,
              },
            ],
          }),
          readInbox: () => ({ status: "ready" as const, items: [] }),
        }),
        runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
      } as unknown as RuntimeSpawnerContext;

      // Active reviewer: --mode auto and --mode queue by dispatchId and taskId are all refused before enqueue.
      for (const payload of [
        { dispatchId: reviewerDispatchId, mode: "auto", prompt: "Reviewer steer auto" },
        { dispatchId: reviewerDispatchId, mode: "queue", prompt: "Reviewer steer queue" },
        { taskId, mode: "auto", prompt: "Reviewer task steer auto" },
        { taskId, mode: "queue", prompt: "Reviewer task steer queue" },
      ]) {
        await assert.rejects(() => steerRuntime(reviewerCtx, payload, { actor: owner.actor, source: "local" }), {
          code: "runtime_steer_unsupported",
        });
      }
      // Stopped reviewer: also refused before enqueue.
      reviewerAlive = false;
      await assert.rejects(
        () =>
          steerRuntime(
            reviewerCtx,
            { dispatchId: reviewerDispatchId, mode: "queue", prompt: "Stopped reviewer steer" },
            { actor: owner.actor, source: "local" },
          ),
        { code: "runtime_steer_unsupported" },
      );
      assert.equal(storeAppends.length, 0, "refused reviewer queue steer must leave zero pending inbox items");

      // enqueueQueuedSteer itself also enforces refusal for reviewer and read-only targets.
      await assert.rejects(
        () =>
          enqueueQueuedSteer(
            reviewerCtx,
            {
              taskId,
              prompt: "Direct enqueue to reviewer",
              dispatchId: reviewerDispatchId,
              runtimeSessionId: reviewerSessionId,
              agentId: "closeout-reviewer",
              role: "reviewer",
              permissionMode: "read-only",
              idempotencyKey: null,
            },
            { actor: owner.actor, source: "local" },
          ),
        { code: "runtime_steer_unsupported" },
      );

      // 2. Claim-side isolation proof: even if a legacy/residual reviewer-bound runtime_steer item exists in task:<taskId>,
      //    a subsequent rework worker turn on the same task MUST NOT claim or consume it!
      await cell.close();
      cell = undefined;
      const seedStore = makeTaskEventStore({ rootDir: canonicalRoot(root), repoId });
      const seedProjection = makeTaskProjection({ rootDir: canonicalRoot(root), eventStore: seedStore });
      seedProjection.catchUp();
      const rev = (seedStore.readHead()?.revision ?? 0) + 1;
      const residualEvent = compileInboxEnqueuedEvent({
        eventId: "event-residual-reviewer-steer",
        workspaceRevision: rev,
        opId: "op-residual-reviewer-steer",
        actor: owner.actor,
        source: "local",
        occurredAt: "2026-11-27T00:06:00.000Z",
        payload: {
          inboxId: `task:${taskId}`,
          itemId: "steer_residual_reviewer_1",
          source: "runtime_steer",
          sourceRef: `dispatch/${reviewerDispatchId}`,
          sourceEpoch: rev,
          dedupeKey: "runtime-steer:residual-reviewer-1",
          admission: "dispatchable",
          consumerKind: "unattended_dispatch",
          taskId,
          agentId: "closeout-reviewer",
          lane: "steer",
          correlationId: reviewerDispatchId,
          summary: "Stale instruction aimed at reviewer only",
          enqueuedAt: "2026-11-27T00:06:00.000Z",
        },
      });
      const residualPlan = canonicalEventWritePlan(residualEvent, "inbox", `task:${taskId}`);
      seedStore.append({ event: residualEvent, plan: residualPlan, blobs: [] });
      seedProjection.apply(residualEvent, residualPlan);

      // Direct consumer check: consumeQueuedSteersAfterTurn returns null for a rework worker trigger.
      const directClaimResult = await consumeQueuedSteersAfterTurn(
        {
          input: {
            repoId,
            rootDir: root,
            now: () => "2026-11-27T00:07:00.000Z",
            schedule: () => undefined,
            store: () => seedStore,
            projection: () => seedProjection,
          },
          processes: new Map(),
          requiredRuntimeStore: () => seedStore,
          requiredRuntimeProjection: () => seedProjection,
          spawnQueuedSteerTurn: async () => {
            throw new Error("should not spawn");
          },
          runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
        } as unknown as RuntimeSpawnerContext,
        {
          taskId,
          previousDispatchId: "dispatch_c20000000000000000000002",
          previousRuntimeSessionId: "runtime_c20000000000000000000002",
          previousKindId: "agy",
          previousProviderSessionId: null,
          previousAgentId: "sol-worker",
          previousRole: "worker",
          previousInstanceId: "agy-main",
          previousModel: "gemini-4-neon",
          previousPermissionMode: "bypass",
          previousMcpPolicy: null,
          previousFinalText: "Rework complete.",
          binding: { actor: owner.actor, source: "local" },
        },
      );
      assert.equal(directClaimResult, null);
      await seedStore.drain();

      // Reopen RepoCell, spawn a real rework worker turn on the same task, and let it finish cleanly.
      cell = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(root),
        ownerId: "pr1-f4d8b1f60-owner",
        runtimeDaemonRoute: {
          userRoot: path.join(root, ".daemon-user-root"),
          daemonId: "pr1-f4d8b1f60",
          endpoint: path.join(root, ".daemon.sock"),
        },
        runtimeInstances: () => [makeAgyInstance("agy-main")],
        prepareRuntimeLaunch: (instanceId, request) => ({
          definition: makeAgyDefinition(instanceId),
          installation: agyInstallation,
          protocolFamily: "agy",
          executablePath: agyInstallation.executablePath,
          args: ["--output-format", "stream-json", "--model", "gemini-4-neon"],
          env: {},
          cwd: request.cwd,
          prompt: request.prompt,
        }),
        runtimeLaunch: fake.launcher as never,
      });

      const reworkSpawn = await cell.spawnRuntime(
        {
          agentId: "sol-worker",
          taskId,
          prompt: "Rework implementation after review.",
          dispatchKey: "f4d8b1f60-rework-worker-1",
        },
        owner,
      );
      assert.equal(reworkSpawn.outcome, "applied", JSON.stringify(reworkSpawn));
      assert.equal(fake.turns.length, 1);
      const reworkSessionId = String(reworkSpawn.runtimeSessionId);
      const reworkTurn = fake.turns[0]!;
      reworkTurn.emitOutput(
        JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "Rework complete." } }),
      );
      reworkTurn.finish(0);

      // F-33B06E52: wait for authoritative terminal settlement and drain the serialized writer
      // queue (where scheduled turn-end steer consumers run) with zero wall-clock timers.
      await cell.awaitRuntimeOutcome(reworkSessionId);
      await waitForDurableCondition(() => cell!.status().queueDepth === 0);
      const drainFence = await cell.run({ kind: "todo-add", text: "drain-fence-after-rework-exit" }, owner);
      assert.equal(drainFence.outcome, "applied", JSON.stringify(drainFence));
      assert.equal(
        fake.turns.length,
        1,
        "rework worker must NEVER spawn a continuation consuming a reviewer-bound inbox item",
      );

      // Confirm via runtime-collect that the residual reviewer-bound item was never claimed/completed by the worker.
      const collectAfterRework = await cell.run({ kind: "runtime-collect", taskId }, owner);
      const collectData = evidence(collectAfterRework) as {
        readonly inbox: readonly {
          readonly itemId: string;
          readonly status: string;
          readonly completedByDispatchId: string | null;
        }[];
      };
      const residualRow = collectData.inbox.find((item) => item.itemId === "steer_residual_reviewer_1");
      assert.ok(residualRow, "residual item should remain visible in collect");
      assert.equal(residualRow.status, "pending", "residual reviewer item must not be claimed by rework worker");
      assert.equal(residualRow.completedByDispatchId, null);
    } finally {
      for (const turn of fake.turns) turn.finish(0);
      await cell?.close();
      removeTempRepository(root);
    }
  },
);
