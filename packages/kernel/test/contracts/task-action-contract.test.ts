// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { explainEntityKind, getEntityKindContract } from "../../src/domain/entity-kind-registry.ts";
import { projectActionState, validateEntityActionDescriptor } from "../../src/domain/entity-action-descriptor.ts";
import { REVIEW_V1_SCHEMA } from "../../src/domain/review.ts";
import { TASK_LIFECYCLE_TRANSITIONS } from "../../src/domain/task-lifecycle-transitions.ts";
import { TASK_LIFECYCLE_COMMAND_CATALOG } from "../../src/domain/task-lifecycle-contract-catalog.ts";
import { lifecycleFixture } from "../store/task-lifecycle-fixture.ts";

const concurrencyFields = [
  "expectedVersion",
  "leasePolicy",
  "occurrenceClaim",
  "idempotency",
  "artifactOwnership",
] as const;

test("all public Task writes are complete executable Action contracts", () => {
  const task = getEntityKindContract("task"),
    actions = task?.actionCatalog?.actions ?? [];
  assert.deepEqual(
    actions.map(({ id }) => id),
    [
      "create",
      "start",
      "transition",
      "submit",
      "review",
      "consent",
      "reconcile",
      "repoint",
      "complete",
      "release",
      "amend",
      "archive",
      "supersede",
      "delete",
      "reopen",
      "contract-migrate",
    ],
  );
  for (const action of actions) {
    assert.ok(action.execution, action.id);
    assert.equal(action.actor.source, "authenticated-binding");
    assert.equal(action.target.kind, "task");
    assert.equal(action.input.schema, "entity-action-input/v2");
    assert.ok(action.criteria.length >= 1, action.id);
    assert.deepEqual(Object.keys(action.concurrency), concurrencyFields);
    assert.ok(["execution", "task"].includes(String(action.concurrency.artifactOwnership.owner)), action.id);
    assert.ok(
      action.effects.every(({ ref }) => ref.includes("task-lifecycle") || ref.includes("task-mutation")),
      action.id,
    );
    assert.equal(action.returns.schema, "action-result/v1");
    assert.deepEqual(validateEntityActionDescriptor(action), [], action.id);
    assert.ok(action.explain.length > 0);
  }
  assert.deepEqual(explainEntityKind("task").transitions.available, [
    "create",
    "start",
    "transition",
    "submit",
    "review",
    "consent",
    "reconcile",
    "repoint",
    "complete",
    "release",
    "amend",
    "archive",
    "supersede",
    "delete",
    "reopen",
    "contract-migrate",
  ]);
  assert.deepEqual(explainEntityKind("agent").transitions.available, ["install", "validate", "list", "inspect"]);
});

test("task creation result and all seven guidance entries derive from its descriptor", () => {
  const create = getEntityKindContract("task")?.actionCatalog?.actions.find(({ id }) => id === "create");
  assert.ok(create);
  assert.deepEqual(
    TASK_LIFECYCLE_COMMAND_CATALOG.find(({ commandType }) => commandType === "CreateReplayTask")?.returns,
    create.returns,
  );
  assert.deepEqual(create.returns.guidance, [
    { kind: "repository-diff-contract", args: {}, when: { outputShape: "repository-diff" } },
    { kind: "task-create-publish", args: {}, when: { dryRun: true } },
    {
      kind: "task-create-start",
      args: { packagePath: "{packagePath}", taskId: "{taskId}" },
      when: { dryRun: false, "proof.canonicalVisible": true },
    },
    {
      kind: "receipt-query",
      args: { opId: "{opId}" },
      when: { dryRun: false, "proof.canonicalVisible": false },
    },
    { kind: "edit-plan", args: { packagePath: "{packagePath}" } },
    { kind: "pin-agenda", args: { taskId: "{taskId}" } },
    { kind: "ledger-managed", args: { fields: ["INDEX.md", "closeout.md"] } },
  ]);
  for (const field of [
    "taskId",
    "status",
    "packagePath",
    "generatedPaths",
    "presetDigest",
    "scaffoldDigest",
    "presetId",
    "profileId",
    "outputShape",
    "completionGates",
    "dryRun",
    "proof.canonicalVisible",
  ])
    assert.ok(create.returns.fields.includes(field), field);
});

test("nested vocabularies retain identity and state projections select one declared branch", () => {
  const actions = getEntityKindContract("task")?.actionCatalog?.actions ?? [],
    review = actions.find(({ id }) => id === "review")!,
    verdict = review.input.fields
      .find(({ field }) => field === "fromFile")
      ?.cli?.jsonSchema?.fields.find(({ field }) => field === "verdict");
  assert.strictEqual(verdict?.value?.kind === "string" ? verdict.value.enumRef : undefined, REVIEW_V1_SCHEMA.verdicts);
  assert.deepEqual(projectActionState(review, { verdict: "changes_requested" }, {}), {
    status: "active",
    currentNode: "implementation",
    executionState: "changes_requested",
  });
  const complete = actions.find(({ id }) => id === "complete")!;
  assert.deepEqual(projectActionState(complete, {}, {}), {
    status: "done",
    currentNode: "review",
    executionState: "accepted",
  });
  for (const transition of TASK_LIFECYCLE_TRANSITIONS)
    assert.deepEqual(Object.keys(transition).sort(), ["actionId", "matches", "reduce", "validate"]);
  assert.equal(new Set(actions.flatMap(({ returns }) => returns.guidance.map(({ kind }) => kind))).size, 7);
});

test("CompleteTask reducer output equals its declared terminal projection", () => {
  const complete = getEntityKindContract("task")?.actionCatalog?.actions.find(({ id }) => id === "complete");
  assert.ok(complete);
  const snapshot = lifecycleFixture().snapshot,
    execution = snapshot.executions.find(({ executionId }) => executionId === "execution-1")!;
  assert.deepEqual(
    { status: snapshot.task?.status, currentNode: snapshot.task?.currentNode, executionState: execution.state },
    projectActionState(complete, {}, {}),
  );
  assert.equal(snapshot.task?.status, "done");
  assert.equal(snapshot.task?.currentNode, "review");
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
