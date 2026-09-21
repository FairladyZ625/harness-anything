// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, type AgentDefinitionSnapshot } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { operationId } from "../src/repo-cell-proof.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";

const settlementActor = {
  actor: { principal: { personId: "schedule-settlement-operator" }, executor: null },
  source: "local" as const,
};
const settlementRuntimeDefinition: AgentDefinitionSnapshot = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: "codex-schedule-settlement",
  installationId: "installation-schedule-settlement",
  kindId: "codex",
  providerId: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  baseUrl: null,
  authMode: "subscription",
};

test("runtime attempt-terminal asynchronously settles the claimed Schedule occurrence", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-schedule-runtime-settlement-")),
    repoId = workspaceId("schedule-runtime-settlement"),
    scheduleId = "settlement-probe";
  let output: ((chunk: string) => void) | null = null,
    exit: ((code: number | null) => void) | null = null;
  const prompts: string[] = [];
  try {
    git(root, "init", "-q");
    git(root, "config", "user.name", "Schedule Settlement Test");
    git(root, "config", "user.email", "schedule-settlement@example.invalid");
    git(root, "commit", "--allow-empty", "-qm", "base");
    const writerStateRoot = path.join(root, ".daemon", "fleet"),
      holderId = "schedule-settlement-test",
      writerEpoch = openPersistentWriterEpoch({ stateRoot: writerStateRoot, holderId }),
      lease = writerEpoch.acquire(repoId);
    writerEpoch.close();
    const cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(root),
      ownerId: holderId,
      defaultWriterEpochFence: {
        schema: "harness-writer-epoch-fence/v1",
        stateRoot: writerStateRoot,
        repoId,
        epoch: lease.epoch,
        holderId,
      },
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon"),
        daemonId: "schedule-settlement-test",
        endpoint: path.join(root, ".daemon", "daemon.sock"),
      },
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: settlementRuntimeDefinition.instanceId,
          name: "Schedule Settlement Codex",
          kindId: settlementRuntimeDefinition.kindId,
          installationId: settlementRuntimeDefinition.installationId,
          providerId: settlementRuntimeDefinition.providerId,
          models: [settlementRuntimeDefinition.model],
          defaultModel: settlementRuntimeDefinition.model,
          enabled: true,
          permissionMode: "workspace-write",
          codex: {},
          authMode: settlementRuntimeDefinition.authMode,
          authState: "configured",
          authReadiness: { status: "ready", code: null, hint: null },
          isolationState: "enforced",
        },
      ],
      prepareRuntimeLaunch: async (_instanceId, request) => {
        prompts.push(request.prompt);
        return {
          definition: settlementRuntimeDefinition,
          installation: {
            installationId: settlementRuntimeDefinition.installationId,
            kindId: settlementRuntimeDefinition.kindId,
            executablePath: "/opt/test/codex",
            version: "1.0.0",
            observedAt: "2026-08-27T00:00:00.000Z",
          },
          executablePath: "/opt/test/codex",
          args: [],
          env: {},
          cwd: request.cwd,
          prompt: request.prompt,
        };
      },
      runtimeLaunch: () => ({
        pid: 4343,
        onOutput: (listener) => {
          output = listener;
        },
        onErrorOutput: () => undefined,
        onExit: (listener) => {
          exit = listener;
        },
        terminate: () => undefined,
      }),
    });
    try {
      assert.equal(
        (
          await cell.run(
            {
              kind: "agent-install",
              declaration: {
                schema: "agent-declaration/v1",
                id: "settlement-agent",
                name: "Settlement Agent",
                instructions: "Complete the Schedule settlement probe.",
                runtimes: [{ type: "codex" }],
              },
            },
            settlementActor,
          )
        ).outcome,
        "applied",
      );
      assert.equal(
        (
          await cell.run(
            {
              kind: "schedule-create",
              scheduleId,
              name: "Settlement probe",
              mode: "detect",
              everyMs: 300_000,
              agentId: "settlement-agent",
              runtimeInstanceId: settlementRuntimeDefinition.instanceId,
              mission: "Finish successfully so the occurrence can settle.",
              idempotencyKey: "create-settlement-probe",
            },
            settlementActor,
          )
        ).outcome,
        "applied",
      );
      const started = await cell.run(
        { kind: "schedule-run-now", scheduleId, idempotencyKey: "run-settlement-probe" },
        settlementActor,
      );
      assert.equal(started.outcome, "applied", JSON.stringify(started));
      const inFlight = await listedSettlementSchedule(cell, scheduleId),
        dispatchId = inFlight.status.activeRun?.dispatchId,
        runtimeSessionId = inFlight.status.activeRun?.runtimeSessionId;
      assert.equal(typeof dispatchId, "string");
      assert.equal(typeof runtimeSessionId, "string");
      assert.equal(inFlight.status.lastRun, null);

      output?.(
        `${JSON.stringify({ type: "thread.started", thread_id: "schedule-settlement" })}\n` +
          `${JSON.stringify({ type: "item.completed", item: { id: "write", type: "file_change", status: "completed" } })}\n` +
          `${JSON.stringify({
            type: "item.completed",
            item: {
              id: "message",
              type: "agent_message",
              text: "not completed\n\nHARNESS-OUTCOME: failed",
            },
          })}\n` +
          `${JSON.stringify({ type: "turn.completed" })}\n`,
      );
      exit?.(0);

      const settled = await eventuallyAsync(async () => {
        const schedule = await listedSettlementSchedule(cell, scheduleId);
        return schedule.status.activeRun === null && schedule.status.lastRun?.outcome === "failed";
      });
      assert.equal(settled, true);
      assert.equal(prompts[0]?.endsWith("HARNESS-OUTCOME: failed"), true);
      const events = makeTaskEventStore({ repoId, rootDir: root }).read().events,
        claimIndex = events.findIndex((event) => event.type === "schedule_occurrence_claimed"),
        dispatchIndex = events.findIndex((event) => event.type === "runtime_dispatch_requested"),
        terminalIndex = events.findIndex((event) => event.type === "runtime_session_outcome_observed"),
        settleIndex = events.findIndex((event) => event.type === "schedule_run_settled"),
        settlement = events[settleIndex];
      assert.equal(claimIndex < dispatchIndex && dispatchIndex < terminalIndex && terminalIndex < settleIndex, true);
      assert.equal(
        settlement?.opId,
        operationId(
          {
            kind: "schedule-settle",
            scheduleId,
            idempotencyKey: `${runtimeSessionId}:attempt-terminal`,
          },
          settlementActor,
          repoId,
          0,
        ),
      );
      assert.equal(settlement?.type === "schedule_run_settled" && settlement.payload.schedule.status.activeRun, null);
      assert.equal(
        settlement?.type === "schedule_run_settled" && settlement.payload.schedule.status.lastRun?.runtimeSessionId,
        runtimeSessionId,
      );

      await runOccurrence(cell, scheduleId, "run-success-verdict", "done\nHARNESS-OUTCOME: succeeded", "succeeded", {
        output: () => output,
        exit: () => exit,
      });
      await runOccurrence(cell, scheduleId, "run-missing-verdict", "done", "unknown", {
        output: () => output,
        exit: () => exit,
      });
    } finally {
      await cell.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function runOccurrence(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  scheduleId: string,
  idempotencyKey: string,
  finalText: string,
  expectedOutcome: string,
  callbacks: {
    readonly output: () => ((chunk: string) => void) | null;
    readonly exit: () => ((code: number | null) => void) | null;
  },
): Promise<void> {
  const started = await cell.run({ kind: "schedule-run-now", scheduleId, idempotencyKey }, settlementActor);
  assert.equal(started.outcome, "applied", JSON.stringify(started));
  callbacks.output()?.(
    `${JSON.stringify({ type: "thread.started", thread_id: idempotencyKey })}\n` +
      `${JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: finalText } })}\n` +
      `${JSON.stringify({ type: "turn.completed" })}\n`,
  );
  callbacks.exit()?.(0);
  assert.equal(
    await eventuallyAsync(async () => {
      const schedule = await listedSettlementSchedule(cell, scheduleId);
      return schedule.status.activeRun === null && schedule.status.lastRun?.outcome === expectedOutcome;
    }),
    true,
  );
}

async function listedSettlementSchedule(cell: Awaited<ReturnType<typeof openRepoCell>>, scheduleId: string) {
  const listed = (await cell.run({ kind: "schedule-list" }, settlementActor)) as unknown as {
    readonly schedules: readonly {
      readonly scheduleId: string;
      readonly status: {
        readonly activeRun: { readonly dispatchId?: string; readonly runtimeSessionId?: string } | null;
        readonly lastRun: { readonly outcome: string; readonly runtimeSessionId?: string } | null;
      };
    }[];
  };
  return listed.schedules.find((schedule) => schedule.scheduleId === scheduleId)!;
}

async function eventuallyAsync(check: () => Promise<boolean>): Promise<boolean> {
  for (let index = 0; index < 100; index += 1) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

const actor = {
  actor: { principal: { personId: "latched-settlement-operator" }, executor: null },
  source: "local" as const,
};
const definition: AgentDefinitionSnapshot = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: "codex-latched-settlement",
  installationId: "installation-latched-settlement",
  kindId: "codex",
  providerId: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  baseUrl: null,
  authMode: "subscription",
};

test("runtime attempt-terminal settles the Schedule occurrence while the RepoCell is latched", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-schedule-latched-settlement-")),
    repoId = workspaceId("schedule-latched-settlement"),
    scheduleId = "latched-settlement-probe";
  let output: ((chunk: string) => void) | null = null,
    exit: ((code: number | null) => void) | null = null;
  try {
    git(root, "init", "-q");
    git(root, "config", "user.name", "Latched Settlement Test");
    git(root, "config", "user.email", "latched-settlement@example.invalid");
    git(root, "commit", "--allow-empty", "-qm", "base");
    const writerStateRoot = path.join(root, ".daemon", "fleet"),
      holderId = "latched-settlement-test",
      writerEpoch = openPersistentWriterEpoch({ stateRoot: writerStateRoot, holderId }),
      lease = writerEpoch.acquire(repoId);
    writerEpoch.close();
    const cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(root),
      ownerId: holderId,
      defaultWriterEpochFence: {
        schema: "harness-writer-epoch-fence/v1",
        stateRoot: writerStateRoot,
        repoId,
        epoch: lease.epoch,
        holderId,
      },
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon"),
        daemonId: "latched-settlement-test",
        endpoint: path.join(root, ".daemon", "daemon.sock"),
      },
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: definition.instanceId,
          name: "Latched Settlement Codex",
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
        installation: {
          installationId: definition.installationId,
          kindId: definition.kindId,
          executablePath: "/opt/test/codex",
          version: "1.0.0",
          observedAt: "2026-08-27T00:00:00.000Z",
        },
        executablePath: "/opt/test/codex",
        args: [],
        env: {},
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      runtimeLaunch: () => ({
        pid: 4343,
        onOutput: (listener) => {
          output = listener;
        },
        onErrorOutput: () => undefined,
        onExit: (listener) => {
          exit = listener;
        },
        terminate: () => undefined,
      }),
    });
    try {
      assert.equal(
        (
          await cell.run(
            {
              kind: "agent-install",
              declaration: {
                schema: "agent-declaration/v1",
                id: "latched-settlement-agent",
                name: "Latched Settlement Agent",
                instructions: "Complete the latched Schedule settlement probe.",
                runtimes: [{ type: "codex" }],
              },
            },
            actor,
          )
        ).outcome,
        "applied",
      );
      assert.equal(
        (
          await cell.run(
            {
              kind: "schedule-create",
              scheduleId,
              name: "Latched settlement probe",
              mode: "detect",
              everyMs: 300_000,
              agentId: "latched-settlement-agent",
              runtimeInstanceId: definition.instanceId,
              mission: "Finish successfully so the latched occurrence can settle.",
              idempotencyKey: "create-latched-settlement-probe",
            },
            actor,
          )
        ).outcome,
        "applied",
      );
      const started = await cell.run(
        { kind: "schedule-run-now", scheduleId, idempotencyKey: "run-latched-settlement-probe" },
        actor,
      );
      assert.equal(started.outcome, "applied", JSON.stringify(started));
      const inFlight = await listedSchedule(cell, scheduleId),
        runtimeSessionId = inFlight.status.activeRun?.runtimeSessionId;
      assert.equal(typeof runtimeSessionId, "string");
      assert.equal(inFlight.status.lastRun, null);

      // A data-shape fatal rejection latches the cell (state becomes "unavailable") without
      // touching the durable ledger, so recovery from disk will re-attach cleanly later.
      const latching = await cell.run(
        { kind: "schedule-update", scheduleId, everyMs: 1, idempotencyKey: "latch-latched-settlement-probe" },
        actor,
      );
      assert.equal(latching.outcome, "op_rejected");
      assert.equal(latching.code, "invalid_store");
      assert.equal(cell.status().state, "unavailable");

      output?.(
        `${JSON.stringify({ type: "thread.started", thread_id: "latched-settlement" })}\n` +
          `${JSON.stringify({ type: "item.completed", item: { id: "write", type: "file_change", status: "completed" } })}\n` +
          `${JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "done\nHARNESS-OUTCOME: succeeded" } })}\n` +
          `${JSON.stringify({ type: "turn.completed" })}\n`,
      );
      exit?.(0);

      // No run() is issued here, so no recovery can start: the whole terminal chain
      // (exit publication, outcome observation, Schedule settlement) must land on the
      // durable ledger while the cell is still latched.
      const settledWhileLatched = await eventually(() => {
        const events = makeTaskEventStore({ repoId, rootDir: root }).read().events;
        return (
          events.some((event) => event.type === "runtime_session_exited") &&
          events.some((event) => event.type === "runtime_session_outcome_observed") &&
          events.some((event) => event.type === "schedule_run_settled")
        );
      });
      assert.equal(settledWhileLatched, true);
      assert.equal(cell.status().state, "unavailable");

      const events = makeTaskEventStore({ repoId, rootDir: root }).read().events,
        claimIndex = events.findIndex((event) => event.type === "schedule_occurrence_claimed"),
        dispatchIndex = events.findIndex((event) => event.type === "runtime_dispatch_requested"),
        terminalIndex = events.findIndex((event) => event.type === "runtime_session_outcome_observed"),
        settleIndex = events.findIndex((event) => event.type === "schedule_run_settled"),
        settlement = events[settleIndex];
      assert.equal(claimIndex < dispatchIndex && dispatchIndex < terminalIndex && terminalIndex < settleIndex, true);
      assert.equal(
        settlement?.opId,
        operationId(
          {
            kind: "schedule-settle",
            scheduleId,
            idempotencyKey: `${runtimeSessionId}:attempt-terminal`,
          },
          actor,
          repoId,
          0,
        ),
      );

      // The next command re-attaches the cell from the clean on-disk ledger and must see
      // the occurrence settled, not stuck behind a single-flight activeRun.
      assert.equal((await cell.run({ kind: "schedule-list" }, actor)).outcome, "applied");
      assert.equal(cell.status().state, "attached");
      const observed = await listedSchedule(cell, scheduleId);
      assert.equal(observed.status.activeRun, null);
      assert.equal(observed.status.lastRun?.outcome, "succeeded");
      assert.equal(observed.status.lastRun?.runtimeSessionId, runtimeSessionId);
    } finally {
      await cell.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

async function listedSchedule(cell: Awaited<ReturnType<typeof openRepoCell>>, scheduleId: string) {
  const listed = (await cell.run({ kind: "schedule-list" }, actor)) as unknown as {
    readonly schedules: readonly {
      readonly scheduleId: string;
      readonly status: {
        readonly activeRun: { readonly dispatchId?: string; readonly runtimeSessionId?: string } | null;
        readonly lastRun: { readonly outcome: string; readonly runtimeSessionId?: string } | null;
      };
    }[];
  };
  return listed.schedules.find((schedule) => schedule.scheduleId === scheduleId)!;
}

async function eventually(check: () => boolean): Promise<boolean> {
  for (let index = 0; index < 400; index += 1) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
