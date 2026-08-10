import { Effect } from "effect";
import { requireDeterminateFlushReport, stablePayloadHash } from "@harness-anything/kernel";
import type { EntityId, WriteControl, WriteCoordinator, WriteOpKind } from "@harness-anything/kernel";

export function writeCoordinatedPayload(
  coordinator: WriteCoordinator,
  input: {
    readonly entityId: EntityId;
    readonly kind: WriteOpKind;
    readonly opIdPrefix: string;
    readonly payload: Record<string, unknown>;
  }
): Effect.Effect<void, WriteControl> {
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
    yield* requireDeterminateFlushReport(yield* coordinator.flush("explicit"));
  });
}
