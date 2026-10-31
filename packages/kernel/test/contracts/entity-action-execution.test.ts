// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { explainEntityKind, getExecutableEntityAction } from "../../src/domain/entity-kind-registry.ts";

const ingressKinds = [
  "agent-install",
  "agent-assign",
  "agent-unassign",
  "decision-accept",
  "decision-assign",
  "decision-unassign",
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
  "decision-transition",
  "decision-validate",
  "fact-record",
  "fact-assign",
  "fact-unassign",
  "fact-show",
  "relation-reconfirm",
  "relation-relate",
  "relation-unrelate",
  "runtime_session_cancelled",
  "runtime_session_exited",
  "runtime_session_liveness_changed",
  "runtime_session_outcome_observed",
  "runtime_session_provider_bound",
  "runtime_session_started",
  "runtime_session_task_bound",
  "schedule-claim",
  "schedule-assign",
  "schedule-unassign",
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
  "settings-read",
  "settings-update",
  "squad-assign",
  "squad-unassign",
  "task-assign",
  "task-unassign",
] as const;
const readIngressKinds = new Set([
  "decision-list",
  "decision-show",
  "decision-validate",
  "fact-show",
  "fact-type-list",
  "schedule-list",
  "schedule-runs",
  "schedule-show",
  "settings-read",
]);

test("Agent, Decision, Fact, Relation, RuntimeSession, Schedule, and Settings ingress resolves to executable actions", () => {
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

test("Decision and Fact catalog-runtime writes retain their declared ingress and target", () => {
  for (const [ingress, kind, id] of [
    ["decision-dispatch-review", "decision", "dispatch-review"],
    ["decision-rematerialize", "decision", "rematerialize"],
    ["fact-rematerialize", "fact", "rematerialize"],
  ] as const) {
    const action = getExecutableEntityAction(ingress);
    assert.equal(action?.id, id, ingress);
    assert.equal(action?.target.kind, kind, ingress);
    assert.equal(action?.execution?.ingress, ingress);
    assert.equal(action?.execution?.implementation, "catalog-runtime");
    assert.equal(action?.execution?.compile, null);
    assert.equal(action?.execution?.read, false);
  }
});

test("canonical-stream kind bindings resolve to declared Actions on their stream owner", () => {
  // dec_2446BC2F8C68630F71AE3E3BD7/CH4: the doc, migration, script and vertical write roads name the
  // stream kind that owns them; the binding rewrites each Action's ingress to its declaration kind.
  for (const [ingress, kind, id] of [
    ["doc-submit", "document", "submit"],
    ["doc-retire", "document", "retire"],
    ["doc-conflict-resolve", "document", "conflict-resolve"],
    ["doc-conflict-overwrite-center", "document", "conflict-overwrite-center"],
    ["migrate-import", "migration", "import"],
    ["script-run", "script-execution", "run"],
    ["vertical-declaration-migrate", "vertical-declaration", "migrate"],
    ["vertical-kind-upsert", "vertical-declaration", "upsert-kind"],
    ["vertical-kind-publish-schema", "vertical-declaration", "publish-kind-schema"],
    ["vertical-kind-retire", "vertical-declaration", "retire-kind"],
  ] as const) {
    const action = getExecutableEntityAction(ingress);
    assert.equal(action?.id, id, ingress);
    assert.equal(action?.target.kind, kind, ingress);
    assert.equal(action?.execution?.ingress, ingress);
    assert.equal(action?.execution?.implementation, "declared-only");
    assert.equal(action?.execution?.read, false);
  }
  // Runtime control is host ingress, not an entity-catalog action: its canonical events are written
  // by the RuntimeSession event actions or the auxiliary runtime ingress, so no control command may
  // resolve through the catalog (dec_2446BC2F8C68630F71AE3E3BD7/CH4).
  // dec_6C9E3399972A2F06C046BA89DC/CH3: runtime-run is the one runtime command with a canonical
  // catalog target (the shared runtime-session/run action); the rest stay host ingress.
  {
    const action = getExecutableEntityAction("runtime-run");
    assert.equal(action?.id, "run");
    assert.equal(action?.target.kind, "runtime-session");
    assert.equal(action?.execution?.ingress, "runtime-run");
    assert.equal(action?.execution?.implementation, "catalog-runtime");
  }
  for (const ingress of [
    "runtime-batch",
    "runtime-spawn",
    "runtime-cancel",
    "runtime-handoff-export",
    "runtime-handoff-claim",
    "runtime-handoff-revoke",
    "runtime-steer",
    "runtime-incident-dismiss",
  ] as const)
    assert.equal(getExecutableEntityAction(ingress), undefined, ingress);
  assert.deepEqual(
    explainEntityKind("runtime-session").transitions.actions.map(({ id }) => id),
    [
      "runtime_session_started",
      "runtime_session_provider_bound",
      "runtime_session_task_bound",
      "runtime_session_liveness_changed",
      "runtime_session_cancelled",
      "runtime_session_exited",
      "runtime_session_outcome_observed",
      "run",
    ],
  );
});

test("entity explanations expose action identity but keep runtime compile hooks private", () => {
  for (const kind of ["agent", "decision", "fact", "schedule", "settings"] as const) {
    const explanation = explainEntityKind(kind);
    assert.ok(explanation.transitions.actions.length > 0);
    for (const action of explanation.transitions.actions) assert.equal(Object.hasOwn(action, "execution"), false);
  }
});

test("Agent catalog exposes reads while install owns its write contracts", () => {
  const explanation = explainEntityKind("agent"),
    action = getExecutableEntityAction("agent-install");
  assert.deepEqual(explanation.transitions.available, [
    "install",
    "delete",
    "retire",
    "validate",
    "list",
    "inspect",
    "assign",
    "unassign",
    "pin",
    "unpin",
  ]);
  assert.deepEqual(
    explanation.transitions.actions.map(({ id }) => id),
    ["install", "delete", "retire", "validate", "list", "inspect", "assign", "unassign", "pin", "unpin"],
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
      runtimes: [{ type: "codex" }],
    }),
    {
      kind: "entity",
      entityKind: "agent",
      entity: {
        schema: "agent-declaration/v1",
        id: "contract-agent",
        name: "Contract Agent",
        instructions: "Execute the assigned contract.",
        runtimes: [{ type: "codex" }],
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
        runtimes: [{ type: "codex" }],
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
    "reckon",
    "runs",
    "show",
    "assign",
    "unassign",
    "pin",
    "unpin",
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

test("RuntimeSession explains adoption, operation replay, center arbitration, and dispatch-owned artifacts", () => {
  const explanation = explainEntityKind("runtime-session"),
    byId = new Map(explanation.transitions.actions.map((action) => [action.id, action])),
    run = byId.get("run"),
    runtimeRun = getExecutableEntityAction("runtime-run");
  assert.deepEqual(explanation.transitions.available, [
    "run",
    "runtime_session_started",
    "runtime_session_provider_bound",
    "runtime_session_task_bound",
    "runtime_session_liveness_changed",
    "runtime_session_cancelled",
    "runtime_session_exited",
    "runtime_session_outcome_observed",
    "run",
    "pin",
    "unpin",
  ]);
  assert.deepEqual(explanation.canonicalProjection, {
    embeddedEvents: [],
    row: { idField: "runtimeSessionId", ownerField: null },
  });
  assert.equal(run?.target.kind, "runtime-session");
  assert.equal(run?.policy.action, "runtime-run");
  assert.equal(runtimeRun?.execution?.ingress, "runtime-run");
  assert.equal(runtimeRun?.execution?.implementation, "catalog-runtime");
  const started = byId.get("runtime_session_started"),
    outcome = byId.get("runtime_session_outcome_observed");
  assert.equal(started?.concurrency.expectedVersion.startFence, "launchGeneration");
  assert.equal(started?.concurrency.expectedVersion.writerFence, "center-issued writerEpoch");
  assert.equal(started?.concurrency.leasePolicy.arbitration, "center-single-write-queue");
  // dec_3E49EDAB95D138B044C8C40169 CH3 makes RuntimeSession events state transitions.
  assert.equal(started?.concurrency.idempotency.input, "runtimeSessionId");
  assert.equal(started?.concurrency.idempotency.retry, "state-transition");
  assert.equal(started?.concurrency.artifactOwnership.owner, "dispatch/{dispatchId}");
  assert.equal(started?.policy.action, "runtime-run");
  assert.equal(
    outcome?.input.fields.some(({ field }) => field === "resultBody"),
    true,
  );
  assert.ok(getExecutableEntityAction("runtime_session_task_bound")?.execution?.compile);
});
