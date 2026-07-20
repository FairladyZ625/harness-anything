import { isCompleteAuthorityCommittedReceiptV2, type AuthorityCommittedReceipt } from "../authority/index.ts";
import { isRecord } from "../record.ts";
import { compoundReceiptPhases } from "./types.ts";
import { assertHistoricalExcludedSetWitnessV1 } from "./witness-v1.ts";
import {
  compoundReceiptV2Schema,
  type CompoundOperationReceiptV2,
  type ImmutableReceiptAcknowledgementV2
} from "./v2-types.ts";

const authorityTags = ["COMMITTED", "REJECTED", "RETRYABLE_NOT_COMMITTED", "INDETERMINATE"] as const;
const originTags = ["APPLIED_EXACT_AT_CUT", "SUPERSEDED", "LOCAL_CONFLICT", "APPLY_BLOCKED", "NONQUIESCENT", "VIEW_UNAVAILABLE"] as const;
const deliveryStates = ["PENDING", "RESULT_PREPARED", "ACK_COMMITTED", "DETACHED", "PROTOCOL_DAMAGED"] as const;
const leaseStates = ["NOT_REQUESTED", "SATISFIED", "REVOKED"] as const;

export function isCompoundOperationReceiptV2(value: unknown): value is CompoundOperationReceiptV2 {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schema", "workspaceId", "viewId", "opId", "waiterId", "resultTokenDigest", "phase",
      "delivery", "pinReleaseEligible", "currentLease", "sequence", "updatedAt"
    ], [
      "authority", "origin", "originPin", "terminalLSN", "acknowledgement",
      "machineId", "daemonGeneration", "runtimeRegistrationId", "connectionId", "leaseGeneration", "errorCode"
    ])
    || value.schema !== compoundReceiptV2Schema
    || !requiredStringsV2(value, ["workspaceId", "viewId", "opId", "waiterId", "resultTokenDigest", "updatedAt"])
    || !hexDigest(value.resultTokenDigest)
    || !includes(compoundReceiptPhases, value.phase)
    || !includes(deliveryStates, value.delivery)
    || !includes(leaseStates, value.currentLease)
    || typeof value.pinReleaseEligible !== "boolean"
    || !uintReceiptV2(value.sequence)
    || !validTerminalGenerationAxesV2(value)) return false;
  if (value.authority !== undefined && !validAuthorityV2(value.authority, value)) return false;
  if (value.origin !== undefined && !validOriginV2(value.origin, value)) return false;
  if (value.originPin !== undefined && !validOriginPin(value.originPin, value.origin)) return false;
  if (value.acknowledgement !== undefined && !validAcknowledgementV2(value.acknowledgement, value)) return false;
  if (value.acknowledgement !== undefined && !acknowledgementMatchesReceipt(value)) return false;
  if (value.terminalLSN !== undefined && !uintReceiptV2(value.terminalLSN)) return false;
  if ((value.delivery === "ACK_COMMITTED" || value.delivery === "DETACHED") !== value.pinReleaseEligible) return false;
  if (value.delivery === "DETACHED" && (value.terminalLSN === undefined || value.acknowledgement !== undefined)) return false;
  if (value.delivery !== "ACK_COMMITTED" && value.delivery !== "DETACHED" && value.terminalLSN !== undefined) return false;
  if ((value.delivery === "RESULT_PREPARED" || value.delivery === "ACK_COMMITTED")
    && !completeAuthorityReceiptV2(value.authority)) return false;
  if (value.phase === "PENDING") return value.origin === undefined && value.originPin === undefined
    && value.acknowledgement === undefined && value.delivery !== "ACK_COMMITTED";
  if (!isRecord(value.authority) || value.authority.tag !== "COMMITTED") return false;
  if (value.phase === "COMMITTED") return (!isRecord(value.origin) || value.origin.tag !== "APPLIED_EXACT_AT_CUT")
    && value.acknowledgement === undefined && value.delivery !== "ACK_COMMITTED";
  if (!isRecord(value.origin) || value.origin.tag !== "APPLIED_EXACT_AT_CUT"
    || !validOriginPin(value.originPin, value.origin)) return false;
  if (value.phase === "APPLIED_EXACT_AT_CUT") return value.acknowledgement === undefined && value.delivery !== "ACK_COMMITTED";
  return value.delivery === "ACK_COMMITTED" && value.pinReleaseEligible && isRecord(value.acknowledgement)
    && value.terminalLSN === value.acknowledgement.terminalLSN;
}

function validOriginPin(pin: unknown, origin: unknown): boolean {
  return isRecord(pin) && exactKeys(pin, ["state", "cutId", "witnessDigest"], [])
    && pin.state === "PINNED" && isRecord(origin) && origin.tag === "APPLIED_EXACT_AT_CUT"
    && pin.cutId === origin.cutId && pin.witnessDigest === origin.witnessDigest;
}

function validAuthorityV2(authority: unknown, receipt: Record<string, unknown>): boolean {
  if (!isRecord(authority) || !includes(authorityTags, authority.tag)
    || !requiredStringsV2(authority, ["workspaceId", "opId", "semanticDigest"])
    || authority.workspaceId !== receipt.workspaceId || authority.opId !== receipt.opId) return false;
  if (authority.tag === "COMMITTED") {
    return exactKeys(authority, [
      "tag", "workspaceId", "opId", "semanticDigest", "revision", "commitSha", "previousCommit"
    ], ["authorityIntegrity", "integrityTuple"])
      && uintReceiptV2(authority.revision) && typeof authority.commitSha === "string"
      && (authority.previousCommit === null || typeof authority.previousCommit === "string");
  }
  const required = ["tag", "workspaceId", "opId", "semanticDigest", "reason"];
  const optional = authority.tag === "INDETERMINATE" ? ["commitSha"] : [];
  return exactKeys(authority, required, optional) && typeof authority.reason === "string"
    && (authority.commitSha === undefined || typeof authority.commitSha === "string");
}

function validOriginV2(origin: unknown, receipt: Record<string, unknown>): boolean {
  if (!isRecord(origin) || !includes(originTags, origin.tag)
    || origin.viewId !== receipt.viewId || origin.opId !== receipt.opId) return false;
  if (origin.tag === "SUPERSEDED") return exactKeys(origin, [
    "tag", "viewId", "opId", "committedVersion", "visibleVersion"
  ], []) && uintReceiptV2(origin.committedVersion) && uintReceiptV2(origin.visibleVersion);
  if (origin.tag === "LOCAL_CONFLICT") return exactKeys(origin, ["tag", "viewId", "opId", "conflictIds"], [])
    && stringArrayV2(origin.conflictIds);
  if (origin.tag === "APPLY_BLOCKED") return exactKeys(origin, ["tag", "viewId", "opId", "reasons"], [])
    && stringArrayV2(origin.reasons);
  if (origin.tag === "NONQUIESCENT") return exactKeys(origin, ["tag", "viewId", "opId", "writerSetReason"], [])
    && typeof origin.writerSetReason === "string" && origin.writerSetReason.length > 0;
  if (origin.tag === "VIEW_UNAVAILABLE") return exactKeys(origin, ["tag", "viewId", "opId", "reason"], [])
    && typeof origin.reason === "string" && origin.reason.length > 0;
  if (!exactKeys(origin, [
    "tag", "viewId", "opId", "version", "cutId", "cutKind", "cutJournalLSN",
    "verifiedAffectedDigest", "witness", "witnessDigest"
  ], ["writerExclusionId"]) || origin.cutKind !== "WRITE_EXCLUDED" || !requiredStringsV2(origin, [
    "cutId", "verifiedAffectedDigest", "witnessDigest"
  ]) || !uintReceiptV2(origin.version) || !uintReceiptV2(origin.cutJournalLSN) || !isRecord(origin.witness)) return false;
  try {
    assertHistoricalExcludedSetWitnessV1(origin.witness as never);
  } catch {
    return false;
  }
  return origin.witnessDigest === origin.witness.canonicalWitnessDigest
    && origin.cutId === origin.witness.cutId
    && origin.version === origin.witness.revision
    && origin.cutJournalLSN === origin.witness.cutJournalLSN
    && origin.verifiedAffectedDigest === origin.witness.affectedDigest
    && origin.writerExclusionId === origin.witness.writerExclusionId;
}

function validAcknowledgementV2(value: unknown, receipt: Record<string, unknown>): value is ImmutableReceiptAcknowledgementV2 {
  if (!isRecord(value) || !exactKeys(value, [
    "viewId", "workspaceId", "opId", "epochToken", "revision", "commitSha", "canonicalEventDigest",
    "changeSetDigest", "semanticMutationSetDigest", "actorAxesBindingDigest", "affectedDigest",
    "cutId", "cutKind", "cutJournalLSN", "witnessDigest", "waiterId", "preparedSequence",
    "preparedReceiptDigest", "terminalLSN"
  ], ["writerExclusionId"]) || !requiredStringsV2(value, [
    "viewId", "workspaceId", "opId", "epochToken", "commitSha", "canonicalEventDigest",
    "changeSetDigest", "semanticMutationSetDigest", "actorAxesBindingDigest", "affectedDigest",
    "cutId", "cutKind", "witnessDigest", "waiterId", "preparedReceiptDigest"
  ]) || value.viewId !== receipt.viewId || value.workspaceId !== receipt.workspaceId
    || value.opId !== receipt.opId || value.waiterId !== receipt.waiterId) return false;
  return ["revision", "cutJournalLSN", "preparedSequence", "terminalLSN"].every((field) => uintReceiptV2(value[field]))
    && ["canonicalEventDigest", "changeSetDigest", "semanticMutationSetDigest", "actorAxesBindingDigest", "witnessDigest", "preparedReceiptDigest"]
      .every((field) => hexDigest(value[field]));
}

function acknowledgementMatchesReceipt(receipt: Record<string, unknown>): boolean {
  const acknowledgement = receipt.acknowledgement;
  const authority = receipt.authority;
  const origin = receipt.origin;
  if (!isRecord(acknowledgement) || !completeAuthorityReceiptV2(authority)
    || !isRecord(origin) || origin.tag !== "APPLIED_EXACT_AT_CUT" || !isRecord(origin.witness)) return false;
  return acknowledgement.revision === authority.revision
    && acknowledgement.commitSha === authority.commitSha
    && acknowledgement.canonicalEventDigest === authority.integrityTuple.canonicalEventDigest
    && acknowledgement.changeSetDigest === authority.integrityTuple.changeSetDigest
    && acknowledgement.semanticMutationSetDigest === authority.integrityTuple.semanticMutationSetDigest
    && acknowledgement.actorAxesBindingDigest === authority.integrityTuple.actorAxesBindingDigest
    && acknowledgement.epochToken === origin.witness.epochToken
    && acknowledgement.affectedDigest === origin.verifiedAffectedDigest
    && acknowledgement.cutId === origin.cutId
    && acknowledgement.cutKind === origin.cutKind
    && acknowledgement.cutJournalLSN === origin.cutJournalLSN
    && acknowledgement.witnessDigest === origin.witnessDigest
    && acknowledgement.writerExclusionId === origin.writerExclusionId;
}

function completeAuthorityReceiptV2(value: unknown): value is AuthorityCommittedReceipt & {
  readonly authorityIntegrity: NonNullable<AuthorityCommittedReceipt["authorityIntegrity"]>;
  readonly integrityTuple: NonNullable<AuthorityCommittedReceipt["integrityTuple"]>;
} {
  return isRecord(value) && value.tag === "COMMITTED"
    && isCompleteAuthorityCommittedReceiptV2(value as unknown as AuthorityCommittedReceipt);
}

function requiredStringsV2(value: Record<string, unknown>, fields: ReadonlyArray<string>): boolean {
  return fields.every((field) => typeof value[field] === "string" && (value[field] as string).length > 0);
}

function uintReceiptV2(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hexDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function includes<const Values extends readonly string[]>(values: Values, value: unknown): value is Values[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string>
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function stringArrayV2(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

function validTerminalGenerationAxesV2(value: Record<string, unknown>): boolean {
  for (const field of ["machineId", "runtimeRegistrationId", "connectionId", "errorCode"] as const) {
    if (value[field] !== undefined && (typeof value[field] !== "string" || value[field].length === 0)) return false;
  }
  for (const field of ["daemonGeneration", "leaseGeneration"] as const) {
    if (value[field] !== undefined && (!uintReceiptV2(value[field]) || Number(value[field]) < 1)) return false;
  }
  return true;
}
