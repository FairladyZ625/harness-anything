import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { taskEntityId } from "../domain/index.ts";
import type { EntityId, TaskId, WriteError } from "../domain/index.ts";
import { stablePayloadHash } from "../integrity/stable-hash.ts";
import type { WriteCoordinator, WriteOpKind } from "../ports/index.ts";

export type PayloadHasher = (payload: unknown) => string;

export interface CoordinatedTaskDocumentWrite {
  readonly taskId: TaskId;
  readonly path: string;
  readonly body: string;
  readonly kind: WriteOpKind;
  readonly packageSlug?: string;
}

export { stablePayloadHash };

export function writeCoordinatedTaskDocuments(
  coordinator: WriteCoordinator,
  hashPayload: PayloadHasher,
  writes: ReadonlyArray<CoordinatedTaskDocumentWrite>
): Effect.Effect<void, WriteError> {
  return Effect.gen(function* () {
    for (const write of writes) {
      yield* writeCoordinatedPayload(coordinator, hashPayload, {
        entityId: taskEntityId(write.taskId),
        kind: write.kind,
        payload: {
          path: write.path,
          body: write.body,
          ...(write.packageSlug ? { packageSlug: write.packageSlug } : {})
        }
      }, { flush: false });
    }
    yield* coordinator.flush("explicit");
  });
}

export function writeCoordinatedPayload(
  coordinator: WriteCoordinator,
  hashPayload: PayloadHasher,
  input: {
    readonly entityId: EntityId;
    readonly kind: WriteOpKind;
    readonly payload?: unknown;
    readonly opIdPrefix?: string;
  },
  options: { readonly flush?: boolean } = {}
): Effect.Effect<void, WriteError> {
  return Effect.gen(function* () {
    // Default op ids carry random entropy: delta-shaped payloads (e.g. progress_append)
    // are constant for identical text, so timestamp+hash alone would collide within one
    // millisecond and silently dedupe a legitimate second append. Callers that pass an
    // explicit opIdPrefix opt into deterministic ids for intentional idempotency. The
    // hash still folds in entityId/kind so distinct ops never share a payload hash.
    const prefix = input.opIdPrefix ?? `${Date.now()}-${randomBytes(4).toString("hex")}`;
    const opId = `${prefix}-${hashPayload({
      entityId: input.entityId,
      kind: input.kind,
      payload: input.payload
    }).slice(0, 16)}`;
    yield* coordinator.enqueue({
      opId,
      entityId: input.entityId,
      kind: input.kind,
      payload: input.payload
    });
    if (options.flush ?? true) yield* coordinator.flush("explicit");
  });
}
