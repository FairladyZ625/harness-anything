import { existsSync, globSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { consumeKnownError } from "@harness-anything/kernel";
import type { DispatchAttemptOutcome } from "@harness-anything/kernel/internal/domain/dispatch-lifecycle.ts";
import { withReadOnlyFile } from "../../storage/src/durable-file.ts";
import { dispatchStreamPath } from "./dispatch-stream.ts";
import { readDeepSeekSessionTranscript } from "./runtime-spawn-deepseek-session.ts";
import { scrubProviderValue } from "./secret-scrub.ts";
import type { DispatchExitClassification } from "./runtime-fallback-contract.ts";
import type { RuntimeInstanceKind } from "./agent-runtime-instances.ts";

/**
 * One dispatch's raw stream and the provider-side session it drove, copied before settlement
 * archives and compacts the stream. The bodies are already redacted by the process-wide scrubber;
 * a reader never needs the live local root to reconstruct who asked what and which provider
 * thread/turn answered.
 */
export interface RuntimeDispatchForensics {
  /** The dispatch stream as JSONL, capped at the evidence snapshot limit. */
  readonly stream: string;
  /** The provider's native session transcript, capped the same way; null when none was found. */
  readonly providerRollout: string | null;
  /** The redacted request/response correlation record, JSON text. */
  readonly requestTrace: string;
}

/** The frozen request side the settlement already holds; evidence capture never re-reads it. */
export interface DispatchForensicsRequest {
  readonly dispatchOpId: string;
  readonly actor: unknown;
  readonly source: unknown;
  readonly permissionMode: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly cwd: string | null;
  readonly startedAt: string;
  readonly promptSource: string | null;
  readonly prompt: string;
}

export interface DispatchForensicsInput {
  readonly rootDir: string;
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly taskId: string | null;
  readonly executionId: string | null;
  readonly instanceId: string;
  readonly kindId: RuntimeInstanceKind;
  readonly providerSessionId: string | null;
  readonly resolvedProviderDirectory: string | null;
  readonly outcome: DispatchAttemptOutcome;
  readonly classification: DispatchExitClassification;
  readonly reason: string;
  readonly endedAt: string;
  readonly request: DispatchForensicsRequest;
  /** An existing marker (the dispatch's `needs_attention` incident receipt) asks for evidence. */
  readonly evidenceRequired?: boolean;
}

type DowngradedOutcome = DispatchForensicsInput["outcome"];

// The explicit marker is the dispatch's existing `needs_attention` incident receipt; the rest is
// the ordinary abnormal set. A worker that stopped to ask the owner is the one deliberate stop:
// its question is already a durable ruling artifact, so retaining every waiting turn would be noise.
export function dispatchForensicsRequired(
  outcome: DowngradedOutcome,
  classification: DispatchExitClassification,
  evidenceRequired = false,
): boolean {
  return (
    evidenceRequired ||
    (classification !== "awaiting_ruling" && (outcome === "failed" || outcome === "stopped" || outcome === "unknown"))
  );
}

/**
 * Copy the stream, provider transcript and request trace for an abnormal settlement. Returns null
 * for a normal success and for a ruling wait; settlement therefore does not need a second check.
 * A missing transcript is recorded in the trace rather than failing the settlement.
 */
export function captureDispatchForensics(input: DispatchForensicsInput): RuntimeDispatchForensics | null {
  if (!dispatchForensicsRequired(input.outcome, input.classification, input.evidenceRequired)) return null;
  const streamFile = dispatchStreamPath(input.rootDir, input.dispatchId),
    stream = readSnapshot(streamFile);
  if (stream.totalBytes === 0) return null;
  const provider = readProviderTranscript(input),
    requestTrace = buildRequestTrace(input, stream, provider);
  return {
    stream: scrubJsonLines(stream.text),
    providerRollout: provider.text === null ? null : scrubJsonLines(provider.text),
    requestTrace: serializeTrace(requestTrace),
  };
}

const evidenceSnapshotLimitBytes = 4 * 1024 * 1024,
  evidenceHeadBytes = evidenceSnapshotLimitBytes / 2,
  promptLimitBytes = 128 * 1024,
  traceLimitBytes = 512 * 1024,
  correlationValueLimit = 256,
  truncatedRecordSchema = "runtime-dispatch-evidence-truncated/v1";

interface Snapshot {
  readonly text: string;
  readonly totalBytes: number;
  readonly capturedBytes: number;
  readonly truncated: boolean;
}

interface ProviderSnapshot {
  /** Which provider log answered, for the request trace; null when neither log exists. */
  readonly capture: {
    readonly file: string | null;
    readonly totalBytes: number;
    readonly capturedBytes: number;
    readonly truncated: boolean;
    readonly reason?: string;
  };
  readonly text: string | null;
}

function readSnapshot(file: string): Snapshot {
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return { text: "", totalBytes: 0, capturedBytes: 0, truncated: false };
  if (stat.size <= evidenceSnapshotLimitBytes) return snapshotBytes(readFileSync(file));
  const head = readRange(file, 0, evidenceHeadBytes),
    tail = readRange(file, Math.max(0, stat.size - evidenceHeadBytes), evidenceHeadBytes);
  return truncatedSnapshot(head, tail, stat.size);
}

function readRange(file: string, start: number, length: number): Buffer {
  return withReadOnlyFile(file, (descriptor) => {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(descriptor, buffer, offset, length - offset, start + offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset);
  });
}

/**
 * Keep only complete lines at the head cut. A window with no newline is one unterminated
 * provider record: retaining any of it could start or end inside an arbitrary credential value,
 * where no scrubber can recover the missing field/scheme context. Fail closed and keep none.
 */
function completeHead(buffer: Buffer): string {
  const text = buffer.toString("utf8"),
    newline = text.lastIndexOf("\n");
  return newline < 0 ? "" : text.slice(0, newline + 1);
}

/**
 * Drop the partial first line after the tail cut. If the window has no newline it is entirely a
 * fragment of one record, so keep none rather than publish a mid-credential suffix.
 */
function completeTail(buffer: Buffer): string {
  const text = buffer.toString("utf8"),
    newline = text.indexOf("\n");
  return newline < 0 ? "" : text.slice(newline + 1);
}

function snapshotBytes(buffer: Buffer): Snapshot {
  if (buffer.length <= evidenceSnapshotLimitBytes)
    return { text: buffer.toString("utf8"), totalBytes: buffer.length, capturedBytes: buffer.length, truncated: false };
  return truncatedSnapshot(
    buffer.subarray(0, evidenceHeadBytes),
    buffer.subarray(Math.max(0, buffer.length - evidenceHeadBytes)),
    buffer.length,
  );
}

function truncatedSnapshot(headBuffer: Buffer, tailBuffer: Buffer, totalBytes: number): Snapshot {
  const head = completeHead(headBuffer),
    tail = completeTail(tailBuffer),
    marker = `${JSON.stringify({
      schema: truncatedRecordSchema,
      kind: "dispatch-stream-snapshot",
      truncated: true,
      reason: "snapshot_limit",
      bytes: totalBytes,
      totalBytes,
      capturedBytes: Buffer.byteLength(head) + Buffer.byteLength(tail),
    })}\n`;
  return {
    text: `${head}${marker}${tail}`,
    totalBytes,
    capturedBytes: Buffer.byteLength(head) + Buffer.byteLength(tail),
    truncated: true,
  };
}

/**
 * Scrub a JSONL transcript record by record. A record the provider wrote but this daemon cannot
 * parse is scrubbed as text: dropping it would lose the exact bytes that made it unreadable, while
 * passing it through would bypass the key-aware redaction.
 */
function scrubJsonLines(text: string): string {
  if (text.length === 0) return text;
  const endsWithNewline = text.endsWith("\n"),
    lines = text.split("\n");
  if (endsWithNewline) lines.pop();
  const scrubbed = lines.map((line) => {
    if (line.trim().length === 0) return line;
    try {
      return JSON.stringify(scrubProviderValue(JSON.parse(line)));
    } catch (error) {
      consumeKnownError(error);
      return String(scrubProviderValue(line));
    }
  });
  return `${scrubbed.join("\n")}${endsWithNewline ? "\n" : ""}`;
}

function readProviderTranscript(input: DispatchForensicsInput): ProviderSnapshot {
  const unavailable = (reason: string): ProviderSnapshot => ({
    capture: { file: null, totalBytes: 0, capturedBytes: 0, truncated: false, reason },
    text: null,
  });
  if (typeof input.resolvedProviderDirectory !== "string" || input.resolvedProviderDirectory.length === 0)
    return unavailable("no resolved provider directory");
  if (typeof input.providerSessionId !== "string" || input.providerSessionId.length === 0)
    return unavailable("no provider session id");
  if (!/^[a-z0-9-]+$/iu.test(input.providerSessionId)) return unavailable("invalid provider session id");
  const sessions = path.join(input.resolvedProviderDirectory, "sessions");
  if (!existsSync(sessions)) return unavailable("provider sessions directory absent");
  if (input.kindId === "deepseek-harness") {
    const transcript = readDeepSeekSessionTranscript(
      input.resolvedProviderDirectory,
      input.providerSessionId,
      evidenceSnapshotLimitBytes * 2,
    );
    if (transcript === null) return unavailable("no single deepseek session transcript");
    const snapshot = snapshotBytes(transcript.body);
    return {
      capture: {
        file: `${input.providerSessionId}/session.v4.jsonl`,
        totalBytes: snapshot.totalBytes,
        capturedBytes: snapshot.capturedBytes,
        truncated: snapshot.truncated || transcript.truncated,
      },
      text: snapshot.text,
    };
  }
  if (input.kindId !== "codex") return unavailable(`provider rollout capture is not implemented for ${input.kindId}`);
  const matches = globSync(`**/rollout-*-${input.providerSessionId}.jsonl`, { cwd: sessions });
  if (matches.length !== 1)
    return unavailable(`expected one rollout for the provider session, found ${matches.length}`);
  const file = path.join(sessions, matches[0]!),
    snapshot = readSnapshot(file);
  return {
    capture: {
      file: matches[0]!,
      totalBytes: snapshot.totalBytes,
      capturedBytes: snapshot.capturedBytes,
      truncated: snapshot.truncated,
    },
    text: snapshot.text,
  };
}

interface Correlation {
  readonly threadIds: string[];
  readonly turnIds: string[];
  readonly nativeTurnIds: string[];
  readonly requestIds: string[];
  readonly responseIds: string[];
  readonly passthroughTurnIds: string[];
}

const correlationKeys = new Map<string, keyof Correlation>([
  ["thread_id", "threadIds"],
  ["threadId", "threadIds"],
  ["turn_id", "turnIds"],
  ["turnId", "turnIds"],
  // deepseek-harness v4 transcripts name the native turn `data.turn` (number), never `turn_id`.
  // Keep it in a namespaced bucket so the trace can still join to the provider session.
  ["turn", "nativeTurnIds"],
  ["request_id", "requestIds"],
  ["requestId", "requestIds"],
  ["response_id", "responseIds"],
  ["responseId", "responseIds"],
]);

/** Collect only the identifiers that let an operator join this dispatch to a provider thread. */
function collectCorrelation(
  value: unknown,
  into: Map<keyof Correlation, Set<string>>,
  nativeNamespace: string,
  passthrough = false,
): void {
  if (typeof value === "string" || typeof value === "number") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectCorrelation(entry, into, nativeNamespace, passthrough);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const kind = correlationKeys.get(key),
      innerPassthrough = passthrough || /passthrough/iu.test(key);
    if (kind && (typeof entry === "string" || typeof entry === "number")) {
      const raw = String(entry);
      if (raw.length <= correlationValueLimit) {
        if (kind === "nativeTurnIds") into.get(kind)!.add(`${nativeNamespace}:turn:${raw}`);
        else {
          const bucket = kind === "turnIds" && innerPassthrough ? "passthroughTurnIds" : kind;
          into.get(bucket)!.add(raw);
        }
      }
    }
    collectCorrelation(entry, into, nativeNamespace, innerPassthrough);
  }
}

function correlationOf(streamText: string, rolloutText: string | null, nativeNamespace: string): Correlation {
  const buckets = new Map<keyof Correlation, Set<string>>(
    (["threadIds", "turnIds", "nativeTurnIds", "requestIds", "responseIds", "passthroughTurnIds"] as const).map(
      (key) => [key, new Set()],
    ),
  );
  for (const text of [streamText, rolloutText ?? ""]) {
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        collectCorrelation(JSON.parse(line), buckets, nativeNamespace);
      } catch (error) {
        consumeKnownError(error);
        // A truncated or malformed record still carries identifiers on its surviving prefix.
        for (const [key, value] of line.matchAll(/"([a-zA-Z_]+)"\s*:\s*"([^"]+)"/gu)) {
          const kind = correlationKeys.get(key!);
          if (kind === undefined || value!.length > correlationValueLimit) continue;
          if (kind === "nativeTurnIds") buckets.get(kind)!.add(`${nativeNamespace}:turn:${value!}`);
          else buckets.get(kind)!.add(value!);
        }
      }
    }
  }
  const explicitTurns = [...buckets.get("turnIds")!],
    nativeTurns = [...buckets.get("nativeTurnIds")!];
  return {
    threadIds: [...buckets.get("threadIds")!].sort().slice(0, 64),
    turnIds: [...new Set([...explicitTurns, ...nativeTurns])].sort().slice(0, 64),
    nativeTurnIds: nativeTurns.sort().slice(0, 64),
    requestIds: [...buckets.get("requestIds")!].sort().slice(0, 64),
    responseIds: [...buckets.get("responseIds")!].sort().slice(0, 64),
    passthroughTurnIds: [...buckets.get("passthroughTurnIds")!].sort().slice(0, 64),
  };
}

interface BoundedText {
  readonly text: string;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

/** Bound the request prompt before it enters the trace; the byte count stays auditable. */
function boundedText(value: string, limitBytes: number): BoundedText {
  const bytes = Buffer.from(value);
  if (bytes.length <= limitBytes) return { text: value, totalBytes: bytes.length, truncated: false };
  return {
    text: bytes.subarray(0, limitBytes).toString("utf8"),
    totalBytes: bytes.length,
    truncated: true,
  };
}

function serializeTrace(value: Readonly<Record<string, unknown>>): string {
  const scrubbed = scrubProviderValue(value) as Readonly<Record<string, unknown>>,
    serialized = JSON.stringify(scrubbed, null, 2);
  if (Buffer.byteLength(serialized) <= traceLimitBytes) return `${serialized}\n`;
  const compacted = {
    schema: scrubbed.schema,
    dispatchId: scrubbed.dispatchId,
    taskId: scrubbed.taskId,
    executionId: scrubbed.executionId,
    runtimeSessionId: scrubbed.runtimeSessionId,
    providerSessionId: scrubbed.providerSessionId,
    outcome: scrubbed.outcome,
    classification: scrubbed.classification,
    reason: scrubbed.reason,
    endedAt: scrubbed.endedAt,
    traceTruncated: true,
    traceBytes: Buffer.byteLength(serialized),
    request: { ...(scrubbed.request as Record<string, unknown>), prompt: null, promptTruncated: true },
    response: scrubbed.response,
    capture: scrubbed.capture,
  };
  return `${JSON.stringify(scrubProviderValue(compacted), null, 2)}\n`;
}

function buildRequestTrace(
  input: DispatchForensicsInput,
  stream: Snapshot,
  provider: ProviderSnapshot,
): Readonly<Record<string, unknown>> {
  const prompt = boundedText(input.request.prompt, promptLimitBytes),
    nativeNamespace = `${input.kindId}:${input.providerSessionId ?? "unknown"}`,
    correlation = correlationOf(stream.text, provider.text, nativeNamespace);
  return {
    schema: "runtime-dispatch-evidence/v1",
    dispatchId: input.dispatchId,
    taskId: input.taskId,
    executionId: input.executionId,
    runtimeSessionId: input.runtimeSessionId,
    instanceId: input.instanceId,
    kindId: input.kindId,
    providerSessionId: input.providerSessionId,
    outcome: input.outcome,
    classification: input.classification,
    reason: input.reason,
    endedAt: input.endedAt,
    // The request side is what this node asked the provider to do: the frozen dispatch request
    // the settlement already holds, never a second read of the stream header.
    request: {
      dispatchOpId: input.request.dispatchOpId,
      actor: input.request.actor,
      source: input.request.source,
      permissionMode: input.request.permissionMode,
      model: input.request.model,
      reasoningEffort: input.request.reasoningEffort,
      cwd: input.request.cwd,
      startedAt: input.request.startedAt,
      promptSource: input.request.promptSource,
      prompt: prompt.text,
      promptBytes: prompt.totalBytes,
      promptTruncated: prompt.truncated,
    },
    // The response side is joinable to a provider thread/turn/request even after the live stream
    // and provider home are gone. Native DSH turns carry their provider namespace; passthrough
    // turn ids are split out because they are model-visible metadata, not the local turn.
    response: {
      providerSessionId: input.providerSessionId,
      ...correlation,
    },
    capture: {
      stream: {
        file: path.basename(dispatchStreamPath(input.rootDir, input.dispatchId)),
        totalBytes: stream.totalBytes,
        capturedBytes: stream.capturedBytes,
        truncated: stream.truncated,
      },
      providerRollout: provider.capture,
    },
  };
}
