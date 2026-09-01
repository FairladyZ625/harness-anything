// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { explainEntityKind, getEntityKindContract } from "../../src/domain/entity-kind-registry.ts";

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
  assert.deepEqual(explainEntityKind("agent").transitions.available, ["install"]);
});

test("Agent-readable input and CLI facets share the same field declarations", () => {
  const actions = getEntityKindContract("task")?.actionCatalog?.actions ?? [];
  for (const action of actions) {
    const cliFields = action.input.fields.filter(({ cli }) => cli);
    assert.equal(new Set(cliFields.map(({ field }) => field)).size, cliFields.length, action.id);
    assert.ok(
      cliFields.every(({ cli }) => cli?.name.startsWith("--")),
      action.id,
    );
  }
  assert.deepEqual(actions.find(({ id }) => id === "submit")?.input.exactlyOneOf, [["fromFile", "jsonInput"]]);
});

test("entity explain reports all runtime-local bounded-context Action exceptions", () => {
  assert.deepEqual(
    explainEntityKind("task").boundedContextExceptions.map(({ boundedContext }) => boundedContext),
    ["daemon-user-root", "preset-library", "daemon-user-root", "terminal-host"],
  );
});
