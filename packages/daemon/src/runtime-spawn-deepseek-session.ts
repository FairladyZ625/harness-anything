import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { consumeKnownError } from "@harness-anything/kernel";

/** dsh billing buckets for one whole session, folded from its durable transcript. */
export interface DeepSeekSessionUsage {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/** One (turn, step) usage sample as the provider reported it. */
interface UsageSample extends DeepSeekSessionUsage {
  turn: number;
  step: number;
}

const ZSTD_MAGIC = 0xfd2fb528;

function providerRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * The complete dsh session usage, folded from the session transcript the provider
 * itself durably logged. The transcript — `sessions/<project>/<id>/session.v4.jsonl.zstd`
 * under the provider home frozen at launch — is the billing authority; the
 * `session_projcache` JSON beside it is only a checkpoint that lags the log whenever
 * the provider exits before its fire-and-forget write-back, so it is never consulted.
 * Returns null when no single transcript is on disk or its content cannot be trusted
 * (no usage rows, a foreign format generation, a corrupt log): settlement then
 * reports the usage as unavailable rather than a partial total as the session bill.
 */
export function deepSeekSessionUsageTotals(providerHome: string, sessionId: string): DeepSeekSessionUsage | null {
  const sessionsRoot = path.join(providerHome, "sessions"),
    // The project directory encodes the session cwd, which the daemon never knows;
    // the session id is a validated `[a-z0-9-]+` filename component.
    matches = globSync(`**/${sessionId}/session.v4.jsonl*`, { cwd: sessionsRoot });
  if (matches.length !== 1) return null;
  try {
    const raw = readFileSync(path.join(sessionsRoot, matches[0]!));
    return foldSessionUsage(decompressSessionLog(raw, matches[0]!.endsWith(".zstd")));
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

/**
 * Expand the transcript's concatenated zstd frames. Node's one-shot zstd decode
 * stops after the first frame, and dsh appends one independently decodable frame
 * per committed batch, so complete frames are located structurally — a torn final
 * frame (a crash mid-append) ends the scan — and decoded one by one.
 */
function decompressSessionLog(raw: Buffer, zstd: boolean): Buffer {
  if (!zstd) return raw;
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const frame = zstdFrameRange(raw, offset);
    if (frame === null) break;
    frames.push(zstdDecompressSync(raw.subarray(frame.start, frame.end)));
    offset = frame.end;
  }
  return Buffer.concat(frames);
}

/** The byte range of the complete zstd frame at `start`: null when the buffer ends
 * inside the frame (torn), a throw when the structure is corrupt. Frame layout per
 * the zstd format: magic, descriptor (content-size / single-segment / checksum /
 * dictionary flags), optional window byte, 3-byte block headers, optional checksum. */
function zstdFrameRange(buffer: Buffer, start: number): { start: number; end: number } | null {
  let offset = start;
  if (buffer.length - offset < 4) return null;
  if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC)
    throw new Error(`corrupt zstd session log: invalid frame magic at byte ${offset}`);
  offset += 4;
  if (offset === buffer.length) return null;
  const descriptor = buffer.readUInt8(offset);
  offset += 1;
  if ((descriptor & 0x18) !== 0)
    throw new Error(`corrupt zstd session log: reserved frame-header bit at byte ${offset - 1}`);
  const contentSizeFlag = descriptor >>> 6,
    singleSegment = (descriptor & 0x20) !== 0,
    checksum = (descriptor & 0x04) !== 0,
    dictionaryFlag = descriptor & 0x03,
    dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag,
    contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag,
    remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  if (buffer.length - offset < remainingHeaderBytes) return null;
  offset += remainingHeaderBytes;
  for (;;) {
    if (buffer.length - offset < 3) return null;
    const blockHeader = buffer.readUIntLE(offset, 3);
    offset += 3;
    const lastBlock = (blockHeader & 1) !== 0,
      blockType = (blockHeader >>> 1) & 0x03,
      blockSize = blockHeader >>> 3;
    if (blockType === 0x03) throw new Error(`corrupt zstd session log: reserved block type at byte ${offset - 3}`);
    const payloadBytes = blockType === 0x01 ? 1 : blockSize;
    if (buffer.length - offset < payloadBytes) return null;
    offset += payloadBytes;
    if (lastBlock) break;
  }
  if (checksum) {
    if (buffer.length - offset < 4) return null;
    offset += 4;
  }
  return { start, end: offset };
}

/**
 * Fold the transcript's usage rows with the provider's own projection algorithm
 * (dsh `tokenUsage`): every `assistant` usage sample belongs to a (turn, step), and
 * a later sample of the same turn/step replaces the earlier one instead of adding
 * to it — an early per-chunk sample is superseded by the finalized message. Any
 * anomaly — a non-object row, a `seq` gap, a foreign format version, a usage row
 * without integer buckets — throws, so the caller settles unavailable rather than
 * reporting a partial total.
 */
function foldSessionUsage(plaintext: Buffer): DeepSeekSessionUsage | null {
  const lines = plaintext.toString("utf8").split("\n");
  // A final record without its newline is a torn tail; a trailing newline leaves "".
  lines.pop();
  if (lines.length === 0) throw new Error("empty session transcript");
  const header = jsonRecord(lines[0]!);
  if (header.type !== "session" || header.version !== 4)
    throw new Error(`session transcript header is not a v4 log: ${String(header.type)}`);
  let expectedSeq = 0,
    totals: DeepSeekSessionUsage | null = null,
    last: UsageSample | null = null;
  for (let index = 1; index < lines.length; index += 1) {
    const record = jsonRecord(lines[index]!),
      type = record.type;
    // Packed delta-chunk rows never carry usage (usage stays one event per line);
    // they still advance the seq sequence by their member count.
    if (type === "text-chunks" || type === "reasoning-chunks" || type === "tool-call-chunks") {
      const data = providerRecord(record.data) ? record.data : null;
      if (!Array.isArray(data?.dt) || record.seq0 !== expectedSeq)
        throw new Error(`corrupt session transcript: packed row breaks the seq sequence at line ${index + 1}`);
      expectedSeq += data.dt.length + 1;
      continue;
    }
    if (record.seq !== expectedSeq)
      throw new Error(`corrupt session transcript: seq gap at line ${index + 1} (expected ${expectedSeq})`);
    expectedSeq += 1;
    const sample = usageSampleOf(type, record.data);
    if (sample === undefined) continue;
    totals = addSample(totals, last, sample);
    last = sample;
  }
  return totals === null ? null : totals;
}

/** Parse one transcript row, rejecting anything that is not a JSON object. */
function jsonRecord(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (!providerRecord(value)) throw new Error("session transcript row is not a JSON object");
  return value;
}

/** The billing sample one row carries, undefined when the row reports no usage. */
function usageSampleOf(type: unknown, data: unknown): UsageSample | undefined {
  if (!providerRecord(data)) throw new Error("session transcript event data is not an object");
  let usage: unknown;
  if (type === "assistant/chunk") {
    const chunk = providerRecord(data.chunk) ? data.chunk : null;
    if (chunk === null || chunk.type !== "usage") return undefined;
    usage = chunk.usage;
  } else if (type === "assistant/message") {
    if (data.usage === undefined) return undefined;
    usage = data.usage;
  } else return undefined;
  if (!providerRecord(usage) || typeof data.turn !== "number" || typeof data.step !== "number")
    throw new Error("session transcript usage row is malformed");
  const uncachedInputTokens = nonnegativeInteger(usage.inputTokens),
    outputTokens = nonnegativeInteger(usage.outputTokens),
    cacheReadTokens = usage.cacheReadTokens === undefined ? 0 : nonnegativeInteger(usage.cacheReadTokens),
    cacheWriteTokens = usage.cacheWriteTokens === undefined ? 0 : nonnegativeInteger(usage.cacheWriteTokens);
  if (uncachedInputTokens === null || outputTokens === null || cacheReadTokens === null || cacheWriteTokens === null)
    throw new Error("session transcript usage row lacks integer token buckets");
  return { turn: data.turn, step: data.step, uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens };
}

/** Add a sample to the running totals, replacing the previous sample of the same
 * turn/step instead of double counting its superseded value. */
function addSample(
  totals: DeepSeekSessionUsage | null,
  last: UsageSample | null,
  sample: UsageSample,
): DeepSeekSessionUsage {
  if (totals === null)
    return {
      uncachedInputTokens: sample.uncachedInputTokens,
      cacheReadTokens: sample.cacheReadTokens,
      cacheWriteTokens: sample.cacheWriteTokens,
      outputTokens: sample.outputTokens,
    };
  const replace = last !== null && last.turn === sample.turn && last.step === sample.step ? last : null;
  return {
    uncachedInputTokens: totals.uncachedInputTokens - (replace?.uncachedInputTokens ?? 0) + sample.uncachedInputTokens,
    cacheReadTokens: totals.cacheReadTokens - (replace?.cacheReadTokens ?? 0) + sample.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens - (replace?.cacheWriteTokens ?? 0) + sample.cacheWriteTokens,
    outputTokens: totals.outputTokens - (replace?.outputTokens ?? 0) + sample.outputTokens,
  };
}
