import type { MessagePort } from "node:worker_threads";
import type { CanonicalEventStore } from "@harness-anything/kernel";
import type { SqliteAppendPreparation, WriterEpochFenceDescriptor } from "@harness-anything/storage/sqlite";

/** A closed commit vocabulary. There is no callback, read RPC, or host capability in this port. */
export type CanonicalCommitRequest =
  | {
      readonly operation: "append";
      readonly bundle: Parameters<CanonicalEventStore["append"]>[0];
      readonly preparation?: SqliteAppendPreparation;
    }
  | {
      readonly operation: "reject";
      readonly rejection: Parameters<NonNullable<CanonicalEventStore["appendRejection"]>>[0];
    }
  | { readonly operation: "prune"; readonly beforeSequence: number }
  | { readonly operation: "close" };

export interface CanonicalCommitCall {
  readonly schema: "canonical-commit/v1";
  readonly writeRequest?: { readonly state: Int32Array; readonly id: number };
  readonly state: Int32Array;
  readonly response: MessagePort;
  readonly fence: WriterEpochFenceDescriptor | undefined;
  readonly request: CanonicalCommitRequest;
}

export type CanonicalCommitResponse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly name: string; readonly message: string; readonly code?: string } };
