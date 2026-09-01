// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  ENTITY_ACTION_EXPLANATION_SCHEMA,
  getEntityKindContract,
  taskActionUsage,
  validateEntityActionExplainRequest,
  validateEntityActionExplanationSet,
  type ActorIdentity,
  type EntityActionContract,
  type EntityActionExplanationSetV1,
  type EntityActionExplanationV1,
} from "../../src/index.ts";
import { serializeEntityActionExplanationSet } from "../../src/domain/entity-action-explanation.ts";

const actor: ActorIdentity = { principal: { personId: "person-explain" }, executor: null };

test("Entity Action explain request is exact and caps object batches at 500 refs", () => {
  assert.deepEqual(
    validateEntityActionExplainRequest({
      schema: "entity-action-explain-request/v1",
      mode: "object",
      entityKind: null,
      refs: Array.from({ length: 500 }, () => "task/task-1"),
    }),
    [],
  );
  assert.match(
    validateEntityActionExplainRequest({
      schema: "entity-action-explain-request/v1",
      mode: "object",
      entityKind: null,
      refs: Array.from({ length: 501 }, () => "task/task-1"),
    }).join("\n"),
    /1\.\.500/u,
  );
  assert.match(
    validateEntityActionExplainRequest({
      schema: "entity-action-explain-request/v1",
      mode: "catalog",
      entityKind: "task",
      refs: [],
      actor,
    }).join("\n"),
    /unknown/u,
  );
});

test("catalog and object modes share one strict schema with four honest criterion states", () => {
  const { ref, actions } = taskCatalog(),
    catalog: EntityActionExplanationSetV1 = {
      schema: ENTITY_ACTION_EXPLANATION_SCHEMA.id,
      mode: "catalog",
      subjects: [
        {
          kind: "task",
          ref: null,
          revision: null,
          actions: actions.map((action) => ({
            action: descriptor(ref, action),
            target: null,
            available: null,
            criteria: action.criteria.map((criterion) => ({
              ...criterion,
              status: "not-evaluated",
              nextActions: [],
            })),
            unmetCriteria: [],
            authorizationDecision: null,
            nextActions: [],
            evaluatedAtCut: null,
          })),
          failure: null,
        },
      ],
      evaluatedAtCut: null,
    };
  assert.deepEqual(validateEntityActionExplanationSet(catalog), []);
  assert.equal(JSON.parse(serializeEntityActionExplanationSet(catalog)).mode, "catalog");

  const cut = "canonical:17",
    target = "task/task-1" as const,
    object: EntityActionExplanationSetV1 = {
      schema: ENTITY_ACTION_EXPLANATION_SCHEMA.id,
      mode: "object",
      subjects: [
        {
          kind: "task",
          ref: target,
          revision: 17,
          actions: actions.map((action, actionIndex) => {
            const criteria = action.criteria.map((criterion, criterionIndex) => ({
                ...criterion,
                status:
                  actionIndex === 1 && criterionIndex === 1
                    ? ("invocation-required" as const)
                    : actionIndex === 0 && criterionIndex === 0
                      ? ("unmet" as const)
                      : ("met" as const),
                nextActions: criterionIndex === 0 ? ["Refresh the Task witness."] : [],
              })),
              unmetCriteria = criteria
                .filter(({ status }) => status === "unmet")
                .map(({ ref: criterionRef, failureCode, explain }) => ({
                  ref: criterionRef,
                  failureCode,
                  explain,
                }));
            return {
              action: descriptor(ref, action),
              target: { ref: target, revision: 17 },
              available: unmetCriteria.length === 0,
              criteria,
              unmetCriteria,
              authorizationDecision: {
                policyRef: "default@5",
                actor,
                subject: target,
                bindingsUsed: [],
                outcome: "allowed",
                reasonCodes: [],
                nextActions: [],
                evaluatedAtCut: cut,
              },
              nextActions: criteria.flatMap((criterion) => criterion.nextActions),
              evaluatedAtCut: cut,
            };
          }),
          failure: null,
        },
      ],
      evaluatedAtCut: cut,
    };
  assert.deepEqual(validateEntityActionExplanationSet(object), []);
  assert.deepEqual(
    object.subjects[0]!.actions[0]!.unmetCriteria.map(({ ref: criterionRef }) => criterionRef),
    ["task-lifecycle-contract-support/revisionIssues"],
  );
  assert.equal(
    actions.reduce((count, action) => count + action.criteria.length, 0),
    19,
  );

  const dishonestAvailability = structuredClone(object) as unknown as {
    subjects: { actions: { available: boolean }[] }[];
  };
  dishonestAvailability.subjects[0]!.actions[0]!.available = true;
  assert.match(validateEntityActionExplanationSet(dishonestAvailability).join("\n"), /available must equal/u);

  const dishonestProjection = structuredClone(object) as unknown as {
    subjects: { actions: { unmetCriteria: { ref: string }[] }[] }[];
  };
  dishonestProjection.subjects[0]!.actions[0]!.unmetCriteria[0]!.ref =
    "task-lifecycle-command-transitions/canStartExecution";
  assert.match(validateEntityActionExplanationSet(dishonestProjection).join("\n"), /exact unmet criteria/u);
});

function taskCatalog(): { readonly ref: string; readonly actions: readonly EntityActionContract[] } {
  const catalog = getEntityKindContract("task")?.actionCatalog;
  assert.ok(catalog);
  return catalog;
}

function descriptor(catalogRef: string, action: EntityActionContract): EntityActionExplanationV1["action"] {
  return {
    kind: "task",
    id: action.id,
    catalogRef,
    contractVersion: `${action.version.major}.${action.version.minor}`,
    explain: action.explain,
    syntax: { usage: taskActionUsage(action), inputs: action.input.fields },
  };
}
