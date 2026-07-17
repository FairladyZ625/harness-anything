import type { CanonicalCborValue } from "./canonical-cbor.ts";
import type { AuthorityStoredOperationRecord } from "./types.ts";
import {
  authorityCutoverControlStateSchema,
  authorityCutoverEqualityReceiptSchema,
  authorityCutoverScanReceiptSchema,
  cutoverContractCborDigest,
  recordedProtocolTupleDigest,
  requireCutoverContractDigest,
  requireCutoverContractText,
  type AuthorityCutoverControlState,
  type AuthorityCutoverEqualityReceipt,
  type AuthorityCutoverScanReceipt,
  type AuthorityCutoverStateStore,
  type AuthorityPendingClassification,
  type AuthorityProductionRepoScan
} from "./cutover-contract.ts";
import { validateAuthorityCutoverEntityRegistryQualification } from "./cutover-registry-qualification.ts";

export function equalityReceipt(store: AuthorityCutoverStateStore, receiptId: string): AuthorityCutoverEqualityReceipt {
  const receipt = store.get<AuthorityCutoverEqualityReceipt>(`receipt:${requireCutoverContractText(receiptId, "equalityReceiptId")}`);
  if (receipt?.schema !== authorityCutoverEqualityReceiptSchema
    || receipt.status !== "DOUBLE_FINAL_SCAN_PASS"
    || !receipt.canonicalDigest
    || !equalityReceiptDigestMatches(receipt)) throw new Error("AUTHORITY_CUTOVER_EQUALITY_RECEIPT_INVALID");
  return receipt;
}

export function scanReceipt(store: AuthorityCutoverStateStore, scanId: string): AuthorityCutoverScanReceipt {
  const receipt = store.get<AuthorityCutoverScanReceipt>(`scan:${requireCutoverContractText(scanId, "scanId")}`);
  if (!validScanReceipt(receipt)) throw new Error("AUTHORITY_CUTOVER_SCAN_RECEIPT_NOT_FOUND");
  return receipt;
}

export function validateProductionRepoScan(value: AuthorityProductionRepoScan): void {
  if (value.schema !== "authority-production-repo-scan/v1"
    || !/^[0-9a-f]{40,64}$/u.test(value.headCommit)
    || !/^[0-9a-f]{40,64}$/u.test(value.headTree)
    || !/^[0-9a-f]{64}$/u.test(value.indexDigest)
    || !/^[0-9a-f]{64}$/u.test(value.workingTreeDigest)
    || !["missing", "symlink", "directory", "file", "other"].includes(value.rawLocal.kind)
    || (value.rawLocal.kind === "missing"
      ? value.rawLocal.mode !== null || value.rawLocal.targetDigest !== null || value.rawLocal.treeDigest !== null
      : !Number.isInteger(value.rawLocal.mode) || !/^[0-9a-f]{64}$/u.test(value.rawLocal.treeDigest ?? ""))
    || (value.rawLocal.kind === "symlink"
      ? !/^[0-9a-f]{64}$/u.test(value.rawLocal.targetDigest ?? "")
      : value.rawLocal.targetDigest !== null)) {
    throw new Error("AUTHORITY_CUTOVER_PRODUCTION_SCAN_INVALID");
  }
}

export function validScanReceipt(value: AuthorityCutoverScanReceipt | undefined): value is AuthorityCutoverScanReceipt {
  const basic = value?.schema === authorityCutoverScanReceiptSchema
    && typeof value.scanId === "string"
    && /^[0-9a-f]{64}$/u.test(value.canonicalDigest)
    && cutoverContractCborDigest("ha/authority-cutover-final-scan/v1\0", value.snapshot as unknown as CanonicalCborValue) === value.canonicalDigest;
  if (!basic) return false;
  try {
    validateAuthorityCutoverEntityRegistryQualification(value.snapshot.entityRegistryQualification);
    return true;
  } catch {
    return false;
  }
}

export function validateClassification(
  classification: AuthorityPendingClassification,
  record: AuthorityStoredOperationRecord
): void {
  const expectedDigest = recordedProtocolTupleDigest(record.recordedProtocol);
  if (!expectedDigest) throw new Error(`AUTHORITY_CUTOVER_RECORDED_TUPLE_REQUIRED:${record.opId}`);
  if (classification.recordedTupleDigest !== expectedDigest) {
    throw new Error(`AUTHORITY_CUTOVER_RECORDED_TUPLE_MISMATCH:${record.opId}`);
  }
  if (!classification.evidenceRef.trim()) throw new Error(`AUTHORITY_CUTOVER_CLASSIFICATION_EVIDENCE_REQUIRED:${record.opId}`);
  if ((record.state === "PUBLISHED" || record.state === "INDEXED") && classification.disposition !== "indeterminate") {
    throw new Error(`AUTHORITY_CUTOVER_PUBLISHED_OPERATION_MUST_BE_INDETERMINATE:${record.opId}`);
  }
  if (classification.disposition !== "retryable-not-committed" && classification.disposition !== "indeterminate") {
    throw new Error(`AUTHORITY_CUTOVER_CLASSIFICATION_INVALID:${record.opId}`);
  }
}

export function normalizedClassification(input: AuthorityPendingClassification): AuthorityPendingClassification {
  return {
    opId: requireCutoverContractText(input.opId, "classification.opId"),
    disposition: input.disposition,
    recordedTupleDigest: requireCutoverContractDigest(input.recordedTupleDigest, "classification.recordedTupleDigest"),
    evidenceRef: requireCutoverContractText(input.evidenceRef, "classification.evidenceRef")
  };
}

export function operationSnapshot(record: AuthorityStoredOperationRecord): Record<string, CanonicalCborValue> {
  return {
    workspaceId: record.workspaceId,
    opId: record.opId,
    semanticDigest: record.semanticDigest,
    state: record.state,
    recordedTupleDigest: recordedProtocolTupleDigest(record.recordedProtocol) ?? null,
    commitSha: record.commitSha ?? null
  };
}

export function validateRecoveredState(
  candidate: AuthorityCutoverControlState,
  expected: AuthorityCutoverControlState
): AuthorityCutoverControlState {
  const validPhaseState = (candidate.phase === "ACTIVE" && candidate.admission === "open" && !candidate.v1FreshWriterRetired && !candidate.boundary)
    || ((candidate.phase === "DRAINING" || candidate.phase === "DRAINED") && candidate.admission === "closed" && !candidate.v1FreshWriterRetired && !candidate.boundary)
    || (candidate.phase === "BOUNDARY_ACTIVE" && candidate.admission === "open" && candidate.v1FreshWriterRetired && candidate.boundary?.status === "BOUNDARY_ACTIVE")
    || (candidate.phase === "WRITES_FROZEN" && candidate.admission === "closed" && candidate.v1FreshWriterRetired && candidate.boundary?.status === "BOUNDARY_ACTIVE" && candidate.freezeReceipt?.status === "CONTAINED_WRITES_FROZEN");
  if (candidate.schema !== authorityCutoverControlStateSchema
    || candidate.repoId !== expected.repoId
    || candidate.workspaceId !== expected.workspaceId
    || candidate.selectedSchemaTupleDigest !== expected.selectedSchemaTupleDigest
    || !["ACTIVE", "DRAINING", "DRAINED", "BOUNDARY_ACTIVE", "WRITES_FROZEN"].includes(candidate.phase)
    || (candidate.admission !== "open" && candidate.admission !== "closed")
    || typeof candidate.v1FreshWriterRetired !== "boolean"
    || !Array.isArray(candidate.classifications)
    || !validPhaseState) {
    throw new Error("AUTHORITY_CUTOVER_DURABLE_STATE_INVALID");
  }
  return structuredClone(candidate);
}

function equalityReceiptDigestMatches(receipt: AuthorityCutoverEqualityReceipt): boolean {
  const body = {
    schema: receipt.schema,
    status: receipt.status,
    firstScanId: receipt.firstScanId,
    secondScanId: receipt.secondScanId,
    canonicalDigest: receipt.canonicalDigest,
    recordedAt: receipt.recordedAt
  };
  const expected = cutoverContractCborDigest("ha/authority-cutover-equality-receipt/v1\0", body as unknown as CanonicalCborValue);
  return receipt.receiptDigest === expected && receipt.receiptId === `equality_${expected.slice(0, 24)}`;
}
