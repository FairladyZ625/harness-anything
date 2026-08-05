import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultRepoWriteRequestTimeoutMs } from "../runtime/repo-write-client-contract.ts";
import type { RepoWriteTelemetryFrame } from "../runtime/repo-write-protocol.ts";

const execFileAsync = promisify(execFile);
const defaultMaximumTrackedRequests = 64;

export const provenanceCapacityHeadroomThresholdRatio = 1 / 3;

interface HistoryStart {
  readonly elapsedMs: number;
  readonly pathCount: number | null;
}

interface RequestState {
  completionWitnessObserved: boolean;
  canonicalEventPublished: boolean;
  historyStarts: HistoryStart[];
  historyDurationsMs: number[];
  historyPathCounts: Array<number | null>;
  telemetryInvalid: boolean;
  writerExecutionMs: number | null;
}

export interface ProvenanceCapacityTriggerOptions {
  readonly writerDeadlineMs?: number;
  readonly maximumTrackedRequests?: number;
}

export interface ProvenanceCapacitySignal {
  readonly schema: "provenance-capacity-signal/v1";
  readonly requestId: string;
  readonly status: "ok" | "alert" | "measurement-failed";
  readonly source: "production-task-complete";
  readonly proofHistoryMs: number | null;
  readonly historyScanCount: number;
  readonly historyPathCounts: ReadonlyArray<number | null>;
  readonly writerExecutionMs: number | null;
  readonly writerTerminalMs: number;
  readonly writerDeadlineMs: number;
  readonly headroomMs: number;
  readonly headroomRatio: number;
  readonly alertThresholdRatio: number;
}

export interface ProvenanceLedgerScale {
  readonly ledgerHead: string;
  readonly firstParentCommitCount: number;
  readonly totalCommitCount: number;
}

export type ProvenanceCapacityObservation =
  Omit<ProvenanceCapacitySignal, "schema">
  & ProvenanceLedgerScale
  & { readonly schema: "provenance-capacity-observation/v1" };

export interface ProvenanceCapacityTelemetryTrigger {
  readonly observe: (frame: RepoWriteTelemetryFrame) => ProvenanceCapacitySignal | null;
}

export function createProvenanceCapacityTelemetryTrigger(
  options: ProvenanceCapacityTriggerOptions = {}
): ProvenanceCapacityTelemetryTrigger {
  const writerDeadlineMs = positiveFinite(
    options.writerDeadlineMs ?? defaultRepoWriteRequestTimeoutMs,
    "writerDeadlineMs"
  );
  const maximumTrackedRequests = positiveProvenanceInteger(
    options.maximumTrackedRequests ?? defaultMaximumTrackedRequests,
    "maximumTrackedRequests"
  );
  const requests = new Map<string, RequestState>();

  return {
    observe: (frame) => {
      const existing = requests.get(frame.requestId);
      const startsCompletionWitness = isCompletionWitnessStart(frame);
      const isHistory = isHistoryFrame(frame);
      if (!existing && !startsCompletionWitness && !isHistory) return null;

      const state = existing ?? emptyRequestState();
      if (!existing) {
        evictOldestRequestWhenFull(requests, maximumTrackedRequests);
        requests.set(frame.requestId, state);
      }

      if (startsCompletionWitness) state.completionWitnessObserved = true;
      if (frame.phase === "authority-event-published") state.canonicalEventPublished = true;
      if (frame.phase === "child-execution-returned") {
        state.writerExecutionMs = finiteMilliseconds(frame.elapsedMs);
      }
      observeHistoryFrame(state, frame);

      if (frame.phase !== "child-terminal-response") return null;
      requests.delete(frame.requestId);
      if (!state.completionWitnessObserved || !state.canonicalEventPublished) return null;
      return capacitySignal(frame.requestId, state, finiteMilliseconds(frame.elapsedMs), writerDeadlineMs);
    }
  };
}

export async function readProvenanceLedgerScale(
  authoredGitRoot: string,
  timeoutMs = 5_000
): Promise<ProvenanceLedgerScale> {
  const boundedTimeoutMs = positiveProvenanceInteger(timeoutMs, "timeoutMs");
  const git = async (...args: ReadonlyArray<string>): Promise<string> => {
    const { stdout } = await execFileAsync("git", ["-C", authoredGitRoot, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: boundedTimeoutMs,
      windowsHide: true
    });
    return stdout.trim();
  };
  const [ledgerHead, firstParentCount, totalCount] = await Promise.all([
    git("rev-parse", "HEAD"),
    git("rev-list", "--first-parent", "--count", "HEAD"),
    git("rev-list", "--count", "HEAD")
  ]);
  if (!/^[a-f0-9]{40,64}$/u.test(ledgerHead)) throw new Error("PROVENANCE_CAPACITY_LEDGER_HEAD_INVALID");
  return {
    ledgerHead,
    firstParentCommitCount: commitCount(firstParentCount, "first-parent"),
    totalCommitCount: commitCount(totalCount, "total")
  };
}

export function completeProvenanceCapacityObservation(
  signal: ProvenanceCapacitySignal,
  scale: ProvenanceLedgerScale
): ProvenanceCapacityObservation {
  return {
    ...signal,
    ...scale,
    schema: "provenance-capacity-observation/v1"
  };
}

function capacitySignal(
  requestId: string,
  state: RequestState,
  writerTerminalMs: number,
  writerDeadlineMs: number
): ProvenanceCapacitySignal {
  const telemetryComplete = state.historyDurationsMs.length === 4
    && state.historyStarts.length === 0
    && state.historyPathCounts.every((pathCount) => pathCount !== null)
    && !state.telemetryInvalid;
  const headroomMs = roundProvenanceMilliseconds(writerDeadlineMs - writerTerminalMs);
  const headroomRatio = roundProvenanceRatio(headroomMs / writerDeadlineMs);
  const alert = writerDeadlineMs - writerTerminalMs
    <= writerDeadlineMs * provenanceCapacityHeadroomThresholdRatio;
  return {
    schema: "provenance-capacity-signal/v1",
    requestId,
    status: telemetryComplete ? (alert ? "alert" : "ok") : "measurement-failed",
    source: "production-task-complete",
    proofHistoryMs: telemetryComplete
      ? roundProvenanceMilliseconds(state.historyDurationsMs.reduce((sum, duration) => sum + duration, 0))
      : null,
    historyScanCount: state.historyDurationsMs.length,
    historyPathCounts: [...state.historyPathCounts],
    writerExecutionMs: state.writerExecutionMs,
    writerTerminalMs: roundProvenanceMilliseconds(writerTerminalMs),
    writerDeadlineMs: roundProvenanceMilliseconds(writerDeadlineMs),
    headroomMs,
    headroomRatio,
    alertThresholdRatio: roundProvenanceRatio(provenanceCapacityHeadroomThresholdRatio)
  };
}

function observeHistoryFrame(state: RequestState, frame: RepoWriteTelemetryFrame): void {
  if (frame.phase !== "authority-publication-proof") return;
  const stage = frame.details?.stage;
  if (stage === "history-start") {
    state.historyStarts.push({
      elapsedMs: finiteMilliseconds(frame.elapsedMs),
      pathCount: telemetryPathCount(frame)
    });
    return;
  }
  if (stage !== "history-done") return;
  const start = state.historyStarts.shift();
  const pathCount = telemetryPathCount(frame);
  if (!start || start.pathCount !== pathCount || frame.elapsedMs < start.elapsedMs) {
    state.telemetryInvalid = true;
    return;
  }
  state.historyDurationsMs.push(frame.elapsedMs - start.elapsedMs);
  state.historyPathCounts.push(pathCount);
}

function isCompletionWitnessStart(frame: RepoWriteTelemetryFrame): boolean {
  return frame.phase === "compile-task-witness"
    && frame.details?.stage === "document-produce"
    && frame.details?.state === "start";
}

function isHistoryFrame(frame: RepoWriteTelemetryFrame): boolean {
  return frame.phase === "authority-publication-proof"
    && (frame.details?.stage === "history-start" || frame.details?.stage === "history-done");
}

function telemetryPathCount(frame: RepoWriteTelemetryFrame): number | null {
  const value = frame.details?.pathCount;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function emptyRequestState(): RequestState {
  return {
    completionWitnessObserved: false,
    canonicalEventPublished: false,
    historyStarts: [],
    historyDurationsMs: [],
    historyPathCounts: [],
    telemetryInvalid: false,
    writerExecutionMs: null
  };
}

function evictOldestRequestWhenFull(requests: Map<string, RequestState>, maximum: number): void {
  if (requests.size < maximum) return;
  const oldest = requests.keys().next().value;
  if (typeof oldest === "string") requests.delete(oldest);
}

function finiteMilliseconds(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("PROVENANCE_CAPACITY_ELAPSED_INVALID");
  return value;
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`PROVENANCE_CAPACITY_${name.toUpperCase()}_INVALID`);
  return value;
}

function positiveProvenanceInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`PROVENANCE_CAPACITY_${name.toUpperCase()}_INVALID`);
  return value;
}

function commitCount(value: string, label: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`PROVENANCE_CAPACITY_${label.toUpperCase()}_COUNT_INVALID`);
  const count = Number(value);
  if (!Number.isSafeInteger(count)) throw new Error(`PROVENANCE_CAPACITY_${label.toUpperCase()}_COUNT_INVALID`);
  return count;
}

function roundProvenanceMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function roundProvenanceRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
