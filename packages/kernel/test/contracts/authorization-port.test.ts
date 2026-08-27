// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_POLICY } from "../../src/domain/default-policy.ts";
import { validateWriteReceipt } from "../../src/domain/receipt-domain-registry.ts";
import { createAuthorizationPort, evaluateAuthorization } from "../../src/ports/authorization-port.ts";
import {
  currentActionEnvelopeVersion,
  type ActionEnvelope,
  type ActorIdentity,
  type AuthorizationContext,
  type DelegatedExecutionToken,
  type LeaseV1,
} from "../../src/index.ts";

const owner: ActorIdentity = {
    principal: { personId: "owner" },
    executor: { kind: "agent", id: "implementer" },
  },
  humanOwner: ActorIdentity = { principal: owner.principal, executor: null },
  taskOwner: ActorIdentity = { principal: { personId: "task-owner" }, executor: null },
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
      authorizationRef: `${DEFAULT_POLICY.id}@${DEFAULT_POLICY.version}`,
      idempotencyKey: `idempotency-${kind}`,
    },
    { ...context, evaluatedAtCut: "canonical:17" },
  );
}

function commandBinding(
  commandClass: string,
  actor: ActorIdentity,
  target: ActionEnvelope["target"] = "settings/repository",
): Pick<AuthorizationContext, "roleBindings" | "roleBindingTargets"> {
  return {
    roleBindings: [
      {
        actor: { kind: "person", id: actor.principal.personId },
        role: commandClass,
        target,
        source: "derived",
        expiresAt: null,
      },
    ],
    roleBindingTargets: [target],
  };
}

test("v3 uses one Execution owner RoleBinding for consent and completion", () => {
  const ownerBinding = commandBinding("owner", owner, "execution/execution-1");
  for (const action of ["task.consent", "task.complete"])
    assert.equal(
      decide(action, humanOwner, "execution/execution-1", { ...ownerBinding, target: {} }).outcome,
      "allowed",
      action,
    );
  for (const action of ["task.consent", "task.complete"])
    assert.equal(
      decide(action, outsider, "execution/execution-1", { ...ownerBinding, target: {} }).outcome,
      "denied",
      action,
    );
});

test("v3 admits execution start only through the server-admitted repo-write command class", () => {
  assert.equal(
    decide("execution.start", owner, "execution/execution-1", {
      ...commandBinding("repo-write", owner),
      target: {},
    }).outcome,
    "allowed",
  );
  assert.equal(decide("execution.start", owner, "execution/execution-1", { target: {} }).outcome, "denied");
});

test("v3 models held and orphaned release bindings without overloading ownership", () => {
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

test("v3 limits task-owner reclamation to orphaned leases and terminal Runtime bindings", () => {
  const targetOwner = { principal: taskOwner.principal, executor: { kind: "agent", id: "task-creator" } } as const,
    terminalRuntimeBinding = {
      runtimeSessionId: "runtime-1",
      taskId: lease.taskId,
      executionId: lease.executionId,
    };
  assert.equal(
    decide("execution.release", taskOwner, "execution/execution-1", {
      target: { owner: targetOwner, lease, canonicalExecutionExists: true },
    }).outcome,
    "denied",
  );
  assert.equal(
    decide("execution.release", taskOwner, "execution/execution-1", {
      target: { owner: targetOwner, lease: { ...lease, phase: "orphaned" }, canonicalExecutionExists: true },
    }).outcome,
    "allowed",
  );
  assert.equal(
    decide("execution.release", taskOwner, "execution/execution-1", {
      target: { owner: targetOwner, lease, canonicalExecutionExists: false },
    }).outcome,
    "denied",
  );
  assert.equal(
    decide("execution.release", taskOwner, "execution/execution-1", {
      target: { owner: targetOwner, lease, canonicalExecutionExists: true, terminalRuntimeBinding },
    }).outcome,
    "allowed",
  );
  assert.equal(
    decide("execution.release", outsider, "execution/execution-1", {
      target: { owner: targetOwner, lease, canonicalExecutionExists: true, terminalRuntimeBinding },
    }).outcome,
    "denied",
  );
});

test("v3 preserves same-principal dispatcher and live RuntimeSession handoff behavior", () => {
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

test("v3 requires write-source equality on both direct and delegated document branches", () => {
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

test("v3 keeps execution review independent and rejects Decision outcomes from the proposal agent", () => {
  assert.equal(
    decide("execution.review", reviewer, "execution/execution-1", {
      ...commandBinding("arbiter", reviewer),
      target: { executionActor: owner, runtimeBinding: null },
    }).outcome,
    "allowed",
  );
  assert.equal(
    decide("execution.review", owner, "execution/execution-1", {
      ...commandBinding("arbiter", owner),
      target: { executionActor: owner, runtimeBinding: null },
    }).outcome,
    "denied",
  );
  assert.equal(
    decide("execution.review", reviewer, "execution/execution-1", {
      target: { executionActor: owner, runtimeBinding: null },
    }).outcome,
    "denied",
  );
  assert.equal(
    decide("decision.accept", owner, "decision/decision-1", {
      ...commandBinding("arbiter", owner),
      target: { proposalActor: owner },
    }).outcome,
    "denied",
  );
  assert.equal(
    decide("decision.accept", humanOwner, "decision/decision-1", {
      ...commandBinding("arbiter", humanOwner),
      target: { proposalActor: humanOwner },
    }).outcome,
    "allowed",
  );
  assert.equal(decide("decision.accept", outsider, "decision/decision-1", { target: {} }).outcome, "denied");
});

test("the default port keeps broader Decision review independence disabled", () => {
  const port = createAuthorizationPort(DEFAULT_POLICY),
    decision = (actor: ActorIdentity) =>
      port.authorize(
        {
          version: currentActionEnvelopeVersion,
          actionId: `gated-decision-${actor.executor?.id ?? "human"}`,
          kind: "decision.accept",
          target: "decision/decision-1",
          actor,
          authorizationRef: `${DEFAULT_POLICY.id}@${DEFAULT_POLICY.version}`,
          idempotencyKey: `gated-decision-${actor.executor?.id ?? "human"}`,
        },
        {
          ...commandBinding("arbiter", actor),
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
        authorizationRef: `${DEFAULT_POLICY.id}@${DEFAULT_POLICY.version}`,
        idempotencyKey: "gated-decision-human",
      },
      {
        ...commandBinding("arbiter", humanOwner),
        target: { proposalActor: humanOwner },
        evaluatedAtCut: "canonical:17",
      },
    ).outcome,
    "allowed",
  );
});

test("v3 closeout selects owner and active-lease rules explicitly", () => {
  const ownerBinding = commandBinding("owner", owner, "task/task-1");
  assert.equal(
    decide("task.closeout", humanOwner, "task/task-1", {
      ...ownerBinding,
      ruleScope: "owner",
      target: {},
    }).outcome,
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
    decide("task.closeout", outsider, "task/task-1", {
      ...ownerBinding,
      ruleScope: "owner",
      target: { lease },
    }).outcome,
    "denied",
  );
});

test("evaluation fails closed for stale policy references and missing action or scoped rules", () => {
  const action: ActionEnvelope = {
    version: currentActionEnvelopeVersion,
    actionId: "stale",
    kind: "task.complete",
    target: "execution/execution-1",
    actor: owner,
    authorizationRef: "default@1",
    idempotencyKey: "stale",
  };
  assert.deepEqual(
    evaluateAuthorization(DEFAULT_POLICY, action, { target: {}, evaluatedAtCut: "canonical:17" }).reasonCodes,
    ["authorization_ref_mismatch"],
  );
  assert.equal(
    decide("task.closeout", owner, "task/task-1", { target: { owner, lease } }).reasonCodes[0],
    "policy_rule_missing",
  );
});

test("AuthorizationDecision audits the DelegatedExecutionToken used as actor proof", () => {
  const delegatedActor: ActorIdentity = {
      principal: { personId: "owner" },
      executor: { kind: "agent", id: "runtime-session:runtime-1" },
    },
    token: DelegatedExecutionToken = {
      schema: "delegated-execution-token/v1",
      tokenId: "det_owner_runtime_1",
      issuer: delegatedActor.principal,
      delegate: { runtimeSessionId: "runtime-1" },
      allowedActions: ["execution.start"],
      issuedAt: "2026-08-27T02:00:00.000Z",
      expiresAt: "2026-08-27T03:00:00.000Z",
      revokedAt: null,
    },
    decision = decide("execution.start", delegatedActor, "execution/execution-1", {
      ...commandBinding("repo-write", delegatedActor),
      delegatedExecutionToken: token,
      evaluatedAt: "2026-08-27T02:30:00.000Z",
      target: {},
    });
  assert.equal(decision.outcome, "allowed");
  assert.deepEqual(decision.bindingsUsed[0], {
    proof: "delegated-execution-token",
    tokenId: token.tokenId,
    issuerPersonId: "owner",
    runtimeSessionId: "runtime-1",
  });
  assert.deepEqual(
    validateWriteReceipt({
      outcome: "op_rejected",
      opId: "op-token-audit",
      code: "audit_sample",
      origin: "test",
      nextAction: "No action is required.",
      evidence: "authorization:det_owner_runtime_1",
      authorizationDecision: decision,
    }),
    [],
  );

  const expired = decide("execution.start", delegatedActor, "execution/execution-1", {
    ...commandBinding("repo-write", delegatedActor),
    delegatedExecutionToken: token,
    evaluatedAt: token.expiresAt,
    target: {},
  });
  assert.equal(expired.outcome, "denied");
  assert.ok(expired.reasonCodes.includes("delegated_token_expired"));
  const revoked = decide("execution.start", delegatedActor, "execution/execution-1", {
    ...commandBinding("repo-write", delegatedActor),
    delegatedExecutionToken: { ...token, revokedAt: "2026-08-27T02:20:00.000Z" },
    evaluatedAt: "2026-08-27T02:30:00.000Z",
    target: {},
  });
  assert.equal(revoked.outcome, "denied");
  assert.ok(revoked.reasonCodes.includes("delegated_token_revoked"));
  const malformed = decide("execution.start", delegatedActor, "execution/execution-1", {
    ...commandBinding("repo-write", delegatedActor),
    delegatedExecutionToken: {} as DelegatedExecutionToken,
    evaluatedAt: "2026-08-27T02:30:00.000Z",
    target: {},
  });
  assert.equal(malformed.outcome, "denied");
  assert.ok(malformed.reasonCodes.includes("delegated_token_contract_invalid"));
  assert.equal(
    malformed.bindingsUsed.some((binding) => binding.proof === "delegated-execution-token"),
    false,
  );
});
