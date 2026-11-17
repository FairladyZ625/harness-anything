import {
  authorizeWithAuthority as kernelAuthorizeWithAuthority,
  authorizationPort,
  type ActionEnvelope,
  type AuthorizationContext,
  type AuthorizationDecision,
  type AuthorizationAuthority,
  type AuthorizationPort,
} from "@harness-anything/kernel";

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

/** Async provider entry point: the provider evaluates, then the kernel validates its decision. */
export function authorizeActionWithAuthority(
  authority: AuthorizationAuthority,
  action: ActionEnvelope,
  context: AuthorizationContext,
): Promise<AuthorizationDecision> {
  return kernelAuthorizeWithAuthority(authority, action, context);
}
