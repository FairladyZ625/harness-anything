import type { ActorIdentity, EventHead } from "../domain/write-chain.contract.ts";
import type { LedgerLayoutState } from "../layout/ledger-object-layout.ts";
import type { EventPublicationKillpoint } from "./task-event-store.ts";
import type { WalDurableCutDescriptor } from "./wal-event-log.ts";

export const WAL_MATERIALIZATION_REQUEST_SCHEMA = "harness-wal-materialization-request/v1" as const;
export const WAL_MATERIALIZATION_RESPONSE_SCHEMA = "harness-wal-materialization-response/v1" as const;

export interface WalMaterializationWorkerConfig {
  readonly schema: "harness-wal-materialization-worker/v1";
  readonly repoId: string;
  readonly rootDir: string;
  readonly authoredBranch?: string;
}

export interface WalMaterializationFenceV1 {
  readonly schema: "harness-writer-epoch-fence/v1";
  readonly stateRoot: string;
  readonly repoId: string;
  readonly epoch: number;
  readonly holderId: string;
}

export interface WalMaterializationRequestV1 {
  readonly schema: typeof WAL_MATERIALIZATION_REQUEST_SCHEMA;
  readonly requestId: string;
  readonly cut: WalDurableCutDescriptor;
  readonly expectedGit: {
    readonly revision: number;
    readonly commitSha: string;
    readonly layout: LedgerLayoutState;
  };
  readonly context: string;
  readonly compactWorktree: boolean;
  readonly previousSettlementFingerprint: string | null;
  readonly fence: WalMaterializationFenceV1 | null;
  readonly testFault?: {
    readonly point: EventPublicationKillpoint | "before_materialization" | "worker_exit";
  };
}

export interface WalBaselineDeltaV1 {
  readonly events: readonly {
    readonly opId: string;
    readonly oid: string;
  }[];
  readonly files: readonly (
    | {
        readonly target: string;
        readonly mode: "100644" | "120000";
        readonly oid: string;
      }
    | { readonly delete: string }
  )[];
}

export interface WalDocSettlementIntentV1 {
  readonly schema: "harness-doc-settlement-intent/v1";
  readonly actor: ActorIdentity;
  readonly fingerprint: string;
  readonly inventory: unknown | null;
}

export interface WalMaterializationSuccessV1 {
  readonly schema: typeof WAL_MATERIALIZATION_RESPONSE_SCHEMA;
  readonly requestId: string;
  readonly outcome: "materialized";
  readonly cut: WalDurableCutDescriptor;
  readonly git: {
    readonly commitSha: string;
    readonly head: EventHead | null;
    readonly layout: LedgerLayoutState;
  };
  readonly baselineDelta: WalBaselineDeltaV1;
  readonly settlementFingerprint: string | null;
  readonly settlementIntent: WalDocSettlementIntentV1 | null;
  readonly spans: {
    readonly materializationMs: number;
    readonly fingerprintMs: number;
  };
}

export interface WalMaterializationFailureV1 {
  readonly schema: typeof WAL_MATERIALIZATION_RESPONSE_SCHEMA;
  readonly requestId: string;
  readonly outcome: "failed";
  readonly cut: WalDurableCutDescriptor;
  readonly error: {
    readonly name: string;
    readonly message: string;
    readonly code: string | null;
    readonly classification: "git_diverged" | "retryable" | "deterministic_failure";
    readonly canonicalSha: string | null;
  };
}

export type WalMaterializationResponseV1 = WalMaterializationSuccessV1 | WalMaterializationFailureV1;
