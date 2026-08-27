import { validateActionEnvelope, type ActionEnvelope } from "../domain/action-envelope.ts";
import type { ActorIdentity } from "../domain/actor-identity.ts";
import { isIndependentFrom, isSameExecution, isSamePerson } from "../domain/actor-domain-services.ts";
import { DEFAULT_POLICY } from "../domain/default-policy.ts";
import type { EntityRef } from "../domain/entity-ref.ts";
import type { LeaseV1 } from "../domain/execution.ts";
import {
  parseDelegatedExecutionToken,
  validateDelegatedExecutionToken,
  verifyDelegatedExecutionToken,
  type DelegatedExecutionToken,
  type DelegatedExecutionTokenVerification,
} from "../domain/delegated-execution-token.ts";
import {
  validatePolicyDeclarationV1,
  type PolicyActionRule,
  type PolicyDeclarationV1,
  type PolicyPredicateExpression,
} from "../domain/policy.ts";
import type { AuthorizationDecision, ReceiptJsonValue } from "../domain/receipt-frame.ts";
import { roleBindingApplies, type RoleBinding } from "../domain/role-binding.ts";
import { runtimeSessionIdFromActor, type TaskBoundRuntimeBinding } from "../domain/task-bound-runtime-authority.ts";
import { sameWriteSource, type WriteSource } from "../domain/write-chain.contract.ts";

export interface AuthorizationTargetSnapshot {
  readonly owner?: ActorIdentity | null;
  readonly lease?: LeaseV1 | null;
  readonly canonicalExecutionExists?: boolean;
  readonly terminalRuntimeBinding?: TaskBoundRuntimeBinding | null;
  readonly executionActor?: ActorIdentity | null;
  readonly proposalActor?: ActorIdentity | null;
  readonly runtimeBinding?: TaskBoundRuntimeBinding | null;
}

/** Volatile bindings are inputs to evaluation, not fields added to ActionEnvelope. */
export interface AuthorizationContext {
  readonly delegatedExecutionToken?: DelegatedExecutionToken;
  readonly ruleScope?: string;
  readonly roleBindings?: readonly RoleBinding[];
  readonly roleBindingTargets?: readonly EntityRef[];
  readonly evaluatedAt?: string;
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

export function createAuthorizationPort(defaultPolicy: PolicyDeclarationV1 = DEFAULT_POLICY): AuthorizationPort {
  return Object.freeze({
    authorize: (action: ActionEnvelope, context: AuthorizationContext, policy = defaultPolicy) =>
      evaluateAuthorization(policy, action, context),
  });
}

/** Pure Policy rule × typed context evaluator. */
export function evaluateAuthorization(
  policy: PolicyDeclarationV1,
  action: ActionEnvelope,
  context: AuthorizationContext,
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
    tokenVerification = verifyActorProof(action, context),
    evaluated = rules.map((rule) => evaluateRule(rule, action, context)),
    allowed = policyValid && actionValid && authorizationRefMatches && evaluated.some((result) => result.allowed),
    actorProofAllowed = tokenVerification === null || tokenVerification.ok,
    authorizationAllowed = allowed && actorProofAllowed,
    tokenBinding = context.delegatedExecutionToken
      ? receiptDelegatedExecutionToken(context.delegatedExecutionToken)
      : null,
    bindingsUsed = [...(tokenBinding ? [tokenBinding] : []), ...evaluated.flatMap((result) => result.bindings)],
    missing = rules.length === 0 ? "policy_rule_missing" : null,
    reasonCodes = authorizationAllowed
      ? ["authorization_allowed"]
      : [
          ...(tokenVerification !== null && !tokenVerification.ok ? [tokenVerification.reasonCode] : []),
          ...(authorizationRefMatches ? [] : ["authorization_ref_mismatch"]),
          ...(policyValid ? [] : ["policy_contract_invalid"]),
          ...(actionValid ? [] : ["action_envelope_invalid"]),
          ...(missing ? [missing] : []),
          ...(!allowed && rules.length && policyValid && actionValid && authorizationRefMatches
            ? ["authorization_predicate_failed"]
            : []),
        ];
  return Object.freeze({
    policyRef,
    actor: action.actor,
    subject: action.target,
    bindingsUsed: Object.freeze(bindingsUsed),
    outcome: authorizationAllowed ? "allowed" : "denied",
    reasonCodes: Object.freeze(reasonCodes),
    nextActions: Object.freeze(
      authorizationAllowed
        ? []
        : [missing ? `Define Policy rule ${action.kind}.` : `Retry ${action.kind} with authorized bindings.`],
    ),
    evaluatedAtCut: context.evaluatedAtCut,
  });
}

function verifyActorProof(
  action: ActionEnvelope,
  context: AuthorizationContext,
): DelegatedExecutionTokenVerification | null {
  if (!context.delegatedExecutionToken) return null;
  return verifyDelegatedExecutionToken(
    context.delegatedExecutionToken,
    action.actor,
    action.kind,
    context.evaluatedAt ?? "",
  );
}

function evaluateRule(
  rule: PolicyActionRule,
  action: ActionEnvelope,
  context: AuthorizationContext,
): { readonly allowed: boolean; readonly bindings: readonly Readonly<Record<string, ReceiptJsonValue>>[] } {
  const branches = rule.anyOf.map((clause) =>
      clause.allOf.map((predicate) => evaluatePredicate(predicate, action, context)),
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
    terminalRuntimeBinding = target.terminalRuntimeBinding ?? null,
    runtimeDelegation =
      leaseTargetsSubject &&
      lease?.phase === "held" &&
      runtimeSessionId !== null &&
      runtimeBinding?.runtimeSessionId === runtimeSessionId &&
      runtimeBinding.taskId === lease.taskId &&
      runtimeBinding.executionId === lease.executionId &&
      isSamePerson(lease.actor, actor);
  const terminalRuntimeOwnsLease =
    leaseTargetsSubject &&
    lease !== null &&
    terminalRuntimeBinding?.taskId === lease.taskId &&
    terminalRuntimeBinding.executionId === lease.executionId;
  let holds = false;
  if (expression.predicate === "holdsExecutionLease")
    holds = leaseTargetsSubject && lease !== null && isSameExecution(lease.actor, actor);
  else if (expression.predicate === "reclaimsOrphanedLease")
    holds =
      leaseTargetsSubject &&
      lease !== null &&
      ((isSamePerson(lease.actor, actor) &&
        (lease.phase === "orphaned" || target.canonicalExecutionExists === false || terminalRuntimeOwnsLease)) ||
        ((lease.phase === "orphaned" || terminalRuntimeOwnsLease) &&
          target.owner !== null &&
          target.owner !== undefined &&
          isSamePerson(target.owner, actor)));
  else if (expression.predicate === "dispatchesExecution")
    holds =
      leaseTargetsSubject &&
      lease?.phase === "held" &&
      isSamePerson(lease.actor, actor) &&
      (actor.executor === null || isSameExecution(lease.actor, actor));
  else if (expression.predicate === "delegatedByRuntimeSession") holds = runtimeDelegation;
  else if (expression.predicate === "hasCommandClass") {
    const targets = [action.target, ...(context.roleBindingTargets ?? [])],
      matched = (context.roleBindings ?? []).find((binding) =>
        roleBindingApplies(binding, actor, expression.commandClass, targets, context.evaluatedAt),
      );
    holds = matched !== undefined;
    return {
      holds,
      binding: Object.freeze({
        predicate: expression.predicate,
        satisfied: holds,
        role: expression.commandClass,
        matched: matched ? receiptRoleBinding(matched) : null,
      }),
    };
  } else if (expression.predicate === "reviewIndependence") {
    const author = target.executionActor ?? target.proposalActor ?? null,
      executorIndependent = author !== null && isIndependentFrom(author, actor);
    holds =
      executorIndependent &&
      runtimeBinding === null &&
      (expression.level === "L1" || (author !== null && !isSamePerson(author, actor)));
  } else if (expression.predicate === "isNotProposalAgent")
    holds =
      target.proposalActor !== null &&
      target.proposalActor !== undefined &&
      (actor.executor === null || !isSameExecution(target.proposalActor, actor));
  else if (expression.predicate === "sameWriteSource")
    holds = context.writeSource !== undefined && lease !== null && sameWriteSource(lease.source, context.writeSource);
  return {
    holds,
    binding: Object.freeze({ predicate: expression.predicate, satisfied: holds }),
  };
}

function receiptRoleBinding(binding: RoleBinding): ReceiptJsonValue {
  return {
    actor: { kind: binding.actor.kind, id: binding.actor.id },
    role: binding.role,
    target: binding.target,
    source: binding.source,
    expiresAt: binding.expiresAt,
  };
}

function receiptDelegatedExecutionToken(value: unknown): Readonly<Record<string, ReceiptJsonValue>> | null {
  if (validateDelegatedExecutionToken(value).length) return null;
  const token = parseDelegatedExecutionToken(value);
  return Object.freeze({
    proof: "delegated-execution-token",
    tokenId: token.tokenId,
    issuerPersonId: token.issuer.personId,
    runtimeSessionId: token.delegate.runtimeSessionId,
  });
}

export const authorizationPort = createAuthorizationPort(DEFAULT_POLICY);
