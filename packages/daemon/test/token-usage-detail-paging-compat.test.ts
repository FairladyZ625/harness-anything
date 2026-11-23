// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

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
      readonly cacheWriteTokens?: number;
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
        ...(options.settle.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: options.settle.cacheWriteTokens }),
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
      cursorSecret: "test-paging-compat-secret-32bytes",
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
    removeTempRepository(repo.rootDir);
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
    //    - edgeItemized: task-bound settlement with top-level cacheWriteTokens: 4_000 -> differential pricing!
    //    - edgeTaskless: taskless Edge settlement (taskId=null, archive=null) with cacheWriteTokens: 1_500 (F17!)
    //    - edgeUnreported: settlement without cacheWriteTokens -> cacheWriteUnreportedDispatches = 1
    const edgeItemized = { dispatchId: "dispatch_00000000000000000000f121", sessionId: "runtime-f12-itemized" },
      edgeTaskless = { dispatchId: "dispatch_00000000000000000000f123", sessionId: "runtime-f12-taskless" },
      edgeUnreported = { dispatchId: "dispatch_00000000000000000000f122", sessionId: "runtime-f12-unreported" };

    appendDispatch(repo, {
      dispatchId: edgeItemized.dispatchId,
      runtimeSessionId: edgeItemized.sessionId,
      agentId: "agent-edge-f12",
      startedAt,
      taskId,
      executionId,
      settle: {
        endedAt,
        inputTokens: 10_000,
        cacheReadTokens: 2_000,
        cacheWriteTokens: 4_000,
        outputTokens: 1_000,
        toolCallCount: 4,
      },
    });
    appendDispatch(repo, {
      dispatchId: edgeTaskless.dispatchId,
      runtimeSessionId: edgeTaskless.sessionId,
      agentId: "agent-edge-f12",
      startedAt: "2026-09-14T10:01:00.000Z",
      settle: {
        endedAt,
        inputTokens: 3_000,
        cacheReadTokens: 500,
        cacheWriteTokens: 1_500,
        outputTokens: 400,
        toolCallCount: 3,
      },
    });
    appendDispatch(repo, {
      dispatchId: edgeUnreported.dispatchId,
      runtimeSessionId: edgeUnreported.sessionId,
      agentId: "agent-edge-f12",
      startedAt: "2026-09-14T10:02:00.000Z",
      taskId,
      executionId,
      settle: { endedAt, inputTokens: 2_000, cacheReadTokens: 0, outputTokens: 500, toolCallCount: 2 },
    });

    // Publish normal RuntimeDispatchArchive for edgeItemized and verify archive contains NO runtimeMetrics.
    const resultText = `archive result ${edgeItemized.dispatchId}\n`,
      resultSha = createHash("sha256").update(resultText).digest("hex"),
      archiveReceipt = archiveRuntimeDispatch({
        workspaceId: "ha13-compat",
        rootDir: repo.rootDir,
        store: repo.store,
        projection: repo.projection,
        binding: {
          actor: {
            principal: { personId: "person-a" },
            executor: { id: `runtime-session:${edgeItemized.sessionId}`, kind: "agent" },
          },
          source: "local",
          authorizationDecision: {
            policyRef: "policy/local-test",
            actor: {
              principal: { personId: "person-a" },
              executor: { id: `runtime-session:${edgeItemized.sessionId}`, kind: "agent" },
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
          dispatchId: edgeItemized.dispatchId,
          taskId,
          executionId,
          agentId: "agent-edge-f12",
          agentName: "Agent Edge F12",
          instanceId: DEFINITION_SNAPSHOT.instanceId,
          model: DEFINITION_SNAPSHOT.model,
          reasoningEffort: null,
          fast: false,
          cwd: "/edge/workspace",
          prompt: `prompt ${edgeItemized.dispatchId}`,
          runtimeSessionId: edgeItemized.sessionId,
          providerSessionId: null,
          startedAt,
          endedAt,
          outcome: "succeeded",
          exitCode: 0,
          resultRef: `artifact:runtime-result/sha256/${resultSha}`,
          resultText,
          attemptGroupId: edgeItemized.dispatchId,
          attemptIndex: 0,
          provider: { instance: DEFINITION_SNAPSHOT.instanceId, model: DEFINITION_SNAPSHOT.model },
          classification: "worker_stop",
          reason: "Worker completed the attempt successfully.",
        },
      });
    assert.equal(archiveReceipt.outcome, "applied", JSON.stringify(archiveReceipt));
    const packagePath = repo.projection.readTaskIndex({ taskIds: [taskId] }).rows[0]!.packagePath,
      archivedDoc = repo.projection.readDocument(
        `${packagePath}/artifacts/dispatches/${edgeItemized.dispatchId}.json`,
      ).document!;
    assert.equal(Object.hasOwn(JSON.parse(archivedDoc.body), "runtimeMetrics"), false);

    // 3) Verify EVERY persisted canonical event keeps 6-key runtimeMetrics AND cold rebuild has 0 issues!
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
      removeTempRepository(legacyRoot);
    }

    // 4) F17: Verify Edge local stream root AND Center canonical-only root report IDENTICAL cacheWriteTokens & USD!
    const edgeLocalRoot = mkdtempSync(path.join(tmpdir(), "ha-f17-edge-local-"));
    try {
      mkdirSync(path.join(edgeLocalRoot, "harness"), { recursive: true });
      writeFileSync(
        path.join(edgeLocalRoot, "harness/harness.yaml"),
        "schema: harness-anything/v1\nname: ha13-compat\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
      );
      for (const [entry, st, metrics, raw] of [
        [
          edgeItemized,
          startedAt,
          {
            inputTokens: 10_000,
            cacheReadTokens: 2_000,
            cacheWriteTokens: 4_000,
            outputTokens: 1_000,
            totalTokens: 11_000,
            toolCallCount: 4,
          },
          { input_tokens: 10_000, cache_creation_input_tokens: 4_000, output_tokens: 1_000 },
        ],
        [
          edgeTaskless,
          "2026-09-14T10:01:00.000Z",
          {
            inputTokens: 3_000,
            cacheReadTokens: 500,
            cacheWriteTokens: 1_500,
            outputTokens: 400,
            totalTokens: 3_400,
            toolCallCount: 3,
          },
          { input_tokens: 3_000, cache_creation_input_tokens: 1_500, output_tokens: 400 },
        ],
        [
          edgeUnreported,
          "2026-09-14T10:02:00.000Z",
          { inputTokens: 2_000, cacheReadTokens: 0, outputTokens: 500, totalTokens: 2_500, toolCallCount: 2 },
          { input_tokens: 2_000, output_tokens: 500 },
        ],
      ] as const) {
        openDispatchStream(edgeLocalRoot, {
          dispatchId: entry.dispatchId,
          runtimeSessionId: entry.sessionId,
          instanceId: DEFINITION_SNAPSHOT.instanceId,
          taskId: entry === edgeTaskless ? null : taskId,
          executionId: entry === edgeTaskless ? null : executionId,
          startedAt: st,
          agentId: "agent-edge-f12",
          model: DEFINITION_SNAPSHOT.model,
        });
        appendRuntimeWorkerRecord(edgeLocalRoot, entry.dispatchId, {
          kind: "runtime_metrics",
          ...metrics,
          compacted: false,
          raw,
        });
      }

      const price = modelPriceOf("claude-haiku-4-5")!;
      assert.ok(price && price.cacheWritePerMillion !== price.inputPerMillion);
      const expectedCost =
        usageCostUsd(price, {
          inputTokens: 10_000,
          cacheReadTokens: 2_000,
          cacheWriteTokens: 4_000,
          outputTokens: 1_000,
        }) +
        usageCostUsd(price, {
          inputTokens: 3_000,
          cacheReadTokens: 500,
          cacheWriteTokens: 1_500,
          outputTokens: 400,
        }) +
        usageCostUsd(price, { inputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500 });

      const cut = repo.projection.readCut();
      const centerAgg = readAgentRuntimeTokenUsage({
        rootDir: repo.rootDir,
        now: nowIso,
        range: "today",
        entityLabel: () => null,
        taskOf: () => undefined,
        cut,
        projection: repo.projection,
      });
      const edgeAgg = readAgentRuntimeTokenUsage({
        rootDir: edgeLocalRoot,
        now: nowIso,
        range: "today",
        entityLabel: () => null,
        taskOf: () => undefined,
        cut,
        projection: repo.projection,
      });
      assert.deepEqual(validateAgentRuntimeTokenUsage(centerAgg), []);
      assert.equal(centerAgg.totals.cacheWriteTokens, 5_500);
      assert.equal(centerAgg.totals.cacheWriteUnreportedDispatches, 1);
      assert.equal(centerAgg.totals.cacheWriteUnitemizedDispatches, 0);
      assert.ok(Math.abs(centerAgg.totals.costUsd - expectedCost) < 1e-12);
      assert.deepEqual(
        centerAgg.totals,
        edgeAgg.totals,
        "F17: Edge and Center totals (including taskless Edge session) must match identically",
      );

      const centerDetail = readAgentRuntimeTokenUsageDetail({
        rootDir: repo.rootDir,
        now: nowIso,
        range: "today",
        member: { kind: "agent", agentId: "agent-edge-f12" },
        entityLabel: () => null,
        cut,
        projection: repo.projection,
      });
      const edgeDetail = readAgentRuntimeTokenUsageDetail({
        rootDir: edgeLocalRoot,
        now: nowIso,
        range: "today",
        member: { kind: "agent", agentId: "agent-edge-f12" },
        entityLabel: () => null,
        cut,
        projection: repo.projection,
      });
      assert.deepEqual(validateAgentRuntimeTokenUsageDetail(centerDetail), []);
      assert.deepEqual(centerDetail.totals, edgeDetail.totals);
      assert.equal(
        centerDetail.sessions.find((s) => s.dispatchId === edgeTaskless.dispatchId)?.cacheWriteTokens,
        1_500,
      );

      // 5) F15: Poisoned or invalid non-JSON documents at artifacts/dispatches/<dispatchId>.json
      //    cannot alter canonical token usage or throw!
      for (const untrustedBody of [
        JSON.stringify({
          schema: "runtime-dispatch/v1",
          runtimeMetrics: {
            inputTokens: 999_999,
            cacheReadTokens: 888_888,
            cacheWriteTokens: 777_777,
            outputTokens: 666_666,
            totalTokens: 1_666_665,
            toolCallCount: 99,
            usageUnavailable: false,
          },
        }),
        "{{{ corrupt non-json regular doc-submit payload",
      ]) {
        const poisonedProjection = new Proxy(repo.projection, {
          get(target, prop, receiver) {
            if (prop === "readDocument") {
              return () => ({
                document: {
                  path: `${packagePath}/artifacts/dispatches/${edgeItemized.dispatchId}.json`,
                  body: untrustedBody,
                },
              });
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const afterPoisonAgg = readAgentRuntimeTokenUsage({
          rootDir: repo.rootDir,
          now: nowIso,
          range: "today",
          entityLabel: () => null,
          taskOf: () => undefined,
          cut,
          projection: poisonedProjection,
        });
        const afterPoisonDetail = readAgentRuntimeTokenUsageDetail({
          rootDir: repo.rootDir,
          now: nowIso,
          range: "today",
          member: { kind: "agent", agentId: "agent-edge-f12" },
          limit: 10,
          cursorSecret: "test-f12-poison-secret-32bytes",
          entityLabel: () => null,
          cut,
          projection: poisonedProjection,
        });
        assert.deepEqual(
          afterPoisonAgg.totals,
          centerAgg.totals,
          "F15: untrusted document must never alter canonical totals",
        );
        assert.deepEqual(
          afterPoisonDetail.totals,
          centerDetail.totals,
          "F15: untrusted document must never alter detail totals",
        );
      }
    } finally {
      removeTempRepository(edgeLocalRoot);
    }
  } finally {
    repo.projection.close();
    removeTempRepository(repo.rootDir);
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
    const pagingSecret = "test-f13-f14-cursor-secret-32bytes",
      page1Cut = repo.projection.readCut(),
      page1 = readAgentRuntimeTokenUsageDetail({
        rootDir: repo.rootDir,
        now: beforeMidnightNow,
        range: "today",
        member: { kind: "agent", agentId: "agent-f13" },
        personId: "person-a",
        limit: 2,
        cursorSecret: pagingSecret,
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
    // 3) Settle the previously unsettled 23:10 dispatch at revision > page1Cut.watermark AND write
    //    a local .jsonl stream with runtime_metrics + process_exit on disk to verify F13 (neither
    //    local stream files nor post-watermark lifecycle/settlements may leak into Page 2..K!).
    openDispatchStream(repo.rootDir, {
      dispatchId: "dispatch_00000000000000000000f131",
      runtimeSessionId: "runtime-dispatch_00000000000000000000f131",
      instanceId: DEFINITION_SNAPSHOT.instanceId,
      taskId: null,
      executionId: null,
      startedAt: localIso(14, 23, 10),
      agentId: "agent-f13",
      model: DEFINITION_SNAPSHOT.model,
    });
    appendRuntimeWorkerRecord(repo.rootDir, "dispatch_00000000000000000000f131", {
      kind: "runtime_metrics",
      inputTokens: 7_777,
      cacheReadTokens: 0,
      cacheWriteTokens: 555,
      outputTokens: 7_777,
      totalTokens: 15_554,
      toolCallCount: 77,
      compacted: false,
    });
    appendRuntimeWorkerRecord(repo.rootDir, "dispatch_00000000000000000000f131", {
      kind: "process_exit",
      exitCode: 0,
      signal: null,
    });
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
          cacheWriteTokens: 555,
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

    // Continue pagination AFTER local midnight and AFTER concurrent writes across BOTH the hot
    // projection AND a brand-new cold second reader instance (`coldReader`):
    const newCut = repo.projection.readCut();
    assert.ok(newCut.watermark > page1Cut.watermark);
    const coldReader = makeTaskProjection({ rootDir: repo.rootDir, eventStore: repo.store });
    try {
      for (const [readerLabel, reader] of [
        ["hot-reader", repo.projection],
        ["cold-second-reader", coldReader],
      ] as const) {
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
            cursorSecret: pagingSecret,
            entityLabel: () => null,
            cut: newCut,
            projection: reader,
          });
          assert.equal(next.since, page1.since, `${readerLabel}: continuation must stay pinned across midnight`);
          assert.equal(next.watermark, page1.watermark, `${readerLabel}: continuation must preserve pinned watermark`);
          assert.deepEqual(next.totals, page1.totals, `${readerLabel}: continuation totals must not drift`);
          assert.deepEqual(next.buckets, page1.buckets, `${readerLabel}: continuation buckets must not drift`);
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
        );
        const tailRow = collected.at(-1)!;
        assert.equal(tailRow.totalTokens, 0, `${readerLabel}: post-watermark stream/outcome must not leak into row`);
        assert.equal(tailRow.cacheWriteTokens, 0);
        assert.equal(tailRow.endedAt, null);
        assert.equal(tailRow.usage, "pending");
        // Verify exact sum(all paged session rows) === page1.totals at page1.watermark!
        assert.equal(
          collected.reduce((acc, row) => acc + row.totalTokens, 0),
          page1.totals.totalTokens,
          `${readerLabel}: sum(paged totalTokens) must equal page1.totals.totalTokens`,
        );
        assert.equal(
          collected.reduce((acc, row) => acc + row.inputTokens, 0),
          page1.totals.inputTokens,
        );
        assert.equal(
          collected.reduce((acc, row) => acc + row.outputTokens, 0),
          page1.totals.outputTokens,
        );
        assert.equal(
          collected.reduce((acc, row) => acc + row.toolCallCount, 0),
          page1.totals.toolCallCount,
        );
        assert.equal(collected.filter((row) => row.usage === "reported").length, page1.totals.usageReportedDispatches);
        assert.equal(
          collected.filter((row) => row.usage === "unavailable").length,
          page1.totals.usageUnavailableDispatches,
        );
      }
    } finally {
      coldReader.close();
    }

    // F14: Negative cursor binding & oversized/forged window checks MUST reject BEFORE any DB query!
    let dbQueryCountOnInvalidCursor = 0;
    const trapProjection: TaskProjection = new Proxy(repo.projection, {
      get(target, prop, receiver) {
        if (prop === "readRuntimeDispatchPage" || prop === "readDispatchLifecycle") {
          return () => {
            dbQueryCountOnInvalidCursor += 1;
            throw new Error(`unexpected storage query ${String(prop)} on invalid cursor`);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const forgedMultiYearV2 = Buffer.from(
      [
        "v2",
        "2026-09-14T23:40:00.000Z",
        "dispatch_00000000000000000000f134",
        "today",
        "agent",
        "agent-f13",
        "person-a",
        "0",
        String(Date.parse("2099-01-01T00:00:00.000Z")),
        "5",
        "5",
      ].join("\0"),
      "utf8",
    ).toString("base64url");
    const tamperedV3 = `${page1.page!.nextCursor!.slice(0, -4)}AAAA`;
    const oversizedCursor = `v3.${"A".repeat(9_000)}.${"B".repeat(100)}`;

    for (const badCall of [
      {
        range: "7d" as const,
        member: { kind: "agent" as const, agentId: "agent-f13" },
        personId: "person-a",
        cursor: page1.page!.nextCursor!,
      },
      {
        range: "today" as const,
        member: { kind: "agent" as const, agentId: "agent-other" },
        personId: "person-a",
        cursor: page1.page!.nextCursor!,
      },
      {
        range: "today" as const,
        member: { kind: "agent" as const, agentId: "agent-f13" },
        personId: "person-b",
        cursor: page1.page!.nextCursor!,
      },
      {
        range: "today" as const,
        member: { kind: "agent" as const, agentId: "agent-f13" },
        personId: "person-a",
        cursor: forgedMultiYearV2,
      },
      {
        range: "today" as const,
        member: { kind: "agent" as const, agentId: "agent-f13" },
        personId: "person-a",
        cursor: tamperedV3,
      },
      {
        range: "today" as const,
        member: { kind: "agent" as const, agentId: "agent-f13" },
        personId: "person-a",
        cursor: oversizedCursor,
      },
    ]) {
      assert.throws(
        () =>
          readAgentRuntimeTokenUsageDetail({
            rootDir: repo.rootDir,
            now: afterMidnightNow,
            ...badCall,
            limit: 2,
            cursorSecret: pagingSecret,
            entityLabel: () => null,
            cut: newCut,
            projection: trapProjection,
          }),
        (error: unknown) => (error as { code?: string })?.code === "invalid_cursor",
      );
    }
    assert.equal(dbQueryCountOnInvalidCursor, 0, "F14: invalid/forged cursors must reject before querying SQLite/PG");
  } finally {
    repo.projection.close();
    removeTempRepository(repo.rootDir);
  }
});

test("F11: stateless cold second-reader continuation seeks O(pageSize) with 0 stream opens and Fleet unpaginated ceiling fails closed", () => {
  const originalOpenSync = fs.openSync;
  const runScenario = (windowSize: number, otherAgentRows: number) => {
    const repo = makeRepoRoot(`ha-f11-bounded-${windowSize}-`);
    let coldProjection: TaskProjection | null = null;
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
            cacheWriteTokens: 50,
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

      // Open a brand-new cold second reader instance that NEVER ran Page 1!
      coldProjection = makeTaskProjection({ rootDir: repo.rootDir, eventStore: repo.store });
      let pageCalls = 0,
        rowsReturned = 0,
        lifecycleCalls = 0,
        streamOpens = 0;
      const makeSpied = (base: TaskProjection): TaskProjection =>
        new Proxy(base, {
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
      const spiedHot = makeSpied(repo.projection),
        spiedCold = makeSpied(coldProjection);

      const cut = repo.projection.readCut(),
        pageSize = 5;
      fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
        if (String(args[0]).includes("dispatches")) streamOpens += 1;
        return originalOpenSync(...args);
      }) as typeof fs.openSync;
      syncBuiltinESMExports();

      const pagingSecret = "test-f11-cold-cursor-secret-32bytes";
      // Page 1 on hot reader:
      const page1 = readAgentRuntimeTokenUsageDetail({
        rootDir: repo.rootDir,
        now: nowIso,
        range: "today",
        member: { kind: "agent", agentId: "agent-target" },
        limit: pageSize,
        cursorSecret: pagingSecret,
        entityLabel: () => null,
        cut,
        projection: spiedHot,
      });
      assert.equal(page1.sessions.length, pageSize);
      assert.equal(streamOpens, 0, "Page 1 paginated read must open 0 local .jsonl stream files");
      assert.ok(page1.page?.nextCursor);

      // Measure Page 2 on the COLD SECOND READER INSTANCE: must be strictly O(pageSize), 0 window rescan, 0 lifecycle group_json reads!
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
        cursorSecret: pagingSecret,
        entityLabel: () => null,
        cut,
        projection: spiedCold,
      });
      const coldPage2Stats = { pageCalls, rowsReturned, lifecycleCalls, streamOpens };

      // Drain remaining pages on cold second reader and verify exact sum parity with Page 1!
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
          cursorSecret: pagingSecret,
          entityLabel: () => null,
          cut,
          projection: spiedCold,
        });
        assert.deepEqual(next.totals, page1.totals);
        collected.push(...next.sessions);
        cursor = next.page?.nextCursor ?? null;
      }
      const totalRowsReadAcrossAllPages = page1Rows + rowsReturned;
      assert.equal(collected.length, windowSize);
      assert.equal(new Set(collected.map((row) => row.dispatchId)).size, windowSize);
      assert.equal(
        collected.reduce((acc, row) => acc + row.totalTokens, 0),
        page1.totals.totalTokens,
      );
      assert.equal(
        collected.reduce((acc, row) => acc + row.cacheWriteTokens, 0),
        page1.totals.cacheWriteTokens,
      );

      // Also verify Fleet unpaginated ceiling (`maxUnpaginatedSessions`) fails closed before scanning W!
      pageCalls = 0;
      rowsReturned = 0;
      if (windowSize > 10) {
        assert.throws(
          () =>
            readAgentRuntimeTokenUsageDetail({
              rootDir: repo.rootDir,
              now: nowIso,
              range: "today",
              member: { kind: "agent", agentId: "agent-target" },
              maxUnpaginatedSessions: 10,
              entityLabel: () => null,
              cut,
              projection: spiedCold,
            }),
          (error: unknown) => (error as { code?: string })?.code === "resource_exhausted",
        );
        assert.equal(pageCalls, 1, "Fleet unpaginated ceiling must abort on the first dispatch page");
      }
      return { coldPage2Stats, totalRowsReadAcrossAllPages };
    } finally {
      fs.openSync = originalOpenSync;
      syncBuiltinESMExports();
      coldProjection?.close();
      repo.projection.close();
      removeTempRepository(repo.rootDir);
    }
  };

  const small = runScenario(20, 40),
    large = runScenario(160, 100);
  assert.equal(small.coldPage2Stats.pageCalls, 1);
  assert.equal(large.coldPage2Stats.pageCalls, 1);
  assert.equal(small.coldPage2Stats.rowsReturned, 5);
  assert.equal(large.coldPage2Stats.rowsReturned, 5);
  assert.equal(small.coldPage2Stats.lifecycleCalls, 0);
  assert.equal(large.coldPage2Stats.lifecycleCalls, 0);
  assert.equal(small.coldPage2Stats.streamOpens, 0);
  assert.equal(large.coldPage2Stats.streamOpens, 0);
  assert.ok(
    large.totalRowsReadAcrossAllPages <= 160 * 2,
    `cold cross-instance full-window drain must stay O(W) (<= 320 rows), observed ${large.totalRowsReadAcrossAllPages}`,
  );
});
