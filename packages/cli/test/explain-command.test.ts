// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { makeTaskActionExplanationService } from "../../application/src/task-action-explanation-service.ts";
import { renderEntityActionExplanation } from "../src/cli/entity-action-explain-render.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("explain parser selects catalog/object mode without duplicating EntityRef validation", () => {
  const catalog = parseThinCommand(["explain", "task", "--json"]),
    objects = parseThinCommand(["explain", "task/task-one", "fact/F-ABCDEFGH", "not-a-ref"]),
    fiveHundredRefs = Array.from({ length: 500 }, (_, index) => `task/task-${index}`),
    maximum = parseThinCommand(["explain", ...fiveHundredRefs]),
    empty = parseThinCommand(["explain"]),
    overMaximum = parseThinCommand(["explain", ...fiveHundredRefs, "task/task-500"]),
    actorOverride = parseThinCommand(["explain", "task/task-one", "--actor", "owner"]),
    cutOverride = parseThinCommand(["explain", "task/task-one", "--cut", "canonical:1"]);

  assert.equal(catalog.ok, true);
  assert.equal(objects.ok, true);
  assert.equal(maximum.ok, true);
  assert.equal(empty.ok, false);
  assert.equal(overMaximum.ok, false);
  assert.equal(actorOverride.ok, false);
  assert.equal(cutOverride.ok, false);
  if (!catalog.ok || !objects.ok || !maximum.ok) return;
  assert.equal(catalog.command.json, true);
  assert.equal(catalog.command.method, "repo.entity.actions.explain");
  assert.deepEqual(catalog.command.action, {
    kind: "entity-action-explain",
    schema: "entity-action-explain-request/v1",
    mode: "catalog",
    refs: [],
  });
  assert.deepEqual(objects.command.action, {
    kind: "entity-action-explain",
    schema: "entity-action-explain-request/v1",
    mode: "object",
    refs: ["task/task-one", "fact/F-ABCDEFGH", "not-a-ref"],
  });
  assert.deepEqual(maximum.command.action.refs, fiveHundredRefs);
});

test("human renderer exposes availability, reasons, next actions, and the evaluated cut", () => {
  const catalog = makeTaskActionExplanationService({
      actor: { principal: { personId: "person-explain" }, executor: null },
      authorize: () => {
        throw new Error("catalog rendering must not evaluate authorization");
      },
    }).catalog(),
    renderedCatalog = renderEntityActionExplanation(catalog),
    renderedObject = renderEntityActionExplanation({
      schema: "entity-action-explanation/v1",
      mode: "object",
      evaluatedAtCut: "canonical:8",
      subjects: [
        {
          kind: "task",
          ref: "task/task-one",
          revision: 8,
          failure: null,
          actions: [
            {
              ...catalog.subjects[0]!.actions[0]!,
              target: { ref: "task/task-one", revision: 8 },
              available: false,
              criteria: [
                {
                  ref: "criteria/task-state",
                  failureCode: "invalid_transition",
                  explain: "The Task state must permit this Action.",
                  status: "unmet",
                  nextActions: ["Move the Task to planned."],
                },
              ],
              unmetCriteria: [
                {
                  ref: "criteria/task-state",
                  failureCode: "invalid_transition",
                  explain: "The Task state must permit this Action.",
                },
              ],
              authorizationDecision: {
                policyRef: "default@5",
                actor: { principal: { personId: "person-explain" }, executor: null },
                subject: "task/task-one",
                bindingsUsed: [],
                outcome: "allowed",
                reasonCodes: [],
                nextActions: [],
                evaluatedAtCut: "canonical:8",
              },
              nextActions: ["Move the Task to planned."],
              evaluatedAtCut: "canonical:8",
            },
          ],
        },
      ],
    });

  assert.match(renderedCatalog, /catalog; availability is not evaluated/u);
  assert.match(renderedCatalog, /start: not evaluated/u);
  assert.doesNotMatch(renderedCatalog, /start: (?:available|unavailable)/u);
  assert.match(renderedObject, /start: unavailable/u);
  assert.match(renderedObject, /unmet: criteria\/task-state \[invalid_transition\]/u);
  assert.match(renderedObject, /next: Move the Task to planned\./u);
  assert.match(renderedObject, /evaluated cut: canonical:8/u);
});

test("human renderer fails closed when a typed action row is incomplete", () => {
  const catalog = makeTaskActionExplanationService({
      actor: { principal: { personId: "person-explain" }, executor: null },
      authorize: () => {
        throw new Error("catalog rendering must not evaluate authorization");
      },
    }).catalog(),
    row = catalog.subjects[0]!.actions[0]!,
    { evaluatedAtCut: _missing, ...incompleteRow } = row;
  assert.throws(
    () =>
      renderEntityActionExplanation({
        ...catalog,
        subjects: [{ ...catalog.subjects[0]!, actions: [incompleteRow] }],
      } as unknown as Parameters<typeof renderEntityActionExplanation>[0]),
    /missing required fields/u,
  );
});
