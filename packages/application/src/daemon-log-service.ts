import { createHmac, randomBytes } from "node:crypto";
import {
  DaemonLogContractError,
  decodeDaemonLogEntry,
  decodeDaemonLogListInput,
  type DaemonLogEntryV1,
  type DaemonLogListInputV1,
  type DaemonLogPageV1,
  type DaemonLogRepoContext,
  type DaemonLogService
} from "./daemon-log-contract.ts";

export interface DaemonLogServiceOptions {
  readonly store: DaemonLogStorePort;
  readonly now?: () => string;
  readonly cursorSecret?: string | Uint8Array;
}

export interface DaemonLogStoreReadResult {
  readonly records: ReadonlyArray<unknown>;
  readonly droppedCount: number;
}

export interface DaemonLogStorePort {
  readonly append: (entry: DaemonLogEntryV1) => Promise<void>;
  readonly read: () => Promise<DaemonLogStoreReadResult>;
}

const messageLimit = 4_096;
const hintLimit = 2_048;

export function makeDaemonLogService(options: DaemonLogServiceOptions): DaemonLogService {
  const cursorSecret = options.cursorSecret ?? randomBytes(32);
  let appendTail = Promise.resolve();
  let nextSequence: number | undefined;
  return {
    append: (input, context) => {
      const operation = appendTail.then(async () => {
        nextSequence ??= await readNextSequence(options.store);
        const entry = redactDaemonLogEntry({
          schema: "daemon-log-entry/v1",
          timestamp: options.now?.() ?? new Date().toISOString(),
          sequence: nextSequence,
          ...input,
          repoId: context.repo.repoId,
          redaction: { policy: "runtime-log-redaction/v1", fieldsRemoved: [], truncated: false }
        }, context.repo.canonicalRoot);
        nextSequence += 1;
        await options.store.append(entry);
        return entry;
      });
      appendTail = operation.then(() => undefined, () => undefined);
      return operation;
    },
    list: async (input, context) => {
      await appendTail;
      return listEntries(options.store, input, context, cursorSecret);
    }
  };
}

async function listEntries(
  store: DaemonLogStorePort,
  rawInput: DaemonLogListInputV1,
  context: DaemonLogRepoContext,
  cursorSecret: string | Uint8Array
): Promise<DaemonLogPageV1> {
  const input = decodeDaemonLogListInput(rawInput);
  const read = await readAllEntries(store, context.repo.canonicalRoot);
  const filtered = read.entries
    .filter((entry) => entry.repoId === context.repo.repoId)
    .filter((entry) => input.since === null || Date.parse(entry.timestamp) >= Date.parse(input.since))
    .filter((entry) => input.levels.length === 0 || input.levels.includes(entry.level))
    .filter((entry) => !input.errorOnly || entry.level === "error" || entry.level === "fatal")
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp) || right.sequence - left.sequence);
  const offset = input.cursor === null
    ? 0
    : cursorOffset(filtered, decodeCursor(input.cursor, context.repo.repoId, input, cursorSecret));
  const entries = filtered.slice(offset, offset + input.limit);
  const hasMore = offset + entries.length < filtered.length;
  return {
    schema: "daemon-log-page/v1",
    entries,
    nextCursor: hasMore && entries.length > 0
      ? encodeCursor(entries.at(-1)!.sequence, context.repo.repoId, input, cursorSecret)
      : null,
    truncated: read.droppedCount > 0 || entries.some((entry) => entry.redaction.truncated),
    droppedCount: read.droppedCount
  };
}

async function readAllEntries(
  store: DaemonLogStorePort,
  canonicalRoot: string
): Promise<{ readonly entries: ReadonlyArray<DaemonLogEntryV1>; readonly droppedCount: number }> {
  const stored = await store.read();
  const entries: DaemonLogEntryV1[] = [];
  let droppedCount = stored.droppedCount;
  for (const record of stored.records) {
    try {
      const decoded = decodeDaemonLogEntry(record);
      entries.push(redactDaemonLogEntry(decoded, canonicalRoot));
    } catch {
      droppedCount += 1;
    }
  }
  return { entries, droppedCount };
}

function redactDaemonLogEntry(entry: DaemonLogEntryV1, canonicalRoot?: string): DaemonLogEntryV1 {
  const fieldsRemoved = new Set(entry.redaction.fieldsRemoved);
  const message = redactText(entry.message, canonicalRoot, messageLimit, fieldsRemoved, "message");
  const hintResult = typeof entry.hint === "string"
    ? redactText(entry.hint, canonicalRoot, hintLimit, fieldsRemoved, "hint")
    : undefined;
  const redacted: DaemonLogEntryV1 = {
    ...entry,
    message: message.value,
    ...(entry.hint !== undefined ? { hint: hintResult?.value ?? null } : {}),
    redaction: {
      policy: "runtime-log-redaction/v1",
      fieldsRemoved: [...fieldsRemoved].slice(0, 32),
      truncated: entry.redaction.truncated || message.truncated || hintResult?.truncated === true
    }
  };
  return decodeDaemonLogEntry(redacted);
}

function redactText(
  value: string,
  canonicalRoot: string | undefined,
  limit: number,
  fieldsRemoved: Set<string>,
  field: string
): { readonly value: string; readonly truncated: boolean } {
  let result = value;
  if (canonicalRoot && result.includes(canonicalRoot)) {
    result = result.split(canonicalRoot).join("<repo-root>");
    fieldsRemoved.add(`${field}.canonicalRoot`);
  }
  const patterns: ReadonlyArray<RegExp> = [
    /\b(?:authorization|token|api[_-]?key|secret|password)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/giu,
    /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{8,}\b/gu
  ];
  for (const pattern of patterns) {
    const replaced = result.replace(pattern, "<redacted>");
    if (replaced !== result) fieldsRemoved.add(field);
    result = replaced;
  }
  const environmentRedacted = result.replace(
    /\b([A-Z][A-Z0-9_]{1,63})=(?:"[^"]*"|'[^']*'|[^\s,;]+)/gu,
    "$1=<redacted>"
  );
  if (environmentRedacted !== result) fieldsRemoved.add(field);
  result = environmentRedacted;
  return truncateUtf8(result, limit);
}

function truncateUtf8(value: string, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
  let bytes = 0;
  let bounded = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    bounded += character;
    bytes += characterBytes;
  }
  return { value: bounded, truncated: true };
}

async function readNextSequence(store: DaemonLogStorePort): Promise<number> {
  const read = await readAllEntries(store, "");
  return read.entries.reduce((highest, entry) => Math.max(highest, entry.sequence + 1), 0);
}

function encodeCursor(
  lastSequence: number,
  repoId: string,
  input: Required<DaemonLogListInputV1>,
  cursorSecret: string | Uint8Array
): string {
  const payload = JSON.stringify({ lastSequence, repoId, filter: cursorFilter(input) });
  const signature = createHmac("sha256", cursorSecret).update(payload).digest("hex").slice(0, 24);
  return Buffer.from(JSON.stringify({ payload, signature }), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string,
  repoId: string,
  input: Required<DaemonLogListInputV1>,
  cursorSecret: string | Uint8Array
): number {
  try {
    const envelope = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { payload?: unknown; signature?: unknown };
    if (typeof envelope.payload !== "string" || typeof envelope.signature !== "string") throw new Error("invalid envelope");
    const expected = createHmac("sha256", cursorSecret).update(envelope.payload).digest("hex").slice(0, 24);
    if (envelope.signature !== expected) throw new Error("invalid signature");
    const payload = JSON.parse(envelope.payload) as { lastSequence?: unknown; repoId?: unknown; filter?: unknown };
    if (!Number.isInteger(payload.lastSequence) || Number(payload.lastSequence) < 0 || payload.repoId !== repoId || payload.filter !== cursorFilter(input)) {
      throw new Error("cursor scope mismatch");
    }
    return Number(payload.lastSequence);
  } catch {
    throw new DaemonLogContractError("invalid_daemon_log_cursor", "daemon log cursor is invalid or does not match the requested repo and filters");
  }
}

function cursorOffset(entries: ReadonlyArray<DaemonLogEntryV1>, lastSequence: number): number {
  const index = entries.findIndex((entry) => entry.sequence === lastSequence);
  if (index < 0) {
    throw new DaemonLogContractError("invalid_daemon_log_cursor", "daemon log cursor no longer points to a retained entry");
  }
  return index + 1;
}

function cursorFilter(input: Required<DaemonLogListInputV1>): string {
  return JSON.stringify({ limit: input.limit, since: input.since, levels: [...input.levels].sort(), errorOnly: input.errorOnly });
}
