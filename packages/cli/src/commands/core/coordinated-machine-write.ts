import { Effect } from "effect";
import { stablePayloadHash } from "@harness-anything/kernel";
import type { EntityId, WriteCoordinator, WriteError, WriteOpKind } from "@harness-anything/kernel";

export function writeCoordinatedPayload(
  coordinator: WriteCoordinator,
  input: {
    readonly entityId: EntityId;
    readonly kind: WriteOpKind;
    readonly opIdPrefix: string;
    readonly payload: Record<string, unknown>;
  }
): Effect.Effect<void, WriteError> {
  const opId = `${input.opIdPrefix}-${stablePayloadHash({
    entityId: input.entityId,
    kind: input.kind,
    payload: input.payload
  }).slice(0, 16)}`;
  return Effect.gen(function* () {
    yield* coordinator.enqueue({
      opId,
      entityId: input.entityId,
      kind: input.kind,
      payload: input.payload
    });
    yield* coordinator.flush("explicit");
  });
}
