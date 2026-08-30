// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  entityActionCliInputs,
  explainEntityKind,
  getEntityKindContract,
  validateEntityActionInput,
} from "../../src/domain/index.ts";

const concurrencyFields = [
  "expectedVersion",
  "leasePolicy",
  "occurrenceClaim",
  "idempotency",
  "artifactOwnership",
] as const;

test("Task start submit review complete are complete executable Action contracts", () => {
  const task = getEntityKindContract("task"),
    actions = task?.actionCatalog?.actions ?? [];
  assert.deepEqual(
    actions.map(({ id }) => id),
    ["start", "submit", "review", "complete"],
  );
  for (const action of actions) {
    assert.ok(action.execution, action.id);
    assert.equal(action.actor.source, "authenticated-binding");
    assert.equal(action.target.kind, "task");
    assert.equal(action.input.schema, "entity-action-input/v1");
    assert.ok(action.criteria.length >= 3, action.id);
    assert.deepEqual(Object.keys(action.concurrency), concurrencyFields);
    assert.equal(action.concurrency.artifactOwnership.owner, "execution");
    assert.ok(
      action.effects.every(({ ref }) => ref.includes("task-lifecycle")),
      action.id,
    );
    assert.equal(action.returns.schema, "action-result/v1");
    assert.ok(action.explain.length > 0);
  }
  assert.deepEqual(explainEntityKind("task").transitions.available, ["start", "submit", "review", "complete"]);
  assert.deepEqual(explainEntityKind("agent").transitions.available, []);
});

test("Agent-readable input and CLI facets share the same field declarations", () => {
  const actions = getEntityKindContract("task")?.actionCatalog?.actions ?? [];
  for (const action of actions)
    assert.deepEqual(
      entityActionCliInputs(action).map(({ field }) => field),
      action.input.fields.filter(({ cli }) => cli).map(({ field }) => field),
      action.id,
    );
  assert.deepEqual(validateEntityActionInput("task-submit", { kind: "task-submit", taskId: "task_1" }), [
    "task-submit requires exactly one of fromFile, jsonInput",
  ]);
  assert.deepEqual(
    validateEntityActionInput("task-submit", {
      kind: "task-submit",
      taskId: "task_1",
      fromFile: "submission.json",
      jsonInput: "{}",
    }),
    ["task-submit requires exactly one of fromFile, jsonInput"],
  );
  assert.deepEqual(
    validateEntityActionInput("task-submit", {
      kind: "task-submit",
      taskId: "task_1",
      fromFile: "submission.json",
      expectedVersion: 7,
    }),
    [],
  );
});

test("entity explain reports all runtime-local bounded-context Action exceptions", () => {
  assert.deepEqual(
    explainEntityKind("task").boundedContextExceptions.map(({ boundedContext }) => boundedContext),
    ["preset-library", "daemon-user-root", "terminal-host"],
  );
});
