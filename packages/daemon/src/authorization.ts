import {
  authorizationPort,
  type ActionEnvelope,
  type AuthorizationContext,
  type AuthorizationDecision,
  type AuthorizationPort,
} from "../../kernel/src/index.ts";

const daemonAuthorizationPort: AuthorizationPort = authorizationPort;

export function authorizeAction(
  action: ActionEnvelope,
  context: Omit<AuthorizationContext, "evaluatedAtCut"> & { readonly evaluatedAtCut?: string },
): AuthorizationDecision {
  return daemonAuthorizationPort.authorize(action, {
    ...context,
    evaluatedAtCut: context.evaluatedAtCut ?? "canonical:unknown",
  });
}
