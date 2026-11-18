import type { JsonRpcRequest } from "../protocol/json-rpc-types.ts";
import { encodeJsonRpcFrame } from "../protocol/json-rpc-encoding.ts";
import { JSON_LINE_FRAME_MAX_BYTES } from "../runtime-relay-target.ts";
export { JSON_LINE_FRAME_MAX_BYTES };

export interface JsonLineFrameBatch {
  readonly frames: ReadonlyArray<unknown>;
  /** UTF-8 byte length of each complete line, in the same order as `frames`. */
  readonly frameBytes?: ReadonlyArray<number>;
  readonly error?: Error;
}

export interface JsonLineFrameReader {
  readonly push: (chunk: Buffer | string) => JsonLineFrameBatch;
  readonly flush: () => JsonLineFrameBatch;
}

export function createJsonLineFrameReader(): JsonLineFrameReader {
  let buffered = "";
  return {
    push: (chunk) => {
      buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      // Complete lines are frames regardless of how many arrived in one chunk; the cap bounds only the
      // unterminated remainder, because buffering a newline-less writer forever would grow without bound.
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      if (Buffer.byteLength(buffered) > JSON_LINE_FRAME_MAX_BYTES) {
        // Drop the unterminated line and hand the caller an error it can fail the connection with.
        const error = new Error(`JSON-RPC frame exceeds ${JSON_LINE_FRAME_MAX_BYTES} bytes`);
        buffered = "";
        return { frames: [], error };
      }
      return parseLines(lines);
    },
    flush: () => {
      if (buffered.trim() === "") {
        buffered = "";
        return { frames: [] };
      }
      const pending = buffered;
      buffered = "";
      return parseLines([pending]);
    },
  };
}

export function encodeJsonLineFrame(frame: unknown): string {
  return encodeJsonRpcFrame(frame);
}

export function isJsonRpcRequestLike(value: unknown): value is JsonRpcRequest | JsonRpcRequest[] {
  if (Array.isArray(value)) return value.every(isSingleJsonRpcRequestLike);
  return isSingleJsonRpcRequestLike(value);
}

function parseLines(lines: ReadonlyArray<string>): JsonLineFrameBatch {
  const frames: unknown[] = [],
    frameBytes: number[] = [];
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "") continue;
    try {
      frames.push(JSON.parse(line) as unknown);
      frameBytes.push(Buffer.byteLength(rawLine, "utf8") + 1);
    } catch (error) {
      return {
        frames,
        ...(frameBytes.length === frames.length ? { frameBytes } : {}),
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
  return { frames, ...(frameBytes.length > 0 ? { frameBytes } : {}) };
}

function isSingleJsonRpcRequestLike(value: unknown): value is JsonRpcRequest {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { readonly jsonrpc?: unknown }).jsonrpc === "2.0" &&
    typeof (value as { readonly method?: unknown }).method === "string"
  );
}
