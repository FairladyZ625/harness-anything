// @slice-activation PLT-Boundary W2 exports daemon-owned production authority recovery to CLI composition consumers.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  AuthorityCommittedReceipt,
  AuthorityGenerationFence,
  AuthorityOperationRegistry,
  AuthorityStoredOperationRecord,
  ReplicaChangeLog
} from "@harness-anything/application";
import type { makeLocalAuthorityAttributionEventV2Log } from "@harness-anything/kernel";
import {
  assertPublicationMatchesMutationSet,
  AuthorityCanonicalPublicationNotFoundError,
  AuthorityRecoveryWatermarkInvalidError,
  type GitCanonicalPublicationInspector
} from "./publication-evidence.ts";

interface ProductionRecoveryInput {
  readonly workspaceId: string;
  readonly operationRegistry: AuthorityOperationRegistry;
  readonly replicaChangeLog: ReplicaChangeLog;
  readonly eventLog: ReturnType<typeof makeLocalAuthorityAttributionEventV2Log>;
  readonly publicationInspector: GitCanonicalPublicationInspector;
  readonly recover: (record: AuthorityStoredOperationRecord) => Promise<AuthorityCommittedReceipt>;
  readonly watermarkPath?: string;
  readonly onDeferred?: (record: AuthorityStoredOperationRecord, error: unknown) => Promise<void>;
  readonly generationFence?: AuthorityGenerationFence;
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
  const interestedOpIdsDigest = recoveryInterestDigest(interestedOpIds);
  const storedCheckpoint = readRecoveryWatermark(watermarkPath, input.workspaceId);
  const resumePartial = storedCheckpoint?.phase === "partial"
    && storedCheckpoint.interestedOpIdsDigest === interestedOpIdsDigest;
  const baseCommitSha = storedCheckpoint?.phase === "partial"
    ? storedCheckpoint.baseCommitSha
    : storedCheckpoint?.commitSha;
  const preferredCommitSha = resumePartial ? storedCheckpoint.commitSha : baseCommitSha;
  const attempts = [...new Set([preferredCommitSha, baseCommitSha, undefined])];
  let scan: Awaited<ReturnType<GitCanonicalPublicationInspector["scanFirstParentOperationAnchors"]>> | undefined;
  let retainedAnchors: ReadonlyArray<RecoveryWatermarkAnchor> = [];
  let retainedBaseCommitSha: string | undefined;
  for (const exclusiveCommit of attempts) {
    const priorAnchors = resumePartial && exclusiveCommit === preferredCommitSha
      ? storedCheckpoint.anchors
      : [];
    const progressAnchors = [...priorAnchors];
    const attemptBaseCommitSha = exclusiveCommit === undefined ? undefined : baseCommitSha;
    try {
      scan = await input.publicationInspector.scanFirstParentOperationAnchors({
        ...(exclusiveCommit ? { exclusiveCommit } : {}),
        interestedOpIds,
        onProgress: async (progress) => {
          progressAnchors.push(...progress.anchors);
          await persistPartialRecoveryWatermark(input, watermarkPath, {
            commitSha: progress.commitSha,
            ...(attemptBaseCommitSha ? { baseCommitSha: attemptBaseCommitSha } : {}),
            interestedOpIdsDigest,
            anchors: progressAnchors
          });
        }
      });
      retainedAnchors = priorAnchors;
      retainedBaseCommitSha = attemptBaseCommitSha;
      break;
    } catch (error) {
      if (!(error instanceof AuthorityRecoveryWatermarkInvalidError)) throw error;
    }
  }
  if (!scan) throw new Error("AUTHORITY_RECOVERY_SCAN_UNAVAILABLE");
  const allAnchors = [...retainedAnchors, ...scan.anchors];
  if (scan.headCommit) {
    await persistPartialRecoveryWatermark(input, watermarkPath, {
      commitSha: scan.headCommit,
      ...(retainedBaseCommitSha ? { baseCommitSha: retainedBaseCommitSha } : {}),
      interestedOpIdsDigest,
      anchors: allAnchors
    });
  }
  const anchorsByOpId = new Map<string, typeof scan.anchors>();
  for (const anchor of allAnchors) {
    for (const opId of anchor.opIds) {
      if (!interestedOpIds.has(opId)) continue;
      const known = anchorsByOpId.get(opId) ?? [];
      anchorsByOpId.set(opId, [...known, anchor]);
    }
  }
  const scanOrder = new Map(allAnchors.map((anchor, index) => [anchor.commitSha, index]));
  const ordered = [...pending].sort((left, right) => {
    const leftIndex = scanOrder.get(anchorsByOpId.get(left.opId)?.[0]?.commitSha ?? "") ?? -1;
    const rightIndex = scanOrder.get(anchorsByOpId.get(right.opId)?.[0]?.commitSha ?? "") ?? -1;
    return leftIndex - rightIndex || left.opId.localeCompare(right.opId);
  });
  for (const record of ordered) {
    const anchors = anchorsByOpId.get(record.opId) ?? [];
    if (anchors.length === 0) {
      if (record.state === "INDETERMINATE" && !record.commitSha) {
        await runTerminalRecovery(input, record, () => terminalizeConfirmedAbsent(input, record));
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
      await runTerminalRecovery(input, record, () => recoverPublishedRecord(input, record, evidence));
    } catch (error) {
      await input.onDeferred?.(record, error);
    }
  }
  const unsettled = (await input.operationRegistry.list(input.workspaceId)).filter(isUnsettledV2Record);
  if (unsettled.length === 0 && scan.headCommit) {
    const headCommit = scan.headCommit;
    await runTerminalRecovery(input, {
      workspaceId: input.workspaceId,
      opId: "authority-recovery-watermark"
    }, async () => {
      await assertRecoveryGeneration(input, { workspaceId: input.workspaceId, opId: "authority-recovery-watermark" });
      writeCompleteRecoveryWatermark(watermarkPath, input.workspaceId, headCommit);
    });
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
        await runTerminalRecovery(input, record, () => recoverPublishedRecord(input, record, evidence));
        progressed = true;
      } catch (error) {
        if (error instanceof AuthorityCanonicalPublicationNotFoundError
          && error.opId === record.opId
          && record.state === "INDETERMINATE"
          && !record.commitSha) {
          await runTerminalRecovery(input, record, () => terminalizeConfirmedAbsent(input, record));
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

function runTerminalRecovery<Result>(
  input: ProductionRecoveryInput,
  identity: { readonly workspaceId: string; readonly opId: string },
  recover: () => Promise<Result>
): Promise<Result> {
  return input.generationFence
    ? input.generationFence.runExclusive("before-terminal-journal", identity, recover)
    : recover();
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
  if (!change) {
    const latest = await input.replicaChangeLog.latest(record.workspaceId);
    await assertRecoveryGeneration(input, record);
    await input.replicaChangeLog.append({
      schema: "replica-change/v1",
      workspaceId: record.workspaceId,
      revision: (latest?.revision ?? 0) + 1,
      opId: record.opId,
      semanticDigest: record.semanticDigest,
      commitSha: evidence.commitSha,
      previousCommit: evidence.previousCommit,
      changedAt: new Date().toISOString(),
      authorityIntegrity: record.authorityIntegrity!
    });
  }
  const indexed = { ...record, state: "INDEXED" as const, commitSha: evidence.commitSha };
  await assertRecoveryGeneration(input, record);
  await input.operationRegistry.put(indexed);
  await assertRecoveryGeneration(input, record);
  const receipt = await input.recover(indexed);
  await assertRecoveryGeneration(input, record);
  await input.operationRegistry.put({ ...indexed, state: "COMMITTED", receipt, commitSha: receipt.commitSha });
}

async function terminalizeConfirmedAbsent(
  input: ProductionRecoveryInput,
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
  await assertRecoveryGeneration(input, record);
  await input.operationRegistry.put({ ...record, state: "REJECTED", receipt });
}

function assertRecoveryGeneration(
  input: ProductionRecoveryInput,
  identity: { readonly workspaceId: string; readonly opId: string }
): Promise<void> {
  return input.generationFence?.assertHeld("before-terminal-journal", identity) ?? Promise.resolve();
}

function isRecoverablePendingRecord(record: AuthorityStoredOperationRecord): boolean {
  return (record.state === "PREPARED" || record.state === "PUBLISHED"
      || record.state === "INDEXED" || record.state === "INDETERMINATE")
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

interface RecoveryWatermarkAnchor {
  readonly commitSha: string;
  readonly previousCommit: string;
  readonly opIds: ReadonlyArray<string>;
}

type RecoveryWatermark =
  | { readonly phase: "complete"; readonly commitSha: string }
  | {
    readonly phase: "partial";
    readonly commitSha: string;
    readonly baseCommitSha?: string;
    readonly interestedOpIdsDigest: string;
    readonly anchors: ReadonlyArray<RecoveryWatermarkAnchor>;
  };

function readRecoveryWatermark(filePath: string, workspaceId: string): RecoveryWatermark | undefined {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    if (parsed.schema === "authority-recovery-watermark/v1"
      && parsed.workspaceId === workspaceId
      && typeof parsed.commitSha === "string"
      && isCommitSha(parsed.commitSha)) {
      return { phase: "complete", commitSha: parsed.commitSha };
    }
    if (parsed.schema !== "authority-recovery-watermark/v2"
      || parsed.workspaceId !== workspaceId
      || parsed.phase !== "partial"
      || typeof parsed.commitSha !== "string"
      || !isCommitSha(parsed.commitSha)
      || (parsed.baseCommitSha !== undefined && (typeof parsed.baseCommitSha !== "string" || !isCommitSha(parsed.baseCommitSha)))
      || typeof parsed.interestedOpIdsDigest !== "string"
      || !/^[a-f0-9]{64}$/u.test(parsed.interestedOpIdsDigest)
      || !Array.isArray(parsed.anchors)) return undefined;
    const anchors = parsed.anchors.map(parseRecoveryWatermarkAnchor);
    if (anchors.some((anchor) => !anchor)) return undefined;
    return {
      phase: "partial",
      commitSha: parsed.commitSha,
      ...(typeof parsed.baseCommitSha === "string" ? { baseCommitSha: parsed.baseCommitSha } : {}),
      interestedOpIdsDigest: parsed.interestedOpIdsDigest,
      anchors: anchors as RecoveryWatermarkAnchor[]
    };
  } catch {
    return undefined;
  }
}

function parseRecoveryWatermarkAnchor(value: unknown): RecoveryWatermarkAnchor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const anchor = value as Record<string, unknown>;
  return typeof anchor.commitSha === "string"
    && isCommitSha(anchor.commitSha)
    && typeof anchor.previousCommit === "string"
    && isCommitSha(anchor.previousCommit)
    && Array.isArray(anchor.opIds)
    && anchor.opIds.every((opId) => typeof opId === "string")
    ? {
      commitSha: anchor.commitSha,
      previousCommit: anchor.previousCommit,
      opIds: anchor.opIds as string[]
    }
    : undefined;
}

function isCommitSha(value: string): boolean {
  return /^[a-f0-9]{40}$/u.test(value);
}

function recoveryInterestDigest(opIds: ReadonlySet<string>): string {
  return createHash("sha256").update([...opIds].sort().join("\0")).digest("hex");
}

function persistPartialRecoveryWatermark(
  input: ProductionRecoveryInput,
  filePath: string,
  watermark: Omit<Extract<RecoveryWatermark, { readonly phase: "partial" }>, "phase">
): Promise<void> {
  return runTerminalRecovery(input, {
    workspaceId: input.workspaceId,
    opId: "authority-recovery-watermark"
  }, async () => {
    await assertRecoveryGeneration(input, { workspaceId: input.workspaceId, opId: "authority-recovery-watermark" });
    writeRecoveryWatermark(filePath, {
      schema: "authority-recovery-watermark/v2",
      phase: "partial",
      workspaceId: input.workspaceId,
      ...watermark
    });
  });
}

function writeCompleteRecoveryWatermark(filePath: string, workspaceId: string, commitSha: string): void {
  writeRecoveryWatermark(filePath, {
    schema: "authority-recovery-watermark/v1",
    workspaceId,
    commitSha
  });
}

function writeRecoveryWatermark(filePath: string, watermark: Record<string, unknown>): void {
  const body = `${JSON.stringify({ ...watermark, scannedAt: new Date().toISOString() })}\n`;
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
