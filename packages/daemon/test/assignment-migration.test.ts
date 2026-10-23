// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { runAssignmentMigrationAction } from "../src/assignment-migration-action.ts";

const actor = { principal: { personId: "person-migration" }, executor: null } as const;

function legacyAssignmentEvent() {
  return {
    schema: "task-event/v1",
    eventId: "legacy-event-1",
    workspaceRevision: 3,
    opId: "legacy-op-1",
    taskId: "task-migration",
    type: "task_assigned",
    actor,
    source: "local",
    occurredAt: "2026-10-01T00:00:00.000Z",
    payload: {
      task: {
        schema: "task/v2",
        taskId: "task-migration",
        assignment: { assignee: { kind: "person", personId: "person-target" }, expiresAt: "2026-10-02T00:00:00.000Z" },
      },
    },
  } as const;
}

function migrationCell() {
  const events = [legacyAssignmentEvent()],
    published = new Map<string, Record<string, unknown>>(),
    projected: Record<string, unknown>[] = [],
    store = {
      read: () => ({ events }),
      readHead: () => ({ revision: 10 }),
      readEvent: (opId: string) => published.get(opId) ?? null,
      append: ({ event }: { readonly event: Record<string, unknown> }) => {
        published.set(String(event.opId), event);
        events.push(event);
        return { event, revision: event.workspaceRevision };
      },
    },
    cell = {
      input: { repoId: "migration-repo" },
      store,
      projection: { apply: (event: Record<string, unknown>) => projected.push(event) },
      operationId: () => "migration-action-op",
      previewResult: (_opId: string, value: Record<string, unknown>) => ({
        outcome: "pending",
        evidence: JSON.stringify(value),
      }),
      readResult: (_opId: string, value: Record<string, unknown>) => ({
        outcome: "applied",
        evidence: JSON.stringify(value),
      }),
    } as never;
  return { cell, published, projected };
}

test("assignment migration dry-run, apply and replay are idempotent and parity-safe", () => {
  const { cell, published, projected } = migrationCell(),
    binding = { actor, source: "local" as const },
    dryRun = runAssignmentMigrationAction(cell, { kind: "assignment-migrate", dryRun: true }, binding),
    firstApply = runAssignmentMigrationAction(cell, { kind: "assignment-migrate" }, binding),
    secondApply = runAssignmentMigrationAction(cell, { kind: "assignment-migrate" }, binding);
  assert.equal(dryRun.outcome, "pending");
  assert.deepEqual(JSON.parse(String(dryRun.evidence)), {
    schema: "assignment-migration/v1",
    dryRun: true,
    assigned: 1,
    unassigned: 0,
    invalid: 0,
    converted: 1,
    sourceEvents: 1,
  });
  assert.equal(published.size, 1);
  assert.deepEqual(JSON.parse(String(firstApply.evidence)), {
    schema: "assignment-migration/v1",
    dryRun: false,
    assigned: 1,
    unassigned: 0,
    invalid: 0,
    converted: 1,
    appended: 1,
    sourceEvents: 1,
    parity: true,
  });
  assert.equal(projected.length, 1);
  assert.deepEqual(JSON.parse(String(secondApply.evidence)), {
    schema: "assignment-migration/v1",
    dryRun: false,
    assigned: 1,
    unassigned: 0,
    invalid: 0,
    converted: 1,
    appended: 0,
    sourceEvents: 1,
    parity: true,
  });
  assert.equal(published.size, 1);
  assert.equal(projected.length, 1);
});
