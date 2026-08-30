import { validateActionEnvelope, type ActionEnvelope } from "../domain/action-envelope.ts";
import type { ActorIdentity } from "../domain/actor-identity.ts";
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
import type { TaskBoundRuntimeBinding } from "../domain/task-bound-runtime-authority.ts";
import type { WriteSource } from "../domain/write-chain.contract.ts";

export interface AuthorizationTargetSnapshot {
  readonly owner?: ActorIdentity | null;
  /** Criteria may still carry the lease beside Policy; the default Policy never evaluates it. */
  readonly lease?: LeaseV1 | null;
  readonly canonicalExecutionExists?: boolean;
  readonly terminalRuntimeBinding?: TaskBoundRuntimeBinding | null;
  readonly executionActor?: ActorIdentity | null;
  readonly proposalActor?: ActorIdentity | null;
  readonly runtimeBinding?: TaskBoundRuntimeBinding | null;
}

export interface AuthorizationAssignmentBinding {
  readonly repoId: string;
  readonly nodeId: string;
  readonly assignmentId: string;
  readonly scope: Readonly<Record<string, ReceiptJsonValue>>;
  readonly writerEpoch?: number;
}

export interface AuthorizationDefaultBinding {
  readonly principalPersonId: string;
  readonly source: "local";
}

/** Volatile bindings are inputs to evaluation, not fields added to ActionEnvelope. */
export interface AuthorizationContext {
  readonly delegatedExecutionToken?: DelegatedExecutionToken;
  readonly defaultBinding?: AuthorizationDefaultBinding;
  readonly ruleScope?: string;
  readonly roleBindings?: readonly RoleBinding[];
  readonly roleBindingTargets?: readonly EntityRef[];
  readonly evaluatedAt?: string;
  readonly writeSource?: WriteSource;
  readonly assignmentBinding?: AuthorizationAssignmentBinding;
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
  const actor = action.actor;
  if (expression.predicate === "hasRoleBinding") {
    const targets = [action.target, ...(context.roleBindingTargets ?? [])],
      matched = (context.roleBindings ?? []).find((binding) =>
        roleBindingApplies(binding, actor, expression.role, targets, context.evaluatedAt),
      );
    const holds = matched !== undefined;
    return {
      holds,
      binding: Object.freeze({
        predicate: expression.predicate,
        satisfied: holds,
        role: expression.role,
        matched: matched ? receiptRoleBinding(matched) : null,
      }),
    };
  }
  if (expression.predicate === "hasDefaultBinding") {
    const binding = context.defaultBinding,
      holds = binding?.source === "local" && binding.principalPersonId === actor.principal.personId;
    return {
      holds,
      binding: Object.freeze({
        predicate: expression.predicate,
        satisfied: holds,
        principal: holds ? { personId: actor.principal.personId } : null,
        source: holds ? binding.source : null,
      }),
    };
  }
  const assignment = context.assignmentBinding;
  return {
    holds: assignment !== undefined,
    binding: Object.freeze({
      predicate: expression.predicate,
      satisfied: assignment !== undefined,
      assignment: assignment
        ? {
            repoId: assignment.repoId,
            nodeId: assignment.nodeId,
            assignmentId: assignment.assignmentId,
            scope: assignment.scope,
            writerEpoch: assignment.writerEpoch ?? null,
          }
        : null,
    }),
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
