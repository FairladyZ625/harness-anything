// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  parseCanonicalEvent,
  serializeCanonicalEvent,
  taskLifecycleWritePlan,
  type AgentRuntimeEventV1,
  type TaskProjection,
} from "@harness-anything/kernel";
import {
  validateAgentRuntimeEvent,
  validateCurrentAgentRuntimeEvent,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import {
  canonicalEventWritePlan,
  makeTaskEventStore,
  makeTaskProjection,
  readLegacyMigrationSource,
} from "@harness-anything/storage";
import {
  readAgentRuntimeTokenUsage,
  readAgentRuntimeTokenUsageDetail,
  validateAgentRuntimeTokenUsage,
  validateAgentRuntimeTokenUsageDetail,
} from "../src/daemon-host/agent-runtime-token-usage.ts";
import { archiveRuntimeDispatch } from "../src/daemon-host/doc-sync-publication.ts";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/daemon-host/dispatch-stream.ts";
import { modelPriceOf, usageCostUsd } from "../src/runtime-engine/agent-runtime-model-pricing.ts";

const DEFINITION_SNAPSHOT = {
  schema: "agent-definition-snapshot/v1" as const,
  configVersion: 1,
  instanceId: "instance-ha13",
  installationId: "install-ha13",
  kindId: "claude-code",
  providerId: "anthropic",
  model: "claude-haiku-4-5",
  reasoningEffort: null,
  endpointKind: "official" as const,
  baseUrlHash: null,
  authMode: "subscription" as const,
};

function makeRepoRoot(prefix: string): {
  readonly rootDir: string;
  readonly store: ReturnType<typeof makeTaskEventStore>;
  readonly projection: TaskProjection;
  nextRevision: () => number;
} {
  const rootDir = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: ha13-compat\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  const store = makeTaskEventStore({ rootDir, repoId: "ha13-compat" }),
    projection = makeTaskProjection({ rootDir, eventStore: store });
  let rev = 0;
  return {
    rootDir,
    store,
    projection,
    nextRevision: () => {
      rev += 1;
      return rev;
    },
  };
}

function appendDispatch(
  repo: ReturnType<typeof makeRepoRoot>,
  options: {
    readonly dispatchId: string;
    readonly runtimeSessionId: string;
    readonly agentId: string;
    readonly agentName?: string;
    readonly personId?: string;
    readonly startedAt: string;
    readonly taskId?: string;
    readonly executionId?: string;
    readonly model?: string;
    readonly settle?: {
      readonly endedAt: string;
      readonly inputTokens: number;
      readonly cacheReadTokens: number;
      readonly outputTokens: number;
      readonly toolCallCount: number;
      readonly usageUnavailable?: boolean;
    };
  },
): { readonly dispatchRevision: number; readonly outcomeRevision: number | null } {
  const dispatchRev = repo.nextRevision(),
    actor = { principal: { personId: options.personId ?? "person-a" }, executor: null },
    dispatchEvent: AgentRuntimeEventV1 = {
      schema: "agent-runtime-event/v1",
      eventId: `event-req-${options.dispatchId}`,
      opId: `op-req-${options.dispatchId}`,
      workspaceRevision: dispatchRev,
      occurredAt: options.startedAt,
      actor,
      source: "local",
      type: "runtime_dispatch_requested",
      payload: {
        dispatchId: options.dispatchId,
        runtimeSessionId: options.runtimeSessionId,
        instanceId: DEFINITION_SNAPSHOT.instanceId,
        installationId: DEFINITION_SNAPSHOT.installationId,
        kindId: DEFINITION_SNAPSHOT.kindId,
        dispatchKey: `key-${options.dispatchId}`,
        definitionSnapshotRef: "artifact:runtime-definition/ha13",
        startedAt: options.startedAt,
        ...(options.taskId ? { taskId: options.taskId } : {}),
        ...(options.executionId ? { executionId: options.executionId } : {}),
        agentId: options.agentId,
        agentName: options.agentName ?? options.agentId,
        definitionSnapshot: { ...DEFINITION_SNAPSHOT, ...(options.model ? { model: options.model } : {}) },
      },
    };
  const dispatchPlan = canonicalEventWritePlan(dispatchEvent, "agent-runtime/v1", dispatchEvent.opId);
  repo.store.append({ event: dispatchEvent, plan: dispatchPlan, blobs: [] });
  repo.projection.apply(dispatchEvent, dispatchPlan);
  if (!options.settle) return { dispatchRevision: dispatchRev, outcomeRevision: null };

  const body = `settled ${options.dispatchId}\n`,
    sha256 = createHash("sha256").update(body).digest("hex"),
    outcomeRev = repo.nextRevision(),
    outcomeEvent: AgentRuntimeEventV1 = {
      schema: "agent-runtime-event/v1",
      eventId: `event-out-${options.dispatchId}`,
      opId: `op-out-${options.dispatchId}`,
      workspaceRevision: outcomeRev,
      occurredAt: options.settle.endedAt,
      actor,
      source: "local",
      type: "runtime_session_outcome_observed",
      payload: {
        runtimeSessionId: options.runtimeSessionId,
        dispatchId: options.dispatchId,
        outcome: "succeeded",
        exitCode: 0,
        resultRef: `artifact:runtime-result/sha256/${sha256}`,
        result: { sha256, size: Buffer.byteLength(body), mediaType: "text/plain; charset=utf-8" },
        endedAt: options.settle.endedAt,
        runtimeMetrics: {
          inputTokens: options.settle.inputTokens,
          cacheReadTokens: options.settle.cacheReadTokens,
          outputTokens: options.settle.outputTokens,
          totalTokens: options.settle.inputTokens + options.settle.outputTokens,
          toolCallCount: options.settle.toolCallCount,
          usageUnavailable: options.settle.usageUnavailable ?? false,
        },
      },
    };
  const outcomePlan = canonicalEventWritePlan(outcomeEvent, "agent-runtime/v1", outcomeEvent.opId);
  repo.store.append({
    event: outcomeEvent,
    plan: outcomePlan,
    blobs: [{ sha256, size: Buffer.byteLength(body), mediaType: "text/plain; charset=utf-8", body }],
  });
  repo.projection.apply(outcomeEvent, outcomePlan);
  return { dispatchRevision: dispatchRev, outcomeRevision: outcomeRev };
}

function appendTaskCreated(repo: ReturnType<typeof makeRepoRoot>, taskId: string, executionId: string): void {
  const events = lifecycleFixture({ taskId, executionId }).events.slice(0, 2);
  for (const event of events) {
    repo.nextRevision();
    const plan = taskLifecycleWritePlan(event);
    repo.store.append({ event, plan, blobs: [] });
    repo.projection.apply(event, plan);
  }
}

/** Exact baseline (bb7e55c9) 12-key tokenUsageDetail validator for F10 wire-compatibility proof. */
function isBaseline12KeyTokenUsageDetail(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>,
    keys = Object.keys(record).sort();
  return (
    keys.length === 12 &&
    !Object.hasOwn(record, "page") &&
    JSON.stringify(keys) ===
      JSON.stringify([
        "bucketMs",
        "buckets",
        "member",
        "ok",
        "pricing",
        "range",
        "sessions",
        "since",
        "sourceRevision",
        "status",
        "totals",
        "watermark",
      ]) &&
    validateAgentRuntimeTokenUsageDetail(value).length === 0
  );
}

/** Exact baseline (bb7e55c9) 6-key runtimeMetrics validator for F12 rollback/cold-rebuild proof. */
function isBaseline6KeyRuntimeMetrics(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    keys.length === 6 &&
    JSON.stringify(keys) ===
      JSON.stringify([
        "cacheReadTokens",
        "inputTokens",
        "outputTokens",
        "toolCallCount",
        "totalTokens",
        "usageUnavailable",
      ])
  );
}

test("F10: unpaginated tokenUsageDetail returns >500 sessions in exact baseline 12-key shape without truncation", () => {
  const repo = makeRepoRoot("ha-f10-unpaginated-");
  try {
    const baseMs = Date.parse("2026-09-14T02:00:00.000Z"),
      nowIso = "2026-09-14T12:00:00.000Z",
      total = 520;
    for (let i = 0; i < total; i += 1) {
      const startedAt = new Date(baseMs + i * 1_000).toISOString(),
        endedAt = new Date(baseMs + i * 1_000 + 500).toISOString();
      appendDispatch(repo, {
        dispatchId: `dispatch_${String(i + 1).padStart(24, "0")}`,
        runtimeSessionId: `runtime-f10-${i + 1}`,
        agentId: "agent-f10",
        agentName: "Agent F10",
        startedAt,
        settle: {
          endedAt,
          inputTokens: 100,
          cacheReadTokens: 10,
          outputTokens: 50,
          toolCallCount: 1,
        },
      });
    }
    const cut = repo.projection.readCut();
    // Unpaginated call (GUI & legacy consumers): returns ALL 520 sessions and exact 12 keys (no `page`).
    const full = readAgentRuntimeTokenUsageDetail({
      rootDir: repo.rootDir,
      now: nowIso,
      range: "today",
      member: { kind: "agent", agentId: "agent-f10" },
      entityLabel: () => null,
      cut,
      projection: repo.projection,
    });
    assert.equal(full.sessions.length, total, "unpaginated detail must not truncate at 500 sessions");
    assert.equal(full.totals.sessionCount, total);
    assert.equal(Object.hasOwn(full, "page"), false, "unpaginated response must omit 13th key `page`");
    assert.equal(isBaseline12KeyTokenUsageDetail(full), true, "unpaginated response must pass baseline 12-key decoder");

    // Explicit paginated call: returns bounded page with 13th key `page`.
    const paged = readAgentRuntimeTokenUsageDetail({
      rootDir: repo.rootDir,
      now: nowIso,
      range: "today",
      member: { kind: "agent", agentId: "agent-f10" },
      limit: 50,
      entityLabel: () => null,
      cut,
      projection: repo.projection,
    });
    assert.equal(paged.sessions.length, 50);
    assert.equal(Object.keys(paged).length, 13);
    assert.equal(paged.page?.limit, 50);
    assert.equal(paged.page?.cursor, null);
    assert.ok(paged.page?.nextCursor);
    assert.deepEqual(validateAgentRuntimeTokenUsageDetail(paged), []);
  } finally {
    repo.projection.close();
    rmSync(repo.rootDir, { recursive: true, force: true });
  }
});

test("F12: two-step expand-and-contract keeps canonical events baseline 6-key + 0-issue cold rebuild while Edge archive delivers exact cacheWriteTokens pricing", () => {
  const repo = makeRepoRoot("ha-f12-expand-contract-");
  try {
    const taskId = "task_00000000000000000000f120",
      executionId = "exe_00000000000000000000f120",
      startedAt = "2026-09-14T10:00:00.000Z",
      endedAt = "2026-09-14T10:05:00.000Z",
      nowIso = "2026-09-14T12:00:00.000Z";
    appendTaskCreated(repo, taskId, executionId);

    // 1) Validator expand-and-contract checks:
    //    - Current writer validator rejects 7-key runtimeMetrics (prevents premature writes during N-1 window).
    //    - Persisted reader validator accepts both 6-key and optional 7-key (expand phase).
    const sampleBody = "sample outcome\n",
      sampleSha = createHash("sha256").update(sampleBody).digest("hex"),
      sevenKeyEvent: AgentRuntimeEventV1 = {
        schema: "agent-runtime-event/v1",
        eventId: "event-seven-key-check",
        opId: "op-seven-key-check",
        workspaceRevision: 99,
        occurredAt: endedAt,
        actor: { principal: { personId: "person-a" }, executor: null },
        source: "local",
        type: "runtime_session_outcome_observed",
        payload: {
          runtimeSessionId: "runtime-seven-key",
          dispatchId: "dispatch_00000000000000000000f129",
          outcome: "succeeded",
          exitCode: 0,
          resultRef: `artifact:runtime-result/sha256/${sampleSha}`,
          result: { sha256: sampleSha, size: Buffer.byteLength(sampleBody), mediaType: "text/plain; charset=utf-8" },
          endedAt,
          runtimeMetrics: {
            inputTokens: 10_000,
            cacheReadTokens: 2_000,
            cacheWriteTokens: 4_000,
            outputTokens: 1_000,
            totalTokens: 11_000,
            toolCallCount: 5,
            usageUnavailable: false,
          },
        },
      };
    assert.ok(
      validateCurrentAgentRuntimeEvent(sevenKeyEvent).length > 0,
      "current write validator must reject 7th key cacheWriteTokens during N-1 expand window",
    );
    assert.deepEqual(
      validateAgentRuntimeEvent(sevenKeyEvent),
      [],
      "persisted event reader must accept optional cacheWriteTokens (expand phase)",
    );

    // 2) Seed 3 Edge dispatches (zero center-local stream files):
    //    - edgeItemized: archived with cacheWriteTokens: 4_000 -> exact differential pricing!
    //    - edgeUnreported: archived without cacheWriteTokens -> cacheWriteUnreportedDispatches = 1
    //    - edgeUnarchived: NO archive, pure 6-key canonical outcome -> cacheWriteUnitemizedDispatches = 1
    const edgeItemized = { dispatchId: "dispatch_00000000000000000000f121", sessionId: "runtime-f12-itemized" },
      edgeUnreported = { dispatchId: "dispatch_00000000000000000000f122", sessionId: "runtime-f12-unreported" },
      edgeUnarchived = { dispatchId: "dispatch_00000000000000000000f123", sessionId: "runtime-f12-unarchived" };

    appendDispatch(repo, {
      dispatchId: edgeItemized.dispatchId,
      runtimeSessionId: edgeItemized.sessionId,
      agentId: "agent-edge-f12",
      startedAt,
      taskId,
      executionId,
      settle: { endedAt, inputTokens: 10_000, cacheReadTokens: 2_000, outputTokens: 1_000, toolCallCount: 4 },
    });
    appendDispatch(repo, {
      dispatchId: edgeUnreported.dispatchId,
      runtimeSessionId: edgeUnreported.sessionId,
      agentId: "agent-edge-f12",
      startedAt: "2026-09-14T10:01:00.000Z",
      taskId,
      executionId,
      settle: { endedAt, inputTokens: 2_000, cacheReadTokens: 0, outputTokens: 500, toolCallCount: 2 },
    });
    appendDispatch(repo, {
      dispatchId: edgeUnarchived.dispatchId,
      runtimeSessionId: edgeUnarchived.sessionId,
      agentId: "agent-edge-f12",
      startedAt: "2026-09-14T10:02:00.000Z",
      taskId,
      executionId,
      settle: { endedAt, inputTokens: 1_000, cacheReadTokens: 0, outputTokens: 200, toolCallCount: 1 },
    });

    const publishArchive = (
      entry: { readonly dispatchId: string; readonly sessionId: string },
      runtimeMetrics: {
        readonly inputTokens: number;
        readonly cacheReadTokens: number;
        readonly cacheWriteTokens?: number;
        readonly outputTokens: number;
        readonly totalTokens: number;
        readonly toolCallCount: number;
        readonly usageUnavailable: boolean;
      },
    ) => {
      const resultText = `archive result ${entry.dispatchId}\n`,
        sha = createHash("sha256").update(resultText).digest("hex"),
        receipt = archiveRuntimeDispatch({
          workspaceId: "ha13-compat",
          rootDir: repo.rootDir,
          store: repo.store,
          projection: repo.projection,
          binding: {
            actor: {
              principal: { personId: "person-a" },
              executor: { id: `runtime-session:${entry.sessionId}`, kind: "agent" },
            },
            source: "local",
            authorizationDecision: {
              policyRef: "policy/local-test",
              actor: {
                principal: { personId: "person-a" },
                executor: { id: `runtime-session:${entry.sessionId}`, kind: "agent" },
              },
              subject: `task/${taskId}`,
              bindingsUsed: [],
              outcome: "allowed",
              reasonCodes: ["allowed"],
              nextActions: [],
              evaluatedAtCut: `canonical:${repo.projection.readCut().watermark}`,
            },
          },
          now: () => endedAt,
          archive: {
            dispatchId: entry.dispatchId,
            taskId,
            executionId,
            agentId: "agent-edge-f12",
            agentName: "Agent Edge F12",
            instanceId: DEFINITION_SNAPSHOT.instanceId,
            model: DEFINITION_SNAPSHOT.model,
            reasoningEffort: null,
            fast: false,
            cwd: "/edge/workspace",
            prompt: `prompt ${entry.dispatchId}`,
            runtimeSessionId: entry.sessionId,
            providerSessionId: null,
            startedAt,
            endedAt,
            outcome: "succeeded",
            exitCode: 0,
            resultRef: `artifact:runtime-result/sha256/${sha}`,
            resultText,
            runtimeMetrics,
            attemptGroupId: entry.dispatchId,
            attemptIndex: 0,
            provider: { instance: DEFINITION_SNAPSHOT.instanceId, model: DEFINITION_SNAPSHOT.model },
            classification: "worker_stop",
            reason: "Worker completed the attempt successfully.",
          },
        });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    };

    publishArchive(edgeItemized, {
      inputTokens: 10_000,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 4_000,
      outputTokens: 1_000,
      totalTokens: 11_000,
      toolCallCount: 4,
      usageUnavailable: false,
    });
    publishArchive(edgeUnreported, {
      inputTokens: 2_000,
      cacheReadTokens: 0,
      outputTokens: 500,
      totalTokens: 2_500,
      toolCallCount: 2,
      usageUnavailable: false,
    });

    // 3) Verify EVERY persisted canonical event passes baseline 6-key decoder AND cold rebuild has 0 issues!
    const persistedEvents = repo.store.read().events;
    assert.ok(persistedEvents.length > 0);
    const legacyRoot = mkdtempSync(path.join(tmpdir(), "ha-f12-legacy-rebuild-"));
    try {
      mkdirSync(path.join(legacyRoot, "harness/events"), { recursive: true });
      writeFileSync(
        path.join(legacyRoot, "harness/harness.yaml"),
        "schema: harness-anything/v1\nname: ha13-compat\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
      );
      let outcomeCount = 0;
      for (const event of persistedEvents) {
        const body = serializeCanonicalEvent(event),
          parsed = parseCanonicalEvent(body);
        assert.equal(serializeCanonicalEvent(parsed), body);
        if (parsed.schema === "agent-runtime-event/v1" && parsed.type === "runtime_session_outcome_observed") {
          outcomeCount += 1;
          assert.equal(
            isBaseline6KeyRuntimeMetrics(parsed.payload.runtimeMetrics),
            true,
            `persisted outcome ${parsed.eventId} must stay strictly 6-key for N-1 baseline compatibility`,
          );
          assert.deepEqual(validateCurrentAgentRuntimeEvent(parsed), []);
        }
        const plan = canonicalEventWritePlan(
            event,
            event.schema === "task-event/v1"
              ? "task/v1"
              : event.schema === "doc-event/v1"
                ? "doc/v1"
                : "agent-runtime/v1",
            event.opId,
          ),
          eventTarget = plan.targets.find((target) => target.kind === "event_file"),
          fullPath = path.join(legacyRoot, eventTarget!.path);
        mkdirSync(path.dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, body);
      }
      assert.equal(outcomeCount, 3);

      const coldSource = readLegacyMigrationSource(legacyRoot);
      assert.equal(coldSource.complete, true, "cold rebuild must complete cleanly");
      assert.deepEqual(coldSource.issues, [], "cold rebuild must decode all newly written events with zero issues");
    } finally {
      rmSync(legacyRoot, { recursive: true, force: true });
    }

    // 4) Verify Center tokenUsage & tokenUsageDetail (with ZERO local stream files) compute exact
    //    differential cache-write pricing from archived JSON + classify unarchived 6-key as unitemized!
    const price = modelPriceOf("claude-haiku-4-5")!;
    assert.ok(price && price.cacheWritePerMillion !== price.inputPerMillion);
    const expectedCost =
      usageCostUsd(price, {
        inputTokens: 10_000,
        cacheReadTokens: 2_000,
        cacheWriteTokens: 4_000,
        outputTokens: 1_000,
      }) +
      usageCostUsd(price, { inputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500 }) +
      usageCostUsd(price, { inputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200 });
    const cut = repo.projection.readCut();
    const agg = readAgentRuntimeTokenUsage({
      rootDir: repo.rootDir,
      now: nowIso,
      range: "today",
      entityLabel: () => null,
      taskOf: () => undefined,
      cut,
      projection: repo.projection,
    });
    assert.deepEqual(validateAgentRuntimeTokenUsage(agg), []);
    assert.equal(agg.totals.cacheWriteTokens, 4_000);
    assert.equal(agg.totals.cacheWriteUnreportedDispatches, 1);
    assert.equal(agg.totals.cacheWriteUnitemizedDispatches, 1);
    assert.ok(
      Math.abs(agg.totals.costUsd - expectedCost) < 1e-12,
      `expected exact differential cost ${expectedCost}, got ${agg.totals.costUsd}`,
    );

    const detail = readAgentRuntimeTokenUsageDetail({
      rootDir: repo.rootDir,
      now: nowIso,
      range: "today",
      member: { kind: "agent", agentId: "agent-edge-f12" },
      entityLabel: () => null,
      cut,
      projection: repo.projection,
    });
    assert.deepEqual(validateAgentRuntimeTokenUsageDetail(detail), []);
    assert.equal(detail.totals.cacheWriteTokens, 4_000);
    assert.equal(detail.totals.cacheWriteUnreportedDispatches, 1);
    assert.equal(detail.totals.cacheWriteUnitemizedDispatches, 1);
    assert.ok(Math.abs(detail.totals.costUsd - expectedCost) < 1e-12);
    assert.equal(detail.sessions.find((s) => s.dispatchId === edgeItemized.dispatchId)?.cacheWriteTokens, 4_000);
  } finally {
    repo.projection.close();
    rmSync(repo.rootDir, { recursive: true, force: true });
  }
});

test("F13: detail cursor pins [sinceMs, untilMs] and projection cut across local midnight and mid-pagination writes", () => {
  const repo = makeRepoRoot("ha-f13-cursor-pin-");
  try {
    // Use local-time dates so crossing local midnight works identically in any timezone (UTC or +08:00).
    const localIso = (day: number, hour: number, minute: number, second = 0) =>
        new Date(2026, 8, day, hour, minute, second).toISOString(),
      beforeMidnightNow = localIso(14, 23, 59, 30),
      afterMidnightNow = localIso(15, 0, 5, 0);

    const initialDispatches = [
      { id: "dispatch_00000000000000000000f131", at: localIso(14, 23, 10), settle: false },
      { id: "dispatch_00000000000000000000f132", at: localIso(14, 23, 20), settle: true },
      { id: "dispatch_00000000000000000000f133", at: localIso(14, 23, 30), settle: true },
      { id: "dispatch_00000000000000000000f134", at: localIso(14, 23, 40), settle: true },
      { id: "dispatch_00000000000000000000f135", at: localIso(14, 23, 50), settle: true },
    ];
    for (const entry of initialDispatches) {
      appendDispatch(repo, {
        dispatchId: entry.id,
        runtimeSessionId: `runtime-${entry.id}`,
        agentId: "agent-f13",
        personId: "person-a",
        startedAt: entry.at,
        ...(entry.settle
          ? {
              settle: {
                endedAt: new Date(Date.parse(entry.at) + 30_000).toISOString(),
                inputTokens: 1_000,
                cacheReadTokens: 100,
                outputTokens: 200,
                toolCallCount: 2,
              },
            }
          : {}),
      });
    }
    const page1Cut = repo.projection.readCut(),
      page1 = readAgentRuntimeTokenUsageDetail({
        rootDir: repo.rootDir,
        now: beforeMidnightNow,
        range: "today",
        member: { kind: "agent", agentId: "agent-f13" },
        personId: "person-a",
        limit: 2,
        entityLabel: () => null,
        cut: page1Cut,
        projection: repo.projection,
      });
    assert.deepEqual(
      page1.sessions.map((row) => row.dispatchId),
      ["dispatch_00000000000000000000f135", "dispatch_00000000000000000000f134"],
    );
    assert.ok(page1.page?.nextCursor);

    // Now cross local midnight AND perform concurrent writes after Page 1:
    // 1) Brand-new post-midnight dispatch on 2026-09-15
    appendDispatch(repo, {
      dispatchId: "dispatch_00000000000000000000f139",
      runtimeSessionId: "runtime-after-midnight",
      agentId: "agent-f13",
      personId: "person-a",
      startedAt: localIso(15, 0, 2),
      settle: {
        endedAt: localIso(15, 0, 3),
        inputTokens: 9_999,
        cacheReadTokens: 0,
        outputTokens: 9_999,
        toolCallCount: 99,
      },
    });
    // 2) Late-arriving dispatch whose startedAt falls INSIDE 2026-09-14 window but at revision > page1Cut.watermark
    appendDispatch(repo, {
      dispatchId: "dispatch_00000000000000000000f138",
      runtimeSessionId: "runtime-backdated-mid-page",
      agentId: "agent-f13",
      personId: "person-a",
      startedAt: localIso(14, 23, 25),
      settle: {
        endedAt: localIso(14, 23, 26),
        inputTokens: 8_888,
        cacheReadTokens: 0,
        outputTokens: 8_888,
        toolCallCount: 88,
      },
    });
    // 3) Settle the previously unsettled 23:10 dispatch at revision > page1Cut.watermark
    const settleRev = repo.nextRevision(),
      settleBody = "late settle\n",
      settleSha = createHash("sha256").update(settleBody).digest("hex"),
      lateOutcome: AgentRuntimeEventV1 = {
        schema: "agent-runtime-event/v1",
        eventId: "event-late-settle-f131",
        opId: "op-late-settle-f131",
        workspaceRevision: settleRev,
        occurredAt: afterMidnightNow,
        actor: { principal: { personId: "person-a" }, executor: null },
        source: "local",
        type: "runtime_session_outcome_observed",
        payload: {
          runtimeSessionId: "runtime-dispatch_00000000000000000000f131",
          dispatchId: "dispatch_00000000000000000000f131",
          outcome: "succeeded",
          exitCode: 0,
          resultRef: `artifact:runtime-result/sha256/${settleSha}`,
          result: { sha256: settleSha, size: Buffer.byteLength(settleBody), mediaType: "text/plain; charset=utf-8" },
          endedAt: afterMidnightNow,
          runtimeMetrics: {
            inputTokens: 7_777,
            cacheReadTokens: 0,
            outputTokens: 7_777,
            toolCallCount: 77,
            totalTokens: 15_554,
            usageUnavailable: false,
          },
        },
      };
    const latePlan = canonicalEventWritePlan(lateOutcome, "agent-runtime/v1", lateOutcome.opId);
    repo.store.append({
      event: lateOutcome,
      plan: latePlan,
      blobs: [
        {
          sha256: settleSha,
          size: Buffer.byteLength(settleBody),
          mediaType: "text/plain; charset=utf-8",
          body: settleBody,
        },
      ],
    });
    repo.projection.apply(lateOutcome, latePlan);

    // Continue pagination AFTER local midnight and AFTER concurrent writes using Page 1's cursor:
    const newCut = repo.projection.readCut();
    assert.ok(newCut.watermark > page1Cut.watermark);
    const collected = [...page1.sessions];
    let cursor = page1.page!.nextCursor!;
    for (let step = 0; step < 5; step += 1) {
      const next = readAgentRuntimeTokenUsageDetail({
        rootDir: repo.rootDir,
        now: afterMidnightNow,
        range: "today",
        member: { kind: "agent", agentId: "agent-f13" },
        personId: "person-a",
        limit: 2,
        cursor,
        entityLabel: () => null,
        cut: newCut,
        projection: repo.projection,
      });
      assert.equal(next.since, page1.since, "continuation page must stay pinned to Page 1 local day across midnight");
      assert.equal(next.watermark, page1.watermark, "continuation page must preserve pinned projection watermark");
      assert.deepEqual(next.totals, page1.totals, "continuation totals must not drift under concurrent writes");
      assert.deepEqual(next.buckets, page1.buckets, "continuation buckets must not drift across midnight");
      collected.push(...next.sessions);
      if (!next.page?.nextCursor) break;
      cursor = next.page.nextCursor;
    }
    assert.deepEqual(
      collected.map((row) => row.dispatchId),
      [
        "dispatch_00000000000000000000f135",
        "dispatch_00000000000000000000f134",
        "dispatch_00000000000000000000f133",
        "dispatch_00000000000000000000f132",
        "dispatch_00000000000000000000f131",
      ],
      "no pre-midnight rows may disappear and no post-Page-1 rows may leak into the cursor stream",
    );
    const tailRow = collected.at(-1)!;
    assert.equal(tailRow.totalTokens, 0, "outcome settled after Page 1 watermark must not leak into Page 3 row");

    // Negative cursor binding checks: mismatched range, member, or personId must be rejected with invalid_cursor.
    for (const mismatch of [
      { range: "7d" as const, member: { kind: "agent" as const, agentId: "agent-f13" }, personId: "person-a" },
      { range: "today" as const, member: { kind: "agent" as const, agentId: "agent-other" }, personId: "person-a" },
      { range: "today" as const, member: { kind: "agent" as const, agentId: "agent-f13" }, personId: "person-b" },
    ]) {
      assert.throws(
        () =>
          readAgentRuntimeTokenUsageDetail({
            rootDir: repo.rootDir,
            now: afterMidnightNow,
            ...mismatch,
            limit: 2,
            cursor: page1.page!.nextCursor!,
            entityLabel: () => null,
            cut: newCut,
            projection: repo.projection,
          }),
        (error: unknown) => (error as { code?: string })?.code === "invalid_cursor",
      );
    }
  } finally {
    repo.projection.close();
    rmSync(repo.rootDir, { recursive: true, force: true });
  }
});

test("F11: paginated tokenUsageDetail continuation seeks O(pageSize) rows and stream opens regardless of window size W", () => {
  const originalOpenSync = fs.openSync;
  const runScenario = (windowSize: number, otherAgentRows: number) => {
    const repo = makeRepoRoot(`ha-f11-bounded-${windowSize}-`);
    try {
      const baseMs = Date.parse("2026-09-14T01:00:00.000Z"),
        nowIso = "2026-09-14T12:00:00.000Z";
      for (let i = 0; i < otherAgentRows; i += 1) {
        const startedAt = new Date(baseMs + i * 2_000).toISOString();
        appendDispatch(repo, {
          dispatchId: `dispatch_0000000000000000${String(i + 1).padStart(8, "0")}`,
          runtimeSessionId: `runtime-other-${i + 1}`,
          agentId: "agent-noise",
          startedAt,
          settle: {
            endedAt: new Date(baseMs + i * 2_000 + 500).toISOString(),
            inputTokens: 500,
            cacheReadTokens: 0,
            outputTokens: 100,
            toolCallCount: 1,
          },
        });
      }
      for (let i = 0; i < windowSize; i += 1) {
        const dispatchId = `dispatch_1000000000000000${String(i + 1).padStart(8, "0")}`,
          startedAt = new Date(baseMs + i * 3_000).toISOString(),
          endedAt = new Date(baseMs + i * 3_000 + 500).toISOString();
        appendDispatch(repo, {
          dispatchId,
          runtimeSessionId: `runtime-target-${i + 1}`,
          agentId: "agent-target",
          startedAt,
          settle: {
            endedAt,
            inputTokens: 1_000,
            cacheReadTokens: 100,
            outputTokens: 200,
            toolCallCount: 2,
          },
        });
        openDispatchStream(repo.rootDir, {
          dispatchId,
          runtimeSessionId: `runtime-target-${i + 1}`,
          instanceId: DEFINITION_SNAPSHOT.instanceId,
          taskId: null,
          executionId: null,
          startedAt,
          agentId: "agent-target",
          model: DEFINITION_SNAPSHOT.model,
        });
        appendRuntimeWorkerRecord(repo.rootDir, dispatchId, {
          kind: "runtime_metrics",
          inputTokens: 1_000,
          cacheReadTokens: 100,
          cacheWriteTokens: 50,
          outputTokens: 200,
          totalTokens: 1_200,
          toolCallCount: 2,
          compacted: false,
        });
      }

      let pageCalls = 0,
        rowsReturned = 0,
        lifecycleCalls = 0,
        streamOpens = 0;
      const spiedProjection: TaskProjection = new Proxy(repo.projection, {
        get(target, prop, receiver) {
          if (prop === "readRuntimeDispatchPage") {
            return (query: Parameters<TaskProjection["readRuntimeDispatchPage"]>[0]) => {
              pageCalls += 1;
              const result = target.readRuntimeDispatchPage(query);
              rowsReturned += result.rows.length;
              return result;
            };
          }
          if (prop === "readDispatchLifecycle") {
            return (query: Parameters<TaskProjection["readDispatchLifecycle"]>[0]) => {
              lifecycleCalls += 1;
              return target.readDispatchLifecycle(query);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      const cut = repo.projection.readCut(),
        pageSize = 5;
      fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
        if (String(args[0]).includes("dispatches")) streamOpens += 1;
        return originalOpenSync(...args);
      }) as typeof fs.openSync;
      syncBuiltinESMExports();

      // Page 1 populates the pinned window snapshot cache.
      const page1 = readAgentRuntimeTokenUsageDetail({
        rootDir: repo.rootDir,
        now: nowIso,
        range: "today",
        member: { kind: "agent", agentId: "agent-target" },
        limit: pageSize,
        entityLabel: () => null,
        cut,
        projection: spiedProjection,
      });
      assert.equal(page1.sessions.length, pageSize);
      assert.ok(page1.page?.nextCursor);

      // Measure a single continuation page (Page 2): must be strictly O(pageSize), independent of W!
      const page1Rows = rowsReturned;
      pageCalls = 0;
      rowsReturned = 0;
      lifecycleCalls = 0;
      streamOpens = 0;
      const page2 = readAgentRuntimeTokenUsageDetail({
        rootDir: repo.rootDir,
        now: nowIso,
        range: "today",
        member: { kind: "agent", agentId: "agent-target" },
        limit: pageSize,
        cursor: page1.page!.nextCursor!,
        entityLabel: () => null,
        cut,
        projection: spiedProjection,
      });
      const page2Stats = { pageCalls, rowsReturned, lifecycleCalls, streamOpens };

      // Drain remaining pages and verify total work across ALL pages is linear O(W), never O(W^2).
      const collected = [...page1.sessions, ...page2.sessions];
      let cursor = page2.page?.nextCursor ?? null;
      while (cursor !== null) {
        const next = readAgentRuntimeTokenUsageDetail({
          rootDir: repo.rootDir,
          now: nowIso,
          range: "today",
          member: { kind: "agent", agentId: "agent-target" },
          limit: pageSize,
          cursor,
          entityLabel: () => null,
          cut,
          projection: spiedProjection,
        });
        assert.deepEqual(next.totals, page1.totals);
        collected.push(...next.sessions);
        cursor = next.page?.nextCursor ?? null;
      }
      const totalRowsReadAcrossAllPages = page1Rows + rowsReturned;
      assert.equal(collected.length, windowSize);
      assert.equal(new Set(collected.map((row) => row.dispatchId)).size, windowSize);
      return { page2Stats, totalRowsReadAcrossAllPages };
    } finally {
      fs.openSync = originalOpenSync;
      syncBuiltinESMExports();
      repo.projection.close();
      rmSync(repo.rootDir, { recursive: true, force: true });
    }
  };

  const small = runScenario(20, 40),
    large = runScenario(160, 100);
  // Page 2 work is strictly O(pageSize = 5) regardless of whether W = 20 or W = 160!
  assert.equal(small.page2Stats.pageCalls, 1);
  assert.equal(large.page2Stats.pageCalls, 1);
  assert.equal(small.page2Stats.rowsReturned, 5);
  assert.equal(large.page2Stats.rowsReturned, 5);
  assert.equal(small.page2Stats.lifecycleCalls, 5);
  assert.equal(large.page2Stats.lifecycleCalls, 5);
  assert.ok(small.page2Stats.streamOpens > 0, "fs.openSync spy must observe dispatch stream reads");
  assert.ok(
    small.page2Stats.streamOpens <= 5 * 5,
    `continuation stream opens must stay O(pageSize) (<= 25), observed ${small.page2Stats.streamOpens}`,
  );
  assert.equal(
    large.page2Stats.streamOpens,
    small.page2Stats.streamOpens,
    "continuation page stream opens must stay constant as window size W grows 8x",
  );
  assert.equal(
    large.page2Stats.rowsReturned,
    small.page2Stats.rowsReturned,
    "continuation page row reads must stay constant as window size W grows 8x",
  );
  // Draining all 32 pages of W=160 reads <= 2*W rows total (315 rows), never O(W^2) (32*160 = 5,120 rows)!
  assert.ok(
    large.totalRowsReadAcrossAllPages <= 160 * 2,
    `full-window drain must stay O(W) (<= 320 rows), observed ${large.totalRowsReadAcrossAllPages}`,
  );
});
