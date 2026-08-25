import {
  authorizationPort,
  currentActionEnvelopeVersion,
  DEFAULT_POLICY,
  type ActionEnvelope,
  type ActorIdentity,
  type AuthorizationContext,
  type AuthorizationDecision,
  type AuthorizationPort,
  type EntityRef,
} from "../../kernel/src/index.ts";

const daemonAuthorizationPort: AuthorizationPort = authorizationPort;

export function createAuthorizationActionEnvelope(
  kind: string,
  target: EntityRef,
  actor: ActorIdentity,
  actionId: string,
  idempotencyKey: string,
): ActionEnvelope {
  return {
    version: currentActionEnvelopeVersion,
    actionId,
    kind,
    target,
    actor,
    authorizationRef: `${DEFAULT_POLICY.id}@${DEFAULT_POLICY.version}`,
    idempotencyKey,
  };
}

export function authorizeAction(
  kind: string,
  target: EntityRef,
  actor: ActorIdentity,
  actionId: string,
  idempotencyKey: string,
  context: Omit<AuthorizationContext, "evaluatedAtCut"> & { readonly evaluatedAtCut?: string },
): AuthorizationDecision {
  const action = createAuthorizationActionEnvelope(kind, target, actor, actionId, idempotencyKey);
  return daemonAuthorizationPort.authorize(action, {
    ...context,
    evaluatedAtCut: context.evaluatedAtCut ?? "canonical:unknown",
  });
}
