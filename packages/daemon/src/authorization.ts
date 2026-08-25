import {
  authorizationPort,
  DEFAULT_POLICY,
  type ActionEnvelope,
  type ActorIdentity,
  type AuthorizationContext,
  type AuthorizationDecision,
  type AuthorizationPort,
  type EntityRef,
} from "../../kernel/src/index.ts";

const daemonAuthorizationPort: AuthorizationPort = authorizationPort;

export function authorizeAction(
  kind: string,
  target: EntityRef,
  actor: ActorIdentity,
  actionId: string,
  context: Omit<AuthorizationContext, "evaluatedAtCut"> & { readonly evaluatedAtCut?: string },
): AuthorizationDecision {
  const action: ActionEnvelope = {
    actionId,
    kind,
    target,
    actor,
    authorizationRef: `${DEFAULT_POLICY.id}@${DEFAULT_POLICY.version}`,
    idempotencyKey: actionId,
  };
  return daemonAuthorizationPort.authorize(action, {
    ...context,
    evaluatedAtCut: context.evaluatedAtCut ?? "canonical:unknown",
  });
}
