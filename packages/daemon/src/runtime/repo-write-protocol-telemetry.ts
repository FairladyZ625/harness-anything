import {
  repoWriteTelemetryPhases,
  type RepoWriteTelemetryBatchFrame,
  type RepoWriteTelemetryDetails,
  type RepoWriteTelemetryFrame,
  type RepoWriteTelemetrySpan,
  type RepoWriteTelemetryPhase
} from "./repo-write-diagnostic-protocol.ts";
import type { RepoWriteProtocolLimits } from "./repo-write-protocol.ts";
import {
  invalidRepoWriteProtocol as invalid,
  limitRepoWriteProtocol as limit
} from "./repo-write-protocol-errors.ts";

type TelemetryFrameRecord = Record<string, unknown> & {
  readonly kind: string;
};

type TelemetryBaseFields = Pick<RepoWriteTelemetryFrame, "protocol" | "repoId" | "generation">;

export function decodeRepoWriteTelemetry(
  frame: TelemetryFrameRecord,
  limits: RepoWriteProtocolLimits,
  baseFields: TelemetryBaseFields
): RepoWriteTelemetryFrame {
  assertExactTelemetryKeys(frame);
  if (!repoWriteTelemetryPhases.includes(frame.phase as RepoWriteTelemetryPhase)) {
    invalid("$.phase", "telemetry phase");
  }
  if (typeof frame.elapsedMs !== "number" || !Number.isFinite(frame.elapsedMs) || frame.elapsedMs < 0) {
    invalid("$.elapsedMs", "non-negative finite duration");
  }
  return {
    ...baseFields,
    kind: "telemetry",
    requestId: telemetryIdentifier(frame.requestId, "$.requestId", limits),
    ...(Object.hasOwn(frame, "opId") ? { opId: telemetryIdentifier(frame.opId, "$.opId", limits) } : {}),
    phase: frame.phase as RepoWriteTelemetryPhase,
    elapsedMs: frame.elapsedMs,
    ...(Object.hasOwn(frame, "details") ? { details: decodeTelemetryDetails(frame.details, limits) } : {})
  };
}

export function decodeRepoWriteTelemetryBatch(
  frame: TelemetryFrameRecord,
  limits: RepoWriteProtocolLimits,
  baseFields: TelemetryBaseFields
): RepoWriteTelemetryBatchFrame {
  assertExactTelemetryBatchKeys(frame);
  if (!Array.isArray(frame.spans) || frame.spans.length < 1) {
    invalid("$.spans", "non-empty telemetry span array");
  }
  if (frame.spans.length > limits.maxArrayItems) {
    limit("$.spans", "telemetry span count", frame.spans.length, limits.maxArrayItems);
  }
  return {
    ...baseFields,
    kind: "telemetry-batch",
    requestId: telemetryIdentifier(frame.requestId, "$.requestId", limits),
    ...(Object.hasOwn(frame, "opId") ? { opId: telemetryIdentifier(frame.opId, "$.opId", limits) } : {}),
    spans: frame.spans.map((span, index) => decodeTelemetrySpan(span, `$.spans[${index}]`, limits))
  };
}

function decodeTelemetryDetails(value: unknown, limits: RepoWriteProtocolLimits): RepoWriteTelemetryDetails {
  const record = telemetryRecordAt(value, "$.details");
  const entries = Object.entries(record);
  if (entries.length > Math.min(limits.maxObjectKeys, 32)) limit("$.details", "detail key count");
  const decoded: Record<string, string | number | boolean | null> = {};
  for (const [key, detail] of entries) {
    telemetryStringAt(key, "$.details key", Math.min(limits.maxStringBytes, 128));
    if (key === "__proto__" || key === "prototype" || key === "constructor") invalid("$.details", "safe detail keys");
    if (detail === null || typeof detail === "boolean") decoded[key] = detail;
    else if (typeof detail === "string") decoded[key] = telemetryStringAt(detail, `$.details.${telemetryPathSegment(key)}`, 256);
    else if (typeof detail === "number" && Number.isFinite(detail)) decoded[key] = detail;
    else invalid(`$.details.${telemetryPathSegment(key)}`, "scalar telemetry detail");
  }
  return decoded;
}

function assertExactTelemetryKeys(frame: Record<string, unknown>): void {
  const required = ["protocol", "repoId", "generation", "kind", "requestId", "phase", "elapsedMs"];
  const allowed = new Set([...required, "opId", "details"]);
  if (required.some((key) => !Object.hasOwn(frame, key)) || Object.keys(frame).some((key) => !allowed.has(key))) {
    invalid("$", "exact message fields");
  }
}

function assertExactTelemetryBatchKeys(frame: Record<string, unknown>): void {
  const required = ["protocol", "repoId", "generation", "kind", "requestId", "spans"];
  const allowed = new Set([...required, "opId"]);
  if (required.some((key) => !Object.hasOwn(frame, key)) || Object.keys(frame).some((key) => !allowed.has(key))) {
    invalid("$", "exact message fields");
  }
}

function decodeTelemetrySpan(
  value: unknown,
  path: string,
  limits: RepoWriteProtocolLimits
): RepoWriteTelemetrySpan {
  const span = telemetryRecordAt(value, path);
  const required = ["phase", "elapsedMs"];
  const allowed = new Set([...required, "details"]);
  if (required.some((key) => !Object.hasOwn(span, key)) || Object.keys(span).some((key) => !allowed.has(key))) {
    invalid(path, "exact telemetry span fields");
  }
  if (!repoWriteTelemetryPhases.includes(span.phase as RepoWriteTelemetryPhase)) {
    invalid(`${path}.phase`, "telemetry phase");
  }
  if (typeof span.elapsedMs !== "number" || !Number.isFinite(span.elapsedMs) || span.elapsedMs < 0) {
    invalid(`${path}.elapsedMs`, "non-negative finite duration");
  }
  return {
    phase: span.phase as RepoWriteTelemetryPhase,
    elapsedMs: span.elapsedMs,
    ...(Object.hasOwn(span, "details") ? { details: decodeTelemetryDetails(span.details, limits) } : {})
  };
}

function telemetryRecordAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, "object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path, "plain object");
  return value as Record<string, unknown>;
}

function telemetryIdentifier(value: unknown, path: string, limits: RepoWriteProtocolLimits): string {
  const text = telemetryStringAt(value, path, Math.min(limits.maxStringBytes, 4_096));
  if (!text.trim()) invalid(path, "non-empty identifier");
  return text;
}

function telemetryStringAt(value: unknown, path: string, maxBytes: number): string {
  if (typeof value !== "string") invalid(path, "string");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) limit(path, "string byte length", bytes, maxBytes);
  return value;
}

function telemetryPathSegment(value: string): string {
  return value.length <= 48 ? value : `${value.slice(0, 45)}...`;
}
