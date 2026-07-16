import type { CompoundOperationReceipt } from "./types.ts";
import { isCompoundOperationReceiptV2 } from "./validation-v2.ts";
import type { CompoundOperationReceiptV2 } from "./v2-types.ts";

export const compoundExitCodes = {
  COMMITTED_APPLIED: 0,
  NOT_COMMITTED: 20,
  COMMITTED_LOCAL_CONFLICT: 21,
  COMMITTED_APPLY_BLOCKED: 22,
  AUTHORITY_INDETERMINATE: 23,
  NOT_COMMITTED_RETRYABLE: 24,
  RESYNC_OR_UPGRADE_REQUIRED: 25,
  COMMITTED_SUPERSEDED: 26,
  COMMITTED_VIEW_UNAVAILABLE: 27,
  LOCAL_BUSY_UNSENT: 28,
  INTERNAL_ERROR: 1,
  USAGE_ERROR: 2
} as const;

export type CompoundExitSymbol = keyof typeof compoundExitCodes;
export type CompoundExitCode = typeof compoundExitCodes[CompoundExitSymbol];

export interface CompoundExitDefinition {
  readonly code: CompoundExitCode;
  readonly symbol: CompoundExitSymbol;
  readonly meaning: string;
  readonly detectionCondition: string;
  readonly nextAction: string;
}

export const compoundExitDefinitions = {
  COMMITTED_APPLIED: definition("COMMITTED_APPLIED", "Canonical effect committed, applied exactly at the named historical cut, and delivery acknowledgment committed.", "V2 COMMITTED integrity tuple + canonical exact witness + durable ACK_COMMITTED", "Do not retry."),
  NOT_COMMITTED: definition("NOT_COMMITTED", "The authority terminally rejected the operation or found a base conflict.", "Authority REJECTED", "Correct the request and submit with a new opId."),
  COMMITTED_LOCAL_CONFLICT: definition("COMMITTED_LOCAL_CONFLICT", "The canonical effect committed, but the origin view has a local conflict.", "COMMITTED + LOCAL_CONFLICT", "Resolve locally; never resubmit this op."),
  COMMITTED_APPLY_BLOCKED: definition("COMMITTED_APPLY_BLOCKED", "The canonical effect committed, but local apply or required quiescence is blocked.", "COMMITTED + APPLY_BLOCKED or NONQUIESCENT", "Repair or quiesce, then reapply the receipt; never resubmit this op."),
  AUTHORITY_INDETERMINATE: definition("AUTHORITY_INDETERMINATE", "Authority continuity cannot prove the canonical outcome.", "Authority INDETERMINATE", "Use operator recovery; do not automatically replay."),
  NOT_COMMITTED_RETRYABLE: definition("NOT_COMMITTED_RETRYABLE", "The authority proved that no canonical effect occurred.", "Authority RETRYABLE_NOT_COMMITTED", "Retry the same opId and exact request."),
  RESYNC_OR_UPGRADE_REQUIRED: definition("RESYNC_OR_UPGRADE_REQUIRED", "A protocol or schema gate proved the request was not sent.", "Locally proven unsent protocol/schema incompatibility", "Resync or upgrade before retrying."),
  COMMITTED_SUPERSEDED: definition("COMMITTED_SUPERSEDED", "The canonical effect committed, but its exact origin revision is no longer presentable.", "COMMITTED + SUPERSEDED", "Refresh and review; never resubmit this op."),
  COMMITTED_VIEW_UNAVAILABLE: definition("COMMITTED_VIEW_UNAVAILABLE", "The canonical effect committed, but the origin view detached before delivery.", "COMMITTED + VIEW_UNAVAILABLE or durable detach", "Reattach or materialize; never resubmit this op."),
  LOCAL_BUSY_UNSENT: definition("LOCAL_BUSY_UNSENT", "The local scheduler proved the request was not sent and returned a ticket or lease.", "Scheduler-proven unsent request", "Retry the same opId and exact ticket/request, or cancel/expire before obtaining a new ticket."),
  INTERNAL_ERROR: definition("INTERNAL_ERROR", "The effect or delivery outcome is not safely classified.", "Missing proof, pending delivery, or protocol-integrity failure", "Query the opId and waiter first; resync when instructed."),
  USAGE_ERROR: definition("USAGE_ERROR", "The invocation is invalid and the request was not sent.", "Invalid invocation proven unsent", "Correct the invocation.")
} as const satisfies Record<CompoundExitSymbol, CompoundExitDefinition>;

export type CompoundExitInput =
  | { readonly kind: "RECEIPT"; readonly receipt: CompoundOperationReceipt | CompoundOperationReceiptV2 }
  | { readonly kind: "RESYNC_OR_UPGRADE_REQUIRED" }
  | { readonly kind: "LOCAL_BUSY_UNSENT" }
  | { readonly kind: "INTERNAL_ERROR" }
  | { readonly kind: "USAGE_ERROR" };

export function classifyCompoundExit(input: CompoundExitInput): CompoundExitDefinition {
  if (input.kind !== "RECEIPT") return compoundExitDefinitions[input.kind];
  const receipt = input.receipt;
  const authority = receipt.authority;
  if (!authority) return compoundExitDefinitions.INTERNAL_ERROR;
  if (authority.tag === "REJECTED") return compoundExitDefinitions.NOT_COMMITTED;
  if (authority.tag === "RETRYABLE_NOT_COMMITTED") return compoundExitDefinitions.NOT_COMMITTED_RETRYABLE;
  if (authority.tag === "INDETERMINATE") return compoundExitDefinitions.AUTHORITY_INDETERMINATE;
  if (receipt.delivery === "PROTOCOL_DAMAGED") return compoundExitDefinitions.INTERNAL_ERROR;
  if (receipt.delivery === "DETACHED") return compoundExitDefinitions.COMMITTED_VIEW_UNAVAILABLE;
  if (receipt.origin?.tag === "LOCAL_CONFLICT") return compoundExitDefinitions.COMMITTED_LOCAL_CONFLICT;
  if (receipt.origin?.tag === "APPLY_BLOCKED" || receipt.origin?.tag === "NONQUIESCENT") {
    return compoundExitDefinitions.COMMITTED_APPLY_BLOCKED;
  }
  if (receipt.origin?.tag === "SUPERSEDED") return compoundExitDefinitions.COMMITTED_SUPERSEDED;
  if (receipt.origin?.tag === "VIEW_UNAVAILABLE") return compoundExitDefinitions.COMMITTED_VIEW_UNAVAILABLE;
  if (isCompoundOperationReceiptV2(receipt)
    && receipt.origin?.tag === "APPLIED_EXACT_AT_CUT"
    && receipt.origin.witnessDigest === receipt.origin.witness.canonicalWitnessDigest
    && receipt.phase === "ACK_COMMITTED"
    && receipt.delivery === "ACK_COMMITTED"
    && receipt.terminalLSN !== undefined
    && receipt.acknowledgement?.terminalLSN === receipt.terminalLSN) {
    return compoundExitDefinitions.COMMITTED_APPLIED;
  }
  return compoundExitDefinitions.INTERNAL_ERROR;
}

function definition(
  symbol: CompoundExitSymbol,
  meaning: string,
  detectionCondition: string,
  nextAction: string
): CompoundExitDefinition {
  return { code: compoundExitCodes[symbol], symbol, meaning, detectionCondition, nextAction };
}
