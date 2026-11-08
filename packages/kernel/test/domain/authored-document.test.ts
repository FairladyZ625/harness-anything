// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyAuthoredDocumentEvent,
  authoredDocumentReadView,
  decideAuthoredDocument,
  type AuthoredDocumentCommand,
  type AuthoredDocumentDecision,
  type AuthoredDocumentState,
} from "../../src/domain/authored-document.ts";
import { transitionDocumentContract } from "../../src/domain/transition-document-readiness.ts";

const planTemplate = readFileSync(
    new URL("../../../preset/assets/software-coding/templates/task.plan.v2/en-US.md", import.meta.url),
    "utf8",
  ),
  // A feat/docs plan receives the catalog-narrowed contract (the Recurrence Gate is fix-only).
  planContract = transitionDocumentContract(planTemplate, [
    "Brief",
    "Goal",
    "Cheaper Alternatives",
    "Context",
    "Required Reading",
    "Execution Surface",
    "Constraints",
    "Deliverable Contract",
    "Evidence Protocol",
    "Verification",
  ]),
  completePlan = `# Plan\n\n${planContract.requiredSections
    .map((heading) => `## ${heading}\n\nImplemented ${heading}.`)
    .join("\n\n")}\n`;

let sequence = 0;
function meta(opId: string) {
  sequence += 1;
  return {
    documentId: "doc_task_plan_1",
    opId,
    eventId: `evt_${sequence}`,
    workspaceRevision: sequence,
    actor: { principal: { personId: "person_owner" }, executor: null },
    source: "local" as const,
    occurredAt: "2026-11-08T00:00:00.000Z",
  };
}

function claim(body: string) {
  return { path: "tasks/task_1/task_plan.md", sha256: `sha-${body.length}`, size: body.length };
}

/** Decide, require acceptance, and fold the emitted events: the reducer is the only state source. */
function accept(state: AuthoredDocumentState | null, command: AuthoredDocumentCommand): AuthoredDocumentState {
  const decision = decideAuthoredDocument(state, command);
  assert.equal(decision.outcome, "accepted", JSON.stringify(decision));
  return (
    decision as Extract<AuthoredDocumentDecision, { outcome: "accepted" }>
  ).events.reduce<AuthoredDocumentState | null>(applyAuthoredDocumentEvent, state)!;
}

function registered(): AuthoredDocumentState {
  return accept(null, { ...meta("op-register"), type: "register", kind: "task.plan", owner: "task_1" });
}

function revise(state: AuthoredDocumentState, opId: string, body: string, contract = planContract) {
  return {
    ...meta(opId),
    type: "revise" as const,
    expectedRevision: state.revision,
    content: claim(body),
    body,
    contract,
  };
}

test("registration opens the document at revision 1 with no canonical content", () => {
  const view = authoredDocumentReadView(registered());
  assert.deepEqual(view, {
    documentId: "doc_task_plan_1",
    kind: "task.plan",
    owner: "task_1",
    revision: 1,
    content: null,
    readiness: { state: "missing", missingSections: [] },
    retired: false,
  });
});

test("empty template: the untouched scaffold is not_ready and names every required section", () => {
  const state = accept(registered(), revise(registered(), "op-scaffold", planTemplate));
  assert.equal(state.revision, 2);
  assert.equal(state.readiness.state, "not_ready");
  assert.deepEqual(
    state.readiness.missingSections.map(({ section }) => section),
    planContract.requiredSections,
  );
  assert.deepEqual(state.content, claim(planTemplate));
});

test("complete document: every required section authored is ready", () => {
  const state = accept(registered(), revise(registered(), "op-complete", completePlan));
  assert.deepEqual(authoredDocumentReadView(state).readiness, { state: "ready", missingSections: [] });
});

test("unknown contract: a plan without its materialized scaffold is contract_unavailable, never guessed", () => {
  const base = registered(),
    command = { ...revise(base, "op-no-contract", completePlan), contract: undefined },
    state = accept(base, command);
  assert.deepEqual(state.readiness, { state: "contract_unavailable", missingSections: [] });
  assert.equal(state.revision, 2);
});

test("duplicate opId: a retried command is a no-op that names the revision it produced", () => {
  const base = registered(),
    command = revise(base, "op-retry", completePlan),
    state = accept(base, command);
  assert.deepEqual(decideAuthoredDocument(state, command), { outcome: "duplicate", revision: 2 });
  // Even with a fresh base revision, the same opId never appends a second event.
  assert.deepEqual(
    decideAuthoredDocument(state, { ...command, expectedRevision: state.revision, body: planTemplate }),
    {
      outcome: "duplicate",
      revision: 2,
    },
  );
  assert.deepEqual(
    decideAuthoredDocument(state, { ...meta("op-register"), type: "register", kind: "task.plan", owner: "task_1" }),
    {
      outcome: "duplicate",
      revision: 1,
    },
  );
  // A prototype key is not an accepted opId.
  assert.equal(decideAuthoredDocument(state, revise(state, "toString", completePlan)).outcome, "accepted");
});

test("a stale base revision is rejected and the canonical readiness stays", () => {
  const base = registered(),
    ready = accept(base, revise(base, "op-ready", completePlan)),
    decision = decideAuthoredDocument(ready, { ...revise(ready, "op-stale", planTemplate), expectedRevision: 1 });
  assert.equal(decision.outcome, "rejected");
  assert.equal((decision as { code: string }).code, "stale_base");
  assert.equal(ready.readiness.state, "ready");
});

test("accepted content changes re-judge readiness both ways", () => {
  const base = registered(),
    ready = accept(base, revise(base, "op-a", completePlan)),
    back = accept(ready, revise(ready, "op-b", planTemplate));
  assert.equal(back.readiness.state, "not_ready");
  assert.equal(back.revision, 3);
});

test("retirement clears canonical content, answers missing, and refuses later commands", () => {
  const base = registered(),
    ready = accept(base, revise(base, "op-ready", completePlan)),
    retired = accept(ready, { ...meta("op-retire"), type: "retire", expectedRevision: ready.revision });
  assert.deepEqual(authoredDocumentReadView(retired), {
    ...authoredDocumentReadView(ready),
    revision: 3,
    content: null,
    readiness: { state: "missing", missingSections: [] },
    retired: true,
  });
  assert.deepEqual(retired.retirement, { revision: 3, opId: "op-retire" });
  assert.equal(
    (decideAuthoredDocument(retired, revise(retired, "op-after", completePlan)) as { code: string }).code,
    "retired",
  );
});

test("commands before registration and a second registration are rejected", () => {
  const base = registered();
  assert.equal(
    (decideAuthoredDocument(null, revise(base, "op-early", completePlan)) as { code: string }).code,
    "not_registered",
  );
  assert.equal(
    (
      decideAuthoredDocument(base, {
        ...meta("op-register-2"),
        type: "register",
        kind: "task.plan",
        owner: "task_1",
      }) as { code: string }
    ).code,
    "already_registered",
  );
});

test("replay fails closed on an event that does not follow the current revision", () => {
  const base = registered(),
    decision = decideAuthoredDocument(base, revise(base, "op-x", completePlan));
  assert.equal(decision.outcome, "accepted");
  const [event] = (decision as Extract<AuthoredDocumentDecision, { outcome: "accepted" }>).events;
  const advanced = applyAuthoredDocumentEvent(base, event!);
  assert.throws(() => applyAuthoredDocumentEvent(advanced, event!), { code: "authored_document_replay" });
  assert.throws(() => applyAuthoredDocumentEvent(null, event!), { code: "authored_document_replay" });
});
