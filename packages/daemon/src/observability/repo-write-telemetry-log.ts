import {
  repoWriteTelemetryPhases,
  type RepoWriteTelemetryBatchFrame,
  type RepoWriteTelemetryDetails,
  type RepoWriteTelemetryPhase,
  type RepoWriteTelemetrySpan
} from "../runtime/repo-write-diagnostic-protocol.ts";

export const repoWriteTelemetryLogBatchSchema =
  "repo-write-request-telemetry-batch/v1" as const;
export const repoWriteTelemetryLogPhaseTable =
  "repo-write-telemetry-phases/v1" as const;

type CompactTelemetrySpan = readonly [
  phaseIndex: number,
  elapsedMs: number,
  details?: RepoWriteTelemetryDetails
];

export interface DecodedRepoWriteTelemetryLog {
  readonly requestId: string;
  readonly opId?: string;
  readonly spans: ReadonlyArray<RepoWriteTelemetrySpan>;
}

export function encodeRepoWriteTelemetryBatchLog(
  frame: RepoWriteTelemetryBatchFrame
): string {
  const spans: ReadonlyArray<CompactTelemetrySpan> = frame.spans.map((span) => {
    const phaseIndex = repoWriteTelemetryPhases.indexOf(span.phase);
    if (phaseIndex < 0) throw new Error(`Unsupported repo-write telemetry phase: ${span.phase}`);
    return span.details === undefined
      ? [phaseIndex, span.elapsedMs]
      : [phaseIndex, span.elapsedMs, span.details];
  });
  return JSON.stringify({
    schema: repoWriteTelemetryLogBatchSchema,
    requestId: frame.requestId,
    ...(frame.opId ? { opId: frame.opId } : {}),
    encoding: "json",
    phaseTable: repoWriteTelemetryLogPhaseTable,
    spans
  });
}

export function decodeRepoWriteTelemetryLog(
  value: string
): DecodedRepoWriteTelemetryLog | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (!isTelemetryLogRecord(parsed) || typeof parsed.requestId !== "string" || !parsed.requestId.trim()) {
    return null;
  }
  if (parsed.schema === "repo-write-request-telemetry/v1") {
    const span = decodeLegacyTelemetrySpan(parsed);
    return span ? {
      requestId: parsed.requestId,
      ...(typeof parsed.opId === "string" ? { opId: parsed.opId } : {}),
      spans: [span]
    } : null;
  }
  if (parsed.schema !== repoWriteTelemetryLogBatchSchema
    || parsed.encoding !== "json"
    || !Array.isArray(parsed.spans)) {
    return null;
  }
  const indexed = parsed.phaseTable === repoWriteTelemetryLogPhaseTable;
  const spans: RepoWriteTelemetrySpan[] = [];
  for (const candidate of parsed.spans) {
    const span = decodeCompactTelemetrySpan(candidate, indexed);
    if (!span) return null;
    spans.push(span);
  }
  if (spans.length === 0) return null;
  return {
    requestId: parsed.requestId,
    ...(typeof parsed.opId === "string" ? { opId: parsed.opId } : {}),
    spans
  };
}

function decodeLegacyTelemetrySpan(value: Record<string, unknown>): RepoWriteTelemetrySpan | null {
  return decodeTelemetryLogSpan(value.phase, value.elapsedMs, value.details);
}

function decodeCompactTelemetrySpan(
  value: unknown,
  indexed: boolean
): RepoWriteTelemetrySpan | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) return null;
  const phase = indexed && Number.isSafeInteger(value[0])
    ? repoWriteTelemetryPhases[Number(value[0])]
    : value[0];
  return decodeTelemetryLogSpan(phase, value[1], value[2]);
}

function decodeTelemetryLogSpan(
  phase: unknown,
  elapsedMs: unknown,
  details: unknown
): RepoWriteTelemetrySpan | null {
  if (typeof phase !== "string"
    || !(repoWriteTelemetryPhases as ReadonlyArray<string>).includes(phase)
    || typeof elapsedMs !== "number"
    || !Number.isFinite(elapsedMs)
    || elapsedMs < 0) {
    return null;
  }
  if (details !== undefined && !isTelemetryDetails(details)) return null;
  return {
    phase: phase as RepoWriteTelemetryPhase,
    elapsedMs,
    ...(details === undefined ? {} : { details })
  };
}

function isTelemetryDetails(value: unknown): value is RepoWriteTelemetryDetails {
  return isTelemetryLogRecord(value) && Object.values(value).every((detail) =>
    detail === null
    || typeof detail === "string"
    || typeof detail === "boolean"
    || (typeof detail === "number" && Number.isFinite(detail)));
}

function isTelemetryLogRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
