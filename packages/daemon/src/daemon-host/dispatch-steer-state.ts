import { lstatSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { resolveHarnessLayout, sha256Text } from "@harness-anything/kernel";
import { removeFileDurably, writeFileDurably } from "../../../storage/src/durable-file.ts";
import type { RuntimeSteerOutcome } from "./runtime-spawn-types.ts";

const stateSchema = "dispatch-steer-state/v1" as const;
const pendingIndexSchema = "pending-steer-receipts-index/v1" as const;
const MAX_TRACKED_IDS = 512;

export interface PendingSteerAppend {
  readonly opId: string;
  readonly version: number;
  readonly streamOffsetBefore: number;
}

export interface DispatchSteerState {
  readonly schema: typeof stateSchema;
  readonly dispatchId: string;
  readonly version: number;
  /** Byte offset in `<dispatchId>.jsonl` through which `version` and `opIds` are synchronized. */
  readonly streamOffset: number;
  /** Highest contiguous Center workspaceRevision whose remote control events for this dispatch have settled. */
  readonly controlCursorRevision: number;
  readonly opIds: readonly string[];
  /** Write-ahead intent set before appending `steer_requested` to `<dispatchId>.jsonl` and cleared on commit. */
  readonly pendingAppend?: PendingSteerAppend;
  /** Next dispatch id in a taskless resumed conversation, recorded when the child stream opens (F4 O(1) leaf lookup). */
  readonly resumedToDispatchId?: string;
  readonly pendingReceipts: readonly RuntimeSteerOutcome[];
  readonly ackedReceiptOpIds: readonly string[];
}

export interface PendingSteerReceiptEntry {
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly repoId: string;
  readonly outcome: RuntimeSteerOutcome;
}

interface PendingSteerReceiptIndex {
  readonly schema: typeof pendingIndexSchema;
  readonly entries: readonly PendingSteerReceiptEntry[];
}

/** Single terminal receipt identity per `(repoId, runtimeSessionId, requestOpId)` — status-independent (F15). */
export function steerReceiptOpId(repoId: string, runtimeSessionId: string, requestOpId: string): string {
  return `runtime-steer-rcpt-${sha256Text(`${repoId}\0${runtimeSessionId}\0${requestOpId}`).slice(0, 32)}`;
}

export function dispatchSteerStatePath(rootDir: string, dispatchId: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(dispatchId) || dispatchId.includes("..")) throw new Error("dispatch id is invalid");
  return path.join(resolveHarnessLayout(rootDir).localRoot, "runtime", "dispatches", `${dispatchId}.steer-state.json`);
}

export function pendingSteerReceiptsIndexPath(rootDir: string): string {
  return path.join(resolveHarnessLayout(rootDir).localRoot, "runtime", "dispatches", "pending-steer-receipts.json");
}

function emptyState(dispatchId: string): DispatchSteerState {
  return {
    schema: stateSchema,
    dispatchId,
    version: 0,
    streamOffset: 0,
    controlCursorRevision: 0,
    opIds: [],
    pendingReceipts: [],
    ackedReceiptOpIds: [],
  };
}

function trimBounded(items: readonly string[]): readonly string[] {
  return items.length <= MAX_TRACKED_IDS ? items : items.slice(items.length - MAX_TRACKED_IDS);
}

function validSteerOutcome(value: unknown): value is RuntimeSteerOutcome {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    (record.status === "applied" || record.status === "rejected") &&
    typeof record.controlRequestId === "string" &&
    record.controlRequestId.length > 0 &&
    typeof record.requestOpId === "string" &&
    record.requestOpId.length > 0
  );
}

function validPendingAppend(value: unknown): value is PendingSteerAppend {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.opId === "string" &&
    record.opId.length > 0 &&
    typeof record.version === "number" &&
    Number.isSafeInteger(record.version) &&
    record.version >= 1 &&
    typeof record.streamOffsetBefore === "number" &&
    Number.isSafeInteger(record.streamOffsetBefore) &&
    record.streamOffsetBefore >= 0
  );
}

function validPendingIndexEntry(value: unknown): value is PendingSteerReceiptEntry {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.dispatchId === "string" &&
    record.dispatchId.length > 0 &&
    typeof record.runtimeSessionId === "string" &&
    record.runtimeSessionId.length > 0 &&
    typeof record.repoId === "string" &&
    record.repoId.length > 0 &&
    validSteerOutcome(record.outcome)
  );
}

export function readDispatchSteerState(rootDir: string, dispatchId: string): DispatchSteerState | null {
  const file = dispatchSteerStatePath(rootDir, dispatchId);
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return null;
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (
    value.schema !== stateSchema ||
    value.dispatchId !== dispatchId ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 0 ||
    !Array.isArray(value.opIds)
  )
    return null;
  const streamOffset =
      typeof value.streamOffset === "number" && Number.isSafeInteger(value.streamOffset) && value.streamOffset >= 0
        ? value.streamOffset
        : 0,
    controlCursorRevision =
      typeof value.controlCursorRevision === "number" &&
      Number.isSafeInteger(value.controlCursorRevision) &&
      value.controlCursorRevision >= 0
        ? value.controlCursorRevision
        : 0;
  return {
    schema: stateSchema,
    dispatchId,
    version: value.version,
    streamOffset,
    controlCursorRevision,
    opIds: value.opIds.filter((item): item is string => typeof item === "string" && item.length > 0),
    ...(validPendingAppend(value.pendingAppend) ? { pendingAppend: value.pendingAppend } : {}),
    ...(typeof value.resumedToDispatchId === "string" && value.resumedToDispatchId.length > 0
      ? { resumedToDispatchId: value.resumedToDispatchId }
      : {}),
    pendingReceipts: Array.isArray(value.pendingReceipts) ? value.pendingReceipts.filter(validSteerOutcome) : [],
    ackedReceiptOpIds: Array.isArray(value.ackedReceiptOpIds)
      ? value.ackedReceiptOpIds.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [],
  };
}

export function writeDispatchSteerState(rootDir: string, state: DispatchSteerState): void {
  writeFileDurably(dispatchSteerStatePath(rootDir, state.dispatchId), `${JSON.stringify(state)}\n`, 0o600);
}

export function initDispatchSteerState(rootDir: string, dispatchId: string, initialStreamOffset = 0): void {
  if (readDispatchSteerState(rootDir, dispatchId) !== null) return;
  writeDispatchSteerState(rootDir, { ...emptyState(dispatchId), streamOffset: Math.max(0, initialStreamOffset) });
}

/** Records the direct taskless resume edge (`from -> to`) so leaf lookup stays O(chain_length) without scanning archive/. */
export function recordDispatchResumedTo(rootDir: string, fromDispatchId: string, toDispatchId: string): void {
  const current = readDispatchSteerState(rootDir, fromDispatchId) ?? emptyState(fromDispatchId);
  if (current.resumedToDispatchId === toDispatchId) return;
  writeDispatchSteerState(rootDir, {
    ...current,
    resumedToDispatchId: toDispatchId,
  });
}

/** Write-ahead intent persisted before appending `steer_requested` to `<dispatchId>.jsonl` (F12). */
export function prepareDispatchSteerAppend(rootDir: string, dispatchId: string, intent: PendingSteerAppend): void {
  const current = readDispatchSteerState(rootDir, dispatchId) ?? emptyState(dispatchId);
  if (current.opIds.includes(intent.opId)) return;
  writeDispatchSteerState(rootDir, {
    ...current,
    pendingAppend: intent,
  });
}

export function recordDispatchSteerRequest(
  rootDir: string,
  dispatchId: string,
  opId?: string,
  streamOffsetAfter?: number,
): void {
  const current = readDispatchSteerState(rootDir, dispatchId) ?? emptyState(dispatchId);
  const nextOffset =
    typeof streamOffsetAfter === "number" && Number.isSafeInteger(streamOffsetAfter) && streamOffsetAfter >= 0
      ? Math.max(current.streamOffset, streamOffsetAfter)
      : current.streamOffset;
  if (typeof opId === "string" && opId.length > 0 && current.opIds.includes(opId)) {
    if (current.pendingAppend !== undefined || nextOffset !== current.streamOffset) {
      const { pendingAppend: _cleared, ...rest } = current;
      writeDispatchSteerState(rootDir, { ...rest, streamOffset: nextOffset });
    }
    return;
  }
  const opIds = typeof opId === "string" && opId.length > 0 ? trimBounded([...current.opIds, opId]) : current.opIds;
  const { pendingAppend: _cleared, ...rest } = current;
  writeDispatchSteerState(rootDir, {
    ...rest,
    version: current.version + 1,
    streamOffset: nextOffset,
    opIds,
  });
}

export function readDispatchControlCursor(rootDir: string, dispatchId: string): number {
  return readDispatchSteerState(rootDir, dispatchId)?.controlCursorRevision ?? 0;
}

export function advanceDispatchControlCursor(rootDir: string, dispatchId: string, revision: number): void {
  if (!Number.isSafeInteger(revision) || revision <= 0) return;
  const current = readDispatchSteerState(rootDir, dispatchId) ?? emptyState(dispatchId);
  if (revision <= current.controlCursorRevision) return;
  writeDispatchSteerState(rootDir, {
    ...current,
    controlCursorRevision: revision,
  });
}

/**
 * Reconciles a dispatch sidecar against `<dispatchId>.jsonl` starting strictly at `fromOffset` (F12).
 * Used on crash recovery (`pendingAppend !== undefined`) and once on daemon restart/adoption so a crash
 * between stream append and sidecar write never yields a stale steer version or loses a dedup opId.
 */
export function reconcileDispatchSteerStateFromStream(
  rootDir: string,
  dispatchId: string,
  streamPath: string,
  readChunk: (target: string, offset: number) => Buffer,
  parseLine: (line: string) => Readonly<Record<string, unknown>> | null,
  options?: { readonly forceTailScan?: boolean },
): DispatchSteerState | null {
  const current = readDispatchSteerState(rootDir, dispatchId);
  if (!current) return null;
  if (!current.pendingAppend && !options?.forceTailScan) return current;
  const fileSize = statSync(streamPath, { throwIfNoEntry: false })?.size ?? 0;
  const startOffset = current.pendingAppend
    ? Math.min(current.streamOffset, current.pendingAppend.streamOffsetBefore)
    : current.streamOffset;
  if (fileSize <= startOffset && !current.pendingAppend) return current;
  const decoder = new StringDecoder("utf8"),
    marker = '"kind":"steer_requested"',
    knownOpIds = new Set(current.opIds),
    appendedOpIds: string[] = [];
  let offset = Math.max(0, startOffset),
    tail = "",
    version = current.version;
  const scanLine = (line: string): void => {
    if (!line.includes(marker)) return;
    const record = parseLine(line);
    if (record?.kind !== "steer_requested") return;
    const opId = typeof record.opId === "string" && record.opId.length > 0 ? record.opId : null;
    if (opId !== null && knownOpIds.has(opId)) return;
    if (opId !== null) {
      knownOpIds.add(opId);
      appendedOpIds.push(opId);
    }
    if (typeof record.version === "number" && Number.isSafeInteger(record.version) && record.version > version) {
      version = record.version;
    } else {
      version += 1;
    }
  };
  for (;;) {
    const bytes = readChunk(streamPath, offset);
    if (bytes.length === 0) break;
    offset += bytes.length;
    const lines = (tail + decoder.write(bytes)).split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) scanLine(line);
  }
  scanLine(tail + decoder.end());
  const { pendingAppend: _cleared, ...rest } = current;
  const updated: DispatchSteerState = {
    ...rest,
    version,
    streamOffset: Math.max(current.streamOffset, offset),
    opIds: appendedOpIds.length > 0 ? trimBounded([...current.opIds, ...appendedOpIds]) : current.opIds,
  };
  if (
    current.pendingAppend !== undefined ||
    updated.version !== current.version ||
    updated.streamOffset !== current.streamOffset ||
    appendedOpIds.length > 0
  ) {
    writeDispatchSteerState(rootDir, updated);
  }
  return updated;
}

function readPendingReceiptIndex(rootDir: string): PendingSteerReceiptIndex {
  const file = pendingSteerReceiptsIndexPath(rootDir);
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return { schema: pendingIndexSchema, entries: [] };
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (raw === null || typeof raw !== "object") return { schema: pendingIndexSchema, entries: [] };
  const value = raw as Record<string, unknown>;
  if (value.schema !== pendingIndexSchema || !Array.isArray(value.entries))
    return { schema: pendingIndexSchema, entries: [] };
  return {
    schema: pendingIndexSchema,
    entries: value.entries.filter(validPendingIndexEntry),
  };
}

function writePendingReceiptIndex(rootDir: string, entries: readonly PendingSteerReceiptEntry[]): void {
  const file = pendingSteerReceiptsIndexPath(rootDir);
  if (entries.length === 0) {
    if (lstatSync(file, { throwIfNoEntry: false })?.isFile()) removeFileDurably(file);
    return;
  }
  const bounded = entries.length <= MAX_TRACKED_IDS ? entries : entries.slice(entries.length - MAX_TRACKED_IDS);
  writeFileDurably(file, `${JSON.stringify({ schema: pendingIndexSchema, entries: bounded })}\n`, 0o600);
}

/** O(1) check whether any unacknowledged steer receipt awaits replay (zero directory/archive scans, F4). */
export function hasPendingSteerReceipts(rootDir: string): boolean {
  return readPendingReceiptIndex(rootDir).entries.length > 0;
}

/** Bounded read of all unacknowledged steer receipts across active and archived dispatches (F4). */
export function readAllPendingSteerReceipts(rootDir: string): readonly PendingSteerReceiptEntry[] {
  return readPendingReceiptIndex(rootDir).entries;
}

export function recordPendingSteerReceipt(
  rootDir: string,
  dispatchId: string,
  repoId: string,
  runtimeSessionId: string,
  outcome: RuntimeSteerOutcome,
): string {
  const receiptOpId = steerReceiptOpId(repoId, runtimeSessionId, outcome.requestOpId);
  const current = readDispatchSteerState(rootDir, dispatchId) ?? emptyState(dispatchId);
  if (current.ackedReceiptOpIds.includes(receiptOpId)) return receiptOpId;
  const alreadyPending = current.pendingReceipts.some(
    (entry) => steerReceiptOpId(repoId, runtimeSessionId, entry.requestOpId) === receiptOpId,
  );
  if (!alreadyPending) {
    const pendingReceipts =
      current.pendingReceipts.length >= MAX_TRACKED_IDS
        ? [...current.pendingReceipts.slice(current.pendingReceipts.length - MAX_TRACKED_IDS + 1), outcome]
        : [...current.pendingReceipts, outcome];
    writeDispatchSteerState(rootDir, {
      ...current,
      pendingReceipts,
    });
  }
  const index = readPendingReceiptIndex(rootDir);
  const inIndex = index.entries.some(
    (entry) => steerReceiptOpId(entry.repoId, entry.runtimeSessionId, entry.outcome.requestOpId) === receiptOpId,
  );
  if (!inIndex) {
    writePendingReceiptIndex(rootDir, [...index.entries, { dispatchId, runtimeSessionId, repoId, outcome }]);
  }
  return receiptOpId;
}

export function markSteerReceiptAcked(
  rootDir: string,
  dispatchId: string,
  repoId: string,
  runtimeSessionId: string,
  receiptOpId: string,
): void {
  const current = readDispatchSteerState(rootDir, dispatchId);
  if (current) {
    const pendingReceipts = current.pendingReceipts.filter(
      (entry) => steerReceiptOpId(repoId, runtimeSessionId, entry.requestOpId) !== receiptOpId,
    );
    const ackedReceiptOpIds = current.ackedReceiptOpIds.includes(receiptOpId)
      ? current.ackedReceiptOpIds
      : trimBounded([...current.ackedReceiptOpIds, receiptOpId]);
    writeDispatchSteerState(rootDir, {
      ...current,
      pendingReceipts,
      ackedReceiptOpIds,
    });
  }
  const index = readPendingReceiptIndex(rootDir);
  const remaining = index.entries.filter(
    (entry) => steerReceiptOpId(entry.repoId, entry.runtimeSessionId, entry.outcome.requestOpId) !== receiptOpId,
  );
  if (remaining.length !== index.entries.length) writePendingReceiptIndex(rootDir, remaining);
}

export function readPendingSteerReceipts(rootDir: string, dispatchId: string): readonly RuntimeSteerOutcome[] {
  return readDispatchSteerState(rootDir, dispatchId)?.pendingReceipts ?? [];
}

export function removeDispatchSteerState(rootDir: string, dispatchId: string): void {
  const file = dispatchSteerStatePath(rootDir, dispatchId);
  if (lstatSync(file, { throwIfNoEntry: false })?.isFile()) removeFileDurably(file);
  const index = readPendingReceiptIndex(rootDir);
  const remaining = index.entries.filter((entry) => entry.dispatchId !== dispatchId);
  if (remaining.length !== index.entries.length) writePendingReceiptIndex(rootDir, remaining);
}
