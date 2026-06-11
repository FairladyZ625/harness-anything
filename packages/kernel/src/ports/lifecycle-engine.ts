import { Context, Effect } from "effect";
import type { EngineError, EngineId, ExternalRef } from "../domain/index.js";
import type { PublishableProjection, TaskSnapshot } from "../schemas/registry.js";

export interface TaskEngineRef {
  readonly engine: EngineId;
  readonly ref: ExternalRef | null;
}

export interface TaskListFilter {
  readonly engine?: EngineId;
  readonly rawStatus?: string;
}

export interface EngineCapabilities {
  readonly snapshots: true;
  readonly listTasks: boolean;
  readonly publishNote: boolean;
}

export interface NoteRef {
  readonly engine: EngineId;
  readonly ref: ExternalRef;
  readonly url?: string;
}

export interface LifecycleEngine {
  readonly name: EngineId;
  readonly capabilities: Effect.Effect<EngineCapabilities, EngineError>;
  readonly snapshot: (ref: TaskEngineRef) => Effect.Effect<TaskSnapshot, EngineError>;
  readonly listTasks?: (filter: TaskListFilter) => Effect.Effect<ReadonlyArray<TaskSnapshot>, EngineError>;
  readonly publishNote?: (
    ref: TaskEngineRef,
    note: PublishableProjection
  ) => Effect.Effect<NoteRef, EngineError>;
}

export const LifecycleEngine = Context.GenericTag<LifecycleEngine>(
  "@harness-anything/kernel/LifecycleEngine"
);
