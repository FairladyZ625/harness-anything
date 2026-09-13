import type { JsonRpcRequest } from "../protocol/json-rpc-types.ts";

// The largest payload this transport legitimately carries in one frame is the entity content read's
// 2 MiB UTF-8 ceiling (entity-content-read.ts); the cap doubles that to cover the JSON envelope and
// string escaping. A frame that cannot terminate below the cap is a peer defect, not a payload.
export const JSON_LINE_FRAME_MAX_BYTES = 4 * 1024 * 1024;

export interface JsonLineFrameBatch {
  readonly frames: ReadonlyArray<unknown>;
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
      if (Buffer.byteLength(buffered) > JSON_LINE_FRAME_MAX_BYTES) {
        // Drop the unterminated line and hand the caller an error it can fail the connection with;
        // buffering a newline-less writer forever would grow without bound.
        const error = new Error(`JSON-RPC frame exceeds ${JSON_LINE_FRAME_MAX_BYTES} bytes`);
        buffered = "";
        return { frames: [], error };
      }
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
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
  return `${JSON.stringify(frame)}\n`;
}

export function isJsonRpcRequestLike(value: unknown): value is JsonRpcRequest | JsonRpcRequest[] {
  if (Array.isArray(value)) return value.every(isSingleJsonRpcRequestLike);
  return isSingleJsonRpcRequestLike(value);
}

function parseLines(lines: ReadonlyArray<string>): JsonLineFrameBatch {
  const frames: unknown[] = [];
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "") continue;
    try {
      frames.push(JSON.parse(line) as unknown);
    } catch (error) {
      return {
        frames,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
  return { frames };
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
