// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchLifecycleView,
  reduceDispatchLifecycle,
  type AgentRuntimeEventV1,
  type DispatchLifecycleGroup,
  type DispatchLifecycleView,
  type TaskEventV1,
  type TaskProjection,
} from "@harness-anything/kernel";
import {
  finalizeFleetTokenUsageDetailResult,
  fleetTokenUsageDetailCursorKey,
  isValidTokenUsageDetailCursor,
  readTokenUsageDetailPage,
  unwrapFleetTokenUsageDetailCursor,
  type TokenUsageDetailProjection,
  type TokenUsagePricingContext,
} from "@harness-anything/application/queries";

const DEFINITION_SNAPSHOT = {
  schema: "agent-definition-snapshot/v1" as const,
  configVersion: 1,
  instanceId: "inst-app",
  installationId: "install-app",
  kindId: "claude-code",
  providerId: "anthropic",
  model: "claude-haiku-4-5",
  reasoningEffort: null,
  endpointKind: "official" as const,
  baseUrlHash: null,
  authMode: "subscription" as const,
};

function makePricing(version: string, fingerprint: string, ratePerMillion = 1.0): TokenUsagePricingContext {
  return {
    version,
    fingerprint,
    costOf: (_model, metrics) =>
      metrics === null
        ? { costUsd: 0, unpricedTokens: 0 }
        : { costUsd: (metrics.totalTokens * ratePerMillion) / 1_000_000, unpricedTokens: 0 },
  };
}

function makeDispatchEvent(
  rev: number,
  dispatchId: string,
  runtimeSessionId: string,
  startedAt: string,
  task?: { readonly taskId: string; readonly executionId: string },
): Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }> {
  return {
    schema: "agent-runtime-event/v1",
    type: "runtime_dispatch_requested",
    eventId: `ev-${dispatchId}`,
    opId: `op-${dispatchId}`,
    workspaceRevision: rev,
    occurredAt: startedAt,
    actor: { principal: { personId: "person-a" }, executor: null },
    source: "local",
    payload: {
      dispatchId,
      runtimeSessionId,
      instanceId: "inst-app",
      kindId: "claude-code",
      agentId: "agent-app",
      agentName: "App Agent",
      startedAt,
      ...(task ? { taskId: task.taskId, executionId: task.executionId } : {}),
      definitionSnapshotRef: "artifact:runtime-definitions/test/v1",
      definitionSnapshot: DEFINITION_SNAPSHOT,
    },
  };
}

function makeStartedEvent(
  rev: number,
  runtimeSessionId: string,
  occurredAt: string,
): Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_started" }> {
  return {
    schema: "agent-runtime-event/v1",
    type: "runtime_session_started",
    eventId: `ev-start-${rev}`,
    opId: `op-start-${rev}`,
    workspaceRevision: rev,
    occurredAt,
    actor: { principal: { personId: "person-a" }, executor: null },
    source: "local",
    payload: {
      runtimeSessionId,
      instanceId: "inst-app",
      kindId: "claude-code",
      launchGeneration: 1,
      pid: 4200,
    },
  };
}

function makeOutcomeEvent(
  rev: number,
  dispatchId: string,
  runtimeSessionId: string,
  outcome: "succeeded" | "stopped",
  occurredAt: string,
): Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_outcome_observed" }> {
  return {
    schema: "agent-runtime-event/v1",
    type: "runtime_session_outcome_observed",
    eventId: `ev-out-${rev}`,
    opId: `op-out-${rev}`,
    workspaceRevision: rev,
    occurredAt,
    actor: { principal: { personId: "person-a" }, executor: null },
    source: "local",
    payload: {
      runtimeSessionId,
      dispatchId,
      outcome,
      endedAt: occurredAt,
      exitCode: 0,
      resultRef: `artifact:runtime-result/sha256/${"a".repeat(64)}`,
      result: { sha256: "a".repeat(64), size: 10, mediaType: "text/plain" },
      runtimeMetrics: {
        inputTokens: 1_000,
        cacheReadTokens: 0,
        outputTokens: 200,
        totalTokens: 1_200,
        toolCallCount: 1,
        usageUnavailable: false,
      },
      cacheWriteTokens: 100,
    },
  };
}

function makeSubmissionEvent(rev: number, taskId: string, executionId: string, occurredAt: string): TaskEventV1 {
  return {
    schema: "task-event/v1",
    type: "execution_submitted",
    eventId: `ev-sub-${rev}`,
    opId: `op-sub-${rev}`,
    taskId,
    workspaceRevision: rev,
    occurredAt,
    actor: { principal: { personId: "person-a" }, executor: null },
    source: "local",
    payload: {
      execution: {
        executionId,
        iteration: 1,
        status: "submitted",
        submission: {
          submittedAt: occurredAt,
          summary: "Delivered",
          commitSha: "a".repeat(40),
          deliverables: [],
          outputs: [],
        },
      },
    },
  } as unknown as TaskEventV1;
}

test("F19 + F11 + F13 + F18: pure application query pins pricing version/fingerprint, folds task+dispatch delivery at <= maxRevision, bounds Page-1 session IDs, and derives canonical repoId cursors", () => {
  const nowIso = "2026-11-21T12:00:00.000Z";
  const d1 = makeDispatchEvent(1, "dispatch_00000000000000000000aa01", "sess-1", "2026-11-21T11:00:00.000Z", {
    taskId: "task_1",
    executionId: "exe_1",
  });
  const d1Start = makeStartedEvent(2, "sess-1", "2026-11-21T11:00:01.000Z");
  const d1Sub = makeSubmissionEvent(3, "task_1", "exe_1", "2026-11-21T11:00:02.000Z");
  const d1Out = makeOutcomeEvent(4, d1.payload.dispatchId, "sess-1", "stopped", "2026-11-21T11:00:03.000Z");

  const d2 = makeDispatchEvent(5, "dispatch_00000000000000000000aa02", "sess-2", "2026-11-21T11:10:00.000Z");
  const d2Start = makeStartedEvent(6, "sess-2", "2026-11-21T11:10:01.000Z");
  const d2Out = makeOutcomeEvent(7, d2.payload.dispatchId, "sess-2", "succeeded", "2026-11-21T11:10:02.000Z");

  const rows: ReturnType<TaskProjection["readRuntimeDispatchPage"]>["rows"] = [
    {
      event: d2,
      metrics: { ...d2Out.payload.runtimeMetrics!, cacheWriteTokens: 100 },
      endedAt: d2Out.payload.endedAt!,
      outcome: "succeeded",
    },
    {
      event: d1,
      metrics: { ...d1Out.payload.runtimeMetrics!, cacheWriteTokens: 100 },
      endedAt: d1Out.payload.endedAt!,
      outcome: "stopped",
    },
  ];

  // Current live view of d1 has advanced past watermark=7 (revision=99) after a later task transition.
  let d1Group: DispatchLifecycleGroup | null = null;
  for (const ev of [d1, d1Start, d1Sub, d1Out]) {
    const step = reduceDispatchLifecycle(d1Group, ev as never);
    if (step.kind === "applied") d1Group = step.group;
  }
  const advancedView: DispatchLifecycleView = {
    ...dispatchLifecycleView(d1Group!, d1.payload.dispatchId),
    revision: 99,
  };

  let d2Group: DispatchLifecycleGroup | null = null;
  for (const ev of [d2, d2Start, d2Out]) {
    const step = reduceDispatchLifecycle(d2Group, ev as never);
    if (step.kind === "applied") d2Group = step.group;
  }
  const d2View = dispatchLifecycleView(d2Group!, d2.payload.dispatchId);

  const sessionQueryCalls: Array<{
    readonly sessionId: string;
    readonly types: readonly string[];
    readonly options?: { readonly maxRevision?: number; readonly limit?: number; readonly order?: "asc" | "desc" };
  }> = [];

  const projection: TokenUsageDetailProjection = {
    readRuntimeDispatchPage: (query) => {
      const startIndex = query.cursor ? 1 : 0,
        slice = rows.slice(startIndex, startIndex + query.limit);
      return {
        rows: slice,
        done: startIndex + slice.length >= rows.length,
        nextCursor:
          startIndex + slice.length < rows.length
            ? {
                startedAt: slice.at(-1)!.event.payload.startedAt!,
                dispatchId: slice.at(-1)!.event.payload.dispatchId,
              }
            : null,
      };
    },
    readDispatchLifecycle: (query) => {
      const ids = query.by === "dispatch" ? query.dispatchIds : [];
      return {
        status: "ready",
        watermark: 99,
        sourceRevision: 99,
        rows: ids.flatMap((id) =>
          id === d1.payload.dispatchId ? [advancedView] : id === d2.payload.dispatchId ? [d2View] : [],
        ),
        nextCursor: null,
      };
    },
    readRuntimeSessionEventsByType: (sessionId, types, options) => {
      sessionQueryCalls.push({ sessionId, types, options });
      if (sessionId !== "sess-1") return [];
      const all = [d1Start, d1Out].filter(
        (ev) =>
          types.includes(ev.type) &&
          (options?.maxRevision === undefined || ev.workspaceRevision <= options.maxRevision),
      );
      const ordered = options?.order === "desc" ? all.toReversed() : all;
      return options?.limit === undefined ? ordered : ordered.slice(0, options.limit);
    },
    readTaskSubmissionOperation: (taskId, executionId) =>
      taskId === "task_1" && executionId === "exe_1" ? d1Sub.opId : null,
    readTaskOperation: (opId) => (opId === d1Sub.opId ? { event: d1Sub, watermark: 99 } : null),
  };

  const pricingV1 = makePricing("2026-11-20", "1111111111111111", 1.0);
  const page1 = readTokenUsageDetailPage({
    repoId: "repo-canonical",
    now: nowIso,
    range: "today",
    member: { kind: "agent", agentId: "agent-app" },
    limit: 1,
    pricing: pricingV1,
    entityLabel: () => null,
    projection,
    cut: { status: "ready", watermark: 7, sourceRevision: 7 },
  });
  assert.equal(page1.sessions.length, 1);
  assert.equal(page1.sessions[0]!.dispatchId, d2.payload.dispatchId);
  assert.equal(page1.pricing.version, "2026-11-20");
  assert.ok(page1.page?.nextCursor);

  // Page 2 at pinnedWatermark=7: d1's current view has revision=99 > 7, so reconstructPinnedDispatchOutcome
  // runs with bounded { maxRevision: 7, order: "desc", limit } and folds execution_submitted(rev 3) + stopped(rev 4)
  // -> authoritative displayStatus = "succeeded" (NOT raw "stopped")!
  const page2 = readTokenUsageDetailPage({
    repoId: "repo-canonical",
    now: nowIso,
    range: "today",
    member: { kind: "agent", agentId: "agent-app" },
    limit: 1,
    cursor: page1.page!.nextCursor!,
    pricing: pricingV1,
    entityLabel: () => null,
    projection,
    cut: { status: "ready", watermark: 99, sourceRevision: 99 },
  });
  assert.equal(page2.sessions.length, 1);
  assert.equal(page2.sessions[0]!.dispatchId, d1.payload.dispatchId);
  assert.equal(
    page2.sessions[0]!.outcome,
    "succeeded",
    "F13: delivered stopped session at <= maxRevision must stay succeeded even when current view.revision > maxRevision",
  );
  assert.equal(page2.pricing.version, "2026-11-20");
  assert.equal(page2.page?.nextCursor, null);
  assert.ok(sessionQueryCalls.length >= 2);
  for (const call of sessionQueryCalls) {
    assert.equal(call.options?.maxRevision, 7, "F11: readRuntimeSessionEventsByType must receive maxRevision");
    assert.equal(call.options?.order, "desc", "F11: readRuntimeSessionEventsByType must scan desc");
    assert.ok(
      typeof call.options?.limit === "number" && call.options.limit > 0 && call.options.limit <= 64,
      "F11: readRuntimeSessionEventsByType must enforce bounded limit",
    );
  }

  // F13 pricing invalidation: new version OR same version with changed rate fingerprint invalidates cursor!
  for (const driftedPricing of [
    makePricing("2026-11-21", "1111111111111111", 1.0),
    makePricing("2026-11-20", "2222222222222222", 2.0),
  ]) {
    assert.throws(
      () =>
        readTokenUsageDetailPage({
          repoId: "repo-canonical",
          now: nowIso,
          range: "today",
          member: { kind: "agent", agentId: "agent-app" },
          limit: 1,
          cursor: page1.page!.nextCursor!,
          pricing: driftedPricing,
          entityLabel: () => null,
          projection,
          cut: { status: "ready", watermark: 99, sourceRevision: 99 },
        }),
      (error: unknown) => (error as { code?: string })?.code === "invalid_cursor",
    );
  }

  // F11 Page-1 bounded session ID tracking: exceeding maxWindowSessions fails closed with resource_exhausted!
  assert.throws(
    () =>
      readTokenUsageDetailPage({
        repoId: "repo-canonical",
        now: nowIso,
        range: "today",
        member: { kind: "agent", agentId: "agent-app" },
        limit: 1,
        maxWindowSessions: 1,
        pricing: pricingV1,
        entityLabel: () => null,
        projection,
        cut: { status: "ready", watermark: 7, sourceRevision: 7 },
      }),
    (error: unknown) => (error as { code?: string })?.code === "resource_exhausted",
  );

  // F18: canonical repoId cursor key rejects cross-repo and mismatched secret cursors while accepting same repoId.
  assert.equal(
    isValidTokenUsageDetailCursor(page1.page!.nextCursor!, {
      repoId: "repo-canonical",
      nowMs: Date.parse(nowIso),
      pricingVersion: "2026-11-20",
      pricingFingerprint: "1111111111111111",
    }),
    true,
  );
  assert.equal(
    isValidTokenUsageDetailCursor(page1.page!.nextCursor!, {
      repoId: "other-repo",
      nowMs: Date.parse(nowIso),
    }),
    false,
  );
  const keyA = fleetTokenUsageDetailCursorKey("repo-canonical", "cluster-secret-1"),
    keySame = fleetTokenUsageDetailCursorKey("repo-canonical", "cluster-secret-1"),
    keyOther = fleetTokenUsageDetailCursorKey("repo-canonical", "cluster-secret-2"),
    wrapped = finalizeFleetTokenUsageDetailResult(keyA, "repo-canonical", null, page1) as {
      readonly page: { readonly nextCursor: string };
    };
  assert.equal(
    unwrapFleetTokenUsageDetailCursor(keySame, "repo-canonical", wrapped.page.nextCursor),
    page1.page!.nextCursor!,
  );
  assert.equal(unwrapFleetTokenUsageDetailCursor(keyOther, "repo-canonical", wrapped.page.nextCursor), null);
  assert.equal(unwrapFleetTokenUsageDetailCursor(keyA, "other-repo", wrapped.page.nextCursor), null);
});
