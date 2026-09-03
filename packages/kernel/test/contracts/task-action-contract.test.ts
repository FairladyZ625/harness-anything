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
    assert.equal(action.result.schema, "entity-action-result/v2");
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

test("named lifecycle specifications preserve every execution metadata field", () => {
  const actions = getEntityKindContract("task")?.actionCatalog?.actions ?? [];
  assert.deepEqual(
    actions.flatMap((action) => {
      const execution = action.execution,
        lifecycle = execution?.lifecycle;
      return execution && lifecycle
        ? [
            {
              id: action.id,
              ingress: execution.ingress,
              commandType: lifecycle.commandType,
              transitionId: lifecycle.transitionId,
              implementation: execution.implementation,
              topology: execution.topology,
              coordination: lifecycle.coordination,
              eventType: lifecycle.eventType,
              proof: lifecycle.proof,
            },
          ]
        : [];
    }),
    [
      {
        id: "create",
        ingress: "task-create",
        commandType: "CreateReplayTask",
        transitionId: "create_replay_task",
        implementation: "task-lifecycle",
        topology: "center-forward-write",
        coordination: "execute",
        eventType: "task_created",
        proof: ["taskIdUnique", "actorBinding", "validGraph"],
      },
      {
        id: "start",
        ingress: "task-start",
        commandType: "StartExecution",
        transitionId: "start_execution",
        implementation: "task-lifecycle",
        topology: "center-forward-write",
        coordination: "reserve",
        eventType: "execution_started",
        proof: ["actorBinding", "reservation"],
      },
      {
        id: "transition",
        ingress: "task-transition",
        commandType: "TransitionTask",
        transitionId: "transition_task",
        implementation: "task-lifecycle",
        topology: "ledger-write",
        coordination: "execute",
        eventType: "task_transitioned",
        proof: ["auditedReasonWhenRequired"],
      },
      {
        id: "submit",
        ingress: "task-submit",
        commandType: "SubmitExecution",
        transitionId: "submit_execution",
        implementation: "task-lifecycle",
        topology: "ledger-write",
        coordination: "execute",
        eventType: "execution_submitted",
        proof: ["actorBinding", "leaseVersion-or-submitted-cut", "submission"],
      },
      {
        id: "review",
        ingress: "task-review-execution",
        commandType: "RecordReview",
        transitionId: "record_execution_review",
        implementation: "task-lifecycle",
        topology: "local-arbiter",
        coordination: "execute",
        eventType: "review_recorded",
        proof: ["independentActor", "execution-review@v1", "contentCut"],
      },
      {
        id: "consent",
        ingress: "task-review-consent",
        commandType: "RecordReviewConsent",
        transitionId: "record_review_consent",
        implementation: "task-lifecycle",
        topology: "ledger-write",
        coordination: "execute",
        eventType: "review_consent_recorded",
        proof: ["ownerActor", "execution-consent@v1", "reviewDigest", "contentDigest", "submissionDigest"],
      },
      {
        id: "reconcile",
        ingress: "task-code-doc-reconcile",
        commandType: "ReconcileCodeDoc",
        transitionId: "reconcile_code_doc",
        implementation: "task-lifecycle",
        topology: "ledger-write",
        coordination: "execute",
        eventType: "code_doc_reconciled",
        proof: ["actorBinding", "code-doc-reconcile@v1", "commitPaths"],
      },
      {
        id: "repoint",
        ingress: "task-code-doc-repoint",
        commandType: "RepointCodeDoc",
        transitionId: "repoint_code_doc",
        implementation: "task-lifecycle",
        topology: "ledger-write",
        coordination: "execute",
        eventType: "code_doc_repointed",
        proof: ["actorBinding", "code-doc-repoint@v1", "commitPaths"],
      },
      {
        id: "complete",
        ingress: "task-complete",
        commandType: "CompleteTask",
        transitionId: "complete_task",
        implementation: "task-completion",
        topology: "ledger-write",
        coordination: "execute",
        eventType: "task_completed",
        proof: ["ownerOrCommander", "reviewConsent", "typedGateReceipts", "noActiveLease"],
      },
    ],
  );
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
