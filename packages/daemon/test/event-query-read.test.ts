// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalEventStore, CanonicalEventV1 } from "@harness-anything/kernel";
import {
  eventEntityRefs,
  eventMatches,
  eventListQueryFromAction,
  findLedgerEvent,
  selectLedgerEvents,
} from "../src/repo-cell-event-query.ts";

function event(overrides: Partial<CanonicalEventV1> & { readonly workspaceRevision: number }): CanonicalEventV1 {
  return {
    schema: "task-event/v1",
    eventId: `event-${overrides.workspaceRevision}`,
    opId: `op-${overrides.workspaceRevision}`,
    type: "task_created",
    actor: { principal: { personId: "person-a" }, executor: { kind: "agent", id: "agent-a" } },
    source: "local",
    occurredAt: `2026-09-01T00:00:${String(overrides.workspaceRevision).padStart(2, "0")}.000Z`,
    payload: {},
    ...overrides,
  } as CanonicalEventV1;
}

function store(
  events: readonly CanonicalEventV1[],
): Pick<CanonicalEventStore, "readEvent" | "readEventById" | "queryEvents"> {
  return {
    readEvent: (opId) => events.find((candidate) => candidate.opId === opId) ?? null,
    readEventById: (eventId) => events.find((candidate) => candidate.eventId === eventId) ?? null,
    queryEvents: (query) =>
      events
        .filter(
          (candidate) =>
            (query.revisionBound === undefined || candidate.workspaceRevision < query.revisionBound) &&
            eventMatches(candidate, query),
        )
        .slice(-query.limit)
        .reverse(),
  };
}

test("event list filters by type and actor while ordering revision-descending", () => {
  const events = [
      event({ workspaceRevision: 1 }),
      event({ workspaceRevision: 2, type: "settings_changed", schema: "settings-event/v1" }),
      event({ workspaceRevision: 3 }),
      event({
        workspaceRevision: 4,
        type: "settings_changed",
        schema: "settings-event/v1",
        actor: { principal: { personId: "person-b" }, executor: null },
      }),
    ],
    byType = selectLedgerEvents(store(events), { type: "settings_changed", limit: 50 });
  assert.deepEqual(
    byType.rows.map(({ revision }) => revision),
    [4, 2],
  );
  const byActor = selectLedgerEvents(store(events), { actor: "person-b", limit: 50 });
  assert.deepEqual(
    byActor.rows.map(({ revision }) => revision),
    [4],
  );
  const byExecutor = selectLedgerEvents(store(events), { actor: "agent-a", limit: 50 });
  assert.deepEqual(
    byExecutor.rows.map(({ revision }) => revision),
    [3, 2, 1],
  );
});

test("event list filters by entity ref, bare id, and occurredAt window", () => {
  const events = [
      event({ workspaceRevision: 1, payload: { taskId: "task_x" } }),
      event({ workspaceRevision: 2, payload: { taskId: "task_y" } }),
      event({ workspaceRevision: 3, payload: { decisionId: "dec_1" } }),
    ],
    byRef = selectLedgerEvents(store(events), { entity: "task/task_x", limit: 50 });
  assert.deepEqual(
    byRef.rows.map(({ revision }) => revision),
    [1],
  );
  const byBareId = selectLedgerEvents(store(events), { entity: "dec_1", limit: 50 });
  assert.deepEqual(
    byBareId.rows.map(({ revision }) => revision),
    [3],
  );
  const windowed = selectLedgerEvents(store(events), {
    after: "2026-09-01T00:00:02.000Z",
    before: "2026-09-01T00:00:02.500Z",
    limit: 50,
  });
  assert.deepEqual(
    windowed.rows.map(({ revision }) => revision),
    [2],
  );
});

test("event list cursor pages do not overlap and the final page reports no cursor", () => {
  const events = [1, 2, 3, 4, 5].map((revision) => event({ workspaceRevision: revision })),
    ledger = store(events),
    first = selectLedgerEvents(ledger, { limit: 2 });
  assert.deepEqual(
    first.rows.map(({ revision }) => revision),
    [5, 4],
  );
  assert.equal(first.nextCursor, "4");
  const second = selectLedgerEvents(ledger, { limit: 2, revisionBound: Number(first.nextCursor) });
  assert.deepEqual(
    second.rows.map(({ revision }) => revision),
    [3, 2],
  );
  assert.equal(second.nextCursor, "2");
  const third = selectLedgerEvents(ledger, { limit: 2, revisionBound: Number(second.nextCursor) });
  assert.deepEqual(
    third.rows.map(({ revision }) => revision),
    [1],
  );
  assert.equal(third.nextCursor, null);
});

test("event list scan keeps only the newest window and entity refs cover envelope and payload", () => {
  const events = [1, 2, 3].map((revision) => event({ workspaceRevision: revision })),
    ledger = store(events),
    page = selectLedgerEvents(ledger, { limit: 2 });
  assert.deepEqual(
    page.rows.map(({ revision }) => revision),
    [3, 2],
  );
  assert.equal(page.hasMore, true);
  const entityEvent = event({
    workspaceRevision: 9,
    type: "entity_upserted",
    schema: "entity-event/v1",
    payload: { entityKind: "software/coding/adr@1", entityId: "ADR-1" },
  });
  assert.deepEqual(eventEntityRefs(entityEvent), ["software/coding/adr@1/ADR-1"]);
});

test("event list query validation bounds limit and rejects malformed cursor and window", () => {
  const cell = {
      cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    },
    parse = (action: Record<string, unknown>) =>
      eventListQueryFromAction(cell, action as Parameters<typeof eventListQueryFromAction>[1]);
  assert.equal(parse({}).limit, 50);
  assert.equal(parse({ limit: 500 }).limit, 500);
  assert.throws(() => parse({ limit: 501 }), /between 1 and 500/u);
  assert.throws(() => parse({ limit: 0 }), /between 1 and 500/u);
  assert.throws(() => parse({ cursor: "abc" }), /--cursor/u);
  assert.throws(() => parse({ after: "not-a-date" }), /--after/u);
  assert.throws(() => parse({ after: "2026-09-02T00:00:00Z", before: "2026-09-01T00:00:00Z" }), /--after/u);
});

test("event show resolves op ids and event ids without scanning batches", () => {
  const target = event({ workspaceRevision: 2, eventId: "event-needle", opId: "op-2" }),
    ledger = store([event({ workspaceRevision: 1 }), target]);
  assert.equal(findLedgerEvent(ledger, "op-2")?.eventId, "event-needle");
  assert.equal(findLedgerEvent(ledger, "event-needle")?.opId, "op-2");
  assert.equal(findLedgerEvent(ledger, "missing"), null);
});
