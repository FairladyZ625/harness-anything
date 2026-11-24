import { createHash, type Hash } from "node:crypto";
import { canonicalizeContractValue } from "@harness-anything/kernel/internal/domain/task.ts";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeContractValue(value));
}

export function hashCanonicalJsonTextFieldChunks(
  previousDigest: string,
  row: Readonly<Record<string, unknown>>,
  field: string,
  chunks: Iterable<Uint8Array>,
): string {
  const { hash, suffix } = beginCanonicalJsonTextFieldHash(previousDigest, row, field),
    decoder = new TextDecoder();
  for (const chunk of chunks) hash.update(escapeJsonStringContent(decoder.decode(chunk, { stream: true })));
  hash.update(escapeJsonStringContent(decoder.decode()));
  return hash.update(suffix).digest("hex");
}

export async function hashCanonicalJsonTextFieldChunksAsync(
  previousDigest: string,
  row: Readonly<Record<string, unknown>>,
  field: string,
  chunks: AsyncIterable<Uint8Array>,
): Promise<string> {
  const { hash, suffix } = beginCanonicalJsonTextFieldHash(previousDigest, row, field),
    decoder = new TextDecoder();
  for await (const chunk of chunks) hash.update(escapeJsonStringContent(decoder.decode(chunk, { stream: true })));
  hash.update(escapeJsonStringContent(decoder.decode()));
  return hash.update(suffix).digest("hex");
}

function beginCanonicalJsonTextFieldHash(
  previousDigest: string,
  row: Readonly<Record<string, unknown>>,
  field: string,
): { readonly hash: Hash; readonly suffix: string } {
  const serialized = canonicalJson({ ...row, [field]: "" }),
    marker = `${JSON.stringify(field)}:""`,
    markerStart = serialized.indexOf(marker);
  if (markerStart === -1) throw new Error(`canonical JSON row is missing streamed field ${field}`);
  const contentEnd = markerStart + marker.length - 1;
  return {
    hash: createHash("sha256").update(`${previousDigest}\n`).update(serialized.slice(0, contentEnd)),
    suffix: serialized.slice(contentEnd),
  };
}

function escapeJsonStringContent(value: string): string {
  return JSON.stringify(value)!.slice(1, -1);
}
