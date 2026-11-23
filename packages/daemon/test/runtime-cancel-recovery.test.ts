// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeEventV1 } from "@harness-anything/kernel";
import {
  appendRuntimeWorkerRecord,
  archiveDispatchStream,
  openDispatchStream,
  readDispatchStreamHeaders,
} from "../src/daemon-host/dispatch-stream.ts";
import { cancelRuntime } from "../src/daemon-host/runtime-spawn-control.ts";
import { publishExit } from "../src/daemon-host/runtime-spawn-settlement.ts";
import type { RuntimeSpawnerContext } from "../src/daemon-host/runtime-spawn-context.ts";
import { runtimeSpawnError } from "../src/runtime-engine/runtime-spawn-errors.ts";
import { dispatchLifecycleReadOf, lifecycleEvent } from "./dispatch-lifecycle-read.fixtures.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

const binding = { actor: { principal: { personId: "operator" }, executor: null }, source: "local" as const };

test(
  "cancelRuntime continues owner cancellation when recovery fails after the process group is proven stopped",
  { skip: process.platform === "win32" ? "requires POSIX process-group probe semantics" : false },
  async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cancel-recovery-stopped-"));
    try {
      const dispatchId = "dispatch_919191919191919191919191",
        runtimeSessionId = "runtime_919191919191919191919191",
        published: string[] = [];
      openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "cancel-recovery-stopped");
      appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 2_147_483_647 });
      appendRuntimeWorkerRecord(rootDir, dispatchId, {
        kind: "process_exit",
        occurredAt: "2026-11-02T00:00:05.000Z",
        exitCode: 1,
        signal: null,
      });
      const context = {
        input: {
          rootDir,
          repoId: "cancel-recovery-stopped",
          now: () => "2026-11-02T00:01:00.000Z",
        },
        requiredRuntimeProjection: () => ({
          readRuntimeSession: () => liveSession(runtimeSessionId),
          readDispatchLifecycle: dispatchLifecycleReadOf(() => [
            lifecycleEvent("R", runtimeSessionId, { dispatchId, instanceId: "instance-1", source: "local" }),
            lifecycleEvent("S", runtimeSessionId, { dispatchId, instanceId: "instance-1", source: "local" }),
          ]),
          readRuntimeSessions: () => [liveSession(runtimeSessionId)],
          readRuntimeDispatch: () => ({
            actor: binding.actor,
            source: "local",
            payload: { dispatchId, instanceId: "instance-1" },
          }),
          readRuntimeSessionEvents: () => [],
          readRuntimeSessionEventsByType: () => [
            { type: "runtime_session_liveness_changed", source: "local", payload: { processGroupPid: 2_147_483_647 } },
          ],
        }),
        processes: new Map(),
        exiting: new Set<string>(),
        restoreDurableOutputRecords: async () => undefined,
        reconcileFallback: () => undefined,
        publishExit: async (active: { runtimeSessionId: string }) => {
          context.processes.delete(active.runtimeSessionId);
          throw runtimeSpawnError("runtime_recovery_failed", "simulated adoption publishExit failure");
        },
        publishRuntimeEvent: async (type: string) => {
          if (type === "runtime_session_liveness_changed")
            throw runtimeSpawnError("runtime_recovery_failed", "simulated adoption failure after process exit");
          published.push(type);
          return {};
        },
        controlReceipt: (_opId: string, _runtimeSessionId: string, detail: string) => ({ detail }),
        runtimeSpawnError,
      };
      const receipt = await cancelRuntime(context as never, { runtimeSessionId }, binding);
      assert.equal(receipt.detail, "cancelled");
      assert.deepEqual(published, [
        "runtime_session_exited",
        "runtime_session_cancelled",
        "runtime_session_outcome_observed",
      ]);
    } finally {
      removeTempRepository(rootDir);
    }
  },
);

test(
  "cancelRuntime still fails when recovery fails while the process group remains alive",
  { skip: process.platform === "win32" ? "requires POSIX process-group probe semantics" : false },
  async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cancel-recovery-alive-"));
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const exited = once(child, "exit");
    await once(child, "spawn");
    try {
      const dispatchId = "dispatch_929292929292929292929292",
        runtimeSessionId = "runtime_929292929292929292929292",
        published: string[] = [];
      openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "cancel-recovery-alive");
      appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: child.pid! });
      const context = {
        input: {
          rootDir,
          repoId: "cancel-recovery-alive",
          now: () => "2026-11-02T00:01:00.000Z",
        },
        requiredRuntimeProjection: () => ({
          readRuntimeSession: () => liveSession(runtimeSessionId),
          readDispatchLifecycle: dispatchLifecycleReadOf(() => [
            lifecycleEvent("R", runtimeSessionId, { dispatchId, instanceId: "instance-1", source: "local" }),
            lifecycleEvent("S", runtimeSessionId, { dispatchId, instanceId: "instance-1", source: "local" }),
          ]),
          readRuntimeSessions: () => [liveSession(runtimeSessionId)],
          readRuntimeDispatch: () => ({
            actor: binding.actor,
            source: "local",
            payload: { dispatchId, instanceId: "instance-1" },
          }),
          readRuntimeSessionEvents: () => [],
          readRuntimeSessionEventsByType: () => [
            { type: "runtime_session_liveness_changed", source: "local", payload: { processGroupPid: child.pid } },
          ],
        }),
        processes: new Map(),
        exiting: new Set<string>(),
        restoreDurableOutputRecords: async () => undefined,
        reconcileFallback: () => undefined,
        publishExit: async (active: { runtimeSessionId: string }) => {
          context.processes.delete(active.runtimeSessionId);
          throw runtimeSpawnError("runtime_recovery_failed", "simulated adoption publishExit failure");
        },
        publishRuntimeEvent: async (type: string) => {
          if (type === "runtime_session_liveness_changed")
            throw runtimeSpawnError("runtime_recovery_failed", "simulated adoption failure while process alive");
          published.push(type);
          return {};
        },
        controlReceipt: (_opId: string, _runtimeSessionId: string, detail: string) => ({ detail }),
        runtimeSpawnError,
      };
      await assert.rejects(cancelRuntime(context as never, { runtimeSessionId }, binding), {
        code: "runtime_recovery_failed",
      });
      assert.deepEqual(published, []);
    } finally {
      child.stdin!.end();
      await exited;
      removeTempRepository(rootDir);
    }
  },
);

function openMissingProcessStream(
  rootDir: string,
  dispatchId: string,
  runtimeSessionId: string,
  dispatchOpId: string,
  task: { readonly taskId: string; readonly executionId: string } | null = null,
) {
  openDispatchStream(rootDir, {
    dispatchId,
    taskId: task?.taskId ?? null,
    executionId: task?.executionId ?? null,
    runtimeSessionId,
    instanceId: "instance-1",
    startedAt: "2026-09-13T00:00:00.000Z",
    dispatchOpId,
    kindId: "codex",
    permissionMode: null,
    binding,
    cwd: rootDir,
    prompt: "missing process",
    model: "gpt-5.6-sol",
    reasoningEffort: null,
    fast: false,
  });
}

function liveSession(runtimeSessionId: string) {
  return { runtimeSessionId, instanceId: "instance-1", providerSessionId: null, liveness: "live", outcome: null };
}

test(
  "cancelRuntime settles an exited attempt whose outcome submission failed (phase=settling, stopProof=proven_stopped, outcome=null)",
  { skip: process.platform === "win32" ? "requires POSIX process-group probe semantics" : false },
  async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cancel-settled-exited-"));
    try {
      const dispatchId = "dispatch_939393939393939393939393",
        runtimeSessionId = "runtime_939393939393939393939393",
        events: AgentRuntimeEventV1[] = [
          lifecycleEvent("R", runtimeSessionId, { dispatchId, instanceId: "instance-1", source: "local" }),
          lifecycleEvent("S", runtimeSessionId, { dispatchId, instanceId: "instance-1", source: "local" }),
          lifecycleEvent("X", runtimeSessionId, { dispatchId, instanceId: "instance-1", source: "local" }),
        ],
        published: Array<{
          type: string;
          payload: Record<string, unknown>;
          actor: unknown;
          source: unknown;
          body?: string;
        }> = [];
      openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "cancel-exited-unsettled");
      appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 2_147_483_647 });
      appendRuntimeWorkerRecord(rootDir, dispatchId, {
        kind: "process_exit",
        occurredAt: "2026-11-02T00:00:05.000Z",
        exitCode: 1,
        signal: null,
      });

      const readDispatchLifecycle = dispatchLifecycleReadOf(() => events);
      let failOutcomeSubmission = true;
      let outcomeObserved: string | null = null;
      const context = {
        input: {
          rootDir,
          repoId: "cancel-exited-unsettled",
          now: () => "2026-11-02T00:01:00.000Z",
        },
        requiredRuntimeProjection: () => ({
          readRuntimeSession: () => ({
            runtimeSessionId,
            instanceId: "instance-1",
            providerSessionId: null,
            liveness: "exited",
            outcome: outcomeObserved,
          }),
          readDispatchLifecycle,
          readRuntimeSessions: () => [],
          readRuntimeDispatch: () => ({
            actor: binding.actor,
            source: "local",
            payload: { dispatchId, instanceId: "instance-1" },
          }),
          readRuntimeSessionEvents: () => [],
          readRuntimeSessionEventsByType: () => [
            { type: "runtime_session_liveness_changed", source: "local", payload: { processGroupPid: 2_147_483_647 } },
          ],
        }),
        processes: new Map(),
        exiting: new Set<string>(),
        restoreDurableOutputRecords: async () => undefined,
        reconcileFallback: () => undefined,
        publishExit: async (active: { runtimeSessionId: string }) => {
          context.processes.delete(active.runtimeSessionId);
          throw runtimeSpawnError("runtime_recovery_failed", "simulated adoption publishExit failure");
        },
        publishRuntimeEvent: async (
          type: string,
          payload: Record<string, unknown>,
          _opId: string,
          eventBinding: { actor: unknown; source: unknown },
          body?: string,
        ) => {
          if (type === "runtime_session_outcome_observed" && failOutcomeSubmission)
            throw runtimeSpawnError("runtime_recovery_failed", "simulated outcome submission failure");
          published.push({ type, payload, actor: eventBinding.actor, source: eventBinding.source, body });
          if (type === "runtime_session_outcome_observed") {
            outcomeObserved = String(payload.outcome);
            events.push({
              ...lifecycleEvent("O", runtimeSessionId, { dispatchId, instanceId: "instance-1", source: "local" }),
              payload,
            } as unknown as AgentRuntimeEventV1);
          }
          return {};
        },
        controlReceipt: (_opId: string, _runtimeSessionId: string, detail: string) => ({ detail }),
        runtimeSpawnError,
      };

      const initial = readDispatchLifecycle({ by: "session", runtimeSessionId });
      assert.equal(initial.status, "ready");
      if (initial.status !== "ready") assert.fail("lifecycle must be ready");
      assert.equal(initial.rows[0]?.attempt.phase, "settling");
      assert.equal(initial.rows[0]?.attempt.stopProof, "proven_stopped");
      assert.equal(initial.rows[0]?.attempt.outcome, null);
      assert.equal(initial.rows[0]?.policy.attemptSettled, false);

      // Preserve negative controls: local readable stream refuses --ruling; non-owner / foreign-node refuses with execution_scope_mismatch.
      await assert.rejects(
        cancelRuntime(context as never, { runtimeSessionId, ruling: "cannot rule with local stream" }, binding),
        { code: "runtime_ruling_not_allowed" },
      );
      await assert.rejects(
        cancelRuntime(
          context as never,
          { runtimeSessionId },
          { actor: { principal: { personId: "other-person" }, executor: null }, source: "local" },
        ),
        { code: "execution_scope_mismatch" },
      );
      await assert.rejects(
        cancelRuntime(
          { ...context, input: { ...context.input, runtimeNode: { nodeId: "foreign-node" } } } as never,
          { runtimeSessionId },
          { actor: binding.actor, source: { kind: "node", nodeId: "foreign-node" } },
        ),
        { code: "execution_scope_mismatch" },
      );

      // First owner cancel attempt fails during outcome submission -> stays settling/outcome=null.
      await assert.rejects(cancelRuntime(context as never, { runtimeSessionId }, binding), {
        code: "runtime_recovery_failed",
      });
      const afterFirstFailure = readDispatchLifecycle({ by: "session", runtimeSessionId });
      if (afterFirstFailure.status !== "ready") assert.fail("lifecycle must remain ready");
      assert.equal(afterFirstFailure.rows[0]?.attempt.phase, "settling");
      assert.equal(afterFirstFailure.rows[0]?.attempt.stopProof, "proven_stopped");
      assert.equal(afterFirstFailure.rows[0]?.attempt.outcome, null);

      // Owner retry succeeds and closes the attempt exactly once without duplicating runtime_session_exited.
      failOutcomeSubmission = false;
      const receipt = await cancelRuntime(context as never, { runtimeSessionId }, binding);
      assert.equal(receipt.detail, "cancelled");
      assert.deepEqual(
        published.map((entry) => entry.type),
        ["runtime_session_cancelled", "runtime_session_cancelled", "runtime_session_outcome_observed"],
      );
      const outcomeEvent = published.find((entry) => entry.type === "runtime_session_outcome_observed")!;
      assert.deepEqual(outcomeEvent.actor, {
        principal: { personId: "operator" },
        executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` },
      });
      assert.equal(outcomeEvent.source, "local");
      assert.equal(outcomeEvent.payload.outcome, "cancelled");

      const settled = readDispatchLifecycle({ by: "session", runtimeSessionId });
      if (settled.status !== "ready") assert.fail("lifecycle must remain ready");
      assert.equal(settled.rows[0]?.attempt.phase, "closed");
      assert.equal(settled.rows[0]?.attempt.stopProof, "proven_stopped");
      assert.equal(settled.rows[0]?.attempt.outcome, "cancelled");
      assert.equal(settled.rows[0]?.policy.attemptSettled, true);

      // Subsequent cancel is idempotent and does not publish another outcome.
      const repeated = await cancelRuntime(context as never, { runtimeSessionId }, binding);
      assert.equal(repeated.detail, "already-exited");
      assert.equal(published.filter((entry) => entry.type === "runtime_session_outcome_observed").length, 1);
    } finally {
      removeTempRepository(rootDir);
    }
  },
);

for (const scheduled of [false, true])
  test(
    scheduled
      ? "cancelRuntime restores a scheduled fallback after accepted exit and failed outcome without settling its occurrence"
      : "cancelRuntime preserves the persisted reviewer outcome after accepted exit and failed outcome",
    { skip: process.platform === "win32" ? "requires POSIX process-group probe semantics" : false },
    async () => {
      const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cancel-persisted-reviewer-"));
      try {
        const schedule = scheduled
            ? {
                scheduleId: "schedule-one",
                occurrenceId: "occurrence-one",
                claimFence: "claim-one",
                mode: "detect" as const,
              }
            : null,
          fallbackSchedule = {
            notBeforeAt: "2026-11-02T00:00:07.000Z",
            nextProvider: { instance: "instance-next" },
          },
          expectedOutcome = scheduled ? "failed" : "succeeded",
          dispatchId = "dispatch_949494949494949494949494",
          runtimeSessionId = "runtime_949494949494949494949494",
          events: AgentRuntimeEventV1[] = [
            lifecycleEvent("R", runtimeSessionId, {
              dispatchId,
              instanceId: "instance-1",
              source: "local",
              ...(scheduled ? {} : { role: "reviewer" as const }),
            }),
            lifecycleEvent("S", runtimeSessionId, { dispatchId, instanceId: "instance-1", source: "local" }),
            lifecycleEvent("X", runtimeSessionId, { dispatchId, instanceId: "instance-1", source: "local" }),
          ],
          published: Array<{ type: string; payload: Record<string, unknown>; body?: string }> = [];
        const stream = openDispatchStream(rootDir, {
          dispatchId,
          taskId: scheduled ? null : "task-review-1",
          executionId: scheduled ? null : "exe-review-1",
          ...(schedule ? { schedule } : {}),
          runtimeSessionId,
          instanceId: "instance-1",
          startedAt: "2026-09-13T00:00:00.000Z",
          dispatchOpId: "cancel-persisted-reviewer",
          kindId: "codex",
          permissionMode: "read-only",
          binding,
          cwd: rootDir,
          prompt: "review task",
          model: "gpt-5.6-sol",
          reasoningEffort: null,
          fast: false,
        });
        appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 2_147_483_647 });
        appendRuntimeWorkerRecord(rootDir, dispatchId, {
          kind: "process_exit",
          occurredAt: "2026-11-02T00:00:05.000Z",
          exitCode: 0,
          signal: null,
        });
        const body = scheduled
            ? "Provider failed and the fallback was scheduled."
            : "Reviewer verdict and report registered.",
          resultSha = createHash("sha256").update(body).digest("hex");
        stream.appendTerminalOutcome(
          {
            payload: {
              runtimeSessionId,
              outcome: expectedOutcome,
              exitCode: scheduled ? 1 : 0,
              ...(scheduled
                ? {
                    attempt: {
                      classification: "provider_fault" as const,
                      reason: body,
                      fallbackState: "scheduled" as const,
                      fallbackSchedule,
                    },
                  }
                : {}),
              resultRef: `artifact:runtime-result/sha256/${resultSha}`,
              result: {
                sha256: resultSha,
                size: Buffer.byteLength(body),
                mediaType: "text/plain; charset=utf-8",
              },
              dispatchId,
              endedAt: "2026-11-02T00:00:06.000Z",
            },
            body: body,
            reason: body,
            processGroupPid: 2_147_483_647,
          },
          "2026-11-02T00:00:06.000Z",
        );

        const readDispatchLifecycle = dispatchLifecycleReadOf(() => events);
        let outcomeObserved: string | null = null;
        let failOutcomeSubmission = scheduled;
        let activeClaim = schedule?.claimFence ?? null;
        const reconciled: string[] = [];
        const context = {
          input: {
            rootDir,
            repoId: "cancel-persisted-reviewer",
            now: () => "2026-11-02T00:01:00.000Z",
            onAttemptTerminal: (terminal: { schedule: typeof schedule }) => {
              if (terminal.schedule?.claimFence === activeClaim) activeClaim = null;
            },
          },
          requiredRuntimeProjection: () => ({
            readRuntimeSession: () => ({
              runtimeSessionId,
              instanceId: "instance-1",
              providerSessionId: null,
              liveness: "exited",
              outcome: outcomeObserved,
            }),
            readDispatchLifecycle,
            readRuntimeSessions: () => [],
            readRuntimeDispatch: () => ({
              actor: binding.actor,
              source: "local",
              payload: { dispatchId, instanceId: "instance-1" },
            }),
            readRuntimeSessionEvents: () => [],
            readRuntimeSessionEventsByType: () => [
              {
                type: "runtime_session_liveness_changed",
                source: "local",
                payload: { processGroupPid: 2_147_483_647 },
              },
            ],
          }),
          processes: new Map(),
          exiting: new Set<string>(),
          restoreDurableOutputRecords: async () => undefined,
          reconcileFallback: (id: string) => {
            reconciled.push(id);
          },
          publishExit: async (active: Parameters<RuntimeSpawnerContext["publishExit"]>[0], code: number | null) => {
            if ("terminal" in active) return publishExit(context as never, active, code);
            context.processes.delete(active.runtimeSessionId);
            throw runtimeSpawnError("runtime_recovery_failed", "simulated adoption publishExit failure");
          },
          publishRuntimeEvent: async (
            type: string,
            payload: Record<string, unknown>,
            _opId: string,
            _eventBinding: unknown,
            body?: string,
          ) => {
            if (type === "runtime_session_outcome_observed" && failOutcomeSubmission)
              throw runtimeSpawnError("runtime_recovery_failed", "simulated fallback outcome submission failure");
            published.push({ type, payload, body });
            if (type === "runtime_session_outcome_observed") {
              outcomeObserved = String(payload.outcome);
              events.push({
                ...lifecycleEvent("O", runtimeSessionId, { dispatchId, instanceId: "instance-1", source: "local" }),
                payload,
              } as unknown as AgentRuntimeEventV1);
            }
            return {};
          },
          controlReceipt: (_opId: string, _runtimeSessionId: string, detail: string) => ({ detail }),
          runtimeSpawnError,
        };

        if (scheduled) {
          await assert.rejects(cancelRuntime(context as never, { runtimeSessionId }, binding), {
            code: "runtime_recovery_failed",
          });
          const beforeReplay = readDispatchLifecycle({ by: "session", runtimeSessionId });
          assert.ok(beforeReplay.status === "ready");
          assert.equal(beforeReplay.rows[0]?.attempt.stopProof, "proven_stopped");
          assert.equal(beforeReplay.rows[0]?.attempt.outcome, null);
          assert.deepEqual(published, []);
          failOutcomeSubmission = false;
        }

        const receipt = await cancelRuntime(context as never, { runtimeSessionId }, binding);
        assert.equal(receipt.detail, "already-exited");
        assert.deepEqual(
          published.map((entry) => entry.type),
          ["runtime_session_outcome_observed"],
        );
        assert.equal(published[0]!.payload.outcome, expectedOutcome);
        assert.equal(published[0]!.payload.resultRef, `artifact:runtime-result/sha256/${resultSha}`);
        assert.equal(published[0]!.body, body);

        const settled = readDispatchLifecycle({ by: "session", runtimeSessionId });
        if (settled.status !== "ready") assert.fail("lifecycle must remain ready");
        assert.equal(settled.rows[0]?.attempt.phase, "closed");
        assert.equal(settled.rows[0]?.attempt.stopProof, "proven_stopped");
        assert.equal(settled.rows[0]?.attempt.outcome, expectedOutcome);
        if (schedule) {
          assert.equal(settled.rows[0]?.groupPhase, "waiting_backoff");
          assert.equal(activeClaim, schedule.claimFence, "the fallback still owns the scheduled occurrence");
          assert.deepEqual(reconciled, [dispatchId]);
          assert.deepEqual(settled.rows[0]?.successor.schedule, fallbackSchedule);
          const nextDispatchId = "dispatch_959595959595959595959595";
          events.push(
            lifecycleEvent("R", "runtime_959595959595959595959595", {
              dispatchId: nextDispatchId,
              attemptGroupId: dispatchId,
              instanceId: "instance-next",
              source: "local",
            }),
          );
          const continued = readDispatchLifecycle({ by: "group", attemptGroupId: dispatchId });
          assert.ok(continued.status === "ready");
          assert.equal(continued.rows[0]?.controlLeafDispatchId, nextDispatchId);
        }

        const repeated = await cancelRuntime(context as never, { runtimeSessionId }, binding);
        assert.equal(repeated.detail, "already-exited");
        assert.equal(published.length, 1);
      } finally {
        removeTempRepository(rootDir);
      }
    },
  );

/** A running attempt whose local stream was archived or removed before any terminal outcome landed. */
function unsettledWithoutLiveStream(
  t: test.TestContext,
  stream: "archived" | "missing",
  recordedGroupPid: number | null,
) {
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-cancel-${stream}-unsettled-`));
  t.after(() => removeTempRepository(rootDir));
  const dispatchId = "dispatch_969696969696969696969696",
    runtimeSessionId = "runtime_969696969696969696969696",
    ids = { dispatchId, instanceId: "instance-1", source: "local" as const },
    events: AgentRuntimeEventV1[] = [
      lifecycleEvent("R", runtimeSessionId, ids),
      lifecycleEvent("S", runtimeSessionId, ids),
    ],
    published: Array<{ type: string; payload: Record<string, unknown>; body?: string }> = [];
  if (stream === "archived") {
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "cancel-archived-unsettled");
    archiveDispatchStream(rootDir, dispatchId);
    assert.deepEqual(readDispatchStreamHeaders(rootDir), [], "the fixture stream has no live copy");
    assert.equal(readDispatchStreamHeaders(rootDir, true).length, 1, "the fixture stream is archived");
  }
  const readDispatchLifecycle = dispatchLifecycleReadOf(() => events);
  let outcome: string | null = null;
  const context = {
    input: { rootDir, repoId: `cancel-${stream}-unsettled`, now: () => "2026-11-19T00:00:00.000Z" },
    requiredRuntimeProjection: () => ({
      readRuntimeSession: () => ({ ...liveSession(runtimeSessionId), outcome }),
      readDispatchLifecycle,
      readRuntimeSessions: () => [],
      readRuntimeDispatch: () => ({
        actor: binding.actor,
        source: "local",
        payload: { dispatchId, instanceId: "instance-1" },
      }),
      readRuntimeSessionEvents: () => [],
      readRuntimeSessionEventsByType: () =>
        recordedGroupPid === null
          ? []
          : [
              {
                type: "runtime_session_liveness_changed",
                source: "local",
                payload: { processGroupPid: recordedGroupPid },
              },
            ],
    }),
    processes: new Map(),
    exiting: new Set<string>(),
    ownsModelSlot: () => false,
    publishExit: async () => assert.fail("a stream without a live copy must not be adopted"),
    publishRuntimeEvent: async (
      type: string,
      payload: Record<string, unknown>,
      _opId: string,
      _eventBinding: unknown,
      body?: string,
    ) => {
      published.push({ type, payload, body });
      if (type === "runtime_session_outcome_observed") {
        outcome = String(payload.outcome);
        events.push({ ...lifecycleEvent("O", runtimeSessionId, ids), payload } as unknown as AgentRuntimeEventV1);
      }
      return {};
    },
    controlReceipt: (_opId: string, _runtimeSessionId: string, detail: string) => ({ detail }),
    runtimeSpawnError,
  };
  return { rootDir, dispatchId, runtimeSessionId, context, published };
}

test("an archived stream without a terminal outcome is not adopted and accepts the owner ruling", async (t) => {
  const f = unsettledWithoutLiveStream(t, "archived", null);
  await assert.rejects(cancelRuntime(f.context as never, { runtimeSessionId: f.runtimeSessionId }, binding), {
    code: "runtime_process_group_unproven",
  });
  assert.deepEqual(f.published, [], "an unproven stop publishes nothing");
  assert.deepEqual(readDispatchStreamHeaders(f.rootDir), [], "cancellation must not reopen the archived stream");
  const reason = "Owner abandons the archived dispatch that never published its outcome.";
  const receipt = await cancelRuntime(
    f.context as never,
    { runtimeSessionId: f.runtimeSessionId, ruling: reason },
    binding,
  );
  assert.equal(receipt.detail, "ruling_resolved");
  assert.deepEqual(
    f.published.map(({ type }) => type),
    ["runtime_session_outcome_observed"],
  );
  assert.equal(f.published[0]!.payload.reasonCode, "ruling_resolved");
  assert.equal(f.published[0]!.payload.dispatchId, f.dispatchId);
  assert.equal(JSON.parse(f.published[0]!.body!).processStop, "unproven");
  assert.deepEqual(readDispatchStreamHeaders(f.rootDir), [], "the ruling must not reopen the archived stream");
  const repeated = await cancelRuntime(
    f.context as never,
    { runtimeSessionId: f.runtimeSessionId, ruling: reason },
    binding,
  );
  assert.equal(repeated.detail, "already-exited");
  assert.equal(f.published.length, 1, "a repeated ruling appends no second terminal event");
});

for (const stream of ["archived", "missing"] as const)
  test(`an owner ruling over a ${stream} stream still refuses a recorded group whose leader is alive`, async (t) => {
    const f = unsettledWithoutLiveStream(t, stream, process.pid);
    await assert.rejects(
      cancelRuntime(f.context as never, { runtimeSessionId: f.runtimeSessionId, ruling: "Abandon dispatch" }, binding),
      { code: "runtime_ruling_not_allowed" },
    );
    assert.deepEqual(f.published, []);
    assert.deepEqual(readDispatchStreamHeaders(f.rootDir), [], "a refused ruling must not reopen a stream");
  });

test("an owner ruling over a missing stream is not blocked by a recorded group whose leader is gone", async (t) => {
  const f = unsettledWithoutLiveStream(t, "missing", 2_147_483_647);
  const receipt = await cancelRuntime(
    f.context as never,
    { runtimeSessionId: f.runtimeSessionId, ruling: "Owner abandons the dispatch whose stream was pruned." },
    binding,
  );
  if (process.platform === "win32") {
    // Windows cannot observe a group without its local containment witness: only the ruling closes it.
    assert.equal(receipt.detail, "ruling_resolved");
    assert.deepEqual(
      f.published.map(({ type }) => type),
      ["runtime_session_outcome_observed"],
    );
    assert.equal(f.published[0]!.payload.reasonCode, "ruling_resolved");
  } else {
    // POSIX proves the vanished group stopped, so the ruling request settles as a proven cancellation.
    assert.equal(receipt.detail, "cancelled");
    assert.deepEqual(
      f.published.map(({ type }) => type),
      ["runtime_session_exited", "runtime_session_cancelled", "runtime_session_outcome_observed"],
    );
    assert.equal(f.published.at(-1)!.payload.outcome, "cancelled");
  }
});
