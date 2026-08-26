import type { PortableDocumentPath } from "../layout/portable-path.ts";
import type { EntityEventV1 } from "./entity-event.ts";
import type { AgentRuntimeEventV1 } from "./agent-runtime.ts";
import { OPAQUE_TEXTUAL_POLICY_ID, type OpaqueTextualMediaType } from "./artifact-text-classification.ts";
import type { DecisionEventV1 } from "./decision-event.ts";
import type { LeaseV1 } from "./execution.ts";
import type { FactEventV1 } from "./fact-event.ts";
import type { LedgerLayoutMigrationEventV1 } from "./ledger-layout-migration-event.ts";
import type { MigrationDocumentClaim, MigrationImportEventV1 } from "./migration-import-event.ts";
import type { PresetSnapshotUpgradeEventV1 } from "./preset-snapshot-upgrade-event.ts";
import type {
  DocSyncReceiptDetail,
  LedgerCommitIdentity,
  LedgerCutIdentity,
  LedgerIdentity,
} from "./receipt-domain-registry.ts";
import type { TaskBootstrapEventV1 } from "./task-bootstrap-event.ts";
import type { TaskBoundRuntimeBinding } from "./task-bound-runtime-authority.ts";
import type { TaskEventV1 } from "./task-lifecycle.contract.ts";
import type { TaskProgressEventV1 } from "./task-progress-event.ts";
import type { ActorIdentity, EventEnvelope, FrozenWritePlan, WriteSource } from "./write-chain.contract.ts";
import type { AuthorizationDecision } from "./receipt-frame.ts";

export const DOC_POLICY_ID = "markdown-body-replaceable/v1",
  DOC_CODEC_ID = "markdown-regions/v1";

export const DOC_WRITE_INTENT_SCHEMA = Object.freeze({
  id: "doc-write-intent/v1",
  required: Object.freeze(["schema", "executionId", "baseLedgerSha", "changes"]),
});

export const DOC_EVENT_SCHEMA = Object.freeze({
  id: "doc-event/v1",
  required: Object.freeze([
    "schema",
    "eventId",
    "workspaceRevision",
    "opId",
    "type",
    "actor",
    "source",
    "occurredAt",
    "payload",
  ]),
});

export class DocSyncContractError extends Error {
  readonly code = "invalid_contract";
  constructor(message: string) {
    super(message);
    this.name = "DocSyncContractError";
  }
}

export const docRouteRegistry = Object.freeze([
  { prefix: "events/", requiredRoute: "canonical-event" },
  { prefix: "objects/", requiredRoute: "content-blob" },
  { prefix: "harness.yaml", requiredRoute: "workspace-config" },
  { prefix: "people.yaml", requiredRoute: "people-registry" },
] as const);

export const docRegionPolicyRegistry = Object.freeze([
  {
    id: DOC_POLICY_ID,
    codecId: DOC_CODEC_ID,
    writable: "body-replaceable",
    catchAll: "prose/*",
  },
  {
    id: OPAQUE_TEXTUAL_POLICY_ID,
    codecId: null,
    writable: "whole-file-cas",
    catchAll: null,
  },
] as const);

declare const ledgerCommitShaBrand: unique symbol, docClaimRefBrand: unique symbol, docByteLengthBrand: unique symbol;

export interface LedgerCommitSha extends LedgerCommitIdentity {
  readonly [ledgerCommitShaBrand]: true;
}

export type DocClaimRef = string & { readonly [docClaimRefBrand]: true };

export type DocByteLength = number & { readonly [docByteLengthBrand]: true };

export interface ContentClaim {
  readonly ref: DocClaimRef;
  readonly sha256: string;
  readonly size: DocByteLength;
  readonly mediaType: "text/markdown" | "text/plain" | OpaqueTextualMediaType;
}

export interface DocWriteChange {
  readonly path: PortableDocumentPath;
  readonly baseBlobSha256: string | null;
  readonly policyId: string;
  readonly candidate: ContentClaim | null;
}

export interface DocWriteIntent {
  readonly schema: "doc-write-intent/v1";
  readonly executionId: string | null;
  readonly baseLedgerSha: LedgerCutIdentity;
  readonly changes: readonly DocWriteChange[];
}

export interface RegionProof {
  readonly regionId: string;
  readonly policyId: string;
  readonly codecId: string;
  readonly baseSha256: string;
  readonly candidateSha256: string;
  readonly insertBytes: number;
}

export interface DocPolicyUpgrade {
  readonly from: MigrationDocumentClaim["policyId"];
  readonly to: typeof DOC_POLICY_ID;
}

export interface DocEventChange {
  readonly path: PortableDocumentPath;
  readonly baseBlobSha256: string | null;
  readonly candidate: Omit<ContentClaim, "ref">;
  readonly policyId: string;
  readonly regionProofs: readonly RegionProof[];
  readonly policyUpgrade?: DocPolicyUpgrade;
}

export interface DocEventRetirementChange {
  readonly path: PortableDocumentPath;
  readonly baseBlobSha256: string;
  readonly candidate: null;
  readonly policyId: string;
  readonly regionProofs: readonly [];
  readonly policyUpgrade?: never;
}

export type DocEventMutation = DocEventChange | DocEventRetirementChange;

export type DocEventV1 = EventEnvelope<
  "doc-event/v1",
  "documents_written",
  ActorIdentity,
  {
    readonly executionId: string | null;
    readonly baseLedgerSha: LedgerIdentity;
    readonly changes: readonly DocEventMutation[];
    readonly retirementReason?: string;
  }
>;

export type CurrentDocEventV1 = EventEnvelope<
  "doc-event/v1",
  "documents_written",
  ActorIdentity,
  {
    readonly executionId: string | null;
    readonly baseLedgerSha: LedgerCutIdentity;
    readonly changes: readonly DocEventMutation[];
    readonly retirementReason?: string;
  }
>;

export type CanonicalEventV1 =
  | TaskEventV1
  | DocEventV1
  | AgentRuntimeEventV1
  | EntityEventV1
  | TaskBootstrapEventV1
  | TaskProgressEventV1
  | PresetSnapshotUpgradeEventV1
  | FactEventV1
  | DecisionEventV1
  | MigrationImportEventV1
  | LedgerLayoutMigrationEventV1;

export interface DocumentState {
  readonly path: PortableDocumentPath;
  readonly blobSha256: string;
  readonly body: string;
  readonly size: DocByteLength;
  readonly mediaType: string;
  readonly policyId: string;
  readonly workspaceRevision: number;
}

export interface DocContentBlob {
  readonly sha256: string;
  readonly size: DocByteLength;
  readonly mediaType: string;
  readonly body: string;
}

export interface DocWriteDecisionInput {
  readonly intent: DocWriteIntent;
  readonly opId: string;
  readonly eventId: string;
  readonly workspaceRevision: number;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly occurredAt: string;
  readonly currentLedgerSha: LedgerCutIdentity;
  readonly lease: LeaseV1 | null;
  /** Decision evaluated by the daemon AuthorizationPort for execution-bound writes. */
  readonly authorizationDecision: AuthorizationDecision | null;
  readonly runtimeBinding?: TaskBoundRuntimeBinding;
  readonly documents: readonly (DocumentState | null)[];
  readonly claims: readonly (Uint8Array | null)[];
  readonly resolvedTaskIds?: readonly (string | null)[];
  readonly retirementReason?: string;
}

export type DocWriteDecision =
  | {
      readonly accepted: true;
      readonly event: CurrentDocEventV1;
      readonly blobs: readonly DocContentBlob[];
      readonly plan: FrozenWritePlan<"DocSyncSubmit">;
      readonly authorizationDecision: AuthorizationDecision | null;
    }
  | {
      readonly accepted: false;
      readonly code: string;
      readonly detail: DocSyncReceiptDetail;
      readonly authorizationDecision: AuthorizationDecision | null;
    };
