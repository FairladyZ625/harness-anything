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

export const authorizationPort: AuthorizationPort = Object.freeze({
  authorize: (action: ActionEnvelope, context: AuthorizationContext): AuthorizationDecision => {
    const decision = context.decision;
    if (
      validateActionEnvelope(action).length === 0 &&
      decision?.policyRef === "keycloak-policy@1" &&
      decision.subject === action.target &&
      isSameExecution(decision.actor, action.actor) &&
      decision.evaluatedAtCut === context.evaluatedAtCut &&
      decision.bindingsUsed.some((binding) => binding.scope === action.kind)
    )
      return decision;
    return Object.freeze({
      policyRef: "keycloak-policy@1",
      actor: action.actor,
      subject: action.target,
      bindingsUsed: Object.freeze([]),
      outcome: "denied",
      reasonCodes: Object.freeze(["authentication_required"]),
      nextActions: Object.freeze(["Sign in with Keycloak and request an applicable policy group."]),
      evaluatedAtCut: context.evaluatedAtCut,
    });
  },
});
