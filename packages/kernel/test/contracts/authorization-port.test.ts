// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_POLICY } from "../../src/domain/default-policy.ts";
import { createAuthorizationPort, evaluateAuthorization } from "../../src/ports/authorization-port.ts";
import {
  currentActionEnvelopeVersion,
  type ActionEnvelope,
  type ActorIdentity,
  type AuthorizationContext,
  type LeaseV1,
} from "../../src/index.ts";

const owner: ActorIdentity = {
    principal: { personId: "owner" },
    executor: { kind: "agent", id: "implementer" },
  },
  humanOwner: ActorIdentity = { principal: owner.principal, executor: null },
  reviewer: ActorIdentity = {
    principal: owner.principal,
    executor: { kind: "agent", id: "reviewer" },
  },
  outsider: ActorIdentity = { principal: { personId: "outsider" }, executor: null },
  runtimeActor: ActorIdentity = {
    principal: owner.principal,
    executor: { kind: "agent", id: "runtime-session:runtime-1" },
  },
  lease: LeaseV1 = {
    schema: "lease/v1",
    taskId: "task-1",
    executionId: "execution-1",
    actor: owner,
    source: "local",
    phase: "held",
    expiresAt: "2026-08-26T00:00:00.000Z",
    ttlMs: 86_400_000,
    version: 1,
  };

function decide(
  kind: string,
  actor: ActorIdentity,
  target: ActionEnvelope["target"],
  context: Omit<AuthorizationContext, "evaluatedAtCut">,
) {
  return evaluateAuthorization(
    DEFAULT_POLICY,
    {
      version: currentActionEnvelopeVersion,
      actionId: `action-${kind}`,
      kind,
      target,
      actor,
      authorizationRef: "default@2",
      idempotencyKey: `idempotency-${kind}`,
    },
    { ...context, evaluatedAtCut: "canonical:17" },
  );
}

test("v2 separates principal ownership from exact execution ownership", () => {
  assert.equal(decide("task.complete", humanOwner, "task/task-1", { target: { owner } }).outcome, "allowed");
  assert.equal(decide("task.complete", outsider, "task/task-1", { target: { owner } }).outcome, "denied");
  assert.equal(decide("task.consent", humanOwner, "task/task-1", { target: { owner } }).outcome, "denied");
  assert.equal(decide("task.consent", owner, "task/task-1", { target: { owner } }).outcome, "allowed");
});

test("v2 models held and orphaned release bindings without overloading ownership", () => {
  assert.equal(
    decide("execution.release", owner, "execution/execution-1", {
      target: { lease, canonicalExecutionExists: true },
    }).outcome,
    "allowed",
  );
  assert.equal(
    decide("execution.release", humanOwner, "execution/execution-1", {
      target: { lease, canonicalExecutionExists: true },
    }).outcome,
    "denied",
  );
  assert.equal(
    decide("execution.release", owner, "execution/execution-1", {
      target: { lease: { ...lease, phase: "orphaned" }, canonicalExecutionExists: true },
    }).outcome,
    "allowed",
  );
  assert.equal(
    decide("execution.release", humanOwner, "execution/execution-1", {
      target: { lease: { ...lease, phase: "orphaned" }, canonicalExecutionExists: true },
    }).outcome,
    "allowed",
  );
  assert.equal(
    decide("execution.release", humanOwner, "execution/execution-1", {
      target: { lease, canonicalExecutionExists: false },
    }).outcome,
    "allowed",
  );
});

test("v2 preserves same-principal dispatcher and live RuntimeSession handoff behavior", () => {
  assert.equal(decide("runtime.dispatch", humanOwner, "task/task-1", { target: { lease } }).outcome, "allowed");
  assert.equal(decide("runtime.dispatch", reviewer, "task/task-1", { target: { lease } }).outcome, "denied");
  assert.equal(
    decide("runtime.dispatch", runtimeActor, "task/task-1", {
      target: {
        lease,
        runtimeBinding: { runtimeSessionId: "runtime-1", taskId: "task-1", executionId: "execution-1" },
      },
    }).outcome,
    "allowed",
  );
});

test("v2 requires write-source equality on both direct and delegated document branches", () => {
  assert.equal(
    decide("doc.submit", owner, "execution/execution-1", { writeSource: "local", target: { lease } }).outcome,
    "allowed",
  );
  assert.equal(
    decide("doc.submit", owner, "execution/execution-1", { writeSource: "remote_direct", target: { lease } }).outcome,
    "denied",
  );
  assert.equal(
    decide("doc.submit", outsider, "execution/execution-1", { writeSource: "local", target: { lease } }).outcome,
    "denied",
  );
  const target = {
    lease,
    runtimeBinding: { runtimeSessionId: "runtime-1", taskId: "task-1", executionId: "execution-1" },
  } as const;
  assert.equal(
    decide("doc.submit", runtimeActor, "execution/execution-1", { writeSource: "local", target }).outcome,
    "allowed",
  );
  assert.equal(
    decide("doc.submit", runtimeActor, "execution/execution-1", { writeSource: "remote_direct", target }).outcome,
    "denied",
  );
});

test("v2 always rejects proposal-agent self-judgment while keeping broader Decision independence disabled", () => {
  assert.equal(
    decide("execution.review", reviewer, "execution/execution-1", {
      commandClasses: ["arbiter"],
      target: { executionActor: owner, runtimeBinding: null },
    }).outcome,
    "allowed",
  );
  assert.equal(
    decide("execution.review", owner, "execution/execution-1", {
      commandClasses: ["arbiter"],
      target: { executionActor: owner, runtimeBinding: null },
    }).outcome,
    "denied",
  );
  assert.equal(
    decide("execution.review", reviewer, "execution/execution-1", {
      commandClasses: [],
      target: { executionActor: owner, runtimeBinding: null },
    }).outcome,
    "denied",
  );
  assert.equal(
    decide("decision.accept", owner, "decision/decision-1", {
      commandClasses: ["arbiter"],
      target: { proposalActor: owner },
    }).outcome,
    "denied",
  );
  assert.equal(
    decide("decision.accept", humanOwner, "decision/decision-1", {
      commandClasses: ["arbiter"],
      target: { proposalActor: humanOwner },
    }).outcome,
    "allowed",
  );
  assert.equal(
    decide("decision.accept", outsider, "decision/decision-1", { commandClasses: [], target: {} }).outcome,
    "denied",
  );
});

test("the default port applies broader Decision review independence only for the declared environment gate", () => {
  const port = createAuthorizationPort(DEFAULT_POLICY, { HARNESS_REVIEW_INDEPENDENCE: "1" }),
    decision = (actor: ActorIdentity) =>
      port.authorize(
        {
          version: currentActionEnvelopeVersion,
          actionId: `gated-decision-${actor.executor?.id ?? "human"}`,
          kind: "decision.accept",
          target: "decision/decision-1",
          actor,
          authorizationRef: "default@2",
          idempotencyKey: `gated-decision-${actor.executor?.id ?? "human"}`,
        },
        {
          commandClasses: ["arbiter"],
          target: { proposalActor: owner },
          evaluatedAtCut: "canonical:17",
        },
      );
  assert.equal(decision(owner).outcome, "denied");
  assert.equal(decision(reviewer).outcome, "allowed");
  assert.equal(
    port.authorize(
      {
        version: currentActionEnvelopeVersion,
        actionId: "gated-decision-human",
        kind: "decision.accept",
        target: "decision/decision-1",
        actor: humanOwner,
        authorizationRef: "default@2",
        idempotencyKey: "gated-decision-human",
      },
      {
        commandClasses: ["arbiter"],
        target: { proposalActor: humanOwner },
        evaluatedAtCut: "canonical:17",
      },
    ).outcome,
    "denied",
  );
});

test("v2 closeout selects owner and active-lease rules explicitly", () => {
  assert.equal(
    decide("task.closeout", humanOwner, "task/task-1", { ruleScope: "owner", target: { owner } }).outcome,
    "allowed",
  );
  assert.equal(
    decide("task.closeout", owner, "task/task-1", { ruleScope: "active", target: { owner, lease } }).outcome,
    "allowed",
  );
  assert.equal(
    decide("task.closeout", humanOwner, "task/task-1", { ruleScope: "active", target: { owner, lease } }).outcome,
    "denied",
  );
  assert.equal(
    decide("task.closeout", outsider, "task/task-1", { ruleScope: "owner", target: { owner, lease } }).outcome,
    "denied",
  );
});

test("evaluation fails closed for stale policy references and missing action or scoped rules", () => {
  const action: ActionEnvelope = {
    version: currentActionEnvelopeVersion,
    actionId: "stale",
    kind: "task.complete",
    target: "task/task-1",
    actor: owner,
    authorizationRef: "default@1",
    idempotencyKey: "stale",
  };
  assert.deepEqual(
    evaluateAuthorization(DEFAULT_POLICY, action, { target: { owner }, evaluatedAtCut: "canonical:17" }).reasonCodes,
    ["authorization_ref_mismatch"],
  );
  assert.equal(
    decide("task.closeout", owner, "task/task-1", { target: { owner, lease } }).reasonCodes[0],
    "policy_rule_missing",
  );
});
