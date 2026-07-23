import type {
  RepoWriteJsonObject,
  RepoWriteJsonValue
} from "./repo-write-protocol.ts";
import { RepoWriteOutcomeValidationError } from "./repo-write-outcome-errors.ts";

const maximumDepth = 32;
const maximumNodes = 16_384;
const maximumArrayItems = 16_384;
const maximumAggregateBytes = 1024 * 1024;
const maximumStringBytes = 256 * 1024;

export interface RepoWriteJsonBudget {
  nodes: number;
  bytes: number;
}

export function repoWriteJsonBudget(): RepoWriteJsonBudget {
  return { nodes: 0, bytes: 0 };
}

export function repoWriteJsonObjectAt(
  value: unknown,
  path: string,
  budget: RepoWriteJsonBudget,
  depth: number
): RepoWriteJsonObject {
  const decoded = repoWriteJsonValueAt(value, path, budget, depth);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    repoWriteJsonBudgetInvalid(path, "JSON object");
  }
  return decoded as RepoWriteJsonObject;
}

export function repoWriteJsonValueAt(
  value: unknown,
  path: string,
  budget: RepoWriteJsonBudget,
  depth: number
): RepoWriteJsonValue {
  budget.nodes += 1;
  budget.bytes += 1;
  if (budget.nodes > maximumNodes) repoWriteJsonBudgetInvalid(path, "bounded JSON node count");
  if (budget.bytes > maximumAggregateBytes) {
    repoWriteJsonBudgetInvalid(path, "bounded aggregate JSON bytes");
  }
  if (depth > maximumDepth) repoWriteJsonBudgetInvalid(path, "bounded JSON depth");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    repoWriteJsonBudgetConsumeBytes(budget, value, path);
    if (Buffer.byteLength(value, "utf8") > maximumStringBytes) {
      repoWriteJsonBudgetInvalid(path, `string no larger than ${maximumStringBytes} bytes`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) repoWriteJsonBudgetInvalid(path, "finite JSON number");
    repoWriteJsonBudgetConsumeBytes(budget, String(value), path);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > maximumArrayItems) {
      repoWriteJsonBudgetInvalid(path, "bounded JSON array item count");
    }
    return value.map((entry, index) =>
      repoWriteJsonValueAt(entry, `${path}[${index}]`, budget, depth + 1));
  }
  const record = repoWriteJsonBudgetRecordAt(value, path);
  const result: Record<string, RepoWriteJsonValue> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      repoWriteJsonBudgetInvalid(path, "safe JSON object keys");
    }
    repoWriteJsonBudgetConsumeBytes(budget, key, `${path} key`);
    result[key] = repoWriteJsonValueAt(
      entry,
      `${path}.${repoWriteJsonBudgetBoundedSegment(key)}`,
      budget,
      depth + 1
    );
  }
  return result;
}

function repoWriteJsonBudgetRecordAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    repoWriteJsonBudgetInvalid(path, "plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    repoWriteJsonBudgetInvalid(path, "plain object");
  }
  return value as Record<string, unknown>;
}

function repoWriteJsonBudgetConsumeBytes(
  budget: RepoWriteJsonBudget,
  value: string,
  path: string
): void {
  budget.bytes += Buffer.byteLength(value, "utf8");
  if (budget.bytes > maximumAggregateBytes) {
    repoWriteJsonBudgetInvalid(path, "bounded aggregate JSON bytes");
  }
}

function repoWriteJsonBudgetBoundedSegment(value: string): string {
  return value.length <= 48 ? value : `${value.slice(0, 45)}...`;
}

function repoWriteJsonBudgetInvalid(path: string, expected: string): never {
  throw new RepoWriteOutcomeValidationError(
    `Invalid durable repo-write JSON at ${path.slice(0, 160)}: expected ${expected}.`
  );
}
