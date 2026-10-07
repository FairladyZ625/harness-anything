// harness-test-tier: integration
import { signInAt } from "./keycloak.fixtures.ts";
import assert from "node:assert/strict";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { eventually } from "./schedule-actions.fixtures.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fleetNodeOwners } from "./fleet-store.fixture.ts";
import { seedBuiltinSchedules } from "../src/schedule-builtin-executor.ts";
import { registerDaemonRepo, type AgentDefinitionSnapshot } from "@harness-anything/kernel";
import { appendRuntimeWorkerRecord } from "../src/dispatch-stream.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { canonicalRoot } from "../src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";
import type { ScheduleGuiRowDto, SchedulesListResult } from "../src/protocol/schedules-gui-contract.ts";

const actor = withPolicyGroup(
  { actor: { principal: { personId: "schedule-operator" }, executor: null }, source: "local" as const },
  "admin",
);
const definition: AgentDefinitionSnapshot = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: "codex-schedules",
  installationId: "installation-schedules",
  kindId: "codex",
  providerId: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  baseUrl: null,
  authMode: "subscription",
};

function git(root: string, ...args: readonly string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

function initHarnessRepo(root: string, name: string): void {
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    `schema: harness-anything/v1\nname: ${name}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
  );
  git(root, "add", "harness");
  git(root, "commit", "-qm", "base");
}

function scheduleRuntimePorts() {
  return {
    runtimeInstances: () => [
      {
        schemaVersion: 2 as const,
        instanceId: definition.instanceId,
        name: "Schedule Codex",
        kindId: definition.kindId,
        installationId: definition.installationId,
        providerId: definition.providerId,
        models: [definition.model],
        defaultModel: definition.model,
        enabled: true,
        permissionMode: "workspace-write" as const,
        codex: {},
        authMode: definition.authMode,
        authState: "configured" as const,
        authReadiness: { status: "ready" as const, code: null, hint: null },
        isolationState: "enforced" as const,
      },
    ],
    prepareRuntimeLaunch: async (_instanceId: string, request: { cwd: string; prompt: string }) => ({
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
    prepareWorkerGitEnvironment: async () => null,
  };
}

test(
  "local mode: the schedules GUI read joins definition, run projection, and execution rights",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-schedules-gui-local-"));
    let output: ((chunk: string) => void) | null = null,
      exit: ((code: number | null) => void) | null = null;
    try {
      git(root, "init", "-q");
      git(root, "config", "user.name", "Schedule GUI Test");
      git(root, "config", "user.email", "schedule-gui@example.invalid");
      git(root, "commit", "--allow-empty", "-qm", "base");
      const cell = await openRepoCell({
        repoId: "schedules-gui-local",
        rootDir: canonicalRoot(root),
        ownerId: "schedules-gui-test",
        runtimeDaemonRoute: {
          userRoot: path.join(root, ".daemon"),
          daemonId: "schedules-gui-test",
          endpoint: path.join(root, ".daemon", "daemon.sock"),
        },
        ...scheduleRuntimePorts(),
        runtimeLaunch: (_prepared, persistence) => {
          appendRuntimeWorkerRecord(root, persistence.dispatchId, { kind: "process_started", pid: process.pid });
          return {
            pid: process.pid,
            onOutput: (listener: (chunk: string) => void) => {
              output = listener;
            },
            onErrorOutput: () => undefined,
            onExit: (listener: (code: number | null) => void) => {
              exit = listener;
            },
            terminate: () => undefined,
          };
        },
      });
      try {
        assert.equal(
          (
            await cell.run(
              {
                kind: "agent-install",
                declaration: {
                  schema: "agent-declaration/v1",
                  id: "probe-agent",
                  name: "Probe Agent",
                  instructions: "Run the exact probe mission.",
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
                scheduleId: "heartbeat-probe",
                name: "Heartbeat probe",
                mode: "detect",
                everyMs: 300_000,
                agentId: "probe-agent",
                runtimeInstanceId: definition.instanceId,
                mission: "Inspect the repository and report success.",
              },
              actor,
            )
          ).outcome,
          "applied",
        );
        // The GUI parses every read result through the daemon contract, so the
        // integration asserts that path: an invalid row shape must throw here, not
        // merely disagree with field expectations (a claimed-but-unlinked activeRun or a
        // lastRun without detail previously failed this parse).
        const list = async (): Promise<SchedulesListResult> =>
          parseDaemonGuiReadResult(
            "repo.projection.read",
            await cell.read("repo.projection.read", { name: "schedule-plane" }),
          ).projection as SchedulesListResult;
        const initial = await list();
        assert.equal(initial.ok, true);
        assert.equal(initial.repoMode, "local");
        assert.equal(initial.viewerNodeId, "local");
        assert.equal(initial.schedules.length, 1);
        assert.deepEqual(initial.actions.create, { available: true, code: null, nextAction: null });
        assert.deepEqual(initial.options.agents, [
          { agentId: "probe-agent", name: "Probe Agent", runtimes: [{ type: "codex" }] },
        ]);
        assert.equal(initial.options.instances[0]?.instanceId, definition.instanceId);
        assert.deepEqual(initial.options.instances[0]?.models, [definition.model]);
        assert.deepEqual(initial.options.instances[0]?.efforts, ["minimal", "low", "medium", "high", "xhigh", "max"]);
        const created = initial.schedules[0] as ScheduleGuiRowDto;
        assert.equal(created.state, "armed");
        assert.equal(created.definitionResidency, "ledger");
        assert.deepEqual(created.trigger, {
          kind: "interval",
          everyMs: 300_000,
          expression: null,
          timezone: null,
          summary: "every 5m",
        });
        assert.equal(created.executionAvailability, "local");
        assert.equal(created.nextRunAt !== null, true);
        assert.equal(created.actions.runNow.available, true);
        assert.equal(created.actions.disable.available, true);
        assert.equal(created.actions.enable.available, false);

        const runNow = (await cell.run(
          { kind: "schedule-run-now", scheduleId: "heartbeat-probe", idempotencyKey: "gui-run-1" },
          actor,
        )) as unknown as { outcome: string; scheduleId?: string };
        assert.equal(runNow.outcome, "applied");
        assert.equal(runNow.scheduleId, "heartbeat-probe");

        const active = await list();
        const running = active.schedules[0] as ScheduleGuiRowDto;
        assert.notEqual(running.activeRun, null);
        assert.equal(running.activeRun!.nodeId, "local");
        assert.equal(running.activeRun!.attemptIndex, 0);
        assert.equal(running.activeRun!.kind, "manual");
        assert.equal(running.executionAvailability, "local");
        assert.equal(running.actions.runNow.available, false);
        assert.equal(running.actions.runNow.code, "schedule_single_flight_active");

        // Wait for the spawner to subscribe the stub's listeners, then observe
        // the transcript through the same runtime attach surface exposed to clients.
        const emit = await eventually(() => output !== null && exit !== null);
        assert.equal(emit, true, "the scheduled spawn never subscribed its output listener");
        const runtimeSessionId = running.activeRun!.runtimeSessionId;
        assert.notEqual(runtimeSessionId, null);
        const attached = await cell.attach(runtimeSessionId!, "stream:0");
        try {
          assert.equal(attached.initial.ok, true, JSON.stringify(attached.initial));
          output?.(
            `${JSON.stringify({ type: "thread.started", thread_id: "provider-schedules" })}\n` +
              `${JSON.stringify({ type: "item.completed", item: { id: "write", type: "file_change", status: "completed" } })}\n` +
              `${JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "done\nHARNESS-OUTCOME: succeeded" } })}\n` +
              `${JSON.stringify({ type: "turn.completed" })}\n`,
          );
          const pending = attached.initial.ok ? [...attached.initial.events] : [];
          for (;;) {
            const event = pending.shift() ?? (await attached.next());
            assert.notEqual(event, null, "runtime attach stream closed before provider activity arrived");
            assert.notEqual(event?.type, "exit", "runtime exited before provider activity was consumed");
            if (
              event?.type === "activity" &&
              event.activity === "message" &&
              event.content === "done\nHARNESS-OUTCOME: succeeded"
            )
              break;
          }
        } finally {
          attached.detach();
        }
        exit?.(0);
        const settled = await eventually(async () => {
          const read = await list();
          const row = read.schedules[0] as ScheduleGuiRowDto;
          if (row.activeRun !== null || row.lastRun === null) return false;
          if (row.lastRun.outcome !== "succeeded")
            throw new Error(`settlement outcome was ${row.lastRun.outcome}: ${row.lastRun.detail ?? ""}`);
          return true;
        });
        assert.equal(settled, true);
        const afterRun = (await list()).schedules[0] as ScheduleGuiRowDto;
        assert.notEqual(afterRun.lastRun!.runtimeSessionId, null);
        assert.equal(afterRun.lastRun!.nodeId, "local");
        assert.equal(afterRun.missed.count, 0);
        assert.equal(afterRun.actions.runNow.available, true);

        assert.equal(
          (
            await cell.run(
              { kind: "schedule-disable", scheduleId: "heartbeat-probe", idempotencyKey: "gui-disable-1" },
              actor,
            )
          ).outcome,
          "applied",
        );
        const paused = (await list()).schedules[0] as ScheduleGuiRowDto;
        assert.equal(paused.state, "paused");
        assert.equal(paused.nextRunAt, null);
        assert.equal(paused.actions.runNow.available, false);
        assert.equal(paused.actions.runNow.code, "schedule_paused");
        assert.equal(paused.actions.enable.available, true);
        assert.equal(
          (
            await cell.run(
              {
                kind: "schedule-update",
                scheduleId: "heartbeat-probe",
                name: "Edited heartbeat",
                everyMs: 600_000,
                agentId: "probe-agent",
                runtimeInstanceId: definition.instanceId,
                mission: "Inspect the edited schedule.",
                model: definition.model,
                reasoningEffort: "high",
                cwd: null,
                idempotencyKey: "gui-update-1",
              },
              actor,
            )
          ).outcome,
          "applied",
        );
        const edited = (await list()).schedules[0] as ScheduleGuiRowDto;
        assert.equal(edited.name, "Edited heartbeat");
        assert.equal(edited.trigger.everyMs, 600_000);
        assert.equal(edited.mission, "Inspect the edited schedule.");
        assert.equal(
          (
            await cell.run(
              {
                kind: "schedule-delete",
                scheduleId: "heartbeat-probe",
                reason: "GUI integration retirement",
                idempotencyKey: "gui-delete-1",
              },
              actor,
            )
          ).outcome,
          "applied",
        );
        assert.equal((await list()).schedules.length, 0);
      } finally {
        await cell.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "remote-center: the read serves definitions and projection only, with catalog-routed blockers",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-schedules-gui-center-"));
    let host: Awaited<ReturnType<typeof openDaemonHost>> | null = null,
      owners: Awaited<ReturnType<typeof fleetNodeOwners>> | null = null;
    const repo = path.join(root, "center-repo"),
      userRoot = path.join(root, "center-user");
    try {
      mkdirSync(path.join(repo, "harness"), { recursive: true });
      git(repo, "init", "-q");
      git(repo, "config", "user.name", "Schedule Center Test");
      git(repo, "config", "user.email", "center@example.invalid");
      initHarnessRepo(repo, "schedules-gui-center");
      const prepared = await openRepoCell({
        repoId: "schedules-gui-center",
        rootDir: canonicalRoot(repo),
        ownerId: "schedule-fixture",
      });
      try {
        await seedBuiltinSchedules({ cell: prepared, binding: actor });
      } finally {
        await prepared.close();
      }
      registerDaemonRepo({
        canonicalRoot: repo,
        repoId: "schedules-gui-center",
        mode: "remote-center",
        userRoot,
        createConvenienceLinks: false,
      });
      host = await openDaemonHost({ daemonId: "schedules-gui-center", userRoot });
      await host.attachmentsSettled();
      owners = await fleetNodeOwners({
        userRoot,
        owners: { "edge-one": "operator" },
        repoIds: ["schedules-gui-center"],
      });
      const nodeAuth = owners.auth({ nodeId: "edge-one" });
      assert.equal(
        (
          await host.run(
            "schedules-gui-center",
            {
              kind: "schedule-create",
              scheduleId: "heartbeat-probe",
              name: "Heartbeat probe",
              mode: "detect",
              everyMs: 300_000,
              agentId: "probe-agent",
              runtimeInstanceId: definition.instanceId,
              mission: "Inspect the repository and report success.",
            },
            nodeAuth,
          )
        ).outcome,
        "applied",
      );
      signInAt(userRoot, "operator");
      const localAuth = {
        transportKind: "unix-socket" as const,
        unixSocketOwnerBoundary: {
          ownerUid: process.getuid?.() ?? 0,
          source: "unix-socket-filesystem-owner-boundary" as const,
        },
      };
      const list = async (): Promise<SchedulesListResult> =>
        parseDaemonGuiReadResult(
          "repo.projection.read",
          await host.read("schedules-gui-center", "repo.projection.read", { name: "schedule-plane" }, localAuth),
        ).projection as SchedulesListResult;
      const joinedList = await list();
      const rowOf = (scheduleId: string) =>
          joinedList.schedules.find((row) => row.scheduleId === scheduleId) as ScheduleGuiRowDto,
        joined = rowOf("heartbeat-probe");
      assert.deepEqual(joined.claim, { nodeId: null, claimFence: null });
      // Idle topology is local; action admission still requires authenticated node ingress.
      assert.equal(joined.executionAvailability, "local");
      // The seeded builtin executes on the node holding the canonical cell.
      assert.equal(rowOf("builtin-ledger-backup").executionAvailability, "local");
      assert.equal(rowOf("builtin-ledger-backup").actions.runNow.code, "repo_mode_requires_center_ingress");
      const rejected = (await host.run(
        "schedules-gui-center",
        { kind: "schedule-run-now", scheduleId: "heartbeat-probe", idempotencyKey: "center-gui-1" },
        localAuth,
      )) as unknown as { outcome: string; code?: string };
      assert.equal(rejected.outcome, "op_rejected");
    } finally {
      await host?.close();
      await owners?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
