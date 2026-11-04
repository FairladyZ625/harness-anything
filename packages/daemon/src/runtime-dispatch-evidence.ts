import { existsSync, globSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { consumeKnownError } from "@harness-anything/kernel";
import { withReadOnlyFile } from "../../storage/src/durable-file.ts";
import { dispatchStreamPath, readDispatchStreamHeader } from "./dispatch-stream.ts";
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
  readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled" | "stopped";
  readonly classification: DispatchExitClassification;
  readonly reason: string;
  readonly endedAt: string;
}

type DowngradedOutcome = DispatchForensicsInput["outcome"];

// An abnormal terminal is exactly the settlement that loses its raw transport when the archive
// passes run. A worker that stopped to ask the owner is the one deliberate stop: its question is
// already a durable ruling artifact, and retaining every waiting turn would be noise.
export function dispatchForensicsRequired(
  outcome: DowngradedOutcome,
  classification: DispatchExitClassification,
): boolean {
  return (
    classification !== "awaiting_ruling" && (outcome === "failed" || outcome === "stopped" || outcome === "unknown")
  );
}

/**
 * Copy the stream, provider transcript and request trace for an abnormal settlement. Returns null
 * for a normal success and for a ruling wait; settlement therefore does not need a second check.
 * A missing transcript is recorded in the trace rather than failing the settlement.
 */
export function captureDispatchForensics(input: DispatchForensicsInput): RuntimeDispatchForensics | null {
  if (!dispatchForensicsRequired(input.outcome, input.classification)) return null;
  const streamFile = dispatchStreamPath(input.rootDir, input.dispatchId),
    stream = readSnapshot(streamFile);
  if (stream.totalBytes === 0) return null;
  const provider = readProviderTranscript(input),
    requestTrace = buildRequestTrace(input, stream, provider);
  return {
    stream: scrubJsonLines(stream.text),
    providerRollout: provider.text === null ? null : scrubJsonLines(provider.text),
    requestTrace: `${JSON.stringify(scrubProviderValue(requestTrace), null, 2)}\n`,
  };
}

const evidenceSnapshotLimitBytes = 4 * 1024 * 1024,
  evidenceHeadBytes = evidenceSnapshotLimitBytes / 2,
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
  if (stat.size <= evidenceSnapshotLimitBytes) {
    const buffer = readFileSync(file);
    return { text: buffer.toString("utf8"), totalBytes: buffer.length, capturedBytes: buffer.length, truncated: false };
  }
  const head = readRange(file, 0, evidenceHeadBytes),
    tail = readRange(file, Math.max(0, stat.size - evidenceHeadBytes), evidenceHeadBytes),
    headText = completeHead(head),
    tailText = completeTail(tail),
    marker = `${JSON.stringify({
      schema: truncatedRecordSchema,
      reason: "snapshot_limit",
      totalBytes: stat.size,
      capturedBytes: Buffer.byteLength(headText) + Buffer.byteLength(tailText),
    })}\n`;
  return {
    text: `${headText}${marker}${tailText}`,
    totalBytes: stat.size,
    capturedBytes: Buffer.byteLength(headText) + Buffer.byteLength(tailText),
    truncated: true,
  };
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

/** Keep only complete lines at the head cut so a reader never decodes half a UTF-8 record. */
function completeHead(buffer: Buffer): string {
  const text = buffer.toString("utf8"),
    newline = text.lastIndexOf("\n");
  return newline < 0 ? text : text.slice(0, newline + 1);
}

/** Drop the partial first line after the tail cut; the truncation record already separates them. */
function completeTail(buffer: Buffer): string {
  const text = buffer.toString("utf8"),
    newline = text.indexOf("\n");
  return newline < 0 ? text : text.slice(newline + 1);
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
    } catch {
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
  if (input.resolvedProviderDirectory === null) return unavailable("no resolved provider directory");
  if (input.providerSessionId === null) return unavailable("no provider session id");
  if (!/^[a-z0-9-]+$/iu.test(input.providerSessionId)) return unavailable("invalid provider session id");
  const sessions = path.join(input.resolvedProviderDirectory, "sessions");
  if (!existsSync(sessions)) return unavailable("provider sessions directory absent");
  if (input.kindId === "deepseek-harness") {
    const body = readDeepSeekSessionTranscript(input.resolvedProviderDirectory, input.providerSessionId);
    if (body === null) return unavailable("no single deepseek session transcript");
    const snapshot = snapshotBytes(body);
    return {
      capture: {
        file: `${input.providerSessionId}/session.v4.jsonl`,
        totalBytes: snapshot.totalBytes,
        capturedBytes: snapshot.capturedBytes,
        truncated: snapshot.truncated,
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

function snapshotBytes(buffer: Buffer): Snapshot {
  if (buffer.length <= evidenceSnapshotLimitBytes)
    return { text: buffer.toString("utf8"), totalBytes: buffer.length, capturedBytes: buffer.length, truncated: false };
  const head = completeHead(buffer.subarray(0, evidenceHeadBytes)),
    tail = completeTail(buffer.subarray(buffer.length - evidenceHeadBytes)),
    marker = `${JSON.stringify({
      schema: truncatedRecordSchema,
      reason: "snapshot_limit",
      totalBytes: buffer.length,
      capturedBytes: Buffer.byteLength(head) + Buffer.byteLength(tail),
    })}\n`;
  return {
    text: `${head}${marker}${tail}`,
    totalBytes: buffer.length,
    capturedBytes: Buffer.byteLength(head) + Buffer.byteLength(tail),
    truncated: true,
  };
}

interface Correlation {
  readonly threadIds: string[];
  readonly turnIds: string[];
  readonly requestIds: string[];
  readonly responseIds: string[];
  readonly passthroughTurnIds: string[];
}

const correlationKeys = new Map<string, keyof Correlation>([
  ["thread_id", "threadIds"],
  ["threadId", "threadIds"],
  ["turn_id", "turnIds"],
  ["turnId", "turnIds"],
  ["request_id", "requestIds"],
  ["requestId", "requestIds"],
  ["response_id", "responseIds"],
  ["responseId", "responseIds"],
]);

/** Collect only the identifiers that let an operator join this dispatch to a provider thread. */
function collectCorrelation(value: unknown, into: Map<keyof Correlation, Set<string>>, passthrough = false): void {
  if (typeof value === "string" || typeof value === "number") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectCorrelation(entry, into, passthrough);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const kind = correlationKeys.get(key),
      innerPassthrough = passthrough || /passthrough/iu.test(key);
    if (kind && (typeof entry === "string" || typeof entry === "number")) {
      const bucket = kind === "turnIds" && innerPassthrough ? "passthroughTurnIds" : kind;
      into.get(bucket)!.add(String(entry));
    }
    collectCorrelation(entry, into, innerPassthrough);
  }
}

function correlationOf(streamText: string, rolloutText: string | null): Correlation {
  const buckets = new Map<keyof Correlation, Set<string>>(
    (["threadIds", "turnIds", "requestIds", "responseIds", "passthroughTurnIds"] as const).map((key) => [
      key,
      new Set(),
    ]),
  );
  for (const text of [streamText, rolloutText ?? ""]) {
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        collectCorrelation(JSON.parse(line), buckets);
      } catch (error) {
        consumeKnownError(error);
        // A truncated or malformed record still carries identifiers on its surviving prefix.
        for (const [key, value] of line.matchAll(/"([a-zA-Z_]+)"\s*:\s*"([^"]+)"/gu))
          if (correlationKeys.has(key!)) buckets.get(correlationKeys.get(key!)!)!.add(value!);
      }
    }
  }
  return {
    threadIds: [...buckets.get("threadIds")!].sort().slice(0, 64),
    turnIds: [...buckets.get("turnIds")!].sort().slice(0, 64),
    requestIds: [...buckets.get("requestIds")!].sort().slice(0, 64),
    responseIds: [...buckets.get("responseIds")!].sort().slice(0, 64),
    passthroughTurnIds: [...buckets.get("passthroughTurnIds")!].sort().slice(0, 64),
  };
}

function buildRequestTrace(
  input: DispatchForensicsInput,
  stream: Snapshot,
  provider: ProviderSnapshot,
): Readonly<Record<string, unknown>> {
  const header = readDispatchStreamHeader(input.rootDir, input.dispatchId),
    correlation = correlationOf(stream.text, provider.text);
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
    // The request side is what this node asked the provider to do: the frozen dispatch header,
    // never a copy of the provider's output metadata.
    request: {
      dispatchOpId: header?.dispatchOpId ?? null,
      actor: header?.binding?.actor ?? null,
      source: header?.binding?.source ?? null,
      permissionMode: header?.permissionMode ?? null,
      model: header?.model ?? null,
      reasoningEffort: header?.reasoningEffort ?? null,
      cwd: header?.cwd ?? null,
      startedAt: header?.startedAt ?? input.endedAt,
      promptSource: header?.promptSource ?? null,
      prompt: header?.prompt ?? null,
    },
    // The response side is joinable to a provider thread/turn/request even after the live stream
    // and provider home are gone. Passthrough turn ids are split out because they are model-visible
    // metadata, not the turn the local execution declared.
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
