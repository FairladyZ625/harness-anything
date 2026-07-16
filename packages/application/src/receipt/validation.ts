import {
  compoundReceiptPhases,
  compoundReceiptSchema,
  type CompoundOperationReceipt,
  type ImmutableReceiptAcknowledgement,
  type OriginResolution
} from "./types.ts";
import {
  isCompleteAuthorityCommittedReceiptV2,
  type AuthorityCommittedReceipt
} from "../authority/index.ts";
import { isRecord } from "../record.ts";

const authorityTags = ["COMMITTED", "REJECTED", "RETRYABLE_NOT_COMMITTED", "INDETERMINATE"] as const;
const originTags = ["APPLIED_EXACT_AT_CUT", "SUPERSEDED", "LOCAL_CONFLICT", "APPLY_BLOCKED", "NONQUIESCENT", "VIEW_UNAVAILABLE"] as const;
const deliveryStates = ["PENDING", "RESULT_PREPARED", "ACK_COMMITTED", "DETACHED", "PROTOCOL_DAMAGED"] as const;
const leaseStates = ["NOT_REQUESTED", "SATISFIED", "REVOKED"] as const;

export function isCompoundOperationReceipt(value: unknown): value is CompoundOperationReceipt {
  if (!isRecord(value)
    || value.schema !== compoundReceiptSchema
    || !requiredStrings(value, ["workspaceId", "viewId", "opId", "waiterId", "resultToken", "updatedAt"])
    || !includes(compoundReceiptPhases, value.phase)
    || !includes(deliveryStates, value.delivery)
    || !includes(leaseStates, value.currentLease)
    || !nonNegativeInteger(value.sequence)) return false;

  const authority = value.authority;
  const origin = value.origin;
  const acknowledgement = value.acknowledgement;
  if (authority !== undefined && !validAuthority(authority, value)) return false;
  if (origin !== undefined && !validOrigin(origin, value)) return false;
  if (acknowledgement !== undefined && !validAcknowledgement(acknowledgement, value)) return false;
  if (value.terminalLSN !== undefined && !nonNegativeInteger(value.terminalLSN)) return false;
  if ((value.delivery === "RESULT_PREPARED" || value.delivery === "ACK_COMMITTED")
    && !completeAuthority(authority)) return false;

  if (value.phase === "PENDING") return origin === undefined && acknowledgement === undefined && value.delivery !== "ACK_COMMITTED";
  if (!isRecord(authority) || authority.tag !== "COMMITTED") return false;
  if (value.phase === "COMMITTED") return (!isRecord(origin) || origin.tag !== "APPLIED_EXACT_AT_CUT") && acknowledgement === undefined && value.delivery !== "ACK_COMMITTED";
  if (!isRecord(origin) || origin.tag !== "APPLIED_EXACT_AT_CUT") return false;
  if (value.phase === "APPLIED_EXACT_AT_CUT") return acknowledgement === undefined && value.delivery !== "ACK_COMMITTED";
  return value.delivery === "ACK_COMMITTED"
    && isRecord(acknowledgement)
    && value.terminalLSN === acknowledgement.terminalLSN;
}

function validAuthority(authority: unknown, receipt: Record<string, unknown>): boolean {
  return isRecord(authority)
    && includes(authorityTags, authority.tag)
    && requiredStrings(authority, ["workspaceId", "opId", "semanticDigest"])
    && authority.workspaceId === receipt.workspaceId
    && authority.opId === receipt.opId;
}

function validOrigin(origin: unknown, receipt: Record<string, unknown>): origin is OriginResolution {
  if (!isRecord(origin)
    || !includes(originTags, origin.tag)
    || origin.viewId !== receipt.viewId
    || origin.opId !== receipt.opId) return false;
  if (origin.tag === "APPLIED_EXACT_AT_CUT") {
    return requiredStrings(origin, ["cutId", "cutKind", "verifiedAffectedDigest"])
      && (origin.cutKind === "ATOMIC_SINGLE_PATH" || origin.cutKind === "WRITE_EXCLUDED")
      && nonNegativeInteger(origin.version)
      && nonNegativeInteger(origin.cutJournalLSN);
  }
  return true;
}

function validAcknowledgement(
  acknowledgement: unknown,
  receipt: Record<string, unknown>
): acknowledgement is ImmutableReceiptAcknowledgement {
  if (!isRecord(acknowledgement)
    || !requiredStrings(acknowledgement, ["viewId", "workspaceId", "opId", "commitSha", "canonicalEventDigest", "affectedDigest", "cutId", "cutKind", "waiterId"])
    || acknowledgement.viewId !== receipt.viewId
    || acknowledgement.workspaceId !== receipt.workspaceId
    || acknowledgement.opId !== receipt.opId
    || acknowledgement.waiterId !== receipt.waiterId
    || !completeAuthority(receipt.authority)
    || acknowledgement.canonicalEventDigest !== receipt.authority.integrityTuple.canonicalEventDigest) return false;
  return ["epoch", "revision", "cutJournalLSN", "terminalLSN"].every((field) => nonNegativeInteger(acknowledgement[field]));
}

function completeAuthority(value: unknown): value is AuthorityCommittedReceipt & {
  readonly authorityIntegrity: NonNullable<AuthorityCommittedReceipt["authorityIntegrity"]>;
  readonly integrityTuple: NonNullable<AuthorityCommittedReceipt["integrityTuple"]>;
} {
  return isRecord(value)
    && value.tag === "COMMITTED"
    && isCompleteAuthorityCommittedReceiptV2(value as unknown as AuthorityCommittedReceipt);
}

function requiredStrings(value: Record<string, unknown>, fields: ReadonlyArray<string>): boolean {
  return fields.every((field) => typeof value[field] === "string" && (value[field] as string).length > 0);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function includes<const Values extends readonly string[]>(values: Values, value: unknown): value is Values[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
