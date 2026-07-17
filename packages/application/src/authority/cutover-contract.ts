import { createHash } from "node:crypto";
import { encodeCanonicalCbor, type CanonicalCborValue } from "./canonical-cbor.ts";
import type { ProtocolSchemaTupleV2 } from "./actor-axes-binding-v2.ts";
import type { AuthorityProtocolTuple, RecordedAuthorityProtocol } from "./types.ts";
import { entityRegistryKinds } from "../../../kernel/src/index.ts";

export const authorityCutoverControlStateSchema = "authority-cutover-control/v1" as const;
export const authorityCutoverDrainReceiptSchema = "authority-cutover-drain-receipt/v1" as const;
export const authorityCutoverScanReceiptSchema = "authority-cutover-scan-receipt/v1" as const;
export const authorityCutoverEqualityReceiptSchema = "authority-cutover-equality-receipt/v1" as const;
export const authorityCutoverBoundaryReceiptSchema = "authority-cutover-boundary-receipt/v1" as const;
export const authorityCutoverFreezeReceiptSchema = "authority-cutover-freeze-receipt/v1" as const;
export const authorityCutoverReenableReceiptSchema = "authority-cutover-reenable-receipt/v1" as const;

export type AuthorityCutoverPhase = "ACTIVE" | "DRAINING" | "DRAINED" | "BOUNDARY_ACTIVE" | "WRITES_FROZEN";
export type AuthorityPendingDisposition = "retryable-not-committed" | "indeterminate";
export type AuthorityCutoverEntityKind = (typeof entityRegistryKinds)[number];
export type AuthorityCutoverRegistryFacet = "identityCodec" | "storageLocator" | "mutationContract" | "semanticDiff" | "projectionFacet";

export interface AuthorityCutoverRegistryQualificationRow {
  readonly kind: AuthorityCutoverEntityKind;
  readonly facets: {
    readonly identityCodec: "ready";
    readonly storageLocator: "ready";
    readonly mutationContract: "ready";
    readonly semanticDiff: "ready" | "typed-only";
    readonly projectionFacet: "ready";
  };
  readonly mutationActions: ReadonlyArray<string>;
}

export interface AuthorityCutoverEntityRegistryQualification {
  readonly schema: "authority-cutover-entity-registry-qualification/v1";
  readonly registryVersion: 1;
  readonly requiredKinds: ReadonlyArray<AuthorityCutoverEntityKind>;
  readonly requiredFacets: ReadonlyArray<AuthorityCutoverRegistryFacet>;
  readonly rows: ReadonlyArray<AuthorityCutoverRegistryQualificationRow>;
  readonly matrixCellCount: number;
  readonly qualificationDigest: string;
}

export interface AuthorityPendingClassification {
  readonly opId: string;
  readonly disposition: AuthorityPendingDisposition;
  readonly recordedTupleDigest: string;
  readonly evidenceRef: string;
}

export interface AuthorityCutoverControlState {
  readonly schema: typeof authorityCutoverControlStateSchema;
  readonly repoId: string;
  readonly workspaceId: string;
  readonly selectedSchemaTupleDigest: string;
  readonly phase: AuthorityCutoverPhase;
  readonly admission: "open" | "closed";
  readonly classifications: ReadonlyArray<AuthorityPendingClassification>;
  readonly v1FreshWriterRetired: boolean;
  readonly boundary?: AuthorityCutoverBoundaryReceipt;
  readonly freezeReceipt?: AuthorityCutoverFreezeReceipt;
  readonly reenableReceipt?: AuthorityCutoverReenableReceipt;
  readonly lastDrainReceiptId?: string;
  readonly lastScanId?: string;
  readonly lastEqualityReceiptId?: string;
  readonly updatedAt: string;
}

export interface AuthorityProductionRepoScan {
  readonly schema: "authority-production-repo-scan/v1";
  readonly headCommit: string;
  readonly headTree: string;
  readonly indexDigest: string;
  readonly workingTreeDigest: string;
  readonly rawLocal: {
    readonly kind: "missing" | "symlink" | "directory" | "file" | "other";
    readonly mode: number | null;
    readonly targetDigest: string | null;
    readonly treeDigest: string | null;
  };
}

export interface AuthorityCutoverScanSnapshot {
  readonly schema: "authority-cutover-scan-snapshot/v1";
  readonly profileId: "production-final-scan/v1";
  readonly repoId: string;
  readonly workspaceId: string;
  readonly selectedSchemaTupleDigest: string;
  readonly phase: "DRAINED" | "WRITES_FROZEN";
  readonly admission: "closed";
  readonly pendingOperationCount: number;
  readonly operationSnapshotDigest: string;
  readonly configurationDigest: string;
  readonly entityRegistryQualification: AuthorityCutoverEntityRegistryQualification;
  readonly barrier: {
    readonly schema: "authority-write-fence-observation/v1";
    readonly status: "HELD";
  };
  readonly writerInventory: {
    readonly schema: "authority-production-writer-inventory/v1";
    readonly source: "production-authority-lifecycle/v1";
    readonly authorityId: string;
    readonly configuredAuthorityCount: 1;
    readonly configuredFreshWriters: ReadonlyArray<{
      readonly protocol: "authority-operation/v1" | "semantic-mutation-envelope/v2";
      readonly state: "disabled" | "retired" | "admission-closed";
    }>;
  };
  readonly legacyFreshWriterRetired: boolean;
  readonly repository: AuthorityProductionRepoScan;
}

export interface AuthorityCutoverScanReceipt {
  readonly schema: typeof authorityCutoverScanReceiptSchema;
  readonly scanId: string;
  readonly scanSequence: number;
  readonly canonicalDigest: string;
  readonly snapshot: AuthorityCutoverScanSnapshot;
  readonly recordedAt: string;
}

export interface AuthorityCutoverEqualityReceipt {
  readonly schema: typeof authorityCutoverEqualityReceiptSchema;
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly status: "DOUBLE_FINAL_SCAN_PASS" | "FINAL_SCAN_MISMATCH";
  readonly firstScanId: string;
  readonly secondScanId: string;
  readonly canonicalDigest: string | null;
  readonly recordedAt: string;
}

export interface AuthorityCutoverBoundaryReceipt {
  readonly schema: typeof authorityCutoverBoundaryReceiptSchema;
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly status: "BOUNDARY_ACTIVE";
  readonly boundaryId: string;
  readonly equalityReceiptId: string;
  readonly equalityReceiptDigest: string;
  readonly finalScanDigest: string;
  readonly entityRegistryQualificationDigest: string;
  readonly boundaryHeadCommit: string;
  readonly selectedSchemaTupleDigest: string;
  readonly retiredLegacyTuple: AuthorityProtocolTuple;
  readonly retiredLegacyTupleDigest: string;
  readonly v1FreshWriterRetired: true;
  readonly retainedV1ReadOnly: true;
  readonly admission: "open";
  readonly recordedAt: string;
}

export interface AuthorityCutoverFreezeReceipt {
  readonly schema: typeof authorityCutoverFreezeReceiptSchema;
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly status: "CONTAINED_WRITES_FROZEN";
  readonly boundaryId: string;
  readonly boundaryReceiptDigest: string;
  readonly reason: string;
  readonly minimumReenableScanSequence: number;
  readonly v1FreshWriterRestored: false;
  readonly unionReadRetained: true;
  readonly admission: "closed";
  readonly recordedAt: string;
}

export interface AuthorityCutoverReenableReceipt {
  readonly schema: typeof authorityCutoverReenableReceiptSchema;
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly status: "V2_ADMISSION_REENABLED";
  readonly boundaryId: string;
  readonly freezeReceiptDigest: string;
  readonly equalityReceiptId: string;
  readonly forwardFixRef: string;
  readonly v1FreshWriterRestored: false;
  readonly admission: "open";
  readonly recordedAt: string;
}

export interface AuthorityCutoverDrainReceipt {
  readonly schema: typeof authorityCutoverDrainReceiptSchema;
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly repoId: string;
  readonly workspaceId: string;
  readonly status: "DRAINED" | "BLOCKED_UNCLASSIFIED_OPERATIONS";
  readonly admission: "closed";
  readonly selectedSchemaTupleDigest: string;
  readonly operationSnapshotDigest: string;
  readonly terminalOperationIds: ReadonlyArray<string>;
  readonly classifications: ReadonlyArray<AuthorityPendingClassification>;
  readonly unclassifiedOperationIds: ReadonlyArray<string>;
  readonly recordedAt: string;
}

export interface AuthorityCutoverStateStore {
  readonly get: <Value>(key: string) => Value | undefined;
  readonly put: (key: string, value: unknown) => void;
  readonly entries: <Value>() => ReadonlyArray<readonly [string, Value]>;
}

export interface AuthorityCutoverControlService {
  readonly status: () => AuthorityCutoverControlState;
  readonly runDuringOpenAdmission: <Value>(operation: () => Promise<Value>) => Promise<Value>;
  readonly drain: (input: { readonly classifications: ReadonlyArray<AuthorityPendingClassification> }) => Promise<AuthorityCutoverDrainReceipt>;
  readonly scan: (input: { readonly profileId: "production-final-scan/v1" }) => Promise<AuthorityCutoverScanReceipt>;
  readonly confirmEquality: (input: { readonly firstScanId: string; readonly secondScanId: string }) => AuthorityCutoverEqualityReceipt;
  readonly activateBoundary: (input: { readonly boundaryId: string; readonly equalityReceiptId: string; readonly expectedSelectedSchemaTupleDigest: string }) => AuthorityCutoverBoundaryReceipt;
  readonly freeze: (input: { readonly reason: string; readonly expectedBoundaryReceiptDigest: string }) => AuthorityCutoverFreezeReceipt;
  readonly reEnable: (input: { readonly boundaryId: string; readonly expectedFreezeReceiptDigest: string; readonly equalityReceiptId: string; readonly forwardFixRef: string }) => AuthorityCutoverReenableReceipt;
}

export function protocolSchemaTupleDigest(tuple: ProtocolSchemaTupleV2): string {
  return cutoverContractCborDigest("ha/protocol-schema-tuple/v2\0", tuple as unknown as CanonicalCborValue);
}

export function authorityProtocolTupleDigest(tuple: AuthorityProtocolTuple): string {
  return cutoverContractCborDigest("ha/authority-protocol-tuple/v1\0", tuple as unknown as CanonicalCborValue);
}

export function recordedProtocolTupleDigest(protocol: RecordedAuthorityProtocol | undefined): string | undefined {
  if (!protocol) return undefined;
  return protocol.kind === "semantic-mutation-envelope/v2"
    ? protocolSchemaTupleDigest(protocol.schemaTuple)
    : authorityProtocolTupleDigest(protocol.schemaTuple);
}

export function cutoverContractCborDigest(domain: string, value: CanonicalCborValue): string {
  return createHash("sha256").update(domain, "utf8").update(encodeCanonicalCbor(value)).digest("hex");
}

export function requireCutoverContractText(value: string, name: string): string {
  if (!value || value.trim() !== value || value.includes("\0")) throw new Error(`AUTHORITY_CUTOVER_FIELD_INVALID:${name}`);
  return value;
}

export function requireCutoverContractDigest(value: string, name: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`AUTHORITY_CUTOVER_FIELD_INVALID:${name}`);
  return value;
}
