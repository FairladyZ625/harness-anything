import { validateActionEnvelope, type ActionEnvelope } from "../domain/action-envelope.ts";
import type { ActorIdentity } from "../domain/actor-identity.ts";
import { isIndependentFrom, isSameExecution, isSamePerson } from "../domain/actor-domain-services.ts";
import { DEFAULT_POLICY } from "../domain/default-policy.ts";
import type { LeaseV1 } from "../domain/execution.ts";
import {
  validatePolicyDeclarationV1,
  type PolicyActionRule,
  type PolicyDeclarationV1,
  type PolicyPredicateGate,
  type PolicyPredicateExpression,
} from "../domain/policy.ts";
import type { AuthorizationDecision, ReceiptJsonValue } from "../domain/receipt-frame.ts";
import { runtimeSessionIdFromActor, type LiveTaskBoundRuntimeBinding } from "../domain/task-bound-runtime-authority.ts";
import { sameWriteSource, type WriteSource } from "../domain/write-chain.contract.ts";

export interface AuthorizationTargetSnapshot {
  readonly owner?: ActorIdentity | null;
  readonly lease?: LeaseV1 | null;
  readonly canonicalExecutionExists?: boolean;
  readonly executionActor?: ActorIdentity | null;
  readonly proposalActor?: ActorIdentity | null;
  readonly runtimeBinding?: LiveTaskBoundRuntimeBinding | null;
}

/** Volatile bindings are inputs to evaluation, not fields added to ActionEnvelope. */
export interface AuthorizationContext {
  readonly ruleScope?: string;
  readonly commandClasses?: readonly string[];
  readonly writeSource?: WriteSource;
  readonly target: AuthorizationTargetSnapshot;
  readonly evaluatedAtCut: string;
}

export interface AuthorizationPort {
  readonly authorize: (
    action: ActionEnvelope,
    context: AuthorizationContext,
    policy?: PolicyDeclarationV1,
  ) => AuthorizationDecision;
}

type PredicateResult = {
  readonly holds: boolean;
  readonly binding: Readonly<Record<string, ReceiptJsonValue>>;
};

type PolicyGateEvaluator = (gate: PolicyPredicateGate) => boolean;

export function createAuthorizationPort(
  defaultPolicy: PolicyDeclarationV1 = DEFAULT_POLICY,
  environment: Readonly<Record<string, string | undefined>> = {},
): AuthorizationPort {
  return Object.freeze({
    authorize: (action: ActionEnvelope, context: AuthorizationContext, policy = defaultPolicy) =>
      evaluateAuthorization(policy, action, context, (gate) => environment[gate.env] === "1"),
  });
}

/** Pure Policy rule × typed context evaluator. */
export function evaluateAuthorization(
  policy: PolicyDeclarationV1,
  action: ActionEnvelope,
  context: AuthorizationContext,
  gateEnabled: PolicyGateEvaluator = () => false,
): AuthorizationDecision {
  const policyRef = `${policy.id}@${policy.version}`,
    policyValid = validatePolicyDeclarationV1(policy).length === 0,
    actionValid = validateActionEnvelope(action).length === 0,
    rules = !policyValid
      ? []
      : (policy.rules ?? []).filter(
          (candidate) =>
            candidate.action === action.kind &&
            (candidate.scope === undefined ? context.ruleScope === undefined : candidate.scope === context.ruleScope),
        ),
    authorizationRefMatches = action.authorizationRef === policyRef,
    evaluated = rules.map((rule) => evaluateRule(rule, action, context, gateEnabled)),
    allowed = policyValid && actionValid && authorizationRefMatches && evaluated.some((result) => result.allowed),
    bindingsUsed = evaluated.flatMap((result) => result.bindings),
    missing = rules.length === 0 ? "policy_rule_missing" : null,
    reasonCodes = allowed
      ? ["authorization_allowed"]
      : [
          ...(authorizationRefMatches ? [] : ["authorization_ref_mismatch"]),
          ...(policyValid ? [] : ["policy_contract_invalid"]),
          ...(actionValid ? [] : ["action_envelope_invalid"]),
          ...(missing ? [missing] : []),
          ...(rules.length && policyValid && actionValid && authorizationRefMatches
            ? ["authorization_predicate_failed"]
            : []),
        ];
  return Object.freeze({
    policyRef,
    actor: action.actor,
    subject: action.target,
    bindingsUsed: Object.freeze(bindingsUsed),
    outcome: allowed ? "allowed" : "denied",
    reasonCodes: Object.freeze(reasonCodes),
    nextActions: Object.freeze(
      allowed
        ? []
        : [missing ? `Define Policy rule ${action.kind}.` : `Retry ${action.kind} with authorized bindings.`],
    ),
    evaluatedAtCut: context.evaluatedAtCut,
  });
}

function evaluateRule(
  rule: PolicyActionRule,
  action: ActionEnvelope,
  context: AuthorizationContext,
  gateEnabled: PolicyGateEvaluator,
): { readonly allowed: boolean; readonly bindings: readonly Readonly<Record<string, ReceiptJsonValue>>[] } {
  const branches = rule.anyOf.map((clause) =>
      clause.allOf
        .filter((predicate) => predicate.gatedBy === undefined || gateEnabled(predicate.gatedBy))
        .map((predicate) => evaluatePredicate(predicate, action, context)),
    ),
    selected = branches.find((branch) => branch.every((result) => result.holds));
  return {
    allowed: selected !== undefined,
    bindings: (selected ?? branches.flat()).map((result) => result.binding),
  };
}

function evaluatePredicate(
  expression: PolicyPredicateExpression,
  action: ActionEnvelope,
  context: AuthorizationContext,
): PredicateResult {
  const { target } = context,
    actor = action.actor,
    lease = target.lease ?? null,
    leaseTargetsSubject =
      lease !== null &&
      (action.target === `task/${lease.taskId}` || action.target === `execution/${lease.executionId}`),
    runtimeSessionId = runtimeSessionIdFromActor(actor),
    runtimeBinding = target.runtimeBinding ?? null,
    runtimeDelegation =
      leaseTargetsSubject &&
      lease?.phase === "held" &&
      runtimeSessionId !== null &&
      runtimeBinding?.runtimeSessionId === runtimeSessionId &&
      runtimeBinding.taskId === lease.taskId &&
      runtimeBinding.executionId === lease.executionId &&
      isSamePerson(lease.actor, actor);
  let holds = false;
  if (expression.predicate === "isOwner")
    holds = target.owner !== null && target.owner !== undefined && isSamePerson(target.owner, actor);
  else if (expression.predicate === "isSameExecutionOwner")
    holds = target.owner !== null && target.owner !== undefined && isSameExecution(target.owner, actor);
  else if (expression.predicate === "holdsExecutionLease")
    holds = leaseTargetsSubject && lease !== null && isSameExecution(lease.actor, actor);
  else if (expression.predicate === "reclaimsOrphanedLease")
    holds =
      leaseTargetsSubject &&
      lease !== null &&
      target.canonicalExecutionExists === false &&
      isSamePerson(lease.actor, actor);
  else if (expression.predicate === "dispatchesExecution")
    holds =
      leaseTargetsSubject &&
      lease?.phase === "held" &&
      isSamePerson(lease.actor, actor) &&
      (actor.executor === null || isSameExecution(lease.actor, actor));
  else if (expression.predicate === "delegatedByRuntimeSession") holds = runtimeDelegation;
  else if (expression.predicate === "hasCommandClass")
    holds = (context.commandClasses ?? []).includes(expression.commandClass);
  else if (expression.predicate === "reviewIndependence")
    holds =
      (target.executionActor !== null && target.executionActor !== undefined
        ? isIndependentFrom(target.executionActor, actor)
        : target.proposalActor !== null &&
          target.proposalActor !== undefined &&
          isIndependentFrom(target.proposalActor, actor)) && runtimeBinding === null;
  else if (expression.predicate === "sameWriteSource")
    holds = context.writeSource !== undefined && lease !== null && sameWriteSource(lease.source, context.writeSource);
  return {
    holds,
    binding: Object.freeze({ predicate: expression.predicate, satisfied: holds }),
  };
}

export const authorizationPort = createAuthorizationPort(DEFAULT_POLICY, process.env);
