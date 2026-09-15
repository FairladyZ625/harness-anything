// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, resolveHarnessLayout } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { definition, eventually, git } from "./schedule-actions.fixtures.ts";

const actor = withRoleBinding(
  { actor: { principal: { personId: "schedule-operator" }, executor: null }, source: "local" as const },
  "repo-write",
);

test("run-now launches only after an applied claim, stays single-flight, and settles tasklessly", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-schedule-actions-"));
  let output: ((chunk: string) => void) | null = null,
    exit: ((code: number | null) => void) | null = null,
    launchCount = 0,
    preparedPermissionMode: string | undefined,
    preparedFast: boolean | undefined,
    workerGitEnvironmentRequests = 0,
    launched: { readonly env: NodeJS.ProcessEnv; readonly prompt: string } | null = null;
  const secondLaunch = Promise.withResolvers<void>();
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
        {
          schemaVersion: 2,
          instanceId: "codex-schedule-secondary",
          name: "Schedule Codex Secondary",
          kindId: definition.kindId,
          installationId: definition.installationId,
          providerId: "openai-secondary",
          models: [definition.model],
          defaultModel: definition.model,
          enabled: true,
          permissionMode: "workspace-write",
          codex: {
            reasoningEffort: "high",
            fast: true,
            baseUrl: null,
            baseUrlConfigured: false,
            wire_api: null,
            requires_openai_auth: null,
            http_headers: null,
          },
          authMode: "api-key",
          authState: "configured",
          authReadiness: { status: "ready", code: null, hint: null },
          isolationState: "enforced",
        },
      ],
      prepareRuntimeLaunch: async (instanceId, request) => {
        preparedPermissionMode = request.permissionMode;
        preparedFast = request.fast;
        const preparedDefinition =
          instanceId === definition.instanceId
            ? definition
            : { ...definition, instanceId, providerId: "openai-secondary" };
        return {
          definition: preparedDefinition,
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
        if (launchCount === 2) secondLaunch.resolve();
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
                instance: definition.instanceId,
                fallback: {
                  providerPriority: [definition.providerId, "openai-secondary"],
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
          fast: true,
          idempotencyKey: "seed-e2e-probe",
        },
        actor,
      );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      assert.deepEqual(created.effects, ["schedule-event/schedule_created"]);
      assert.deepEqual(created.updatedProjection, {
        kind: "schedule",
        ref: "schedule/e2e-probe",
        revision: created.revision,
      });
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
          fast: true,
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
      assert.equal(preparedFast, true);
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
      const wrongFence = await cell.run(
        {
          kind: "schedule-settle",
          scheduleId: "e2e-probe",
          claimFence: "claim_wrong_fence",
          outcome: "failed",
          endedAt: "2026-08-27T00:01:00.000Z",
          idempotencyKey: "manual-e2e-probe-wrong-fence",
        },
        actor,
      );
      assert.deepEqual(
        { outcome: wrongFence.outcome, code: wrongFence.code, unmetCriteria: wrongFence.unmetCriteria },
        {
          outcome: "op_rejected",
          code: "schedule_claim_stale",
          unmetCriteria: [
            {
              ref: "schedule/active-claim-fence",
              failureCode: "schedule_claim_stale",
              explain: "The active occurrence still owns the supplied claim fence.",
            },
          ],
        },
      );
      output?.(
        `${JSON.stringify({ type: "thread.started", thread_id: "provider-schedule-first" })}\n` +
          `${JSON.stringify({ type: "turn.failed", error: { http_status: 429, message: "rate limited" } })}\n`,
      );
      exit?.(1);
      await secondLaunch.promise;
      assert.equal(launchCount, 2);
      const continuing = (await cell.run({ kind: "schedule-list" }, actor)) as unknown as {
        readonly schedules: readonly { readonly status: { readonly activeRun: unknown; readonly lastRun: unknown } }[];
      };
      assert.notEqual(continuing.schedules[0]?.status.activeRun, null);
      assert.equal(continuing.schedules[0]?.status.lastRun, null);
      output?.(
        `${JSON.stringify({ type: "thread.started", thread_id: "provider-schedule" })}\n` +
          `${JSON.stringify({ type: "item.completed", item: { id: "write", type: "file_change", status: "completed" } })}\n` +
          `${JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "done\nHARNESS-OUTCOME: succeeded" } })}\n` +
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
              kind: "schedule-missed",
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
      const staleClaim = await cell.run(
        {
          kind: "schedule-run-now",
          scheduleId: "e2e-probe",
          scheduledFor: "2026-08-27T00:10:00.000Z",
          observedDefinitionRevision: observedRevision,
          idempotencyKey: "e2e-probe-stale-definition",
        },
        actor,
      );
      assert.deepEqual(
        { outcome: staleClaim.outcome, code: staleClaim.code },
        { outcome: "op_rejected", code: "schedule_definition_stale" },
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
          idempotencyKey: "update-e2e-probe",
        }),
      );
      const updated = await cell.run({ kind: "schedule-update", fromFile: "schedule-update.json" }, actor);
      assert.equal(updated.outcome, "applied", JSON.stringify(updated));
      const shown = (await cell.run(
        { kind: "schedule-show", jsonInput: JSON.stringify({ scheduleId: "e2e-probe" }) },
        actor,
      )) as unknown as {
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
      await waitForFixturePublication(cell, deleted.opId, actor);
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
      const recreatedReceipt = await cell.run(
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
      );
      assert.equal(recreatedReceipt.outcome, "applied", JSON.stringify(recreatedReceipt));
      await waitForFixturePublication(cell, recreatedReceipt.opId, actor);
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
        claimedBeforeDispatch = await cell.run(
          {
            kind: "schedule-claim",
            scheduleId: "restart-heartbeat",
            scheduledFor,
            idempotencyKey: "restart-heartbeat-fire",
          },
          actor,
        );
      assert.equal(claimedBeforeDispatch.outcome, "applied", JSON.stringify(claimedBeforeDispatch));
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
          `${JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "done\nHARNESS-OUTCOME: succeeded" } })}\n` +
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
