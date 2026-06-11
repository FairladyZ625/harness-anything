import { Context, Effect, Option } from "effect";
import type { ArtifactStoreError, EngineId, ExternalRef, TaskId } from "../domain/index.js";

export interface BindingIndex {
  readonly findBindingByExternalRef: (
    engine: EngineId,
    ref: ExternalRef
  ) => Effect.Effect<Option.Option<TaskId>, ArtifactStoreError>;
}

export const BindingIndex = Context.GenericTag<BindingIndex>(
  "@harness-anything/kernel/BindingIndex"
);
