import { stableStringify } from "../integrity/stable-hash.ts";
import {
  normalizeRelativeDocumentPath,
  type PortableDocumentPath,
} from "../layout/portable-path.ts";
import {
  isOpaqueTextualMediaType,
  OPAQUE_TEXTUAL_POLICY_ID,
} from "./artifact-text-classification.ts";
import { DOC_CODEC_ID, DOC_POLICY_ID } from "./doc-sync-types.ts";
import { MIGRATION_DOCUMENT_POLICY_ID } from "./migration-import-event.ts";
import type {
  LedgerCutIdentity,
  LedgerIdentity,
} from "./receipt-domain-registry.ts";
import {
  hasOnlyFields,
  hasRequiredFields,
  isNonEmptyString,
  isRecord,
  validateEventEnvelopeIdentity,
  type WriteSource,
} from "./write-chain.contract.ts";

import { docClaimRef } from "./doc-sync-codec.ts";

export function validateDocEvent(value: unknown): readonly string[] {
  return validateDocEventIdentity(value, ledgerIdentity, true);
}

export function validateCurrentDocEvent(value: unknown): readonly string[] {
  return validateDocEventIdentity(value, ledgerCutIdentity, false);
}

function validateDocEventIdentity(
  value: unknown,
  identity: (candidate: unknown, allowUnknownFields: boolean) => boolean,
  allowUnknownFields: boolean,
): readonly string[] {
  const hasFields = allowUnknownFields ? hasRequiredFields : hasOnlyFields;
  if (
    !isRecord(value) ||
    !hasFields(value, [
      "schema",
      "eventId",
      "workspaceRevision",
      "opId",
      "type",
      "actor",
      "source",
      "occurredAt",
      "payload",
    ]) ||
    value.schema !== "doc-event/v1" ||
    value.type !== "documents_written" ||
    !isRecord(value.payload)
  )
    return ["doc event envelope or payload is invalid"];
  const payloadFields =
    value.payload.retirementReason === undefined
      ? ["executionId", "baseLedgerSha", "changes"]
      : ["executionId", "baseLedgerSha", "changes", "retirementReason"];
  if (
    !hasFields(value.payload, payloadFields) ||
    (value.payload.executionId !== null &&
      !isNonEmptyString(value.payload.executionId)) ||
    !identity(value.payload.baseLedgerSha, allowUnknownFields) ||
    !Array.isArray(value.payload.changes) ||
    value.payload.changes.length === 0
  )
    return ["doc event envelope or payload is invalid"];
  if (validateEventEnvelopeIdentity(value, allowUnknownFields).length)
    return ["doc event envelope identity is invalid"];
  const retirements = value.payload.changes.filter(
      (change) => isRecord(change) && change.candidate === null,
    ),
    validRetirement =
      retirements.length === 0
        ? value.payload.retirementReason === undefined
        : retirements.length === 1 &&
          value.payload.changes.length === 1 &&
          value.payload.executionId === null &&
          isNonEmptyString(value.payload.retirementReason),
    valid = value.payload.changes.every((change) =>
      validDocEventMutation(change, allowUnknownFields),
    ),
    paths = value.payload.changes.map((change) =>
      isRecord(change) ? change.path : null,
    );
  return validRetirement && valid && new Set(paths).size === paths.length
    ? []
    : ["doc event change is invalid"];
}

export function validDocSyncClaim(value: unknown): boolean {
  if (value === null) return true;
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, ["ref", "sha256", "size", "mediaType"]) ||
    !validDocSyncStoredClaim(value, false, true)
  )
    return false;
  try {
    docClaimRef(String(value.ref));
    return true;
  } catch {
    return false;
  }
}

function validDocSyncStoredClaim(
  value: unknown,
  allowUnknownFields = false,
  includesRef = false,
): boolean {
  return (
    isRecord(value) &&
    (allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, [
      ...(includesRef ? ["ref"] : []),
      "sha256",
      "size",
      "mediaType",
    ]) &&
    /^[0-9a-f]{64}$/u.test(String(value.sha256)) &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) >= 0 &&
    (value.mediaType === "text/markdown" ||
      value.mediaType === "text/plain" ||
      isOpaqueTextualMediaType(value.mediaType))
  );
}

function validRegionProof(
  value: unknown,
  allowUnknownFields: boolean,
): boolean {
  return (
    isRecord(value) &&
    (allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, [
      "regionId",
      "policyId",
      "codecId",
      "baseSha256",
      "candidateSha256",
      "insertBytes",
    ]) &&
    isNonEmptyString(value.regionId) &&
    value.policyId === DOC_POLICY_ID &&
    value.codecId === DOC_CODEC_ID &&
    [value.baseSha256, value.candidateSha256].every(
      (hash) => typeof hash === "string" && /^[0-9a-f]{64}$/u.test(hash),
    ) &&
    Number.isInteger(value.insertBytes) &&
    (value.insertBytes as number) >= 0
  );
}

function validDocEventMutation(
  value: unknown,
  allowUnknownFields: boolean,
): boolean {
  if (!isRecord(value)) return false;
  const fields =
      value.policyUpgrade === undefined
        ? ["path", "baseBlobSha256", "candidate", "policyId", "regionProofs"]
        : [
            "path",
            "baseBlobSha256",
            "candidate",
            "policyId",
            "regionProofs",
            "policyUpgrade",
          ],
    hasFields = allowUnknownFields ? hasRequiredFields : hasOnlyFields;
  if (
    !hasFields(value, fields) ||
    !safeDocSyncPath(value.path) ||
    !nullableBlobSha(value.baseBlobSha256) ||
    !Array.isArray(value.regionProofs)
  )
    return false;
  if (value.candidate === null)
    return (
      typeof value.baseBlobSha256 === "string" &&
      isNonEmptyString(value.policyId) &&
      value.regionProofs.length === 0 &&
      value.policyUpgrade === undefined
    );
  return (
    validDocSyncStoredClaim(value.candidate, allowUnknownFields) &&
    ((value.policyId === DOC_POLICY_ID &&
      policyMatchesClaim(value.policyId, value.candidate) &&
      value.regionProofs.length > 0 &&
      value.regionProofs.every((proof) =>
        validRegionProof(proof, allowUnknownFields),
      ) &&
      (value.policyUpgrade === undefined ||
        validPolicyUpgrade(value.policyUpgrade, allowUnknownFields))) ||
      (value.policyId === OPAQUE_TEXTUAL_POLICY_ID &&
        value.regionProofs.length === 0 &&
        value.policyUpgrade === undefined &&
        policyMatchesClaim(value.policyId, value.candidate)))
  );
}

export function validDocEventChange(
  value: unknown,
  allowUnknownFields: boolean,
): boolean {
  return validDocEventMutation(value, allowUnknownFields);
}

function validPolicyUpgrade(
  value: unknown,
  allowUnknownFields: boolean,
): boolean {
  return (
    isRecord(value) &&
    (allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, [
      "from",
      "to",
    ]) &&
    value.from === MIGRATION_DOCUMENT_POLICY_ID &&
    value.to === DOC_POLICY_ID
  );
}

export function commitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function ledgerIdentity(
  value: unknown,
  allowUnknownFields: boolean,
): value is LedgerIdentity {
  return (
    ledgerCutIdentity(value, allowUnknownFields) ||
    (isRecord(value) &&
      (allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, [
        "repoId",
        "sha",
      ]) &&
      /^[a-z][a-z0-9-]{0,62}$/u.test(String(value.repoId)) &&
      commitSha(value.sha))
  );
}

export function ledgerCutIdentity(
  value: unknown,
  allowUnknownFields = false,
): value is LedgerCutIdentity {
  return (
    isRecord(value) &&
    (allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, [
      "repoId",
      "revision",
      "headDigest",
    ]) &&
    /^[a-z][a-z0-9-]{0,62}$/u.test(String(value.repoId)) &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    typeof value.headDigest === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(value.headDigest)
  );
}

export function nullableBlobSha(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" && /^[0-9a-f]{64}$/u.test(value))
  );
}

export function safeDocSyncPath(value: unknown): value is string {
  try {
    return (
      typeof value === "string" &&
      normalizeRelativeDocumentPath(value) === value
    );
  } catch {
    return false;
  }
}

export function policyMatchesClaim(
  policyId: string,
  candidate: unknown,
): boolean {
  return (
    isRecord(candidate) &&
    (policyId === DOC_POLICY_ID
      ? candidate.mediaType === "text/markdown" ||
        candidate.mediaType === "text/plain"
      : policyId === OPAQUE_TEXTUAL_POLICY_ID &&
        isOpaqueTextualMediaType(candidate.mediaType))
  );
}

export function sameWriteChannel(
  left: WriteSource,
  right: WriteSource,
): boolean {
  return stableStringify(left) === stableStringify(right);
}

export function taskFromPath(value: PortableDocumentPath): string | null {
  const match = /^tasks\/([^/]+)\//u.exec(value);
  if (!match) return null;
  const folder = match[1]!;
  return /^task_[0-9A-HJKMNP-TV-Z]{26}(?:-|$)/u.test(folder)
    ? folder.slice(0, 31)
    : folder;
}

export function taskArtifactPath(value: PortableDocumentPath): boolean {
  return /^tasks\/[^/]+\/artifacts\/.+/u.test(value);
}
