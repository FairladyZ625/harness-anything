import { StringDecoder } from "node:string_decoder";
import type { JsonRpcRequest } from "../protocol/json-rpc-types.ts";

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
  let decoder = new StringDecoder("utf8");
  return {
    push: (chunk) => {
      if (typeof chunk === "string") {
        buffered += decoder.end() + chunk;
        decoder = new StringDecoder("utf8");
      } else {
        buffered += decoder.write(chunk);
      }
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      return parseLines(lines);
    },
    flush: () => {
      buffered += decoder.end();
      if (buffered.trim() === "") {
        buffered = "";
        return { frames: [] };
      }
      const pending = buffered;
      buffered = "";
      return parseLines([pending]);
    }
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
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }
  return { frames };
}

function isSingleJsonRpcRequestLike(value: unknown): value is JsonRpcRequest {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { readonly jsonrpc?: unknown }).jsonrpc === "2.0"
    && typeof (value as { readonly method?: unknown }).method === "string";
}
