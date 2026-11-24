import { createHash, type Hash } from "node:crypto";
import { canonicalizeContractValue } from "@harness-anything/kernel/internal/domain/task.ts";

/** Millisecond instant for validated UTC timestamps, matching Date.parse (including optional
 * and sub-millisecond fractions). SQLite's date functions round fractions, so give unixepoch
 * only whole seconds and truncate the fractional part separately. */
export function isoTimestampMillisecondsSql(value: string): string {
  return `(unixepoch(substr(${value}, 1, 19) || 'Z') * 1000 + CAST(substr(substr(${value}, 21, 3) || '000', 1, 3) AS INTEGER))`;
}

/** ISO instant in UTC milliseconds. Parse whole seconds and apply the numeric offset explicitly
 * so fractions truncate like Date.parse and offsets have the same range in both engines. */
export function isoOffsetTimestampMillisecondsSql(value: string, epochSeconds: string): string {
  const zone = `substr(${value},length(${value})-5,6)`,
    hasOffset = `length(${value})>=25 AND substr(${value},length(${value}),1)<>'Z'`,
    offsetMinutes = `(CAST(substr(${zone},2,2) AS INTEGER)*60 + CAST(substr(${zone},5,2) AS INTEGER))`,
    fraction = `substr(${value},21,length(${value})-CASE WHEN ${hasOffset} THEN 26 ELSE 21 END)`;
  return `((${epochSeconds})*1000
    + CASE WHEN substr(${value},20,1)='.' THEN CAST(substr(${fraction} || '000',1,3) AS INTEGER) ELSE 0 END
    + CASE WHEN ${hasOffset} THEN (CASE WHEN substr(${zone},1,1)='+' THEN -60000 ELSE 60000 END)*${offsetMinutes} ELSE 0 END)`;
}

/** Deterministic SQLite expression for ISO-8601 instant in UTC epoch milliseconds (Date.parse truncation, ±23:59 offsets). */
export function sqliteOccurredAtEpochMsSql(column = "occurred_at"): string {
  const ms = isoOffsetTimestampMillisecondsSql(column, `unixepoch(substr(${column},1,19))`);
  return `CASE WHEN length(${column})>=20 AND substr(${column},11,1)='T' THEN ${ms} ELSE NULL END`;
}

/** Deterministic PostgreSQL expression for ISO-8601 instant in UTC epoch milliseconds (Date.parse truncation, ±23:59 offsets). */
export function pgOccurredAtEpochMsSql(value = "value"): string {
  const ms = isoOffsetTimestampMillisecondsSql(
    value,
    `EXTRACT(EPOCH FROM (CASE WHEN substr(${value},1,4)='0000'
      THEN '0001' || substr(${value},5,15) || ' BC' ELSE substr(${value},1,19) END)::timestamp)::bigint`,
  );
  return `CASE WHEN ${value} ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$' THEN ${ms} ELSE NULL END`;
}

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

export function checkedPageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 500)
    throw new Error("query page limit must be an integer between 1 and 500");
  return value;
}

export function encodePageCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

export function decodePageCursor(value: string, expected: number): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("query cursor is invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== expected ||
    parsed.some((part) => typeof part !== "string" || part.length === 0)
  )
    throw new Error("query cursor is invalid");
  return parsed;
}

const decisionIdSortAlphabet = [
    ...new Set([..."-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz"].map((c) => c.toLowerCase())),
  ].sort((left, right) => left.localeCompare(right)),
  decisionIdSortRanks = new Map(decisionIdSortAlphabet.map((character, rank) => [character, rank])),
  lowercaseSortWeight = "a".localeCompare("A") < 0 ? "!" : '"',
  uppercaseSortWeight = lowercaseSortWeight === "!" ? '"' : "!";

/** Encodes the ASCII identifier collation used by localeCompare into a SQLite BINARY-sortable key. */
export function decisionIdSortKey(decisionId: string): string {
  const primary: string[] = [],
    caseWeight: string[] = [];
  for (const character of decisionId) {
    const rank = decisionIdSortRanks.get(character.toLowerCase());
    if (rank === undefined) throw new Error(`decision id contains unsupported character ${JSON.stringify(character)}`);
    primary.push(String.fromCharCode(33 + rank));
    caseWeight.push(character >= "A" && character <= "Z" ? uppercaseSortWeight : lowercaseSortWeight);
  }
  return `${primary.join("")} ${caseWeight.join("")}`;
}

export function decisionLegacyId(decisionId: string): string | undefined {
  const match = /(?:^|_)E([1-9][0-9]*)(?:_|$)/u.exec(decisionId);
  return match ? `E${Number(match[1])}` : undefined;
}
