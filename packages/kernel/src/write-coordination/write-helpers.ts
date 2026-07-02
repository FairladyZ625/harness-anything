import { Effect } from "effect";
import type { TaskId, WriteError } from "../domain/index.ts";
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
        taskId: write.taskId,
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
    readonly taskId: TaskId;
    readonly kind: WriteOpKind;
    readonly payload?: unknown;
    readonly opIdPrefix?: string;
  },
  options: { readonly flush?: boolean } = {}
): Effect.Effect<void, WriteError> {
  return Effect.gen(function* () {
    const opId = `${input.opIdPrefix ?? Date.now()}-${hashPayload({
      taskId: input.taskId,
      kind: input.kind,
      payload: input.payload
    }).slice(0, 16)}`;
    yield* coordinator.enqueue({
      opId,
      taskId: input.taskId,
      kind: input.kind,
      payload: input.payload
    });
    if (options.flush ?? true) yield* coordinator.flush("explicit");
  });
}
