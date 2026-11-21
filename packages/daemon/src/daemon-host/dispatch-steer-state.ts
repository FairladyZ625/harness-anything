import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout, sha256Text } from "@harness-anything/kernel";
import { removeFileDurably, writeFileDurably } from "../../../storage/src/durable-file.ts";
import type { RuntimeSteerOutcome } from "./runtime-spawn-types.ts";

const stateSchema = "dispatch-steer-state/v1" as const;
const MAX_TRACKED_IDS = 512;

export interface DispatchSteerState {
  readonly schema: typeof stateSchema;
  readonly dispatchId: string;
  readonly version: number;
  readonly opIds: readonly string[];
  readonly pendingReceipts: readonly RuntimeSteerOutcome[];
  readonly ackedReceiptOpIds: readonly string[];
}

export function steerReceiptOpId(
  repoId: string,
  runtimeSessionId: string,
  requestOpId: string,
  status: string,
): string {
  return `runtime-steer-rcpt-${sha256Text(`${repoId}\0${runtimeSessionId}\0${requestOpId}\0${status}`).slice(0, 32)}`;
}

export function dispatchSteerStatePath(rootDir: string, dispatchId: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(dispatchId) || dispatchId.includes("..")) throw new Error("dispatch id is invalid");
  return path.join(resolveHarnessLayout(rootDir).localRoot, "runtime", "dispatches", `${dispatchId}.steer-state.json`);
}

function emptyState(dispatchId: string): DispatchSteerState {
  return {
    schema: stateSchema,
    dispatchId,
    version: 0,
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
  return {
    schema: stateSchema,
    dispatchId,
    version: value.version,
    opIds: value.opIds.filter((item): item is string => typeof item === "string" && item.length > 0),
    pendingReceipts: Array.isArray(value.pendingReceipts) ? value.pendingReceipts.filter(validSteerOutcome) : [],
    ackedReceiptOpIds: Array.isArray(value.ackedReceiptOpIds)
      ? value.ackedReceiptOpIds.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [],
  };
}

export function writeDispatchSteerState(rootDir: string, state: DispatchSteerState): void {
  writeFileDurably(dispatchSteerStatePath(rootDir, state.dispatchId), `${JSON.stringify(state)}\n`, 0o600);
}

export function initDispatchSteerState(rootDir: string, dispatchId: string): void {
  if (readDispatchSteerState(rootDir, dispatchId) !== null) return;
  writeDispatchSteerState(rootDir, emptyState(dispatchId));
}

export function recordDispatchSteerRequest(rootDir: string, dispatchId: string, opId?: string): void {
  const current = readDispatchSteerState(rootDir, dispatchId) ?? emptyState(dispatchId);
  if (typeof opId === "string" && opId.length > 0 && current.opIds.includes(opId)) return;
  const opIds = typeof opId === "string" && opId.length > 0 ? trimBounded([...current.opIds, opId]) : current.opIds;
  writeDispatchSteerState(rootDir, {
    ...current,
    version: current.version + 1,
    opIds,
  });
}

export function recordPendingSteerReceipt(
  rootDir: string,
  dispatchId: string,
  repoId: string,
  runtimeSessionId: string,
  outcome: RuntimeSteerOutcome,
): string {
  const receiptOpId = steerReceiptOpId(repoId, runtimeSessionId, outcome.requestOpId, outcome.status);
  const current = readDispatchSteerState(rootDir, dispatchId) ?? emptyState(dispatchId);
  if (current.ackedReceiptOpIds.includes(receiptOpId)) return receiptOpId;
  const alreadyPending = current.pendingReceipts.some(
    (entry) => steerReceiptOpId(repoId, runtimeSessionId, entry.requestOpId, entry.status) === receiptOpId,
  );
  if (alreadyPending) return receiptOpId;
  const pendingReceipts =
    current.pendingReceipts.length >= MAX_TRACKED_IDS
      ? [...current.pendingReceipts.slice(current.pendingReceipts.length - MAX_TRACKED_IDS + 1), outcome]
      : [...current.pendingReceipts, outcome];
  writeDispatchSteerState(rootDir, {
    ...current,
    pendingReceipts,
  });
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
  if (!current) return;
  const pendingReceipts = current.pendingReceipts.filter(
    (entry) => steerReceiptOpId(repoId, runtimeSessionId, entry.requestOpId, entry.status) !== receiptOpId,
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

export function readPendingSteerReceipts(rootDir: string, dispatchId: string): readonly RuntimeSteerOutcome[] {
  return readDispatchSteerState(rootDir, dispatchId)?.pendingReceipts ?? [];
}

export function removeDispatchSteerState(rootDir: string, dispatchId: string): void {
  const file = dispatchSteerStatePath(rootDir, dispatchId);
  if (lstatSync(file, { throwIfNoEntry: false })?.isFile()) removeFileDurably(file);
}
