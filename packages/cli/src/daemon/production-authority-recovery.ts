import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AuthorityCommittedReceipt,
  AuthorityOperationRegistry,
  AuthorityStoredOperationRecord,
  ReplicaChangeLog
} from "../../../application/src/index.ts";
import type { makeLocalAuthorityAttributionEventV2Log } from "../../../kernel/src/index.ts";
import {
  assertPublicationMatchesMutationSet,
  AuthorityCanonicalPublicationNotFoundError,
  AuthorityRecoveryWatermarkInvalidError,
  type GitCanonicalPublicationInspector
} from "./authority-publication-evidence.ts";

interface ProductionRecoveryInput {
  readonly workspaceId: string;
  readonly operationRegistry: AuthorityOperationRegistry;
  readonly replicaChangeLog: ReplicaChangeLog;
  readonly eventLog: ReturnType<typeof makeLocalAuthorityAttributionEventV2Log>;
  readonly publicationInspector: GitCanonicalPublicationInspector;
  readonly recover: (record: AuthorityStoredOperationRecord) => Promise<AuthorityCommittedReceipt>;
  readonly watermarkPath?: string;
  readonly onDeferred?: (record: AuthorityStoredOperationRecord, error: unknown) => Promise<void>;
}

export async function recoverPendingProductionEvents(input: ProductionRecoveryInput): Promise<void> {
  if (input.watermarkPath && typeof input.publicationInspector.scanFirstParentOperationAnchors === "function") {
    await recoverIncrementally(input, input.watermarkPath);
    return;
  }
  await recoverByOperationLookup(input);
}

async function recoverIncrementally(input: ProductionRecoveryInput, watermarkPath: string): Promise<void> {
  const records = await input.operationRegistry.list(input.workspaceId);
  const pending = records.filter(isRecoverablePendingRecord);
  const interestedOpIds = new Set(pending.map((record) => record.opId));
  const storedWatermark = readRecoveryWatermark(watermarkPath, input.workspaceId);
  let scan;
  try {
    scan = await input.publicationInspector.scanFirstParentOperationAnchors({
      ...(storedWatermark ? { exclusiveCommit: storedWatermark } : {}),
      interestedOpIds
    });
  } catch (error) {
    if (!(error instanceof AuthorityRecoveryWatermarkInvalidError)) throw error;
    scan = await input.publicationInspector.scanFirstParentOperationAnchors({ interestedOpIds });
  }
  const anchorsByOpId = new Map<string, typeof scan.anchors>();
  for (const anchor of scan.anchors) {
    for (const opId of anchor.opIds) {
      if (!interestedOpIds.has(opId)) continue;
      const known = anchorsByOpId.get(opId) ?? [];
      anchorsByOpId.set(opId, [...known, anchor]);
    }
  }
  const scanOrder = new Map(scan.anchors.map((anchor, index) => [anchor.commitSha, index]));
  const ordered = [...pending].sort((left, right) => {
    const leftIndex = scanOrder.get(anchorsByOpId.get(left.opId)?.[0]?.commitSha ?? "") ?? -1;
    const rightIndex = scanOrder.get(anchorsByOpId.get(right.opId)?.[0]?.commitSha ?? "") ?? -1;
    return rightIndex - leftIndex || left.opId.localeCompare(right.opId);
  });
  for (const record of ordered) {
    const anchors = anchorsByOpId.get(record.opId) ?? [];
    if (anchors.length === 0) {
      if (record.state === "INDETERMINATE" && !record.commitSha) {
        await terminalizeConfirmedAbsent(input.operationRegistry, record);
      } else {
        await input.onDeferred?.(record, new AuthorityCanonicalPublicationNotFoundError(record.opId));
      }
      continue;
    }
    if (anchors.length !== 1) {
      await input.onDeferred?.(record, new Error(
        `AUTHORITY_CANONICAL_PUBLICATION_NOT_UNIQUE:expectedOpId=${record.opId};matches=${anchors.map((anchor) => anchor.commitSha).join(",")}`
      ));
      continue;
    }
    const anchor = anchors[0]!;
    try {
      const evidence = await input.publicationInspector.inspectPublication(
        anchor.previousCommit,
        anchor.opIds,
        anchor.commitSha
      );
      await recoverPublishedRecord(input, record, evidence);
    } catch (error) {
      await input.onDeferred?.(record, error);
    }
  }
  const unsettled = (await input.operationRegistry.list(input.workspaceId)).filter(isUnsettledV2Record);
  if (unsettled.length === 0 && scan.headCommit) {
    writeRecoveryWatermark(watermarkPath, input.workspaceId, scan.headCommit);
  }
}

async function recoverByOperationLookup(input: ProductionRecoveryInput): Promise<void> {
  const records = await input.operationRegistry.list(input.workspaceId);
  let remaining = records.filter(isRecoverablePendingRecord);
  while (remaining.length > 0) {
    let progressed = false;
    const deferred: typeof remaining = [];
    for (const record of remaining) {
      try {
        const evidence = await input.publicationInspector.findPublicationForOperation(record.opId);
        await recoverPublishedRecord(input, record, evidence);
        progressed = true;
      } catch (error) {
        if (error instanceof AuthorityCanonicalPublicationNotFoundError
          && error.opId === record.opId
          && record.state === "INDETERMINATE"
          && !record.commitSha) {
          await terminalizeConfirmedAbsent(input.operationRegistry, record);
          progressed = true;
          continue;
        }
        await input.onDeferred?.(record, error);
        deferred.push(record);
      }
    }
    if (!progressed) return;
    remaining = deferred;
  }
}

async function recoverPublishedRecord(
  input: ProductionRecoveryInput,
  record: AuthorityStoredOperationRecord,
  evidence: Awaited<ReturnType<GitCanonicalPublicationInspector["inspectPublication"]>>
): Promise<void> {
  if (record.commitSha && record.commitSha !== evidence.commitSha) {
    throw new Error("AUTHORITY_V2_RECOVERY_COMMIT_MISMATCH");
  }
  assertPublicationMatchesMutationSet(evidence, record.authorityIntegrity!.canonicalMutationSet);
  const change = await input.replicaChangeLog.getByOperation(record.workspaceId, record.opId);
  if (change && (change.commitSha !== evidence.commitSha
    || change.previousCommit !== evidence.previousCommit
    || change.semanticDigest !== record.semanticDigest
    || change.authorityIntegrity?.semanticMutationSetDigest !== record.authorityIntegrity!.semanticMutationSetDigest)) {
    throw new Error("AUTHORITY_V2_RECOVERY_CHANGE_MISMATCH");
  }
  const indexed = { ...record, state: "INDEXED" as const, commitSha: evidence.commitSha };
  await input.operationRegistry.put(indexed);
  const receipt = await input.recover(indexed);
  await input.operationRegistry.put({ ...indexed, state: "COMMITTED", receipt, commitSha: receipt.commitSha });
}

async function terminalizeConfirmedAbsent(
  operationRegistry: AuthorityOperationRegistry,
  record: AuthorityStoredOperationRecord
): Promise<void> {
  const originalReason = record.receipt?.tag === "INDETERMINATE"
    ? record.receipt.reason
    : "missing indeterminate receipt reason";
  const receipt = {
    tag: "REJECTED" as const,
    workspaceId: record.workspaceId,
    opId: record.opId,
    semanticDigest: record.semanticDigest,
    reason: `AUTHORITY_RECOVERY_CONFIRMED_NOT_PUBLISHED:originalReason=${originalReason}`
  };
  await operationRegistry.put({ ...record, state: "REJECTED", receipt });
}

function isRecoverablePendingRecord(record: AuthorityStoredOperationRecord): boolean {
  return (record.state === "INDEXED" || record.state === "INDETERMINATE")
    && record.recordedProtocol?.kind === "semantic-mutation-envelope/v2"
    && Boolean(record.authorityIntegrity)
    && Boolean(record.canonicalRequestEnvelope);
}

function isUnsettledV2Record(record: AuthorityStoredOperationRecord): boolean {
  return record.recordedProtocol?.kind === "semantic-mutation-envelope/v2"
    && record.state !== "COMMITTED"
    && record.state !== "REJECTED"
    && record.state !== "RETRYABLE_NOT_COMMITTED";
}

function readRecoveryWatermark(filePath: string, workspaceId: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return parsed.schema === "authority-recovery-watermark/v1"
      && parsed.workspaceId === workspaceId
      && typeof parsed.commitSha === "string"
      && /^[a-f0-9]{40}$/u.test(parsed.commitSha)
      ? parsed.commitSha
      : undefined;
  } catch {
    return undefined;
  }
}

function writeRecoveryWatermark(filePath: string, workspaceId: string, commitSha: string): void {
  const body = `${JSON.stringify({
    schema: "authority-recovery-watermark/v1",
    workspaceId,
    commitSha,
    scannedAt: new Date().toISOString()
  })}\n`;
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const file = openSync(temporaryPath, "wx", 0o600);
  try {
    writeSync(file, body);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporaryPath, filePath);
  if (process.platform === "win32") return;
  const directory = openSync(path.dirname(filePath), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function recoveryErrorSummary(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function recoveryErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "AUTHORITY_RECOVERY_UNKNOWN_ERROR";
  const messageCode = /^([A-Z][A-Z0-9_]+)/u.exec(error.message)?.[1];
  return messageCode ?? error.name;
}
