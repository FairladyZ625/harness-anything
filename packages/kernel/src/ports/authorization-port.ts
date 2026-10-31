import { validateActionEnvelope, type ActionEnvelope } from "../domain/action-envelope.ts";
import { isSameExecution } from "../domain/actor-domain-services.ts";
import type { AuthorizationDecision } from "../domain/receipt-frame.ts";

/** A decision from the online authority; no local role or policy evaluator exists here. */
export interface AuthorizationContext {
  readonly decision?: AuthorizationDecision;
  readonly evaluatedAtCut: string;
}

export interface AuthorizationPort {
  readonly authorize: (action: ActionEnvelope, context: AuthorizationContext) => AuthorizationDecision;
}

/**
 * Provider-facing half of the boundary. A provider evaluates an action; the local port then
 * validates that the returned decision is bound to the action and canonical cut.
 */
export interface AuthorizationAuthority {
  readonly evaluate: (
    action: ActionEnvelope,
    context: Pick<AuthorizationContext, "evaluatedAtCut">,
  ) => AuthorizationDecision | Promise<AuthorizationDecision>;
}

/** Evaluate through a provider, then enforce the kernel binding and canonical-cut checks. */
export async function authorizeWithAuthority(
  authority: AuthorizationAuthority,
  action: ActionEnvelope,
  context: AuthorizationContext,
): Promise<AuthorizationDecision> {
  const decision = await authority.evaluate(action, { evaluatedAtCut: context.evaluatedAtCut });
  return authorizationPort.authorize(action, { ...context, decision });
}

export const authorizationPort: AuthorizationPort = Object.freeze({
  authorize: (action: ActionEnvelope, context: AuthorizationContext): AuthorizationDecision => {
    const decision = context.decision;
    if (
      validateActionEnvelope(action).length === 0 &&
      typeof decision?.policyRef === "string" &&
      decision.policyRef === action.authorizationRef &&
      decision.subject === action.target &&
      isSameExecution(decision.actor, action.actor) &&
      decision.evaluatedAtCut === context.evaluatedAtCut &&
      decision.bindingsUsed.some((binding) => binding.scope === action.kind)
    )
      return decision;
    return Object.freeze({
      // The request chooses the authority namespace. Keeping that ref on a denial preserves
      // provider-specific receipt semantics without making the kernel know the provider.
      policyRef: action.authorizationRef,
      actor: action.actor,
      subject: action.target,
      bindingsUsed: Object.freeze([]),
      outcome: "denied",
      reasonCodes: Object.freeze(["authentication_required"]),
      nextActions: Object.freeze(["Authenticate with the configured authorization provider and request access."]),
      evaluatedAtCut: context.evaluatedAtCut,
    });
  },
});
