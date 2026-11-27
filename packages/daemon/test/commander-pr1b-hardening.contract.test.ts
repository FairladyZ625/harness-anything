// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  type AgentDefinitionSnapshot,
  type AgentRuntimeEventV1,
  type AuthorizationDecision,
  type TaskProjection,
} from "@harness-anything/kernel";
import { compileInboxEnqueuedEvent } from "@harness-anything/kernel/internal/domain/agent-runtime-event.ts";
import { canonicalEventWritePlan, makeTaskEventStore, makeTaskProjection } from "@harness-anything/storage";
import type { RuntimeInstallationWitness, RuntimeInstanceSummary } from "../src/daemon-host/agent-runtime-instances.ts";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import {
  buildContinuationIdentityKey,
  consumeQueuedSteersAfterTurn,
  continuationIdentityMatches,
  enqueueQueuedSteer,
} from "../src/daemon-host/runtime-queued-steer.ts";
import type { RuntimeSpawnerContext } from "../src/daemon-host/runtime-spawn-context.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
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
  git(root, "config", "user.name", "Commander PR1B Hardening");
  git(root, "config", "user.email", "commander-pr1b@example.invalid");
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
  readonly cwd: string;
  readonly prompt: string;
  readonly args: readonly string[];
  readonly dispatchId: string;
  emitOutput: (line: string) => void;
  finish: (code: number) => void;
}

function createFakeAgyController() {
  const turns: FakeTurnHandle[] = [];
  let nextPid = 930_000;
  const launcher = (
    prepared: {
      readonly cwd: string;
      readonly args: readonly string[];
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
      cwd: prepared.cwd,
      prompt: prepared.prompt,
      args: [...prepared.args],
      dispatchId: persistence.dispatchId,
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
      terminate: () => handle.finish(null as unknown as number),
      liveDescendantPids: async () => ({ available: true as const, pids: [] as const }),
    };
  };
  return { turns, launcher };
}

async function installAgent(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  owner: ReturnType<typeof withPolicyGroup>,
  id: string,
  role: "commander" | "worker",
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
  owner: ReturnType<typeof withPolicyGroup>,
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
    owner,
  );
  assert.equal(res.outcome, "applied", JSON.stringify(res));
  await waitForFixturePublication(cell, res.opId, owner);
  const packagePath = String((res as Record<string, unknown>).packagePath);
  await realizeTaskPlanFixture(cell.status().rootDir, packagePath, async (planPath: string) => {
    const submitted = await cell.run({ kind: "doc-submit", paths: [planPath] }, owner);
    if (submitted.outcome === "applied") await waitForFixturePublication(cell, submitted.opId, owner);
    return submitted;
  });
  return String((res as Record<string, unknown>).taskId ?? (evidence(res) as { readonly taskId: string }).taskId);
}

function allowDecision(
  actor: { readonly principal: { readonly personId: string }; readonly executor: null },
  cut: string,
): AuthorizationDecision {
  return {
    policyRef: "default@5",
    actor,
    subject: "runtime-spawn",
    bindingsUsed: [],
    outcome: "allowed",
    reasonCodes: ["authorization_allowed"],
    nextActions: [],
    evaluatedAtCut: cut,
  };
}

function denyDecision(actor: {
  readonly principal: { readonly personId: string };
  readonly executor: null;
}): AuthorizationDecision {
  return {
    policyRef: "default@5",
    actor,
    subject: "runtime-spawn",
    bindingsUsed: [],
    outcome: "denied",
    reasonCodes: ["authorization_denied"],
    nextActions: ["Continuation policy denied this runtime spawn at current cut."],
    evaluatedAtCut: "canonical:current",
  };
}

test(
  "F-54C18D32 + Invariant #3: AGY fresh continuation preserves managed task worktree (cwd === task worktree !== repo root)",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-pr1b-agy-wt-"));
    const repoId = workspaceId("pr1b-agy-wt");
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
        ownerId: "pr1b-agy-wt-owner",
        runtimeDaemonRoute: {
          userRoot: path.join(root, ".daemon-user-root"),
          daemonId: "pr1b-agy-wt",
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
      await installAgent(cell, owner, "neon-worker", "worker", "agy-main");
      const decisionRef = await acceptedWorkDecision(cell, owner, "pr1b-agy-wt");
      const workId = await createTask(cell, owner, { title: "Worktree Work", taskClass: "work", decisionRef });
      const taskId = await createTask(cell, owner, { title: "AGY Code Task", parentTaskId: workId });

      // Materialize managed worktree via task-start
      const started = await cell.run({ kind: "task-start", taskId }, owner);
      assert.equal(started.outcome, "applied", JSON.stringify(started));
      const expectedWorktree = path.join(realpathSync(root), ".worktrees", taskId);
      assert.equal(existsSync(expectedWorktree), true, `expected managed worktree at ${expectedWorktree}`);

      // Turn 1: AGY launches inside managed task worktree
      const turn1Spawn = await cell.spawnRuntime(
        {
          agentId: "neon-worker",
          taskId,
          prompt: "Turn 1 inside worktree.",
          dispatchKey: "agy-wt-turn-1",
        },
        owner,
      );
      assert.equal(turn1Spawn.outcome, "applied", JSON.stringify(turn1Spawn));
      assert.equal(fake.turns.length, 1);
      const turn1 = fake.turns[0]!;
      assert.equal(realpathSync(turn1.cwd), expectedWorktree, "Turn 1 must execute in managed worktree");
      assert.notEqual(realpathSync(turn1.cwd), realpathSync(root));

      // Queue steer while Turn 1 is active
      const steer = await cell.steerRuntime(
        { taskId, mode: "queue", prompt: "Follow-up inside same worktree." },
        owner,
      );
      assert.equal(steer.outcome, "queued", JSON.stringify(steer));

      // End Turn 1 naturally -> AGY fresh continuation Turn 2 must stay in managed worktree!
      turn1.emitOutput(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "Turn 1 done." } }));
      turn1.finish(0);

      await waitForDurableCondition(() => fake.turns.length === 2);
      const turn2 = fake.turns[1]!;
      assert.equal(
        realpathSync(turn2.cwd),
        expectedWorktree,
        "F-54C18D32: AGY fresh continuation MUST preserve managed task worktree cwd",
      );
      assert.notEqual(
        realpathSync(turn2.cwd),
        realpathSync(root),
        "F-54C18D32: AGY fresh continuation MUST NEVER fall back to repository root checkout",
      );
      assert.match(turn2.prompt, /Follow-up inside same worktree\./u);
    } finally {
      for (const turn of fake.turns) turn.finish(0);
      await cell?.close();
      removeTempRepository(root);
    }
  },
);

test(
  "F-5A17B903: queued steer paginates past >50 mixed pending items, drains multi-turn lineage >50 steers, and rejects/settles frozen tasks",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-pr1b-f5a17-"));
    const repoId = workspaceId("pr1b-f5a17");
    const actor = { principal: { personId: "person-owner" }, executor: null } as const;
    const owner = withPolicyGroup({ actor, source: "local" as const }, "admin");
    let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      initGitRepo(root);
      cell = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(root),
        ownerId: "pr1b-f5a17-owner",
      });
      const decisionRef = await acceptedWorkDecision(cell, owner, "pr1b-f5a17");
      const workId = await createTask(cell, owner, { title: "Paging Work", taskClass: "work", decisionRef });
      const activeTaskId = await createTask(cell, owner, { title: "Paging Task", parentTaskId: workId });
      const frozenTaskId = await createTask(cell, owner, { title: "Cancelled Task", parentTaskId: workId });
      const cancelled = await cell.run(
        { kind: "task-transition", taskId: frozenTaskId, status: "cancelled", reason: "frozen test" },
        owner,
      );
      assert.equal(cancelled.outcome, "applied", JSON.stringify(cancelled));

      // 1. Enqueue into frozen/cancelled task MUST be refused BEFORE writing inbox item
      await assert.rejects(
        () => cell!.steerRuntime({ taskId: frozenTaskId, mode: "queue", prompt: "should reject" }, owner),
        (error: unknown) => (error as { readonly code?: unknown }).code === "runtime_steer_unsupported",
      );
      const frozenCollect = evidence(await cell.run({ kind: "runtime-collect", taskId: frozenTaskId }, owner)) as {
        readonly inbox: readonly unknown[];
      };
      assert.equal(frozenCollect.inbox.length, 0, "frozen task must not persist any queued steer item");

      await cell.close();
      cell = undefined;

      // 2. Direct store/projection test for >50 mixed pending items + >50 matching steers across D1 -> D2 lineage
      const store = makeTaskEventStore({ repoId, rootDir: canonicalRoot(root) });
      const projection = makeTaskProjection({ rootDir: canonicalRoot(root), eventStore: store });
      try {
        const inboxId = `task:${activeTaskId}`;
        const d1 = "dispatch_d10000000000000000000001";
        const d2 = "dispatch_d20000000000000000000002";
        const d3 = "dispatch_d30000000000000000000003";
        let rev = store.readHead()?.revision ?? 0;

        // Seed 55 non-matching pending items first (child runtime_report items on unattended_dispatch)
        for (let i = 0; i < 55; i += 1) {
          rev += 1;
          const ev = compileInboxEnqueuedEvent({
            eventId: `event-noise-${i}`,
            workspaceRevision: rev,
            opId: `op-noise-${i}`,
            actor,
            source: "local",
            occurredAt: "2026-11-27T01:00:00.000Z",
            payload: {
              inboxId,
              itemId: `report_noise_${String(i).padStart(3, "0")}`,
              source: "runtime_report",
              sourceRef: `task/child_${i}/milestone`,
              sourceEpoch: rev,
              dedupeKey: `noise:${i}`,
              admission: "dispatchable",
              consumerKind: "unattended_dispatch",
              taskId: activeTaskId,
              agentId: null,
              lane: "milestone",
              summary: `Noise report ${i}`,
              enqueuedAt: "2026-11-27T01:00:00.000Z",
            },
          });
          const plan = canonicalEventWritePlan(ev, "inbox", inboxId);
          store.append({ event: ev, plan, blobs: [] });
          projection.apply(ev, plan);
        }

        // Now seed 55 matching runtime_steer items targeting dispatch/d1 (sitting BEHIND the 55 noise items!)
        for (let i = 0; i < 55; i += 1) {
          rev += 1;
          const ev = compileInboxEnqueuedEvent({
            eventId: `event-steer-${i}`,
            workspaceRevision: rev,
            opId: `op-steer-${i}`,
            actor,
            source: "local",
            occurredAt: "2026-11-27T01:01:00.000Z",
            payload: {
              inboxId,
              itemId: `steer_match_${String(i).padStart(3, "0")}`,
              source: "runtime_steer",
              sourceRef: `dispatch/${d1}`,
              sourceEpoch: rev,
              dedupeKey: `steer-match:${i}`,
              admission: "dispatchable",
              consumerKind: "unattended_dispatch",
              taskId: activeTaskId,
              agentId: "neon-worker",
              lane: "steer",
              summary: `Matching steer ${i}`,
              enqueuedAt: "2026-11-27T01:01:00.000Z",
            },
          });
          const plan = canonicalEventWritePlan(ev, "inbox", inboxId);
          store.append({ event: ev, plan, blobs: [] });
          projection.apply(ev, plan);
        }

        const spawnedPayloads: Record<string, unknown>[] = [];
        const dispatchKeyByDispatchId = new Map<string, string>();
        const wrappedProjection: TaskProjection = {
          ...projection,
          readRuntimeDispatchById: (dispatchId) => {
            const key = dispatchKeyByDispatchId.get(dispatchId);
            if (!key) return projection.readRuntimeDispatchById(dispatchId);
            return {
              event: {
                schema: "agent-runtime-event/v1",
                type: "runtime_dispatch_requested",
                eventId: `ev-${dispatchId}`,
                workspaceRevision: rev,
                opId: `op-${dispatchId}`,
                actor,
                source: "local",
                occurredAt: "2026-11-27T01:02:00.000Z",
                payload: {
                  dispatchId,
                  dispatchKey: key,
                  runtimeSessionId: `session_${dispatchId}`,
                  taskId: activeTaskId,
                  kindId: "agy",
                  instanceId: "agy-main",
                  definitionSnapshot: makeAgyDefinition("agy-main"),
                },
              } as unknown as Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>,
              metrics: null,
              endedAt: null,
              outcome: "succeeded",
            };
          },
        };

        const context = {
          input: {
            repoId,
            rootDir: canonicalRoot(root),
            now: () => "2026-11-27T01:05:00.000Z",
            authorizeRuntimeContinuation: async (_payload: unknown, b: Record<string, unknown>) => ({
              ...b,
              authorizationDecision: allowDecision(actor, "canonical:fresh"),
            }),
          },
          processes: new Map(),
          queuedSteerInFlight: new Set<string>(),
          requiredRuntimeStore: () => store,
          requiredRuntimeProjection: () => wrappedProjection,
          runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
          spawnQueuedSteerTurn: async (payload: Record<string, unknown>) => {
            spawnedPayloads.push(payload);
            const nextDispatch = spawnedPayloads.length === 1 ? d2 : d3;
            dispatchKeyByDispatchId.set(nextDispatch, String(payload.dispatchKey));
            return { dispatchId: nextDispatch };
          },
        } as unknown as RuntimeSpawnerContext;

        // Turn 1 (d1) ends -> paginates past all 55 noise items and claims matching steers #0..#49!
        const res1 = await consumeQueuedSteersAfterTurn(context, {
          taskId: activeTaskId,
          previousDispatchId: d1,
          previousRuntimeSessionId: "runtime_d1",
          previousKindId: "agy",
          previousProviderSessionId: null,
          previousAgentId: "neon-worker",
          previousRole: "worker",
          previousInstanceId: "agy-main",
          previousModel: "gemini-4-neon",
          previousPermissionMode: "bypass",
          previousMcpPolicy: null,
          previousFinalText: "Turn 1 done",
          binding: { actor, source: "local" },
        });
        assert.ok(res1, "Turn 1 must find matching steers beyond page 1");
        assert.equal(res1.spawnedDispatchId, d2);
        assert.equal(res1.consumedItemIds.length, 50);

        // Turn 2 (d2, carrying lineage dispatchKey queued-steer:d1:...) ends -> claims remaining steers #50..#54!
        const res2 = await consumeQueuedSteersAfterTurn(context, {
          taskId: activeTaskId,
          previousDispatchId: d2,
          previousRuntimeSessionId: "runtime_d2",
          previousKindId: "agy",
          previousProviderSessionId: null,
          previousAgentId: "neon-worker",
          previousRole: "worker",
          previousInstanceId: "agy-main",
          previousModel: "gemini-4-neon",
          previousPermissionMode: "bypass",
          previousMcpPolicy: null,
          previousFinalText: "Turn 2 done",
          binding: { actor, source: "local" },
        });
        assert.ok(res2, "Turn 2 must track lineage back to d1 and consume items 51..55");
        assert.equal(res2.spawnedDispatchId, d3);
        assert.equal(res2.consumedItemIds.length, 5);
        assert.equal(new Set([...res1.consumedItemIds, ...res2.consumedItemIds]).size, 55);

        // 3. Task becomes terminal after steer was enqueued -> consume settles pending steer to dropped_stale(target_terminal)
        const pendingBeforeFreeze = enqueueQueuedSteer(
          context,
          {
            taskId: activeTaskId,
            prompt: "Late steer before freeze",
            dispatchId: d3,
            runtimeSessionId: "runtime_d3",
            agentId: "neon-worker",
            idempotencyKey: "late-before-freeze",
          },
          { actor, source: "local" },
        );
        const frozenProjection: TaskProjection = {
          ...wrappedProjection,
          read: (id) => {
            const read = wrappedProjection.read(id);
            if (id !== activeTaskId || !read.snapshot.task) return read;
            return {
              ...read,
              snapshot: {
                ...read.snapshot,
                task: { ...read.snapshot.task, status: "submitted" },
              },
            };
          },
        };
        const frozenCtx = { ...context, requiredRuntimeProjection: () => frozenProjection } as RuntimeSpawnerContext;
        const afterFreeze = await consumeQueuedSteersAfterTurn(frozenCtx, {
          taskId: activeTaskId,
          previousDispatchId: d3,
          previousRuntimeSessionId: "runtime_d3",
          previousKindId: "agy",
          previousProviderSessionId: null,
          previousAgentId: "neon-worker",
          previousRole: "worker",
          previousInstanceId: "agy-main",
          previousModel: "gemini-4-neon",
          previousPermissionMode: "bypass",
          previousMcpPolicy: null,
          previousFinalText: "Turn 3 done",
          binding: { actor, source: "local" },
        });
        assert.equal(afterFreeze, null);
        const settledItem = projection.readInbox({
          by: "item",
          inboxId,
          itemId: pendingBeforeFreeze.inboxItemId,
        });
        assert.equal(settledItem.status, "ready");
        assert.equal(settledItem.items[0]?.status, "dropped_stale");
        assert.equal(settledItem.items[0]?.settlementReason, "target_terminal");
      } finally {
        projection.close();
        await store.drain();
      }
    } finally {
      await cell?.close();
      removeTempRepository(root);
    }
  },
);

test(
  "F-32C1E68D + Invariant #4 + Invariant #5: queued continuation re-authorizes at current cut, forbids employee-swap --resume, and audits --resume -> fresh downgrade",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-pr1b-auth-inv-"));
    const repoId = workspaceId("pr1b-auth-inv");
    const actor = { principal: { personId: "person-owner" }, executor: null } as const;
    const owner = withPolicyGroup({ actor, source: "local" as const }, "admin");
    let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      initGitRepo(root);
      cell = await openRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "pr1b-auth-inv-owner" });
      const decisionRef = await acceptedWorkDecision(cell, owner, "pr1b-auth-inv");
      const workId = await createTask(cell, owner, { title: "Auth Work", taskClass: "work", decisionRef });
      const taskId = await createTask(cell, owner, { title: "Auth Task", parentTaskId: workId });
      await cell.close();
      cell = undefined;

      const store = makeTaskEventStore({ repoId, rootDir: canonicalRoot(root) });
      const projection = makeTaskProjection({ rootDir: canonicalRoot(root), eventStore: store });
      try {
        const inboxId = `task:${taskId}`;
        const prevDispatch = "dispatch_a10000000000000000000001";
        const staleAllow = allowDecision(actor, "canonical:stale-1");

        // Identity helper sanity check (Invariant #4)
        assert.equal(
          continuationIdentityMatches(
            buildContinuationIdentityKey({ employeeId: "sol", taskId, dispatchLineage: prevDispatch }),
            buildContinuationIdentityKey({ employeeId: "neon", taskId, dispatchLineage: prevDispatch }),
          ),
          false,
        );

        // Case A (F-32C1E68D): stale trigger.binding.authorizationDecision is ignored; denial writes inbox_item_failed
        let authCalls = 0;
        let spawnCalls = 0;
        const baseCtx = {
          input: {
            repoId,
            rootDir: canonicalRoot(root),
            now: () => "2026-11-27T02:00:00.000Z",
            authorizeRuntimeContinuation: async (_payload: unknown, b: Record<string, unknown>) => {
              authCalls += 1;
              assert.equal(
                b.authorizationDecision,
                undefined,
                "stale trigger.binding.authorizationDecision must be stripped before re-authorization",
              );
              return { ...b, authorizationDecision: denyDecision(actor) };
            },
          },
          processes: new Map(),
          queuedSteerInFlight: new Set<string>(),
          requiredRuntimeStore: () => store,
          requiredRuntimeProjection: () => projection,
          runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
          spawnQueuedSteerTurn: async () => {
            spawnCalls += 1;
            return { dispatchId: "dispatch_never" };
          },
        } as unknown as RuntimeSpawnerContext;

        const q1 = enqueueQueuedSteer(
          baseCtx,
          {
            taskId,
            prompt: "Denied continuation steer",
            dispatchId: prevDispatch,
            runtimeSessionId: "runtime_a1",
            agentId: "sol-worker",
            idempotencyKey: "auth-deny-1",
          },
          { actor, source: "local" },
        );

        await assert.rejects(
          () =>
            consumeQueuedSteersAfterTurn(baseCtx, {
              taskId,
              previousDispatchId: prevDispatch,
              previousRuntimeSessionId: "runtime_a1",
              previousKindId: "codex",
              previousProviderSessionId: "prov_sess_1",
              previousAgentId: "sol-worker",
              previousRole: "worker",
              previousInstanceId: "codex-main",
              previousModel: "gpt-5.4",
              previousPermissionMode: "bypass",
              previousMcpPolicy: null,
              previousFinalText: null,
              binding: { actor, source: "local", authorizationDecision: staleAllow },
            }),
          (error: unknown) => (error as { readonly code?: unknown }).code === "authorization_denied",
        );
        assert.equal(authCalls, 1);
        assert.equal(spawnCalls, 0);
        const deniedRow = projection.readInbox({ by: "item", inboxId, itemId: q1.inboxItemId });
        assert.equal(deniedRow.status, "ready");
        assert.equal(deniedRow.items[0]?.status, "failed");
        assert.equal(deniedRow.items[0]?.settlementReason, "authorization_denied");

        // Case B (Invariant #4): task slot switched employee (arrangement.agentId = "neon-worker" !== previous "sol-worker")
        // -> --resume MUST be forbidden and item settled to failed(unattended_handoff_packet_missing)
        const q2 = enqueueQueuedSteer(
          baseCtx,
          {
            taskId,
            prompt: "Employee swapped steer",
            dispatchId: prevDispatch,
            runtimeSessionId: "runtime_a1",
            agentId: "sol-worker",
            idempotencyKey: "emp-swap-1",
          },
          { actor, source: "local" },
        );
        const swappedProjection: TaskProjection = {
          ...projection,
          read: (id) => {
            const read = projection.read(id);
            if (id !== taskId || !read.snapshot.task) return read;
            const iteration = read.snapshot.task.iteration;
            return {
              ...read,
              snapshot: {
                ...read.snapshot,
                task: {
                  ...read.snapshot.task,
                  executionArrangement: {
                    id: "arr_swap_1",
                    executionId: "exe_prev_swap_1",
                    iteration,
                    submissionDigest: "sha256:" + "a".repeat(64),
                    actor,
                    source: "local",
                    reason: "employee swap takeover",
                    agentId: "neon-worker",
                    ready: true,
                  },
                },
                executions: [
                  ...read.snapshot.executions,
                  {
                    schema: "execution/v1",
                    executionId: "exe_prev_swap_1",
                    iteration,
                    state: "changes_requested",
                    startedAt: "2026-11-27T02:00:00.000Z",
                    startedBy: actor,
                  },
                ],
              } as typeof read.snapshot,
            };
          },
        };
        let swapSpawnCalls = 0;
        const swapCtx = {
          ...baseCtx,
          requiredRuntimeProjection: () => swappedProjection,
          input: {
            ...baseCtx.input,
            authorizeRuntimeContinuation: async (_p: unknown, b: Record<string, unknown>) => ({
              ...b,
              authorizationDecision: allowDecision(actor, "canonical:fresh-swap"),
            }),
          },
          spawnQueuedSteerTurn: async () => {
            swapSpawnCalls += 1;
            return { dispatchId: "dispatch_swap_never" };
          },
        } as unknown as RuntimeSpawnerContext;
        await assert.rejects(
          () =>
            consumeQueuedSteersAfterTurn(swapCtx, {
              taskId,
              previousDispatchId: prevDispatch,
              previousRuntimeSessionId: "runtime_a1",
              previousKindId: "codex",
              previousProviderSessionId: "prov_sess_1",
              previousAgentId: "sol-worker",
              previousRole: "worker",
              previousInstanceId: "codex-main",
              previousModel: "gpt-5.4",
              previousPermissionMode: "bypass",
              previousMcpPolicy: null,
              previousFinalText: null,
              binding: { actor, source: "local" },
            }),
          (error: unknown) => (error as { readonly code?: unknown }).code === "unattended_handoff_packet_missing",
        );
        assert.equal(swapSpawnCalls, 0, "employee swap on same task slot must forbid direct --resume");
        const swapRow = projection.readInbox({ by: "item", inboxId, itemId: q2.inboxItemId });
        assert.equal(swapRow.status, "ready");
        assert.equal(swapRow.items[0]?.status, "failed");
        assert.equal(swapRow.items[0]?.settlementReason, "unattended_handoff_packet_missing");

        // Case C (Invariant #5): --resume throws runtime_resume_failed -> writes immutable canonical audit event and degrades to fresh
        const q3 = enqueueQueuedSteer(
          baseCtx,
          {
            taskId,
            prompt: "Steer triggering resume failure downgrade",
            dispatchId: prevDispatch,
            runtimeSessionId: "runtime_a1",
            agentId: "sol-worker",
            idempotencyKey: "resume-downgrade-1",
          },
          { actor, source: "local" },
        );
        const attempts: Record<string, unknown>[] = [];
        let freshAuthCount = 0;
        const downgradeCtx = {
          ...baseCtx,
          input: {
            ...baseCtx.input,
            authorizeRuntimeContinuation: async (_p: unknown, b: Record<string, unknown>) => {
              freshAuthCount += 1;
              return { ...b, authorizationDecision: allowDecision(actor, `canonical:fresh-${freshAuthCount}`) };
            },
          },
          spawnQueuedSteerTurn: async (
            payload: Record<string, unknown>,
            b: { authorizationDecision?: AuthorizationDecision },
          ) => {
            attempts.push(payload);
            assert.equal(b.authorizationDecision?.outcome, "allowed");
            if (attempts.length === 1) {
              assert.equal(payload.dispatchId, prevDispatch, "first attempt must try --resume");
              throw Object.assign(new Error("provider session expired"), { code: "runtime_resume_failed" });
            }
            assert.equal(payload.dispatchId, undefined, "degraded fallback must be a fresh turn");
            return { dispatchId: "dispatch_fresh_fallback_1" };
          },
        } as unknown as RuntimeSpawnerContext;

        const downgradeRes = await consumeQueuedSteersAfterTurn(downgradeCtx, {
          taskId,
          previousDispatchId: prevDispatch,
          previousRuntimeSessionId: "runtime_a1",
          previousKindId: "codex",
          previousProviderSessionId: "prov_sess_2",
          previousAgentId: "sol-worker",
          previousRole: "worker",
          previousInstanceId: "codex-main",
          previousModel: "gpt-5.4",
          previousPermissionMode: "bypass",
          previousMcpPolicy: null,
          previousFinalText: "Prior turn summary before resume failed.",
          binding: { actor, source: "local" },
        });
        assert.ok(downgradeRes);
        assert.equal(downgradeRes.degraded, true);
        assert.equal(downgradeRes.downgradedFromResume, true);
        assert.ok(downgradeRes.downgradeAuditItemId, "must emit an immutable audit item id");
        assert.equal(attempts.length, 2);
        assert.equal(freshAuthCount, 2, "both resume and fresh fallback must authorize at current cut");

        const auditRead = projection.readInbox({
          by: "item",
          inboxId,
          itemId: downgradeRes.downgradeAuditItemId!,
        });
        assert.equal(auditRead.status, "ready");
        assert.equal(auditRead.items.length, 1);
        assert.equal(auditRead.items[0]?.source, "runtime_report");
        assert.equal(auditRead.items[0]?.lane, "resume_downgrade");
        assert.match(auditRead.items[0]?.summary ?? "", /runtime_resume_failed/u);
        assert.match(auditRead.items[0]?.summary ?? "", /downgraded=fresh/u);

        const q3Settled = projection.readInbox({ by: "item", inboxId, itemId: q3.inboxItemId });
        assert.equal(q3Settled.status, "ready");
        assert.equal(q3Settled.items[0]?.status, "completed");
        assert.equal(q3Settled.items[0]?.completedByDispatchId, "dispatch_fresh_fallback_1");
      } finally {
        projection.close();
        await store.drain();
      }
    } finally {
      await cell?.close();
      removeTempRepository(root);
    }
  },
);
