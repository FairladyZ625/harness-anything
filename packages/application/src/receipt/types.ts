import type { AuthorityOperationReceipt } from "../authority/index.ts";

export const compoundReceiptSchema = "compound-operation-receipt/v1" as const;

export const compoundReceiptPhases = [
  "PENDING",
  "COMMITTED",
  "APPLIED_EXACT_AT_CUT",
  "ACK_COMMITTED"
] as const;

export type CompoundReceiptPhase = typeof compoundReceiptPhases[number];

export interface ReceiptIdentity {
  readonly workspaceId: string;
  readonly viewId: string;
  readonly opId: string;
  readonly waiterId: string;
  readonly resultToken: string;
}

export interface AppliedExactAtCut {
  readonly tag: "APPLIED_EXACT_AT_CUT";
  readonly viewId: string;
  readonly opId: string;
  readonly version: number;
  readonly cutId: string;
  readonly cutKind: "ATOMIC_SINGLE_PATH" | "WRITE_EXCLUDED";
  readonly cutJournalLSN: number;
  readonly verifiedAffectedDigest: string;
  readonly writerExclusionId?: string;
}

export interface SupersededOrigin {
  readonly tag: "SUPERSEDED";
  readonly viewId: string;
  readonly opId: string;
  readonly committedVersion: number;
  readonly visibleVersion: number;
}

export interface LocalConflictOrigin {
  readonly tag: "LOCAL_CONFLICT";
  readonly viewId: string;
  readonly opId: string;
  readonly conflictIds: ReadonlyArray<string>;
}

export interface ApplyBlockedOrigin {
  readonly tag: "APPLY_BLOCKED";
  readonly viewId: string;
  readonly opId: string;
  readonly reasons: ReadonlyArray<string>;
}

export interface NonquiescentOrigin {
  readonly tag: "NONQUIESCENT";
  readonly viewId: string;
  readonly opId: string;
  readonly writerSetReason: string;
}

export interface ViewUnavailableOrigin {
  readonly tag: "VIEW_UNAVAILABLE";
  readonly viewId: string;
  readonly opId: string;
  readonly reason: string;
}

export type OriginResolution =
  | AppliedExactAtCut
  | SupersededOrigin
  | LocalConflictOrigin
  | ApplyBlockedOrigin
  | NonquiescentOrigin
  | ViewUnavailableOrigin;

export type ReceiptDeliveryState =
  | "PENDING"
  | "RESULT_PREPARED"
  | "ACK_COMMITTED"
  | "DETACHED"
  | "PROTOCOL_DAMAGED";

export type CurrentLeaseState = "NOT_REQUESTED" | "SATISFIED" | "REVOKED";

export interface ImmutableReceiptAcknowledgement {
  readonly viewId: string;
  readonly workspaceId: string;
  readonly opId: string;
  readonly epoch: number;
  readonly revision: number;
  readonly commitSha: string;
  readonly canonicalEventDigest: string;
  readonly affectedDigest: string;
  readonly cutId: string;
  readonly cutKind: AppliedExactAtCut["cutKind"];
  readonly cutJournalLSN: number;
  readonly writerExclusionId?: string;
  readonly waiterId: string;
  readonly terminalLSN: number;
}

export interface CompoundOperationReceipt extends ReceiptIdentity {
  readonly schema: typeof compoundReceiptSchema;
  readonly phase: CompoundReceiptPhase;
  readonly authority?: AuthorityOperationReceipt;
  readonly origin?: OriginResolution;
  readonly delivery: ReceiptDeliveryState;
  readonly terminalLSN?: number;
  readonly acknowledgement?: ImmutableReceiptAcknowledgement;
  readonly currentLease: CurrentLeaseState;
  readonly sequence: number;
  readonly updatedAt: string;
}

export interface CompoundReceiptStore {
  readonly get: (identity: ReceiptIdentity) => Promise<CompoundOperationReceipt | undefined>;
  readonly create: (receipt: CompoundOperationReceipt) => Promise<CompoundOperationReceipt>;
  readonly compareAndSet: (
    identity: ReceiptIdentity,
    expectedSequence: number,
    receipt: CompoundOperationReceipt
  ) => Promise<boolean>;
}

export interface CompoundReceiptService {
  readonly initialize: (identity: ReceiptIdentity) => Promise<CompoundOperationReceipt>;
  readonly recordAuthority: (identity: ReceiptIdentity, receipt: AuthorityOperationReceipt) => Promise<CompoundOperationReceipt>;
  readonly recordOrigin: (identity: ReceiptIdentity, origin: OriginResolution) => Promise<CompoundOperationReceipt>;
  readonly prepareResult: (identity: ReceiptIdentity) => Promise<CompoundOperationReceipt>;
  readonly commitAcknowledgement: (
    identity: ReceiptIdentity,
    acknowledgement: ImmutableReceiptAcknowledgement
  ) => Promise<CompoundOperationReceipt>;
  readonly detach: (identity: ReceiptIdentity, reason: string) => Promise<CompoundOperationReceipt>;
  readonly markProtocolDamaged: (identity: ReceiptIdentity, reason: string) => Promise<CompoundOperationReceipt>;
  readonly setCurrentLease: (identity: ReceiptIdentity, state: CurrentLeaseState) => Promise<CompoundOperationReceipt>;
}

export class CompoundReceiptTransitionError extends Error {
  readonly code = "COMPOUND_RECEIPT_TRANSITION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "CompoundReceiptTransitionError";
  }
}
