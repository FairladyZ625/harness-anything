// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hostname } from "node:os";
import { registerDaemonRepo, type AgentDefinitionSnapshot } from "../../kernel/src/index.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { canonicalRoot } from "../src/protocol/daemon-protocol.contract.ts";
import type { ScheduleGuiRowDto } from "../src/protocol/schedules-gui-contract.ts";

const actor = { actor: { principal: { personId: "schedule-operator" }, executor: null }, source: "local" as const };
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

function initHarnessRepo(root: string, name: string, withPeople = false): void {
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    `schema: harness-anything/v1\nname: ${name}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
  );
  if (withPeople)
    writeFileSync(
      path.join(root, "harness/people.yaml"),
      `${JSON.stringify(
        {
          schema: "harness-people/v1",
          people: [
            {
              personId: "owner",
              displayName: "Owner",
              roles: ["owner"],
              credentials: [
                {
                  kind: "unix-socket-owner-boundary",
                  issuer: `host:${hostname()}`,
                  subject: String(process.getuid?.() ?? 0),
                },
              ],
            },
          ],
          roles: [{ roleId: "owner", commandClasses: ["repo-read", "repo-write"] }],
        },
        null,
        2,
      )}\n`,
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
        runtimeLaunch: () => ({
          pid: 4501,
          onOutput: (listener: (chunk: string) => void) => {
            output = listener;
          },
          onErrorOutput: () => undefined,
          onExit: (listener: (code: number | null) => void) => {
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
                  id: "probe-agent",
                  name: "Probe Agent",
                  instructions: "Run the exact probe mission.",
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
                scheduleId: "heartbeat-probe",
                name: "Heartbeat probe",
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
        const initial = await cell.read("repo.schedules.list");
        assert.equal(initial.ok, true);
        assert.equal(initial.repoMode, "local");
        assert.equal(initial.viewerNodeId, "local");
        assert.equal(initial.schedules.length, 1);
        const created = initial.schedules[0] as ScheduleGuiRowDto;
        assert.equal(created.state, "armed");
        assert.equal(created.definitionResidency, "ledger");
        assert.deepEqual(created.trigger, {
          kind: "interval",
          everyMs: 300_000,
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

        const active = await cell.read("repo.schedules.list");
        const running = active.schedules[0] as ScheduleGuiRowDto;
        assert.notEqual(running.activeRun, null);
        assert.equal(running.activeRun!.nodeId, "local");
        assert.equal(running.activeRun!.attemptIndex, 0);
        assert.equal(running.activeRun!.kind, "manual");
        assert.equal(running.executionAvailability, "local");
        assert.equal(running.actions.runNow.available, false);
        assert.equal(running.actions.runNow.code, "schedule_single_flight_active");

        // Wait for the spawner to subscribe the stub's listeners, then replay a
        // completed transcript and a clean exit so settlement records "succeeded".
        const emit = await eventually(() => Promise.resolve(output !== null && exit !== null));
        assert.equal(emit, true, "the scheduled spawn never subscribed its output listener");
        output?.(
          `${JSON.stringify({ type: "thread.started", thread_id: "provider-schedules" })}\n` +
            `${JSON.stringify({ type: "item.completed", item: { id: "write", type: "file_change", status: "completed" } })}\n` +
            `${JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "done" } })}\n` +
            `${JSON.stringify({ type: "turn.completed" })}\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        exit?.(0);
        const settled = await eventually(async () => {
          const read = await cell.read("repo.schedules.list");
          const row = read.schedules[0] as ScheduleGuiRowDto;
          if (row.activeRun !== null || row.lastRun === null) return false;
          if (row.lastRun.outcome !== "succeeded")
            throw new Error(`settlement outcome was ${row.lastRun.outcome}: ${row.lastRun.detail ?? ""}`);
          return true;
        });
        assert.equal(settled, true);
        const afterRun = (await cell.read("repo.schedules.list")).schedules[0] as ScheduleGuiRowDto;
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
        const paused = (await cell.read("repo.schedules.list")).schedules[0] as ScheduleGuiRowDto;
        assert.equal(paused.state, "paused");
        assert.equal(paused.nextRunAt, null);
        assert.equal(paused.actions.runNow.available, false);
        assert.equal(paused.actions.runNow.code, "schedule_paused");
        assert.equal(paused.actions.enable.available, true);
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
    let host: Awaited<ReturnType<typeof openDaemonHost>> | null = null;
    const repo = path.join(root, "center-repo"),
      userRoot = path.join(root, "center-user");
    try {
      mkdirSync(path.join(repo, "harness"), { recursive: true });
      git(repo, "init", "-q");
      git(repo, "config", "user.name", "Schedule Center Test");
      git(repo, "config", "user.email", "center@example.invalid");
      initHarnessRepo(repo, "schedules-gui-center", true);
      registerDaemonRepo({
        canonicalRoot: repo,
        repoId: "schedules-gui-center",
        mode: "remote-center",
        userRoot,
        createConvenienceLinks: false,
      });
      host = await openDaemonHost({ daemonId: "schedules-gui-center", userRoot });
      await host.attachmentsSettled();
      const assignmentAuth = {
        transportKind: "fleet-tls" as const,
        assignmentBinding: {
          nodeId: "edge-one",
          assignmentId: "assignment-edge-one",
          repoId: "schedules-gui-center",
          scope: { kind: "schedule" as const, scheduleId: "heartbeat-probe", paths: ["schedules"] },
          expiresAt: "2099-01-01T00:00:00.000Z",
          actor: { principal: { personId: "operator" }, executor: { kind: "agent" as const, id: "edge-one" } },
        },
      };
      assert.equal(
        (
          await host.run(
            "schedules-gui-center",
            {
              kind: "schedule-create",
              scheduleId: "heartbeat-probe",
              name: "Heartbeat probe",
              everyMs: 300_000,
              agentId: "probe-agent",
              runtimeInstanceId: definition.instanceId,
              mission: "Inspect the repository and report success.",
            },
            assignmentAuth,
          )
        ).outcome,
        "applied",
      );
      const localAuth = {
        transportKind: "unix-socket" as const,
        unixSocketOwnerBoundary: {
          ownerUid: process.getuid?.() ?? 0,
          source: "unix-socket-filesystem-owner-boundary" as const,
        },
      };
      const read = await host.read("schedules-gui-center", "repo.schedules.list", {}, localAuth);
      assert.equal(read.ok, true);
      assert.equal(read.repoMode, "remote-center");
      assert.equal(read.viewerNodeId, null);
      assert.equal(read.schedules.length, 1);
      const row = read.schedules[0] as ScheduleGuiRowDto;
      assert.equal(row.state, "armed");
      assert.equal(row.executionAvailability, "not-on-this-node");
      assert.equal(row.actions.runNow.available, false);
      assert.equal(row.actions.runNow.code, "repo_mode_requires_center_ingress");
      assert.equal(row.actions.enable.available, false);
      // The center never fabricates a local executor: no node/provider/liveness claims.
      assert.equal(row.claim.nodeId, null);
      const rejected = (await host.run(
        "schedules-gui-center",
        { kind: "schedule-run-now", scheduleId: "heartbeat-probe", idempotencyKey: "center-gui-1" },
        localAuth,
      )) as unknown as { outcome: string; code?: string };
      assert.equal(rejected.outcome, "op_rejected");
    } finally {
      await host?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

async function eventually(check: () => Promise<boolean>): Promise<boolean> {
  for (let index = 0; index < 100; index += 1) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}
