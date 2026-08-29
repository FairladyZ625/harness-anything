// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeTaskEventStore,
  registerDaemonRepo,
  resolveHarnessLayout,
  type AgentDefinitionSnapshot,
} from "../../kernel/src/index.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { openFleetEdgeRuntime } from "../src/fleet-edge-runtime.ts";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { listenFleetTls, type FleetAssignmentRecord } from "../src/fleet/center.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

const actor = { actor: { principal: { personId: "schedule-operator" }, executor: null }, source: "local" as const };
const definition: AgentDefinitionSnapshot = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: "codex-schedule",
  installationId: "installation-schedule",
  kindId: "codex",
  providerId: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  baseUrl: null,
  authMode: "subscription",
};

test("run-now launches only after an applied claim, stays single-flight, and settles tasklessly", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-schedule-actions-"));
  let output: ((chunk: string) => void) | null = null,
    exit: ((code: number | null) => void) | null = null,
    launchCount = 0,
    preparedPermissionMode: string | undefined,
    workerGitEnvironmentRequests = 0,
    launched: { readonly env: NodeJS.ProcessEnv; readonly prompt: string } | null = null;
  try {
    git(root, "init", "-q");
    git(root, "config", "user.name", "Schedule Test");
    git(root, "config", "user.email", "schedule@example.invalid");
    git(root, "commit", "--allow-empty", "-qm", "base");
    const cell = await openRepoCell({
      repoId: workspaceId("schedule-actions"),
      rootDir: canonicalRoot(root),
      ownerId: "schedule-test",
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon"),
        daemonId: "schedule-test",
        endpoint: path.join(root, ".daemon", "daemon.sock"),
      },
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: definition.instanceId,
          name: "Schedule Codex",
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
      prepareRuntimeLaunch: async (_instanceId, request) => {
        preparedPermissionMode = request.permissionMode;
        return {
          definition,
          installation: {
            installationId: definition.installationId,
            kindId: definition.kindId,
            executablePath: "/opt/test/codex",
            version: "1.0.0",
            observedAt: "2026-08-26T00:00:00.000Z",
          },
          executablePath: "/opt/test/codex",
          args: [],
          env: {},
          cwd: request.cwd,
          prompt: request.prompt,
        };
      },
      prepareWorkerGitEnvironment: async () => {
        workerGitEnvironmentRequests += 1;
        return { GITHUB_TOKEN: "must-not-reach-detect-runtime" };
      },
      runtimeLaunch: (prepared) => {
        launchCount += 1;
        launched = { env: prepared.env, prompt: prepared.prompt };
        return {
          pid: 4242,
          onOutput: (listener) => {
            output = listener;
          },
          onErrorOutput: () => undefined,
          onExit: (listener) => {
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
                runtime_type: "codex",
                fallback: {
                  chain: [{ instance: definition.instanceId }, { instance: definition.instanceId }],
                  backoff: { baseMs: 1, maxMs: 1 },
                },
              },
            },
            actor,
          )
        ).outcome,
        "applied",
      );
      const created = await cell.run(
        {
          kind: "schedule-create",
          scheduleId: "e2e-probe",
          name: "E2E probe",
          mode: "detect",
          everyMs: 300_000,
          agentId: "probe-agent",
          runtimeInstanceId: definition.instanceId,
          mission: "Inspect the repository and report success.",
          idempotencyKey: "seed-e2e-probe",
        },
        actor,
      );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      const replayedCreate = await cell.run(
        {
          kind: "schedule-create",
          scheduleId: "e2e-probe",
          name: "E2E probe",
          mode: "detect",
          everyMs: 300_000,
          agentId: "probe-agent",
          runtimeInstanceId: definition.instanceId,
          mission: "Inspect the repository and report success.",
          idempotencyKey: "seed-e2e-probe",
        },
        actor,
      );
      assert.equal(replayedCreate.opId, created.opId);
      const started = await cell.run(
        { kind: "schedule-run-now", scheduleId: "e2e-probe", idempotencyKey: "manual-e2e-probe-1" },
        actor,
      );
      assert.equal(started.outcome, "applied", JSON.stringify(started));
      assert.equal(launchCount, 1);
      assert.equal(preparedPermissionMode, "read-only");
      assert.equal(workerGitEnvironmentRequests, 0);
      assert.equal((launched as { env: NodeJS.ProcessEnv } | null)?.env.HARNESS_TASK_BOUND, undefined);
      assert.equal((launched as { env: NodeJS.ProcessEnv } | null)?.env.HARNESS_SCHEDULE_ID, "e2e-probe");
      assert.equal((launched as { env: NodeJS.ProcessEnv } | null)?.env.HARNESS_SCHEDULE_MODE, "detect");
      assert.equal((launched as { env: NodeJS.ProcessEnv } | null)?.env.GITHUB_TOKEN, undefined);
      assert.match(
        (launched as { prompt: string } | null)?.prompt ?? "",
        /Schedule claim fence:[\s\S]*Assigned Mission/u,
      );
      const activeDelete = await cell.run(
        { kind: "schedule-delete", scheduleId: "e2e-probe", idempotencyKey: "delete-while-active" },
        actor,
      );
      assert.deepEqual(
        { outcome: activeDelete.outcome, code: activeDelete.code },
        { outcome: "op_rejected", code: "schedule_single_flight_active" },
      );
      const replayedRun = await cell.run(
        { kind: "schedule-run-now", scheduleId: "e2e-probe", idempotencyKey: "manual-e2e-probe-1" },
        actor,
      );
      assert.equal(replayedRun.outcome, "applied");
      assert.equal(launchCount, 1);
      const conflicted = await cell.run(
        { kind: "schedule-run-now", scheduleId: "e2e-probe", idempotencyKey: "manual-e2e-probe-2" },
        actor,
      );
      assert.deepEqual(
        { outcome: conflicted.outcome, code: conflicted.code },
        {
          outcome: "op_rejected",
          code: "schedule_single_flight_active",
        },
      );
      output?.(
        `${JSON.stringify({ type: "thread.started", thread_id: "provider-schedule-first" })}\n` +
          `${JSON.stringify({ type: "turn.failed", error: { http_status: 429, message: "rate limited" } })}\n`,
      );
      exit?.(1);
      assert.equal(await eventually(async () => launchCount === 2), true);
      const continuing = (await cell.run({ kind: "schedule-list" }, actor)) as unknown as {
        readonly schedules: readonly { readonly status: { readonly activeRun: unknown; readonly lastRun: unknown } }[];
      };
      assert.notEqual(continuing.schedules[0]?.status.activeRun, null);
      assert.equal(continuing.schedules[0]?.status.lastRun, null);
      output?.(
        `${JSON.stringify({ type: "thread.started", thread_id: "provider-schedule" })}\n` +
          `${JSON.stringify({ type: "item.completed", item: { id: "write", type: "file_change", status: "completed" } })}\n` +
          `${JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "done" } })}\n` +
          `${JSON.stringify({ type: "turn.completed" })}\n`,
      );
      exit?.(0);
      const settled = await eventually(async () => {
        const listed = (await cell.run({ kind: "schedule-list" }, actor)) as unknown as {
          readonly schedules: readonly {
            readonly status: { readonly activeRun: unknown; readonly lastRun: { readonly outcome: string } | null };
          }[];
        };
        return (
          listed.schedules[0]?.status.activeRun === null && listed.schedules[0]?.status.lastRun?.outcome === "succeeded"
        );
      });
      assert.equal(settled, true);
      assert.equal(launchCount, 2);

      const beforeMissed = (await cell.run({ kind: "schedule-list" }, actor)) as unknown as {
          readonly schedules: readonly {
            readonly scheduleId: string;
            readonly definitionRevision: number;
          }[];
        },
        observedRevision = beforeMissed.schedules.find(
          ({ scheduleId }) => scheduleId === "e2e-probe",
        )!.definitionRevision,
        missedAt = "2026-08-27T00:05:00.000Z";
      assert.equal(
        (
          await cell.run(
            {
              kind: "schedule-settle",
              phase: "missed",
              scheduleId: "e2e-probe",
              from: missedAt,
              to: missedAt,
              count: 1,
              reason: "scheduler_unavailable",
              observedDefinitionRevision: observedRevision,
              idempotencyKey: "e2e-probe-missed-1",
            },
            actor,
          )
        ).outcome,
        "applied",
      );
      const afterMissed = (await cell.run({ kind: "schedule-list" }, actor)) as unknown as {
        readonly schedules: readonly {
          readonly scheduleId: string;
          readonly status: { readonly automaticEvaluatedThrough: string; readonly missedCount: number };
        }[];
      };
      const missedStatus = afterMissed.schedules.find(({ scheduleId }) => scheduleId === "e2e-probe")?.status;
      assert.deepEqual(
        { automaticEvaluatedThrough: missedStatus?.automaticEvaluatedThrough, missedCount: missedStatus?.missedCount },
        { automaticEvaluatedThrough: missedAt, missedCount: 1 },
      );
      const runHistoryReceipt = (await cell.run(
          { kind: "schedule-runs", scheduleId: "e2e-probe", limit: 10 },
          actor,
        )) as unknown as { readonly evidence: string },
        { schema: runHistorySchema, ...runHistory } = JSON.parse(runHistoryReceipt.evidence) as {
          readonly schema: string;
          readonly runs: readonly { readonly outcome: string; readonly reportRef: string | null }[];
        };
      assert.equal(runHistorySchema, "schedule-runs/v1");
      assert.deepEqual(runHistory.runs.map(({ outcome }) => outcome).sort(), ["missed", "succeeded"]);
      assert.match(
        runHistory.runs.find(({ outcome }) => outcome === "succeeded")?.reportRef ?? "",
        /^artifact:runtime-result\/sha256\/[0-9a-f]{64}$/u,
      );

      writeFileSync(
        path.join(root, "schedule-update.json"),
        JSON.stringify({
          scheduleId: "e2e-probe",
          name: "Updated E2E probe",
          everyMs: 600_000,
          mission: "Inspect the updated repository and report success.",
          model: definition.model,
          reasoningEffort: "high",
          cwd: null,
          idempotencyKey: "update-e2e-probe",
        }),
      );
      const updated = await cell.run({ kind: "schedule-update", fromFile: "schedule-update.json" }, actor);
      assert.equal(updated.outcome, "applied", JSON.stringify(updated));
      writeFileSync(path.join(root, "schedule-show.json"), JSON.stringify({ scheduleId: "e2e-probe" }));
      const shown = (await cell.run({ kind: "schedule-show", fromFile: "schedule-show.json" }, actor)) as unknown as {
        readonly schedule: {
          readonly name: string;
          readonly spec: { readonly trigger: { readonly everyMs: number }; readonly mission: string };
          readonly status: { readonly missedCount: number; readonly lastRun: unknown };
        };
      };
      assert.equal(shown.schedule.name, "Updated E2E probe");
      assert.equal(shown.schedule.spec.trigger.everyMs, 600_000);
      assert.equal(shown.schedule.spec.mission, "Inspect the updated repository and report success.");
      assert.equal(shown.schedule.status.missedCount, 1);
      assert.notEqual(shown.schedule.status.lastRun, null);
      const authoredSchedulePath = path.join(resolveHarnessLayout(root).authoredRoot, "schedules/e2e-probe.json");
      assert.equal(existsSync(authoredSchedulePath), true);
      writeFileSync(
        path.join(root, "schedule-delete.json"),
        JSON.stringify({
          scheduleId: "e2e-probe",
          reason: "Retired after integration verification",
          idempotencyKey: "delete-e2e-probe",
        }),
      );
      const deleted = await cell.run({ kind: "schedule-delete", fromFile: "schedule-delete.json" }, actor);
      assert.equal(deleted.outcome, "applied", JSON.stringify(deleted));
      assert.equal(existsSync(authoredSchedulePath), false);
      const afterDelete = (await cell.run({ kind: "schedule-list" }, actor)) as unknown as {
        readonly schedules: readonly { readonly scheduleId: string }[];
      };
      assert.equal(
        afterDelete.schedules.some(({ scheduleId }) => scheduleId === "e2e-probe"),
        false,
      );
      const retainedEvents = makeTaskEventStore({ repoId: "schedule-actions", rootDir: root })
        .read()
        .events.filter((event) => event.schema === "schedule-event/v1" && event.entity.id === "e2e-probe");
      assert.equal(
        retainedEvents.some(({ type }) => type === "schedule_updated"),
        true,
      );
      assert.equal(
        retainedEvents.some(({ type }) => type === "schedule_run_settled"),
        true,
      );
      assert.equal(retainedEvents.at(-1)?.type, "schedule_deleted");
      assert.equal(
        (
          await cell.run(
            {
              kind: "schedule-create",
              scheduleId: "e2e-probe",
              name: "Recreated E2E probe",
              mode: "detect",
              everyMs: 900_000,
              agentId: "probe-agent",
              runtimeInstanceId: definition.instanceId,
              mission: "Run the recreated probe.",
              idempotencyKey: "recreate-e2e-probe",
            },
            actor,
          )
        ).outcome,
        "applied",
      );
      const recreated = (await cell.run({ kind: "schedule-show", scheduleId: "e2e-probe" }, actor)) as unknown as {
        readonly schedule: { readonly name: string; readonly status: { readonly lastRun: unknown } };
      };
      assert.equal(recreated.schedule.name, "Recreated E2E probe");
      assert.equal(recreated.schedule.status.lastRun, null);
      assert.equal(existsSync(authoredSchedulePath), true);

      assert.equal(
        (
          await cell.run(
            {
              kind: "schedule-create",
              scheduleId: "restart-heartbeat",
              name: "Restart heartbeat",
              mode: "detect",
              everyMs: 300_000,
              agentId: "probe-agent",
              runtimeInstanceId: definition.instanceId,
              mission: "Resume the claimed heartbeat.",
              idempotencyKey: "seed-restart-heartbeat",
            },
            actor,
          )
        ).outcome,
        "applied",
      );
      const scheduledFor = "2026-08-27T00:05:00.000Z",
        claimedBeforeDispatch = await cell.schedule.claimOccurrence(
          {
            scheduleId: "restart-heartbeat",
            kind: "scheduled",
            scheduledFor,
            nodeId: "local",
            assignmentId: null,
            idempotencyKey: "restart-heartbeat-fire",
          },
          actor,
        );
      assert.equal(claimedBeforeDispatch.outcome, "applied");
      assert.equal(launchCount, 2);
      const resumedClaim = await cell.run(
        {
          kind: "schedule-run-now",
          scheduleId: "restart-heartbeat",
          scheduledFor,
          idempotencyKey: "restart-heartbeat-fire",
        },
        actor,
      );
      assert.equal(resumedClaim.outcome, "applied");
      assert.equal(launchCount, 3);
      const resumedList = (await cell.run({ kind: "schedule-list" }, actor)) as unknown as {
        readonly schedules: readonly {
          readonly scheduleId: string;
          readonly status: {
            readonly automaticEvaluatedThrough: string;
            readonly activeRun: { readonly kind: string; readonly scheduledFor: string } | null;
          };
        }[];
      };
      const restarted = resumedList.schedules.find(({ scheduleId }) => scheduleId === "restart-heartbeat");
      assert.deepEqual(
        {
          automaticEvaluatedThrough: restarted?.status.automaticEvaluatedThrough,
          kind: restarted?.status.activeRun?.kind,
          scheduledFor: restarted?.status.activeRun?.scheduledFor,
        },
        { automaticEvaluatedThrough: scheduledFor, kind: "scheduled", scheduledFor },
      );
      output?.(
        `${JSON.stringify({ type: "thread.started", thread_id: "provider-schedule-restart" })}\n` +
          `${JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "done" } })}\n` +
          `${JSON.stringify({ type: "turn.completed" })}\n`,
      );
      exit?.(0);
      assert.equal(
        await eventually(async () => {
          const listed = (await cell.run({ kind: "schedule-list" }, actor)) as unknown as {
            readonly schedules: readonly {
              readonly scheduleId: string;
              readonly status: { readonly activeRun: unknown };
            }[];
          };
          return (
            listed.schedules.find(({ scheduleId }) => scheduleId === "restart-heartbeat")?.status.activeRun === null
          );
        }),
        true,
      );
    } finally {
      await cell.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "Fleet Schedule forwarding fences a stale disabled view and lets only one edge launch",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-schedule-fleet-")),
      repo = path.join(root, "center-repo"),
      userRoot = path.join(root, "center-user"),
      stateRoot = path.join(root, "center-state"),
      keyFile = path.join(root, "tls.key"),
      certFile = path.join(root, "tls.crt"),
      repoId = "schedule-fleet",
      scheduleId = "e2e-probe",
      assignments: FleetAssignmentRecord[] = ["one", "two"].map((suffix) => ({
        nodeId: `edge-${suffix}`,
        assignmentId: `schedule-assignment-${suffix}`,
        repoId,
        viewId: `schedule-view-${suffix}`,
        scope: { kind: "schedule", scheduleId, paths: ["agents", "schedules"] },
        expiresAt: "2099-01-01T00:00:00.000Z",
        actor: {
          principal: { personId: `operator-${suffix}` },
          executor: { kind: "agent", id: `edge-${suffix}` },
        },
      }));
    let center: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
      host: Awaited<ReturnType<typeof openDaemonHost>> | null = null;
    const edgeRuntimes: ReturnType<typeof openFleetEdgeRuntime>[] = [];
    try {
      initHarnessRepo(repo, "schedule-center");
      registerDaemonRepo({
        canonicalRoot: repo,
        repoId,
        mode: "remote-center",
        userRoot,
        createConvenienceLinks: false,
      });
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyFile,
          "-out",
          certFile,
          "-subj",
          "/CN=localhost",
          "-days",
          "1",
          "-addext",
          "subjectAltName=DNS:localhost",
        ],
        { stdio: "ignore" },
      );
      host = await openDaemonHost({ daemonId: "schedule-center", userRoot });
      await host.attachmentsSettled();
      const assignmentAuth = { transportKind: "fleet-tls" as const, assignmentBinding: assignments[0]! };
      assert.equal(
        (
          await host.run(
            repoId,
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
            assignmentAuth,
          )
        ).outcome,
        "applied",
      );
      const certificate = readFileSync(certFile),
        byId = new Map(assignments.map((assignment) => [assignment.assignmentId, assignment]));
      center = await listenFleetTls({
        host,
        stateRoot,
        key: readFileSync(keyFile),
        cert: certificate,
        replicaDiskQuotaBytes: 64 * 1024 * 1024,
        authenticate: (nodeId, credential) => credential === `credential-${nodeId}`,
        resolveAssignment: (assignmentId) => byId.get(assignmentId) ?? null,
      });
      const launches = [0, 0],
        workspaces = assignments.map((assignment, index) => {
          const workspaceRoot = path.join(root, `edge-${index + 1}`),
            viewRoot = path.join(root, `view-${index + 1}`);
          initHarnessRepo(workspaceRoot, `schedule-edge-${index + 1}`);
          const runtime = openFleetEdgeRuntime({
            request: {
              host: "127.0.0.1",
              port: center!.port,
              caPath: certFile,
              servername: "localhost",
              nodeId: assignment.nodeId,
              credential: `credential-${assignment.nodeId}`,
              assignmentId: assignment.assignmentId,
              repoId,
              viewRoot,
              quotaBytes: 64 * 1024 * 1024,
              workspaceRoot,
              method: "repo.schedule.run",
              action: {},
            },
            daemonGeneration: index + 1,
            daemonRoute: {
              userRoot: path.join(root, `edge-user-${index + 1}`),
              daemonId: `schedule-edge-${index + 1}`,
              endpoint: path.join(root, `edge-user-${index + 1}`, "daemon.sock"),
            },
            ports: scheduleRuntimePorts(),
            launch: () => {
              launches[index] += 1;
              return {
                pid: 4300 + index,
                onOutput: () => undefined,
                onErrorOutput: () => undefined,
                onExit: () => undefined,
                terminate: () => undefined,
              };
            },
          });
          edgeRuntimes.push(runtime);
          return { assignment, runtime, workspaceRoot, viewRoot };
        });
      const created = await workspaces[0]!.runtime.run("repo.schedule.run", {
        kind: "schedule-create",
        scheduleId,
        name: "E2E probe",
        mode: "detect",
        everyMs: 300_000,
        agentId: "probe-agent",
        runtimeInstanceId: definition.instanceId,
        mission: "Inspect the repository and report success.",
        idempotencyKey: "fleet-create",
      });
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      const listed = await workspaces[0]!.runtime.run("repo.schedule.run", { kind: "schedule-list" });
      assert.equal(listed.outcome, "applied");
      assert.equal((listed.schedules as readonly unknown[] | undefined)?.length, 1);
      await pullScheduleView(workspaces[1]!, center.port, certificate);
      assert.match(
        readFileSync(path.join(workspaces[1]!.workspaceRoot, "harness/schedules/e2e-probe.json"), "utf8"),
        /"state": "armed"/u,
      );
      assert.equal(
        (
          await workspaces[0]!.runtime.run("repo.schedule.run", {
            kind: "schedule-disable",
            scheduleId,
            idempotencyKey: "fleet-disable",
          })
        ).outcome,
        "applied",
      );
      const stale = await workspaces[1]!.runtime.run("repo.schedule.run", {
        kind: "schedule-run-now",
        scheduleId,
        idempotencyKey: "stale-disabled-claim",
      });
      assert.equal(stale.outcome, "op_rejected");
      assert.equal((stale.error as { code?: string } | undefined)?.code, "schedule_paused");
      assert.deepEqual(launches, [0, 0]);
      assert.equal(
        (
          await workspaces[0]!.runtime.run("repo.schedule.run", {
            kind: "schedule-enable",
            scheduleId,
            idempotencyKey: "fleet-enable",
          })
        ).outcome,
        "applied",
      );
      const raced = await Promise.all(
        workspaces.map((edge, index) =>
          edge.runtime.run("repo.schedule.run", {
            kind: "schedule-run-now",
            scheduleId,
            idempotencyKey: `dual-edge-${index + 1}`,
          }),
        ),
      );
      assert.deepEqual(raced.map((receipt) => receipt.outcome).sort(), ["applied", "op_rejected"]);
      assert.equal(launches[0] + launches[1], 1);
      const winner = raced.findIndex((receipt) => receipt.outcome === "applied"),
        loser = winner === 0 ? 1 : 0;
      assert.equal(launches[winner], 1);
      assert.equal(launches[loser], 0);
      assert.equal((raced[loser]!.error as { code?: string } | undefined)?.code, "schedule_single_flight_active");
      const localAuth = {
          transportKind: "unix-socket" as const,
          unixSocketOwnerBoundary: {
            ownerUid: process.getuid?.() ?? 0,
            source: "unix-socket-filesystem-owner-boundary" as const,
          },
        },
        centerLocal = await host.run(
          repoId,
          { kind: "schedule-run-now", scheduleId, idempotencyKey: "center-local-rejected" },
          localAuth,
        );
      assert.equal(centerLocal.outcome, "op_rejected");
    } finally {
      for (const runtime of edgeRuntimes) runtime.close();
      await center?.close();
      await host?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

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
        observedAt: "2026-08-26T00:00:00.000Z",
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

async function pullScheduleView(
  edge: { assignment: FleetAssignmentRecord; workspaceRoot: string; viewRoot: string },
  port: number,
  ca: Buffer,
): Promise<void> {
  const pulled = await runFleetReplicaPullClient({
    port,
    ca,
    servername: "localhost",
    nodeId: edge.assignment.nodeId,
    credential: `credential-${edge.assignment.nodeId}`,
    assignmentId: edge.assignment.assignmentId,
    viewRoot: edge.viewRoot,
    diskQuotaBytes: 64 * 1024 * 1024,
  });
  assert.equal(
    applyFleetMirrorCut(edge.viewRoot, edge.assignment.repoId, edge.workspaceRoot, "pull", {
      viewId: pulled.replica.viewId,
    }).outcome,
    "applied",
  );
}

function initHarnessRepo(root: string, name: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.name", "Schedule Test");
  git(root, "config", "user.email", "schedule@example.invalid");
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    `schema: harness-anything/v1\nname: ${name}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
  );
  git(root, "add", "harness");
  git(root, "commit", "-qm", "base");
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
