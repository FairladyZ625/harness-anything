// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalEventV1 } from "@harness-anything/kernel";
import { eventListQueryFromAction, findLedgerEvent } from "../src/repo-cell-event-query.ts";
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

function store(events: readonly CanonicalEventV1[]) {
  return {
    readEvent: (opId: string) => events.find((candidate) => candidate.opId === opId) ?? null,
    readEventById: (eventId: string) => events.find((candidate) => candidate.eventId === eventId) ?? null,
  };
}
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
