// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { makeTaskActionExplanationService } from "../../application/src/task-action-explanation-service.ts";
import { lifecycleHarness, owner } from "../../application/test/task-lifecycle-test-harness.ts";
import { deriveActionResult } from "@harness-anything/daemon/internal/entity-action-catalog-executor";
import { taskActionCommandUsage } from "@harness-anything/daemon/internal/protocol/daemon-protocol-commands";
import { taskActionHelpRows } from "@harness-anything/daemon/internal/protocol/daemon-protocol-commands-task";
import {
  getExecutableEntityAction,
  projectBaseEntityAtCut,
  requireEntityTypeContract,
  type BaseEntity,
} from "@harness-anything/kernel";
import { renderEntityActionExplanation } from "../src/cli/entity-action-explain-render.ts";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import { receiptExitCode } from "../src/index.ts";

test("explain parser selects catalog/object mode without duplicating EntityRef validation", () => {
  const catalog = parseThinCommand(["explain", "task", "--json"]),
    squadCatalog = parseThinCommand(["explain", "squad", "--json"]),
    artifactCatalog = parseThinCommand(["explain", "software/coding/architecture-decision-record@1", "--json"]),
    objects = parseThinCommand(["explain", "task/task-one", "fact/F-ABCDEFGH", "not-a-ref"]),
    fiveHundredRefs = Array.from({ length: 500 }, (_, index) => `task/task-${index}`),
    maximum = parseThinCommand(["explain", ...fiveHundredRefs]),
    empty = parseThinCommand(["explain"]),
    overMaximum = parseThinCommand(["explain", ...fiveHundredRefs, "task/task-500"]),
    actorOverride = parseThinCommand(["explain", "task/task-one", "--actor", "owner"]),
    cutOverride = parseThinCommand(["explain", "task/task-one", "--cut", "canonical:1"]);

  assert.equal(catalog.ok, true);
  assert.equal(squadCatalog.ok, true);
  assert.equal(artifactCatalog.ok, true);
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
    entityKind: "task",
    refs: [],
  });
  if (!squadCatalog.ok) return;
  assert.deepEqual(squadCatalog.command.action, {
    kind: "entity-action-explain",
    schema: "entity-action-explain-request/v1",
    mode: "catalog",
    entityKind: "squad",
    refs: [],
  });
  if (!artifactCatalog.ok) return;
  assert.deepEqual(artifactCatalog.command.action, {
    kind: "entity-action-explain",
    schema: "entity-action-explain-request/v1",
    mode: "catalog",
    entityKind: "software/coding/architecture-decision-record@1",
    refs: [],
  });
  const personCatalog = parseThinCommand(["explain", "person"]);
  assert.equal(personCatalog.ok, true);
  if (personCatalog.ok) {
    assert.equal(personCatalog.command.method, "repo.entity.actions.explain");
    assert.deepEqual(personCatalog.command.action, {
      kind: "entity-action-explain",
      schema: "entity-action-explain-request/v1",
      mode: "catalog",
      entityKind: "person",
      refs: [],
    });
  }
  assert.deepEqual(objects.command.action, {
    kind: "entity-action-explain",
    schema: "entity-action-explain-request/v1",
    mode: "object",
    entityKind: null,
    refs: ["task/task-one", "fact/F-ABCDEFGH", "not-a-ref"],
  });
  assert.deepEqual(maximum.command.action.refs, fiveHundredRefs);
});

test("human renderer exposes availability, reasons, registry guidance, and the evaluated cut", () => {
  const catalog = makeTaskActionExplanationService({
      actor: { principal: { personId: "person-explain" }, executor: null },
      authorize: () => {
        throw new Error("catalog rendering must not evaluate authorization");
      },
      usage: taskActionCommandUsage,
    }).catalog(),
    renderedCatalog = renderEntityActionExplanation(catalog),
    start = catalog.subjects[0]!.actions.find(({ action }) => action.id === "start");
  assert.ok(start);
  const renderedObject = renderEntityActionExplanation({
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
            ...start,
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
  assert.match(
    renderedObject,
    /next: Resolve the listed criteria or authorization decision, then retry ha task start <task-id>.*\./u,
  );
  assert.doesNotMatch(renderedObject, /Move the Task to planned\./u);
  assert.match(renderedObject, /evaluated cut: canonical:8/u);
});

test("explain failure subjects render the daemon message and nextActions under the request-side ref", () => {
  const failureSet = {
    schema: "entity-action-explanation/v1",
    mode: "failure",
    evaluatedAtCut: "canonical:4",
    subjects: [
      {
        kind: null,
        ref: null,
        revision: null,
        actions: [],
        failure: {
          code: "invalid_entity_ref",
          message: "Entity ref hook is invalid.",
          nextActions: ["Use a registered EntityRef such as task/<task-id>, person/<person-id>, or squad/<squad-id>."],
        },
      },
      { kind: "task", ref: "task/task-one", revision: 4, failure: null, actions: [] },
    ],
  };
  const rendered = renderEntityActionExplanation(failureSet, ["hook", "task/task-one"]);

  assert.match(rendered, /^hook: invalid_entity_ref$/mu);
  assert.match(rendered, /^ {2}message: Entity ref hook is invalid\.$/mu);
  assert.match(
    rendered,
    /^ {2}next: Use a registered EntityRef such as task\/<task-id>, person\/<person-id>, or squad\/<squad-id>\.$/mu,
  );
  assert.match(rendered, /^task\/task-one @ revision 4$/mu);
  assert.doesNotMatch(rendered, /invalid ref/u);

  const receipt = renderCliReceipt(failureSet, ["hook", "task/task-one"]);
  assert.equal(receipt.stream, "stdout");
  assert.match(receipt.text, /^hook: invalid_entity_ref$/mu);
});

test("an invalid-ref failure without its request-side ref fails closed instead of relabeling", () => {
  assert.throws(
    () =>
      renderEntityActionExplanation({
        schema: "entity-action-explanation/v1",
        mode: "failure",
        evaluatedAtCut: "canonical:4",
        subjects: [
          {
            kind: null,
            ref: null,
            revision: null,
            actions: [],
            failure: {
              code: "invalid_entity_ref",
              message: "Entity ref hook is invalid.",
              nextActions: ["Retry with a registered EntityRef."],
            },
          },
        ],
      }),
    /missing its request-side ref/u,
  );
});

test("explain receipts exit non-zero exactly when the explanation mode is failure", () => {
  assert.equal(receiptExitCode({ schema: "entity-action-explanation/v1", mode: "failure" }), 1);
  assert.equal(receiptExitCode({ schema: "entity-action-explanation/v1", mode: "object" }), 0);
  assert.equal(receiptExitCode({ schema: "entity-action-explanation/v1", mode: "catalog" }), 0);
  assert.equal(receiptExitCode({ ok: true }), 0);
  assert.equal(receiptExitCode({ code: "missing_field" }), 2);
  assert.equal(receiptExitCode({}), 1);
  assert.equal(receiptExitCode({ exitCode: 3 }), 3);
});

test("human renderer fails closed when a typed action row is incomplete", () => {
  const catalog = makeTaskActionExplanationService({
      actor: { principal: { personId: "person-explain" }, executor: null },
      authorize: () => {
        throw new Error("catalog rendering must not evaluate authorization");
      },
      usage: taskActionCommandUsage,
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

test("help, object explain, and rejected ActionResult preserve one Task Action row", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    const snapshot = (await harness.service.read("task-1")).snapshot,
      event = harness.eventStore.read().events.find(({ workspaceRevision }) => workspaceRevision === snapshot.revision);
    assert.ok(snapshot.task);
    assert.ok(event);
    const cut = `canonical:${snapshot.revision}`,
      entity = projectBaseEntityAtCut<BaseEntity<"task">>(requireEntityTypeContract("task"), {
        kind: "task",
        id: snapshot.task.taskId,
        workspaceRevision: snapshot.revision,
        occurredAt: event.occurredAt,
        actor: event.actor,
        source: event.source,
        pinned: snapshot.task.pinned,
        disposition: snapshot.task.packageDisposition ?? "active",
      }),
      explanation = makeTaskActionExplanationService({
        actor: owner,
        authorize: ({ target, evaluatedAtCut }) => ({
          policyRef: "default@5",
          actor: owner,
          subject: target,
          bindingsUsed: [],
          outcome: "allowed",
          reasonCodes: [],
          nextActions: [],
          evaluatedAtCut,
        }),
        usage: taskActionCommandUsage,
      }).object({ entity, snapshot, evaluatedAtCut: cut }),
      row = explanation.subjects[0]?.actions.find(({ action }) => action.id === "start"),
      contract = getExecutableEntityAction("task-start"),
      help = taskActionHelpRows.find(({ usage }) => usage.startsWith("ha task start "));
    assert.ok(row);
    assert.ok(contract);
    assert.ok(help);
    const firstUnmet = row.unmetCriteria[0];
    assert.ok(firstUnmet);
    assert.equal(row.available, false);
    assert.equal(help.summary, row.action.explain);
    assert.equal(help.usage, row.action.syntax.usage);

    const failure = deriveActionResult(
      contract,
      { kind: "task-start", taskId: "task-1" },
      {
        outcome: "op_rejected",
        opId: "op-three-door",
        code: firstUnmet.failureCode,
        origin: "daemon",
        evidence: "rejection:capability",
        authorizationDecision: row.authorizationDecision!,
        unmetCriteria: row.unmetCriteria,
        rejectionExplanation: firstUnmet.explain,
        nextActions: row.nextActions,
      },
    );
    assert.deepEqual(failure.unmetCriteria, row.unmetCriteria);
    assert.deepEqual(failure.authorizationDecision, row.authorizationDecision);
    assert.deepEqual(failure.nextActions, row.nextActions);
    assert.equal(failure.rejectionExplanation, firstUnmet.explain);
  } finally {
    await harness.cleanup();
  }
});
