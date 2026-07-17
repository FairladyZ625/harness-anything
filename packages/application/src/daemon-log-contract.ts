export const daemonLogLevels = ["debug", "info", "warn", "error", "fatal"] as const;
export type DaemonLogLevel = (typeof daemonLogLevels)[number];

export interface DaemonLogRedactionV1 {
  readonly policy: "runtime-log-redaction/v1";
  readonly fieldsRemoved: ReadonlyArray<string>;
  readonly truncated: boolean;
}

export interface DaemonLogEntryV1 {
  readonly schema: "daemon-log-entry/v1";
  readonly timestamp: string;
  readonly sequence: number;
  readonly level: DaemonLogLevel;
  readonly source: "daemon" | "cli";
  readonly component: string;
  readonly event: string;
  readonly message: string;
  readonly errorCode?: string | null;
  readonly hint?: string | null;
  readonly repoId?: string | null;
  readonly requestId?: string | null;
  readonly taskId?: string | null;
  readonly executionId?: string | null;
  readonly redaction: DaemonLogRedactionV1;
}

export interface DaemonLogListInputV1 {
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly since?: string | null;
  readonly levels?: ReadonlyArray<DaemonLogLevel>;
  readonly errorOnly?: boolean;
}

export interface DaemonLogPageV1 {
  readonly schema: "daemon-log-page/v1";
  readonly entries: ReadonlyArray<DaemonLogEntryV1>;
  readonly nextCursor: string | null;
  readonly truncated: boolean;
  readonly droppedCount: number;
}

export interface DaemonLogRepoContext {
  readonly repo: {
    readonly repoId: string;
    readonly canonicalRoot: string;
  };
}

export interface DaemonLogAppendInput {
  readonly level: DaemonLogLevel;
  readonly source: "daemon" | "cli";
  readonly component: string;
  readonly event: string;
  readonly message: string;
  readonly errorCode?: string | null;
  readonly hint?: string | null;
  readonly requestId?: string | null;
  readonly taskId?: string | null;
  readonly executionId?: string | null;
}

export interface DaemonLogService {
  readonly append: (input: DaemonLogAppendInput, context: DaemonLogRepoContext) => Promise<DaemonLogEntryV1>;
  readonly list: (input: DaemonLogListInputV1, context: DaemonLogRepoContext) => Promise<DaemonLogPageV1>;
}

export class DaemonLogContractError extends Error {
  readonly code: "invalid_daemon_log_entry" | "invalid_daemon_log_list_input" | "invalid_daemon_log_cursor";

  constructor(code: DaemonLogContractError["code"], message: string) {
    super(message);
    this.name = "DaemonLogContractError";
    this.code = code;
  }
}

export function decodeDaemonLogListInput(value: unknown): Required<DaemonLogListInputV1> {
  if (value !== undefined && value !== null && !isDaemonLogObject(value)) {
    throw new DaemonLogContractError("invalid_daemon_log_list_input", "daemon log list input must be an object");
  }
  const input = isDaemonLogObject(value) ? value : {};
  rejectUnknownKeys(input, ["cursor", "limit", "since", "levels", "errorOnly"], "invalid_daemon_log_list_input");
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 200) {
    throw new DaemonLogContractError("invalid_daemon_log_list_input", "limit must be an integer from 1 through 200");
  }
  const cursor = input.cursor ?? null;
  if (cursor !== null && (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 512)) {
    throw new DaemonLogContractError("invalid_daemon_log_list_input", "cursor must be null or a non-empty string no longer than 512 characters");
  }
  const since = input.since ?? null;
  if (since !== null && !isIsoTimestamp(since)) {
    throw new DaemonLogContractError("invalid_daemon_log_list_input", "since must be null or an ISO-8601 timestamp");
  }
  const levels = input.levels ?? [];
  if (!Array.isArray(levels) || levels.length > daemonLogLevels.length || new Set(levels).size !== levels.length
    || levels.some((level) => !isDaemonLogLevel(level))) {
    throw new DaemonLogContractError("invalid_daemon_log_list_input", "levels must contain unique daemon log levels");
  }
  const errorOnly = input.errorOnly ?? false;
  if (typeof errorOnly !== "boolean") {
    throw new DaemonLogContractError("invalid_daemon_log_list_input", "errorOnly must be a boolean");
  }
  return { cursor, limit: Number(limit), since, levels: levels as ReadonlyArray<DaemonLogLevel>, errorOnly };
}

export function decodeDaemonLogEntry(value: unknown): DaemonLogEntryV1 {
  if (!isDaemonLogObject(value)) throw invalidEntry("entry must be an object");
  rejectUnknownKeys(value, [
    "schema", "timestamp", "sequence", "level", "source", "component", "event", "message",
    "errorCode", "hint", "repoId", "requestId", "taskId", "executionId", "redaction"
  ], "invalid_daemon_log_entry");
  if (value.schema !== "daemon-log-entry/v1") throw invalidEntry("schema must be daemon-log-entry/v1");
  if (!isIsoTimestamp(value.timestamp)) throw invalidEntry("timestamp must be an ISO-8601 timestamp");
  if (!Number.isInteger(value.sequence) || Number(value.sequence) < 0) throw invalidEntry("sequence must be a non-negative integer");
  if (!isDaemonLogLevel(value.level)) throw invalidEntry("level is not supported");
  if (value.source !== "daemon" && value.source !== "cli") throw invalidEntry("source must be daemon or cli");
  if (!isBoundedPattern(value.component, /^[a-z0-9][a-z0-9.-]*$/u, 80)) throw invalidEntry("component is invalid");
  if (!isBoundedPattern(value.event, /^[a-z0-9][a-z0-9._-]*$/u, 120)) throw invalidEntry("event is invalid");
  if (typeof value.message !== "string" || value.message.length > 4_096) throw invalidEntry("message is invalid");
  for (const key of ["errorCode", "repoId", "requestId", "taskId", "executionId"] as const) {
    if (!isOptionalNullableBoundedString(value[key], 256)) throw invalidEntry(`${key} is invalid`);
  }
  if (!isOptionalNullableBoundedString(value.hint, 2_048)) throw invalidEntry("hint is invalid");
  if (!isDaemonLogObject(value.redaction)) throw invalidEntry("redaction is invalid");
  rejectUnknownKeys(value.redaction, ["policy", "fieldsRemoved", "truncated"], "invalid_daemon_log_entry");
  if (value.redaction.policy !== "runtime-log-redaction/v1" || !Array.isArray(value.redaction.fieldsRemoved)
    || value.redaction.fieldsRemoved.length > 32
    || value.redaction.fieldsRemoved.some((field) => typeof field !== "string" || field.length > 80)
    || typeof value.redaction.truncated !== "boolean") {
    throw invalidEntry("redaction is invalid");
  }
  return value as unknown as DaemonLogEntryV1;
}

export function decodeDaemonLogPage(value: unknown): DaemonLogPageV1 {
  if (!isDaemonLogObject(value)) throw invalidEntry("page must be an object");
  rejectUnknownKeys(value, ["schema", "entries", "nextCursor", "truncated", "droppedCount"], "invalid_daemon_log_entry");
  if (value.schema !== "daemon-log-page/v1") throw invalidEntry("page schema must be daemon-log-page/v1");
  if (!Array.isArray(value.entries) || value.entries.length > 200) throw invalidEntry("page entries are invalid");
  const entries = value.entries.map(decodeDaemonLogEntry);
  if (value.nextCursor !== null && (typeof value.nextCursor !== "string" || value.nextCursor.length < 1 || value.nextCursor.length > 512)) {
    throw invalidEntry("page nextCursor is invalid");
  }
  if (typeof value.truncated !== "boolean") throw invalidEntry("page truncated is invalid");
  if (!Number.isInteger(value.droppedCount) || Number(value.droppedCount) < 0) throw invalidEntry("page droppedCount is invalid");
  return {
    schema: "daemon-log-page/v1",
    entries,
    nextCursor: value.nextCursor,
    truncated: value.truncated,
    droppedCount: Number(value.droppedCount)
  };
}

export function isDaemonLogContractError(error: unknown): error is DaemonLogContractError {
  return error instanceof DaemonLogContractError;
}

function invalidEntry(message: string): DaemonLogContractError {
  return new DaemonLogContractError("invalid_daemon_log_entry", message);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlyArray<string>,
  code: DaemonLogContractError["code"]
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new DaemonLogContractError(code, `unsupported field: ${unknown}`);
}

function isDaemonLogObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function isDaemonLogLevel(value: unknown): value is DaemonLogLevel {
  return typeof value === "string" && (daemonLogLevels as ReadonlyArray<string>).includes(value);
}

function isBoundedPattern(value: unknown, pattern: RegExp, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && pattern.test(value);
}

function isOptionalNullableBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.length <= maxLength);
}
