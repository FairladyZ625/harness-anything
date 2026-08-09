import type {
  RepoWriteJsonObject,
  RepoWriteJsonValue,
  RepoWriteProtocolLimits
} from "./repo-write-protocol.ts";
import {
  invalidRepoWriteProtocol as invalid,
  limitRepoWriteProtocol as limit
} from "./repo-write-protocol-errors.ts";
import {
  decodeRepoWriteBigInt,
  decodeRepoWriteBytes
} from "./repo-write-protocol-scalars.ts";

export function decodeRepoWriteJsonObject(
  value: unknown,
  path: string,
  limits: RepoWriteProtocolLimits,
  budget: { nodes: number },
  depth: number
): RepoWriteJsonObject {
  const decoded = decodeRepoWriteJsonValue(value, path, limits, budget, depth);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    invalid(path, "JSON object");
  }
  return decoded as RepoWriteJsonObject;
}

function decodeRepoWriteJsonValue(
  value: unknown,
  path: string,
  limits: RepoWriteProtocolLimits,
  budget: { nodes: number },
  depth: number
): RepoWriteJsonValue {
  budget.nodes += 1;
  if (budget.nodes > limits.maxNodes) limit(path, "node count");
  if (depth > limits.maxDepth) limit(path, "nesting depth");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return repoWriteStringAt(value, path, limits.maxStringBytes);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(path, "finite JSON number");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayItems) limit(path, "array item count");
    return value.map((item, index) =>
      decodeRepoWriteJsonValue(item, `${path}[${index}]`, limits, budget, depth + 1)
    );
  }
  const record = repoWriteRecordAt(value, path);
  const entries = Object.entries(record);
  if (entries.length > limits.maxObjectKeys) limit(path, "object key count");
  const result: Record<string, RepoWriteJsonValue> = {};
  for (const [key, item] of entries) {
    repoWriteStringAt(key, `${path} key`, limits.maxStringBytes);
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      invalid(path, "safe JSON object keys");
    }
    result[key] = decodeRepoWriteJsonValue(
      item,
      `${path}.${boundedPathSegment(key)}`,
      limits,
      budget,
      depth + 1
    );
  }
  if ("$repoWriteType" in result) {
    if (result.$repoWriteType === "bigint") decodeRepoWriteBigInt(result);
    else if (result.$repoWriteType === "bytes") decodeRepoWriteBytes(result);
    else invalid(`${path}.$repoWriteType`, "known explicit text encoding");
  }
  return result;
}

export function repoWriteRecordAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, "object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path, "plain object");
  return value as Record<string, unknown>;
}

export function repoWriteStringAt(value: unknown, path: string, maxBytes: number): string {
  if (typeof value !== "string") invalid(path, "string");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) limit(path, "string byte length", bytes, maxBytes);
  return value;
}

function boundedPathSegment(value: string): string {
  return value.length <= 48 ? value : `${value.slice(0, 45)}...`;
}
