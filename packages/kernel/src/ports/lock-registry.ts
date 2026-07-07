import { Context, Effect } from "effect";

export interface LockLease {
  readonly release: () => Effect.Effect<void, LockRegistryError>;
}

export type LockRequest =
  | {
    readonly kind: "external-adopt-claim";
    readonly namespace: string;
    readonly key: string;
  };

export interface LockRegistryError {
  readonly _tag: "LockRegistryError";
  readonly kind: LockRequest["kind"];
  readonly key: string;
  readonly cause: unknown;
}

export interface LockRegistry {
  readonly acquire: (request: LockRequest) => Effect.Effect<LockLease, LockRegistryError>;
}

export const LockRegistry = Context.GenericTag<LockRegistry>(
  "@harness-anything/kernel/LockRegistry"
);
