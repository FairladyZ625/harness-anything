// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_POLICY } from "../../src/domain/default-policy.ts";
import type { PolicyDeclarationV1, PolicyPredicateExpression } from "../../src/domain/policy.ts";
import { evaluateAuthorization } from "../../src/ports/authorization-port.ts";
import {
  currentActionEnvelopeVersion,
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
  },
  runtimeBinding = { runtimeSessionId: "runtime-1", taskId: "task-1", executionId: "execution-1" } as const;

type Case = {
  readonly label: string;
  readonly kind: string;
  readonly target: `task/${string}` | `execution/${string}` | `decision/${string}`;
  readonly actor: ActorIdentity;
  readonly context: Omit<AuthorizationContext, "evaluatedAtCut">;
  readonly expected: "allowed" | "denied";
  readonly gateEnabled?: boolean;
};

const cases: readonly Case[] = [
  {
    label: "consent owner",
    kind: "task.consent",
    target: "task/task-1",
    actor: owner,
    context: { target: { owner } },
    expected: "allowed",
  },
  {
    label: "consent executor mismatch",
    kind: "task.consent",
    target: "task/task-1",
    actor: humanOwner,
    context: { target: { owner } },
    expected: "denied",
  },
  {
    label: "complete owner",
    kind: "task.complete",
    target: "task/task-1",
    actor: humanOwner,
    context: { target: { owner } },
    expected: "allowed",
  },
  {
    label: "complete outsider",
    kind: "task.complete",
    target: "task/task-1",
    actor: outsider,
    context: { target: { owner } },
    expected: "denied",
  },
  {
    label: "start through repo writer",
    kind: "execution.start",
    target: "execution/execution-1",
    actor: owner,
    context: { commandClasses: ["repo-write"], target: {} },
    expected: "allowed",
  },
  {
    label: "start without repo writer",
    kind: "execution.start",
    target: "execution/execution-1",
    actor: owner,
    context: { commandClasses: [], target: {} },
    expected: "denied",
  },
  {
    label: "independent arbiter review",
    kind: "execution.review",
    target: "execution/execution-1",
    actor: reviewer,
    context: { commandClasses: ["arbiter"], target: { executionActor: owner, runtimeBinding: null } },
    expected: "allowed",
  },
  {
    label: "review without arbiter",
    kind: "execution.review",
    target: "execution/execution-1",
    actor: reviewer,
    context: { commandClasses: [], target: { executionActor: owner, runtimeBinding: null } },
    expected: "denied",
  },
  {
    label: "dependent review",
    kind: "execution.review",
    target: "execution/execution-1",
    actor: owner,
    context: { commandClasses: ["arbiter"], target: { executionActor: owner, runtimeBinding: null } },
    expected: "denied",
  },
  {
    label: "independent arbiter Decision outcome",
    kind: "decision.accept",
    target: "decision/decision-1",
    actor: reviewer,
    context: { commandClasses: ["arbiter"], target: { proposalActor: owner } },
    expected: "allowed",
  },
  {
    label: "dependent arbiter Decision outcome",
    kind: "decision.accept",
    target: "decision/decision-1",
    actor: owner,
    context: { commandClasses: ["arbiter"], target: { proposalActor: owner } },
    expected: "denied",
    gateEnabled: false,
  },
  {
    label: "gated human Decision self-judgment",
    kind: "decision.accept",
    target: "decision/decision-1",
    actor: humanOwner,
    context: { commandClasses: ["arbiter"], target: { proposalActor: humanOwner } },
    expected: "denied",
    gateEnabled: true,
  },
  {
    label: "non-arbiter Decision outcome",
    kind: "decision.accept",
    target: "decision/decision-1",
    actor: reviewer,
    context: { commandClasses: [], target: { proposalActor: owner } },
    expected: "denied",
  },
  {
    label: "held release",
    kind: "execution.release",
    target: "execution/execution-1",
    actor: owner,
    context: { target: { lease, canonicalExecutionExists: true } },
    expected: "allowed",
  },
  {
    label: "orphan reclaim",
    kind: "execution.release",
    target: "execution/execution-1",
    actor: humanOwner,
    context: { target: { lease: { ...lease, phase: "orphaned" }, canonicalExecutionExists: true } },
    expected: "allowed",
  },
  {
    label: "orphaned exact holder release",
    kind: "execution.release",
    target: "execution/execution-1",
    actor: owner,
    context: { target: { lease: { ...lease, phase: "orphaned" }, canonicalExecutionExists: true } },
    expected: "allowed",
  },
  {
    label: "foreign release",
    kind: "execution.release",
    target: "execution/execution-1",
    actor: outsider,
    context: { target: { lease, canonicalExecutionExists: true } },
    expected: "denied",
  },
  {
    label: "principal dispatcher",
    kind: "runtime.dispatch",
    target: "task/task-1",
    actor: humanOwner,
    context: { target: { lease } },
    expected: "allowed",
  },
  {
    label: "bound runtime dispatcher",
    kind: "runtime.dispatch",
    target: "task/task-1",
    actor: runtimeActor,
    context: { target: { lease, runtimeBinding } },
    expected: "allowed",
  },
  {
    label: "foreign dispatcher",
    kind: "runtime.dispatch",
    target: "task/task-1",
    actor: outsider,
    context: { target: { lease } },
    expected: "denied",
  },
  {
    label: "direct doc writer",
    kind: "doc.submit",
    target: "execution/execution-1",
    actor: owner,
    context: { writeSource: "local", target: { lease } },
    expected: "allowed",
  },
  {
    label: "direct wrong source",
    kind: "doc.submit",
    target: "execution/execution-1",
    actor: owner,
    context: { writeSource: "remote_direct", target: { lease } },
    expected: "denied",
  },
  {
    label: "foreign doc writer",
    kind: "doc.submit",
    target: "execution/execution-1",
    actor: outsider,
    context: { writeSource: "local", target: { lease } },
    expected: "denied",
  },
  {
    label: "delegated doc writer",
    kind: "doc.submit",
    target: "execution/execution-1",
    actor: runtimeActor,
    context: { writeSource: "local", target: { lease, runtimeBinding } },
    expected: "allowed",
  },
  {
    label: "delegated wrong source",
    kind: "doc.submit",
    target: "execution/execution-1",
    actor: runtimeActor,
    context: { writeSource: "remote_direct", target: { lease, runtimeBinding } },
    expected: "denied",
  },
  {
    label: "owner closeout",
    kind: "task.closeout",
    target: "task/task-1",
    actor: humanOwner,
    context: { ruleScope: "owner", target: { owner, lease } },
    expected: "allowed",
  },
  {
    label: "foreign owner closeout",
    kind: "task.closeout",
    target: "task/task-1",
    actor: outsider,
    context: { ruleScope: "owner", target: { owner, lease } },
    expected: "denied",
  },
  {
    label: "active closeout",
    kind: "task.closeout",
    target: "task/task-1",
    actor: owner,
    context: { ruleScope: "active", target: { owner, lease } },
    expected: "allowed",
  },
  {
    label: "active closeout executor mismatch",
    kind: "task.closeout",
    target: "task/task-1",
    actor: humanOwner,
    context: { ruleScope: "active", target: { owner, lease } },
    expected: "denied",
  },
];

function assertLocationOracles(policy: PolicyDeclarationV1): void {
  for (const row of cases) {
    const decision = evaluateAuthorization(
      policy,
      {
        version: currentActionEnvelopeVersion,
        actionId: `mutation-${row.label}`,
        kind: row.kind,
        target: row.target,
        actor: row.actor,
        authorizationRef: "default@2",
        idempotencyKey: `mutation-${row.label}`,
      },
      { ...row.context, evaluatedAtCut: "canonical:mutation" },
      (gate) => row.gateEnabled !== false && gate.env === "HARNESS_REVIEW_INDEPENDENCE",
    );
    assert.equal(decision.outcome, row.expected, row.label);
  }
}

function clonePolicy(): PolicyDeclarationV1 {
  return structuredClone(DEFAULT_POLICY);
}

test("every v2 rule deletion is killed by its location oracle", async (t) => {
  for (const [ruleIndex, rule] of (DEFAULT_POLICY.rules ?? []).entries())
    await t.test(`${rule.action}:${rule.scope ?? "default"}`, () => {
      const mutant = clonePolicy(),
        rules = [...(mutant.rules ?? [])];
      rules.splice(ruleIndex, 1);
      assert.throws(() => assertLocationOracles({ ...mutant, rules }), assert.AssertionError);
    });
});

test("every v2 rule-predicate deletion is killed by its location oracle", async (t) => {
  for (const [ruleIndex, rule] of (DEFAULT_POLICY.rules ?? []).entries())
    for (const [clauseIndex, clause] of rule.anyOf.entries())
      for (const [predicateIndex, predicate] of clause.allOf.entries())
        await t.test(`${rule.action}:${rule.scope ?? "default"}:${clauseIndex}:${predicate.predicate}`, () => {
          const mutant = clonePolicy(),
            rules = [...(mutant.rules ?? [])],
            mutantRule = rules[ruleIndex]!,
            anyOf = [...mutantRule.anyOf],
            allOf = [...anyOf[clauseIndex]!.allOf];
          allOf.splice(predicateIndex, 1);
          anyOf[clauseIndex] = { allOf };
          rules[ruleIndex] = { ...mutantRule, anyOf };
          assert.throws(() => assertLocationOracles({ ...mutant, rules }), assert.AssertionError);
        });
});

test("deleting the Decision environment gate is killed by the default-off oracle", () => {
  const mutant = clonePolicy(),
    rules = (mutant.rules ?? []).map((rule) => {
      if (rule.action !== "decision.accept") return rule;
      return {
        ...rule,
        anyOf: rule.anyOf.map((clause) => ({
          allOf: clause.allOf.map((predicate): PolicyPredicateExpression => {
            if (predicate.predicate !== "reviewIndependence") return predicate;
            const { gatedBy: _gate, ...ungated } = predicate;
            return ungated;
          }),
        })),
      };
    }),
    action = {
      version: currentActionEnvelopeVersion,
      actionId: "mutation-decision-gate",
      kind: "decision.accept",
      target: "decision/decision-1" as const,
      actor: humanOwner,
      authorizationRef: "default@2",
      idempotencyKey: "mutation-decision-gate",
    },
    context = {
      commandClasses: ["arbiter"],
      target: { proposalActor: humanOwner },
      evaluatedAtCut: "canonical:mutation",
    };
  assert.equal(evaluateAuthorization(DEFAULT_POLICY, action, context).outcome, "allowed");
  assert.equal(evaluateAuthorization({ ...mutant, rules }, action, context).outcome, "denied");
});
