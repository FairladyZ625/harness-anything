import assert from "node:assert/strict";
import type { AgentRuntimeEventV1, TaskProjectionQueries } from "@harness-anything/kernel";
import { canonicalEventWritePlan, type CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import type { PgTaskQueryMethods } from "../../src/pg/pg-task-query-contract.ts";

export async function appendRuntimeQueryFixtures(
  append: (bundle: CanonicalWriteBundle) => Promise<void>,
  revision: () => number,
  source: AgentRuntimeEventV1["source"] = "local",
): Promise<void> {
  const installation: AgentRuntimeEventV1 = {
    schema: "agent-runtime-event/v1",
    type: "runtime_installation_observed",
    eventId: "event-runtime-query-installation",
    opId: "operation-runtime-query-installation",
    workspaceRevision: revision(),
    occurredAt: "2026-08-30T00:00:00.000Z",
    actor: { executor: null, principal: { personId: "person_runtime" } },
    source,
    payload: {
      installationId: "runtime-query-installation",
      kindId: "codex",
      protocolFamily: "codex-compatible",
      version: "1.0.0",
      discoverySource: "wrapper",
      hostRef: "host:local",
      capabilities: [],
    },
  };
  await append({
    event: installation,
    plan: canonicalEventWritePlan(installation, "agent-runtime/v1", installation.opId),
    blobs: [],
  });
  const started: AgentRuntimeEventV1 = {
    schema: "agent-runtime-event/v1",
    type: "runtime_session_started",
    eventId: "event-runtime-query-start",
    opId: "operation-runtime-query-start",
    workspaceRevision: revision(),
    occurredAt: "2026-08-31T00:00:00.000Z",
    actor: { executor: null, principal: { personId: "person_runtime" } },
    source,
    payload: {
      runtimeSessionId: "runtime-query-session",
      instanceId: "runtime-query-instance",
      installationId: "runtime-query-installation",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
      taskBinding: { taskId: "task-parity", executionId: "execution-parity" },
      launchGeneration: 1,
      attachable: false,
    },
  };
  await append({ event: started, plan: canonicalEventWritePlan(started, "agent-runtime/v1", started.opId), blobs: [] });
  for (const [id, startedAt, extra] of [
    ["runtime-query-a", "2026-09-01T00:00:00.000Z", {}],
    ["runtime-query-b", "2026-09-01T00:00:00.000Z", { resumedFromDispatchId: "runtime-query-a" }],
    [
      "runtime-query-c",
      "2026-09-02T00:00:00.000Z",
      { reviewTarget: { kind: "decision", decisionId: "dec_PG_PARITY", digest: "sha256:" + "1".repeat(64) } },
    ],
  ] as const) {
    const event: AgentRuntimeEventV1 = {
      schema: "agent-runtime-event/v1",
      type: "runtime_dispatch_requested",
      eventId: `event-${id}`,
      opId: `operation-${id}`,
      workspaceRevision: revision(),
      occurredAt: startedAt,
      actor: { executor: null, principal: { personId: id === "runtime-query-c" ? "person_other" : "person_runtime" } },
      source,
      payload: {
        dispatchId: id,
        dispatchKey: `key-${id}`,
        runtimeSessionId: "runtime-query-session",
        instanceId: "runtime-query-instance",
        installationId: "runtime-query-installation",
        kindId: "codex",
        definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
        definitionSnapshot: {
          schema: "agent-definition-snapshot/v1",
          configVersion: 1,
          instanceId: "runtime-query-instance",
          installationId: "runtime-query-installation",
          kindId: "codex",
          providerId: "openai",
          model: "codex-fixture",
          reasoningEffort: null,
          endpointKind: "official",
          baseUrlHash: null,
          authMode: "subscription",
        },
        startedAt,
        taskId: "task-parity",
        executionId: "execution-parity",
        agentId: "parity-agent",
        ...(id === "runtime-query-a" ? { cwd: "/private/pg-parity-example" } : {}),
        ...(id === "runtime-query-a" || id === "runtime-query-b"
          ? {
              squadId: "parity-squad",
              squadRun: {
                squadRunId: "squad_aaaaaaaaaaaaaaaaaaaaaaaa",
                squadId: "parity-squad",
                mission: "query contract",
                leaderAgentId: "parity-agent",
                subject: { kind: "task" as const, taskId: "task-parity", executionId: "execution-parity" },
              },
            }
          : {}),
        attemptGroupId: "runtime-query-attempts",
        ...extra,
      },
    };
    await append({ event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId), blobs: [] });
    if (id === "runtime-query-c") {
      for (const [ordinal, suffix] of ["", ":attempt2", ":fallback:3", ":attempt2:fallback:3"].entries()) {
        const dispatchId = `legacy-review-${ordinal}`,
          legacy: AgentRuntimeEventV1 = {
            ...event,
            eventId: `event-${dispatchId}`,
            opId: `operation-${dispatchId}`,
            workspaceRevision: revision(),
            occurredAt: "2025-09-01T00:00:00.000Z",
            payload: {
              ...event.payload,
              dispatchId,
              runtimeSessionId: `session-${dispatchId}`,
              startedAt: "2025-09-01T00:00:00.000Z",
              dispatchKey: `task-review:task-parity:execution-parity:2:sha256:${"a".repeat(64)}${suffix}`,
              role: "reviewer",
              agentId: "reviewer-b",
              reviewTarget: {
                kind: "task",
                taskId: "task-parity",
                executionId: "execution-parity",
                digest: `sha256:${"a".repeat(64)}`,
              },
            },
          };
        await append({
          event: legacy,
          plan: canonicalEventWritePlan(legacy, "agent-runtime/v1", legacy.opId),
          blobs: [],
        });
        if (ordinal === 0) {
          const duplicate = {
            ...legacy,
            workspaceRevision: revision(),
            eventId: "event-review-duplicate",
            opId: "operation-review-duplicate",
            payload: {
              ...legacy.payload,
              dispatchId: "legacy-review-duplicate",
              runtimeSessionId: "session-legacy-review-duplicate",
            },
          };
          await append({
            event: duplicate,
            plan: canonicalEventWritePlan(duplicate, "agent-runtime/v1", duplicate.opId),
            blobs: [],
          });
        }
      }
    }
  }
  const outcome: AgentRuntimeEventV1 = {
    schema: "agent-runtime-event/v1",
    type: "runtime_session_outcome_observed",
    eventId: "event-runtime-query-outcome",
    opId: "operation-runtime-query-outcome",
    workspaceRevision: revision(),
    occurredAt: "2026-09-02T01:00:00.000Z",
    actor: { executor: null, principal: { personId: "person_runtime" } },
    source: "local",
    payload: {
      runtimeSessionId: "runtime-query-session",
      dispatchId: "runtime-query-a",
      outcome: "failed",
      exitCode: 1,
      endedAt: "2026-09-02T01:00:00.000Z",
      reasonCode: "fixture_failure",
      resultRef: "artifact:runtime-result/sha256/" + "1".repeat(64),
      result: null,
      runtimeMetrics: {
        inputTokens: 320,
        cacheReadTokens: 80,
        outputTokens: 40,
        totalTokens: 360,
        toolCallCount: 3,
        usageUnavailable: false,
      },
      cacheWriteTokens: 60,
    },
  };
  await append({ event: outcome, plan: canonicalEventWritePlan(outcome, "agent-runtime/v1", outcome.opId), blobs: [] });
  for (const [id, occurredAt, closed] of [
    ["window-live", "2026-08-01T00:00:00.000Z", false],
    ["window-closed", "2026-09-02T01:00:00Z", true],
    ["window-fraction", "2026-09-02T01:00:00.1234Z", true],
  ] as const) {
    const event: AgentRuntimeEventV1 = {
      ...started,
      eventId: `${id}-start`,
      opId: `${id}-start`,
      occurredAt: new Date(occurredAt).toISOString(),
      workspaceRevision: revision(),
      payload: { ...started.payload, runtimeSessionId: id, taskBinding: { taskId: "window-task", executionId: id } },
    };
    await append({ event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId), blobs: [] });
    if (closed) {
      const exit: AgentRuntimeEventV1 = {
        ...event,
        type: "runtime_session_exited",
        eventId: `${id}-exit`,
        opId: `${id}-exit`,
        workspaceRevision: revision(),
        payload: { runtimeSessionId: id },
      };
      await append({ event: exit, plan: canonicalEventWritePlan(exit, "agent-runtime/v1", exit.opId), blobs: [] });
    }
  }
}

/** One contract body is invoked on each backend before the complete results are compared. */
function dispatchContract(
  queries: Pick<
    TaskProjectionQueries,
    keyof Pick<
      PgTaskQueryMethods,
      | "readRuntimeDispatch"
      | "readRuntimeDispatchById"
      | "readRuntimeDispatchByDispatchKey"
      | "readRuntimeDispatchByResumeSource"
      | "readRuntimeDispatchesBySession"
      | "readRuntimeDispatchEventsBySession"
      | "readRuntimeDispatchesByTaskIds"
      | "readLatestRuntimeDispatchesByTaskIds"
      | "readRuntimeDispatchByDispatchIdPrefix"
      | "countRuntimeDispatchesByAgent"
      | "readRuntimeDispatchesByTaskExecution"
      | "readRuntimeDispatchesByAttemptGroup"
      | "readRuntimeDispatchesByDecision"
      | "readRuntimeDispatchesByDecisions"
      | "readRuntimeDispatchPage"
      | "readRuntimeDispatchesByMember"
      | "readRuntimeSessionEvents"
      | "readCanonicalEvents"
      | "readOperation"
      | "readReplicaBasis"
    >
  >,
  nodeId: string,
) {
  const all = queries.readRuntimeDispatchesByTaskIds(["task-parity"]),
    byId = queries.readRuntimeDispatchById("runtime-query-a");
  assert.equal(all.length, 8);
  assert.deepEqual(
    all.slice(0, 3).map(({ payload }) => payload.dispatchId),
    ["runtime-query-a", "runtime-query-b", "runtime-query-c"],
  );
  assert.deepEqual(queries.readRuntimeDispatchesByTaskIds(["missing-task"]), []);
  assert.deepEqual(queries.readLatestRuntimeDispatchesByTaskIds(["missing-task"]), []);
  assert.deepEqual(
    queries.readLatestRuntimeDispatchesByTaskIds(["task-parity"]).map(({ payload }) => payload.dispatchId),
    ["runtime-query-c"],
  );
  assert.deepEqual(
    queries.readRuntimeDispatchByDispatchIdPrefix("runtime-query-", 10).map(({ event }) => event.payload.dispatchId),
    ["runtime-query-a", "runtime-query-b", "runtime-query-c"],
  );
  assert.equal(queries.countRuntimeDispatchesByAgent("parity-agent"), 3);
  assert.equal(queries.countRuntimeDispatchesByAgent("missing-agent"), 0);
  const scope = { agentId: "parity-agent", personId: "person_runtime", nodeId, limit: 1 };
  const memberPage = queries.readRuntimeDispatchesByMember(scope);
  assert.deepEqual(
    memberPage.rows.map(({ payload }) => payload.dispatchId),
    ["runtime-query-b"],
  );
  assert.equal(memberPage.sessions.length, 1);
  assert.equal(memberPage.truncated, true);
  assert.deepEqual(
    queries.readRuntimeDispatchesByMember({ ...scope, nodeId: nodeId === "center" ? "edge-missing" : "center" }),
    { rows: [], sessions: [], truncated: false },
  );
  for (const keyed of [
    queries.readRuntimeDispatchesByTaskIds(["task-parity"]),
    queries.readRuntimeDispatchEventsBySession("runtime-query-session"),
    queries.readRuntimeDispatchByDispatchIdPrefix("runtime-query-", 10).map(({ event }) => event),
  ])
    assert.ok(
      keyed.every(({ payload }) => !("cwd" in payload)),
      "keyed dispatch reads must apply the public dispatch mapper",
    );
  assert.equal("cwd" in byId!.event.payload, false);
  assert.deepEqual(
    queries.readRuntimeDispatchEventsBySession("runtime-query-session").map(({ payload }) => payload.dispatchId),
    ["runtime-query-a", "runtime-query-b", "runtime-query-c"],
  );
  assert.equal(byId?.outcome, "failed");
  assert.equal(byId?.endedAt, "2026-09-02T01:00:00.000Z");
  assert.equal(queries.readRuntimeDispatchById("missing"), null);
  assert.equal(queries.readRuntimeDispatch("missing"), null);
  assert.equal(queries.readRuntimeDispatch("runtime-query-session", "missing"), null);
  assert.equal(queries.readRuntimeDispatchById("runtime-query-b")?.outcome, null);
  const pages = [],
    limit = 1;
  let cursor: Parameters<TaskProjectionQueries["readRuntimeDispatchPage"]>[0]["cursor"];
  for (;;) {
    const page = queries.readRuntimeDispatchPage({
      startedAtGte: "2026-09-01T00:00:00.000Z",
      limit,
      ...(cursor ? { cursor } : {}),
    });
    pages.push(page);
    if (page.done) break;
    assert.ok(page.nextCursor);
    assert.notDeepEqual(page.nextCursor, cursor);
    cursor = page.nextCursor;
    assert.ok(pages.length <= 3);
  }
  assert.deepEqual(
    pages.flatMap(({ rows }) => rows.map(({ event }) => event.payload.dispatchId)),
    ["runtime-query-a", "runtime-query-b", "runtime-query-c"],
  );
  // F11 + F13 parity: member/person/upper-bound/maxRevision/desc seek pages match across SQLite and PostgreSQL.
  const descAllPages = [];
  let descAllCursor: Parameters<TaskProjectionQueries["readRuntimeDispatchPage"]>[0]["cursor"];
  for (;;) {
    const page = queries.readRuntimeDispatchPage({
      agentId: "parity-agent",
      startedAtGte: "2026-09-01T00:00:00.000Z",
      startedAtLte: "2026-09-03T00:00:00.000Z",
      order: "desc",
      limit: 1,
      ...(descAllCursor ? { cursor: descAllCursor } : {}),
    });
    descAllPages.push(page);
    if (page.done) break;
    assert.ok(page.nextCursor);
    descAllCursor = page.nextCursor;
    assert.ok(descAllPages.length <= 4);
  }
  assert.deepEqual(
    descAllPages.flatMap(({ rows }) => rows.map(({ event }) => event.payload.dispatchId)),
    ["runtime-query-c", "runtime-query-a", "runtime-query-b"],
  );
  const descPersonPages = [];
  let descPersonCursor: Parameters<TaskProjectionQueries["readRuntimeDispatchPage"]>[0]["cursor"];
  for (;;) {
    const page = queries.readRuntimeDispatchPage({
      agentId: "parity-agent",
      personId: "person_runtime",
      startedAtGte: "2026-09-01T00:00:00.000Z",
      startedAtLte: "2026-09-03T00:00:00.000Z",
      order: "desc",
      limit: 1,
      ...(descPersonCursor ? { cursor: descPersonCursor } : {}),
    });
    descPersonPages.push(page);
    if (page.done) break;
    assert.ok(page.nextCursor);
    descPersonCursor = page.nextCursor;
    assert.ok(descPersonPages.length <= 3);
  }
  assert.deepEqual(
    descPersonPages.flatMap(({ rows }) => rows.map(({ event }) => event.payload.dispatchId)),
    ["runtime-query-a", "runtime-query-b"],
  );
  assert.deepEqual(
    queries
      .readRuntimeDispatchPage({
        agentId: "parity-agent",
        startedAtGte: "2026-09-01T00:00:00.000Z",
        startedAtLte: "2026-09-02T00:00:00.000Z",
        order: "desc",
        maxRevision: byId!.event.workspaceRevision,
        limit: 10,
      })
      .rows.map(({ event }) => event.payload.dispatchId),
    ["runtime-query-a"],
  );
  // F11 parity: bounded readRuntimeSessionEventsByType with maxRevision/limit/order across SQLite and PostgreSQL.
  const allSessionOutcomes = queries.readRuntimeSessionEventsByType("runtime-query-session", [
    "runtime_dispatch_requested",
    "runtime_session_outcome_observed",
  ]);
  assert.ok(allSessionOutcomes.length >= 2);
  const firstSessionRev = allSessionOutcomes[0]!.workspaceRevision;
  assert.deepEqual(
    queries
      .readRuntimeSessionEventsByType(
        "runtime-query-session",
        ["runtime_dispatch_requested", "runtime_session_outcome_observed"],
        { maxRevision: firstSessionRev, limit: 10, order: "desc" },
      )
      .map((event) => event.workspaceRevision),
    [firstSessionRev],
  );
  assert.deepEqual(
    queries
      .readRuntimeSessionEventsByType(
        "runtime-query-session",
        ["runtime_dispatch_requested", "runtime_session_outcome_observed"],
        { limit: 1, order: "desc" },
      )
      .map((event) => event.workspaceRevision),
    [allSessionOutcomes.at(-1)!.workspaceRevision],
  );
  assert.throws(
    () =>
      queries.readRuntimeSessionEventsByType("runtime-query-session", ["runtime_session_outcome_observed"], {
        limit: 0,
      }),
    /limit/,
  );
  assert.throws(
    () =>
      queries.readRuntimeSessionEventsByType("runtime-query-session", ["runtime_session_outcome_observed"], {
        maxRevision: -1,
      }),
    /maxRevision/,
  );
  // F16 parity: bounded readEventList with afterRevision + order across SQLite and PostgreSQL.
  const allActorEvents = queries.readEventList({ actorPersonId: "person_runtime", limit: 100 });
  if (allActorEvents.rows.length >= 2) {
    const oldest = allActorEvents.rows.at(-1)!.revision,
      newest = allActorEvents.rows[0]!.revision,
      ascWindow = queries.readEventList({
        actorPersonId: "person_runtime",
        afterRevision: oldest - 1,
        revisionBound: newest + 1,
        order: "asc",
        limit: 100,
      });
    assert.deepEqual(
      ascWindow.rows.map((row) => row.revision),
      allActorEvents.rows.map((row) => row.revision).toReversed(),
    );
  }
  assert.throws(() => queries.readRuntimeDispatchPage({ startedAtGte: "", limit: 0 }), /limit/);
  assert.throws(() => queries.readRuntimeDispatchPage({ startedAtGte: "", limit: 501 }), /limit/);
  const historical = ["", ":attempt2", ":fallback:3", ":attempt2:fallback:3"].map((suffix, ordinal) => {
    const oldKey = `task-review:task-parity:execution-parity:2:sha256:${"a".repeat(64)}${suffix}`,
      key = `task-review:task-parity:execution-parity:2:sha256:${"a".repeat(64)}:reviewer:reviewer-b${suffix}`,
      row = queries.readRuntimeDispatchByDispatchKey(key);
    assert.ok(row, `historical reviewer lookup ${suffix}`);
    assert.equal(queries.readRuntimeDispatchByDispatchKey(oldKey), null);
    assert.equal(row.event.opId, `operation-legacy-review-${ordinal}`);
    assert.equal(row.event.eventId, `event-legacy-review-${ordinal}`);
    assert.equal(row.event.payload.dispatchId, `legacy-review-${ordinal}`);
    assert.equal(row.event.payload.runtimeSessionId, `session-legacy-review-${ordinal}`);
    assert.equal(row.event.payload.dispatchKey, key);
    assert.deepEqual(row, queries.readRuntimeDispatchById(row.event.payload.dispatchId));
    assert.deepEqual(row.event, queries.readRuntimeDispatch(row.event.payload.runtimeSessionId));
    assert.deepEqual([row], queries.readRuntimeDispatchesBySession(row.event.payload.runtimeSessionId));
    assert.deepEqual([row.event], queries.readRuntimeSessionEvents(row.event.payload.runtimeSessionId, 0, 100));
    assert.deepEqual(row.event, queries.readOperation(row.event.opId)?.event);
    assert.deepEqual(
      row.event,
      queries.readCanonicalEvents(0, 500).events.find(({ eventId }) => eventId === row.event.eventId),
    );
    assert.deepEqual(
      row.event,
      queries.readReplicaBasis(0).events.find(({ eventId }) => eventId === row.event.eventId),
    );
    return row;
  });
  return {
    all,
    historical,
    historicalPage: queries.readRuntimeDispatchPage({ startedAtGte: "2025-01-01T00:00:00.000Z", limit: 500 }),
    reviewers: queries.readRuntimeDispatchesByMember({ agentId: "reviewer-b", limit: 500 }),
    byId,
    pages,
    dispatch: queries.readRuntimeDispatch("runtime-query-session"),
    definition: queries.readRuntimeDispatch("runtime-query-session", "artifact:runtime-definitions/codex/v1"),
    key: queries.readRuntimeDispatchByDispatchKey("key-runtime-query-b"),
    resume: queries.readRuntimeDispatchByResumeSource("runtime-query-a"),
    session: queries.readRuntimeDispatchesBySession("runtime-query-session"),
    sessionEvents: queries.readRuntimeDispatchEventsBySession("runtime-query-session"),
    taskRows: queries.readRuntimeDispatchesByTaskIds(["task-parity"]),
    latestTaskRows: queries.readLatestRuntimeDispatchesByTaskIds(["task-parity"]),
    prefix: queries.readRuntimeDispatchByDispatchIdPrefix("runtime-query-", 10),
    agentCount: queries.countRuntimeDispatchesByAgent("parity-agent"),
    execution: queries.readRuntimeDispatchesByTaskExecution("task-parity", "execution-parity"),
    attempts: queries.readRuntimeDispatchesByAttemptGroup("runtime-query-attempts"),
    decisions: queries.readRuntimeDispatchesByDecision("dec_PG_PARITY"),
    decisionReviews: queries.readRuntimeDispatchesByDecisions([
      ...Array.from({ length: 1_001 }, (_, index) => `dec_missing_${index}`),
      "dec_PG_PARITY",
      "dec_PG_PARITY",
    ]),
    empty: queries.readRuntimeDispatchPage({ startedAtGte: "2027-01-01T00:00:00.000Z", limit: 1 }),
  };
}
export function assertRuntimeQueryParity(
  pg: PgTaskQueryMethods,
  sqlite: TaskProjectionQueries,
  nodeId = "center",
): void {
  const postgres = dispatchContract(pg, nodeId);
  assert.deepEqual(
    postgres.decisionReviews,
    postgres.decisions.map(({ event }) => event),
  );
  assert.ok(postgres.decisionReviews.length > 0);
  assert.deepEqual(pg.readRuntimeDispatchesByDecisions([]), []);
  assert.deepEqual(dispatchContract(sqlite, nodeId), postgres);
  const boundary = "2026-09-02T01:00:00.123Z";
  for (const query of [
    { observedAfter: boundary },
    { observedBefore: boundary },
    { observedAfter: boundary, observedBefore: "2026-09-02T01:00:00.1234Z" },
    { observedAfter: "2026-09-02T01:00:00Z", observedBefore: "2026-09-02T01:00:00.000Z" },
    { activitySince: boundary },
    { activitySince: boundary, nonExitedOnly: true },
    { activitySince: boundary, inFlightOnly: true },
    { activitySince: boundary, runtimeSessionId: "window-fraction" },
    { observedAfter: boundary, runtimeSessionId: "window-closed" },
  ])
    assert.deepEqual(pg.readRuntimeSessions(query), sqlite.readRuntimeSessions(query), JSON.stringify(query));
  const activityIds = pg
    .readRuntimeSessions({ activitySince: boundary })
    .map(({ runtimeSessionId }) => runtimeSessionId);
  assert.ok(activityIds.includes("window-live"), "an old live session survives the cutoff");
  assert.ok(activityIds.includes("window-fraction"), "closed sessions at the millisecond boundary remain visible");
  assert.ok(!activityIds.includes("window-closed"), "closed sessions before the cutoff are excluded");
}
