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
  cursorSecretBytesOrNull,
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

  let readDispatchLifecycleCalls = 0;
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
      readDispatchLifecycleCalls += 1;
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

  const testSecret = "app-cluster-cursor-secret-32bytes",
    pricingV1 = makePricing("2026-11-20", "1111111111111111", 1.0);
  const page1 = readTokenUsageDetailPage({
    repoId: "repo-canonical",
    now: nowIso,
    range: "today",
    member: { kind: "agent", agentId: "agent-app" },
    limit: 1,
    cursorSecret: testSecret,
    pricing: pricingV1,
    entityLabel: () => null,
    projection,
    cut: { status: "ready", watermark: 7, sourceRevision: 7 },
  });
  assert.equal(page1.sessions.length, 1);
  assert.equal(page1.sessions[0]!.dispatchId, d2.payload.dispatchId);
  assert.equal(page1.pricing.version, "2026-11-20");
  assert.ok(page1.page?.nextCursor);

  // Page 2 at pinnedWatermark=7: continuation pages MUST NOT call readDispatchLifecycle at all (0 group_json reads, F11),
  // reconstructing directly from bounded canonical events at <= 7 and folding execution_submitted(rev 3) + stopped(rev 4)
  // -> authoritative displayStatus = "succeeded" (NOT raw "stopped")!
  readDispatchLifecycleCalls = 0;
  const page2 = readTokenUsageDetailPage({
    repoId: "repo-canonical",
    now: nowIso,
    range: "today",
    member: { kind: "agent", agentId: "agent-app" },
    limit: 1,
    cursor: page1.page!.nextCursor!,
    cursorSecret: testSecret,
    pricing: pricingV1,
    entityLabel: () => null,
    projection,
    cut: { status: "ready", watermark: 99, sourceRevision: 99 },
  });
  assert.equal(
    readDispatchLifecycleCalls,
    0,
    "F11: cursor continuation must NEVER query current dispatch_lifecycle_attempt/group_json",
  );
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
  assert.ok(
    sessionQueryCalls.some((call) => call.types.includes("runtime_session_cancelled")),
    "F13: coreSessionEvents must include runtime_session_cancelled",
  );
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
          cursorSecret: testSecret,
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
        cursorSecret: testSecret,
        maxWindowSessions: 1,
        pricing: pricingV1,
        entityLabel: () => null,
        projection,
        cut: { status: "ready", watermark: 7, sourceRevision: 7 },
      }),
    (error: unknown) => (error as { code?: string })?.code === "resource_exhausted",
  );

  // F20: missing or empty cursorSecret MUST fail closed with cursor_secret_unconfigured (never empty repoId-only HMAC!).
  assert.equal(cursorSecretBytesOrNull(undefined), null);
  assert.equal(cursorSecretBytesOrNull(""), null);
  assert.equal(cursorSecretBytesOrNull(Buffer.alloc(0)), null);
  assert.ok(cursorSecretBytesOrNull(testSecret) !== null);
  for (const missingSecret of [undefined, "", Buffer.alloc(0)]) {
    assert.throws(
      () =>
        readTokenUsageDetailPage({
          repoId: "repo-canonical",
          now: nowIso,
          range: "today",
          member: { kind: "agent", agentId: "agent-app" },
          limit: 1,
          ...(missingSecret === undefined ? {} : { cursorSecret: missingSecret }),
          pricing: pricingV1,
          entityLabel: () => null,
          projection,
          cut: { status: "ready", watermark: 7, sourceRevision: 7 },
        }),
      (error: unknown) => (error as { code?: string })?.code === "cursor_secret_unconfigured",
    );
  }
  assert.throws(
    () => fleetTokenUsageDetailCursorKey("repo-canonical", ""),
    (error: unknown) => (error as { code?: string })?.code === "cursor_secret_unconfigured",
  );
  assert.throws(
    () => finalizeFleetTokenUsageDetailResult(null, "repo-canonical", null, page1),
    (error: unknown) => (error as { code?: string })?.code === "cursor_secret_unconfigured",
  );

  // F18 + F20: canonical repoId + server cursorSecret rejects cross-repo and mismatched-secret cursors.
  assert.equal(
    isValidTokenUsageDetailCursor(page1.page!.nextCursor!, {
      repoId: "repo-canonical",
      nowMs: Date.parse(nowIso),
      cursorSecret: testSecret,
      pricingVersion: "2026-11-20",
      pricingFingerprint: "1111111111111111",
    }),
    true,
  );
  assert.equal(
    isValidTokenUsageDetailCursor(page1.page!.nextCursor!, {
      repoId: "repo-canonical",
      nowMs: Date.parse(nowIso),
      cursorSecret: "wrong-secret",
    }),
    false,
  );
  assert.equal(
    isValidTokenUsageDetailCursor(page1.page!.nextCursor!, {
      repoId: "other-repo",
      nowMs: Date.parse(nowIso),
      cursorSecret: testSecret,
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

test("F13 + F11: pre-watermark runtime_session_cancelled + post-watermark exit folds to settling/unknown (never running) with 0 readDispatchLifecycle calls", () => {
  const nowIso = "2026-11-21T12:00:00.000Z",
    testSecret = "cancel-regression-secret-32bytes";
  const d1 = makeDispatchEvent(1, "dispatch_00000000000000000000bb01", "sess-cancelled", "2026-11-21T11:00:00.000Z"),
    d1Start = makeStartedEvent(2, "sess-cancelled", "2026-11-21T11:00:01.000Z"),
    d1Cancel: Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_cancelled" }> = {
      schema: "agent-runtime-event/v1",
      type: "runtime_session_cancelled",
      eventId: "ev-cancel-3",
      opId: "op-cancel-3",
      workspaceRevision: 3,
      occurredAt: "2026-11-21T11:00:02.000Z",
      actor: { principal: { personId: "person-a" }, executor: null },
      source: "local",
      payload: { runtimeSessionId: "sess-cancelled" },
    },
    d2 = makeDispatchEvent(4, "dispatch_00000000000000000000bb02", "sess-newest", "2026-11-21T11:10:00.000Z"),
    d2Start = makeStartedEvent(5, "sess-newest", "2026-11-21T11:10:01.000Z"),
    d1Exit: Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_exited" }> = {
      schema: "agent-runtime-event/v1",
      type: "runtime_session_exited",
      eventId: "ev-exit-10",
      opId: "op-exit-10",
      workspaceRevision: 10,
      occurredAt: "2026-11-21T11:15:00.000Z",
      actor: { principal: { personId: "person-a" }, executor: null },
      source: "local",
      payload: { runtimeSessionId: "sess-cancelled" },
    };

  let d2Group: DispatchLifecycleGroup | null = null;
  for (const ev of [d2, d2Start]) {
    const step = reduceDispatchLifecycle(d2Group, ev as never);
    if (step.kind === "applied") d2Group = step.group;
  }
  const d2View = dispatchLifecycleView(d2Group!, d2.payload.dispatchId);

  const rows: ReturnType<TaskProjection["readRuntimeDispatchPage"]>["rows"] = [
    { event: d2, metrics: null, endedAt: null, outcome: null },
    { event: d1, metrics: null, endedAt: null, outcome: null },
  ];

  let lifecycleCalls = 0;
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
    readDispatchLifecycle: () => {
      lifecycleCalls += 1;
      return { status: "ready", watermark: 5, sourceRevision: 5, rows: [d2View], nextCursor: null };
    },
    readRuntimeSessionEventsByType: (sessionId, types, options) => {
      if (sessionId !== "sess-cancelled") return [];
      const all = [d1Start, d1Cancel, d1Exit].filter(
        (ev) =>
          types.includes(ev.type) &&
          (options?.maxRevision === undefined || ev.workspaceRevision <= options.maxRevision),
      );
      const ordered = options?.order === "desc" ? all.toReversed() : all;
      return options?.limit === undefined ? ordered : ordered.slice(0, options.limit);
    },
  };

  const pricing = makePricing("2026-11-20", "1111111111111111", 1.0);
  const page1 = readTokenUsageDetailPage({
    repoId: "repo-cancel",
    now: nowIso,
    range: "today",
    member: { kind: "agent", agentId: "agent-app" },
    limit: 1,
    cursorSecret: testSecret,
    pricing,
    entityLabel: () => null,
    projection,
    cut: { status: "ready", watermark: 5, sourceRevision: 5 },
  });
  assert.ok(page1.page?.nextCursor);

  lifecycleCalls = 0;
  const page2 = readTokenUsageDetailPage({
    repoId: "repo-cancel",
    now: nowIso,
    range: "today",
    member: { kind: "agent", agentId: "agent-app" },
    limit: 1,
    cursor: page1.page!.nextCursor!,
    cursorSecret: testSecret,
    pricing,
    entityLabel: () => null,
    projection,
    cut: { status: "ready", watermark: 10, sourceRevision: 10 },
  });
  assert.equal(lifecycleCalls, 0, "F11: continuation must not read current dispatch_lifecycle projection");
  assert.equal(page2.sessions.length, 1);
  assert.equal(page2.sessions[0]!.dispatchId, d1.payload.dispatchId);
  assert.equal(
    page2.sessions[0]!.outcome,
    "unknown",
    "F13: pre-watermark runtime_session_cancelled + post-watermark exit must fold to settling/unknown (never running)",
  );
});
