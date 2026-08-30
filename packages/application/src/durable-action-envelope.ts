import {
  currentActionEnvelopeVersion,
  DEFAULT_POLICY,
  validateActionEnvelope,
  type ActionEnvelope,
  type ActorIdentity,
  type EntityRef,
} from "../../kernel/src/index.ts";

/** Canonical composition used by every durable adapter after transport has bound the actor. */
export function composeDurableActionEnvelope(input: {
  readonly actionId: string;
  readonly kind: string;
  readonly target: EntityRef;
  readonly actor: ActorIdentity;
  readonly idempotencyKey?: string;
}): ActionEnvelope {
  const envelope: ActionEnvelope = {
    version: currentActionEnvelopeVersion,
    actionId: input.actionId,
    kind: input.kind,
    target: input.target,
    actor: input.actor,
    authorizationRef: `${DEFAULT_POLICY.id}@${DEFAULT_POLICY.version}`,
    idempotencyKey: input.idempotencyKey ?? input.actionId,
  };
  const errors = validateActionEnvelope(envelope);
  if (errors.length) throw new Error(`invalid durable Action envelope: ${errors.join("; ")}`);
  return Object.freeze(envelope);
}
