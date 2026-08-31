// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { explainEntityKind, getExecutableEntityAction } from "../../src/domain/entity-kind-registry.ts";

const ingressKinds = [
  "agent-install",
  "decision-accept",
  "decision-amend",
  "decision-claim-add",
  "decision-claim-fulfill",
  "decision-defer",
  "decision-list",
  "decision-propose",
  "decision-reckon",
  "decision-reject",
  "decision-repin",
  "decision-retire",
  "decision-show",
  "decision-supersede",
  "decision-transition",
  "decision-validate",
  "fact-record",
  "fact-search",
  "fact-show",
  "relation-relate",
  "relation-unrelate",
  "schedule-claim",
  "schedule-create",
  "schedule-delete",
  "schedule-disable",
  "schedule-dispatch-link",
  "schedule-enable",
  "schedule-list",
  "schedule-missed",
  "schedule-run-now",
  "schedule-runs",
  "schedule-settle",
  "schedule-show",
  "schedule-update",
] as const;
const readIngressKinds = new Set([
  "decision-list",
  "decision-show",
  "decision-validate",
  "fact-search",
  "fact-show",
  "schedule-list",
  "schedule-runs",
  "schedule-show",
]);

test("Agent, Decision, Fact, Relation, and Schedule ingress resolves to executable per-action catalog declarations", () => {
  for (const ingress of ingressKinds) {
    const action = getExecutableEntityAction(ingress);
    assert.ok(action?.execution, ingress);
    assert.equal(action.execution.ingress, ingress);
    assert.equal(action.execution.read, readIngressKinds.has(ingress), ingress);
    assert.equal(action.execution.compile === null, action.execution.read, ingress);
  }
  assert.equal(getExecutableEntityAction("fact-undeclared"), undefined);
  assert.equal(getExecutableEntityAction("schedule-fire"), undefined);
});

test("entity explanations expose action identity but keep runtime compile hooks private", () => {
  for (const kind of ["agent", "decision", "fact", "schedule"] as const) {
    const explanation = explainEntityKind(kind);
    assert.ok(explanation.transitions.actions.length > 0);
    for (const action of explanation.transitions.actions) assert.equal(Object.hasOwn(action, "execution"), false);
  }
});

test("Agent install owns declaration readiness, revision, idempotency, and artifact contracts", () => {
  const explanation = explainEntityKind("agent"),
    action = getExecutableEntityAction("agent-install");
  assert.deepEqual(explanation.transitions.available, ["install"]);
  assert.deepEqual(
    explanation.transitions.actions.map(({ id }) => id),
    ["install"],
  );
  assert.ok(action?.execution?.compile);
  assert.equal(action.execution.implementation, "compiled-event");
  assert.deepEqual(action.input.exactlyOneOf, [["packageSource", "declaration"]]);
  assert.equal(action.concurrency.expectedVersion.conflict, "revision_conflict");
  assert.equal(action.concurrency.idempotency.retry, "canonical-event-replay");
  assert.equal(action.concurrency.leasePolicy.authority, "not-applicable");
  assert.equal(action.concurrency.occurrenceClaim.authority, "not-applicable");
  assert.deepEqual(action.concurrency.artifactOwnership, {
    owner: "agent/{id}",
    declaration: "agents/{id}.json",
    policy: "typed-entity/v1",
  });
  const compile = (declaration: Readonly<Record<string, unknown>>) =>
    action.execution!.compile!({
      action: { kind: "agent-install", declaration },
      actor: { principal: { personId: "person-agent-action" }, executor: null },
      source: "local",
      session: { kind: "unavailable", reason: "contract-test" },
      opId: "agent-action-contract",
      occurredAt: "2026-09-01T00:00:00.000Z",
      workspaceRevision: 1,
    });
  assert.deepEqual(
    compile({
      schema: "agent-declaration/v1",
      id: "contract-agent",
      name: "Contract Agent",
      instructions: "Execute the assigned contract.",
      runtime_type: "codex",
    }),
    {
      kind: "entity",
      entityKind: "agent",
      entity: {
        schema: "agent-declaration/v1",
        id: "contract-agent",
        name: "Contract Agent",
        instructions: "Execute the assigned contract.",
        runtime_type: "codex",
      },
    },
  );
  assert.throws(
    () =>
      compile({
        schema: "agent-declaration/v1",
        id: "placeholder-agent",
        name: "Placeholder Agent",
        instructions: "(To be written: this text becomes the agent's system prompt verbatim.)",
        runtime_type: "codex",
      }),
    (error: unknown) => (error as { readonly code?: unknown }).code === "instructions_placeholder",
  );
});

test("Schedule explanations expose revision, single-flight, assignment, claim-fence, and replay contracts", () => {
  const explanation = explainEntityKind("schedule"),
    byId = new Map(explanation.transitions.actions.map((action) => [action.id, action]));
  assert.deepEqual(explanation.transitions.available, [
    "create",
    "update",
    "delete",
    "enable",
    "disable",
    "run-now",
    "claim",
    "link",
    "record-missed",
    "settle",
    "list",
    "runs",
    "show",
  ]);
  assert.equal(byId.has("fire"), false);
  assert.equal(
    byId.get("create")?.input.fields.some(({ field }) => field === "scheduleId"),
    true,
  );
  assert.equal(byId.get("run-now")?.concurrency.occurrenceClaim.mode, "single-flight");
  assert.equal(
    byId.get("run-now")?.concurrency.occurrenceClaim.assignmentFence,
    "authenticated WriteSource assignment",
  );
  assert.equal(byId.get("link")?.concurrency.occurrenceClaim.mode, "claim-fence");
  assert.equal(byId.get("settle")?.concurrency.idempotency.retry, "canonical-event-replay");
});
