import type { AuthorityOperationReceipt } from "../authority/index.ts";
import type { OriginResolution, CompoundReceiptPhase, CurrentLeaseState, ReceiptDeliveryState } from "./types.ts";
import type { HistoricalExcludedSetWitnessV1 } from "./witness-v1.ts";

export const compoundReceiptV2Schema = "compound-operation-receipt/v2" as const;
export const compoundTerminalJournalSchema = "compound-terminal-journal-entry/v1" as const;

export interface WaiterScope {
  readonly workspaceId: string;
  readonly viewId: string;
  readonly opId: string;
}

export interface ReceiptIdentityV2 extends WaiterScope {
  readonly waiterId: string;
}

export interface ReceiptCapabilityV2 extends ReceiptIdentityV2 {
  readonly resultToken: string;
}

export interface AppliedExactAtCutV2 {
  readonly tag: "APPLIED_EXACT_AT_CUT";
  readonly viewId: string;
  readonly opId: string;
  readonly version: number;
  readonly cutId: string;
  readonly cutKind: "WRITE_EXCLUDED";
  readonly cutJournalLSN: number;
  readonly verifiedAffectedDigest: string;
  readonly writerExclusionId?: string;
  readonly witness: HistoricalExcludedSetWitnessV1;
  readonly witnessDigest: string;
}

export type OriginResolutionV2 = AppliedExactAtCutV2 | Exclude<OriginResolution, { readonly tag: "APPLIED_EXACT_AT_CUT" }>;

export interface OriginPinV2 {
  readonly state: "PINNED";
  readonly cutId: string;
  readonly witnessDigest: string;
}

export interface ImmutableReceiptAcknowledgementV2 {
  readonly viewId: string;
  readonly workspaceId: string;
  readonly opId: string;
  readonly epochToken: string;
  readonly revision: number;
  readonly commitSha: string;
  readonly canonicalEventDigest: string;
  readonly changeSetDigest: string;
  readonly semanticMutationSetDigest: string;
  readonly actorAxesBindingDigest: string;
  readonly affectedDigest: string;
  readonly cutId: string;
  readonly cutKind: AppliedExactAtCutV2["cutKind"];
  readonly cutJournalLSN: number;
  readonly witnessDigest: string;
  readonly writerExclusionId?: string;
  readonly waiterId: string;
  readonly preparedSequence: number;
  readonly preparedReceiptDigest: string;
  readonly terminalLSN: number;
}

export interface CompoundOperationReceiptV2 extends ReceiptIdentityV2 {
  readonly schema: typeof compoundReceiptV2Schema;
  readonly resultTokenDigest: string;
  readonly phase: CompoundReceiptPhase;
  readonly authority?: AuthorityOperationReceipt;
  readonly origin?: OriginResolutionV2;
  readonly originPin?: OriginPinV2;
  readonly delivery: ReceiptDeliveryState;
  readonly pinReleaseEligible: boolean;
  readonly terminalLSN?: number;
  readonly acknowledgement?: ImmutableReceiptAcknowledgementV2;
  readonly currentLease: CurrentLeaseState;
  readonly sequence: number;
  readonly updatedAt: string;
}

export interface OpenedCompoundWaiterV2 {
  readonly identity: ReceiptIdentityV2;
  readonly resultToken: string;
  readonly receipt: CompoundOperationReceiptV2;
}

export interface DeliveryAcknowledgementInputV2 extends ReceiptCapabilityV2 {
  readonly preparedSequence: number;
  readonly preparedReceiptDigest: string;
}

export interface CompoundTerminalJournalEntry {
  readonly schema: typeof compoundTerminalJournalSchema;
  readonly terminalLSN: number;
  readonly workspaceId: string;
  readonly viewId: string;
  readonly opId: string;
  readonly waiterId: string;
  readonly kind: "ACK_COMMITTED" | "DETACHED";
  readonly pinReleaseEligible: true;
  readonly receiptSequence: number;
  readonly recordedAt: string;
  readonly preparedSequence?: number;
  readonly preparedReceiptDigest?: string;
  readonly reason?: string;
}

export type CompoundTerminalJournalDraft = Omit<CompoundTerminalJournalEntry, "terminalLSN" | "receiptSequence">;

export interface CompoundReceiptStoreV2 {
  readonly get: (identity: ReceiptIdentityV2) => Promise<CompoundOperationReceiptV2 | undefined>;
  readonly create: (receipt: CompoundOperationReceiptV2) => Promise<CompoundOperationReceiptV2>;
  readonly compareAndSet: (
    identity: ReceiptIdentityV2,
    expectedSequence: number,
    receipt: CompoundOperationReceiptV2
  ) => Promise<boolean>;
  /** Allocates terminalLSN and persists the journal entry and receipt in one crash boundary. */
  readonly commitTerminal: (
    identity: ReceiptIdentityV2,
    expectedSequence: number,
    draft: CompoundTerminalJournalDraft,
    buildReceipt: (terminalLSN: number) => CompoundOperationReceiptV2
  ) => Promise<CompoundOperationReceiptV2 | undefined>;
}

export interface CompoundReceiptServiceV2 {
  readonly openWaiter: (scope: WaiterScope) => Promise<OpenedCompoundWaiterV2>;
  readonly getWaiter: (capability: ReceiptCapabilityV2) => Promise<CompoundOperationReceiptV2 | undefined>;
  readonly recordAuthority: (identity: ReceiptIdentityV2, receipt: AuthorityOperationReceipt) => Promise<CompoundOperationReceiptV2>;
  readonly recordOrigin: (identity: ReceiptIdentityV2, origin: OriginResolutionV2) => Promise<CompoundOperationReceiptV2>;
  readonly prepareResult: (identity: ReceiptIdentityV2) => Promise<CompoundOperationReceiptV2>;
  readonly commitAcknowledgement: (input: DeliveryAcknowledgementInputV2) => Promise<CompoundOperationReceiptV2>;
  readonly detach: (identity: ReceiptIdentityV2, reason: string) => Promise<CompoundOperationReceiptV2>;
  readonly markProtocolDamaged: (identity: ReceiptIdentityV2, reason: string) => Promise<CompoundOperationReceiptV2>;
  readonly setCurrentLease: (identity: ReceiptIdentityV2, state: CurrentLeaseState) => Promise<CompoundOperationReceiptV2>;
}

export class CompoundReceiptProtocolError extends Error {
  readonly code = "COMPOUND_RECEIPT_PROTOCOL_INTEGRITY_FAILURE";

  constructor(message: string) {
    super(message);
    this.name = "CompoundReceiptProtocolError";
  }
}
