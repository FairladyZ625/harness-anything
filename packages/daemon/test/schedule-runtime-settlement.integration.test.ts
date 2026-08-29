// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, type AgentDefinitionSnapshot } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { operationId } from "../src/repo-cell-proof.ts";

const actor = {
  actor: { principal: { personId: "schedule-settlement-operator" }, executor: null },
  source: "local" as const,
};
const definition: AgentDefinitionSnapshot = {
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
  try {
    git(root, "init", "-q");
    git(root, "config", "user.name", "Schedule Settlement Test");
    git(root, "config", "user.email", "schedule-settlement@example.invalid");
    git(root, "commit", "--allow-empty", "-qm", "base");
    const cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(root),
      ownerId: "schedule-settlement-test",
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon"),
        daemonId: "schedule-settlement-test",
        endpoint: path.join(root, ".daemon", "daemon.sock"),
      },
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: definition.instanceId,
          name: "Schedule Settlement Codex",
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
                id: "settlement-agent",
                name: "Settlement Agent",
                instructions: "Complete the Schedule settlement probe.",
                runtime_type: "codex",
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
              name: "Settlement probe",
              mode: "detect",
              everyMs: 300_000,
              agentId: "settlement-agent",
              runtimeInstanceId: definition.instanceId,
              mission: "Finish successfully so the occurrence can settle.",
              idempotencyKey: "create-settlement-probe",
            },
            actor,
          )
        ).outcome,
        "applied",
      );
      const started = await cell.run(
        { kind: "schedule-run-now", scheduleId, idempotencyKey: "run-settlement-probe" },
        actor,
      );
      assert.equal(started.outcome, "applied", JSON.stringify(started));
      const inFlight = await listedSchedule(cell, scheduleId),
        dispatchId = inFlight.status.activeRun?.dispatchId,
        runtimeSessionId = inFlight.status.activeRun?.runtimeSessionId;
      assert.equal(typeof dispatchId, "string");
      assert.equal(typeof runtimeSessionId, "string");
      assert.equal(inFlight.status.lastRun, null);

      output?.(
        `${JSON.stringify({ type: "thread.started", thread_id: "schedule-settlement" })}\n` +
          `${JSON.stringify({ type: "item.completed", item: { id: "write", type: "file_change", status: "completed" } })}\n` +
          `${JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "done" } })}\n` +
          `${JSON.stringify({ type: "turn.completed" })}\n`,
      );
      exit?.(0);

      const settled = await eventually(async () => {
        const schedule = await listedSchedule(cell, scheduleId);
        return schedule.status.activeRun === null && schedule.status.lastRun?.outcome === "succeeded";
      });
      assert.equal(settled, true);
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
      assert.equal(settlement?.type === "schedule_run_settled" && settlement.payload.schedule.status.activeRun, null);
      assert.equal(
        settlement?.type === "schedule_run_settled" && settlement.payload.schedule.status.lastRun?.runtimeSessionId,
        runtimeSessionId,
      );
    } finally {
      await cell.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
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

async function eventually(check: () => Promise<boolean>): Promise<boolean> {
  for (let index = 0; index < 100; index += 1) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
