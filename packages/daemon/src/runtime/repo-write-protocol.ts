// @slice-activation P5-W2 repo-writer foundation; public recovery routing remains activation work owned by task_01KY6QFFC306JRW8JW4Y2ND2TM.
import { repoWriteTerminalReceiptMatches } from "./repo-write-terminal-receipt.ts";
export const repoWriteProtocolType = "harness-repo-write-ipc/v1" as const;

export interface RepoWriteProtocolLimits {
  readonly maxFrameBytes: number;
  readonly maxStringBytes: number;
  readonly maxDiagnosticBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxObjectKeys: number;
  readonly maxArrayItems: number;
}

export const defaultRepoWriteProtocolLimits: RepoWriteProtocolLimits = {
  maxFrameBytes: 1024 * 1024,
  maxStringBytes: 256 * 1024,
  maxDiagnosticBytes: 2 * 1024,
  maxDepth: 32,
  maxNodes: 16_384,
  maxObjectKeys: 1_024,
  maxArrayItems: 16_384
};

export type RepoWriteJsonPrimitive = string | number | boolean | null;
export type RepoWriteJsonValue = RepoWriteJsonPrimitive | RepoWriteJsonObject | ReadonlyArray<RepoWriteJsonValue>;
export interface RepoWriteJsonObject { readonly [key: string]: RepoWriteJsonValue }
export interface RepoWriteEncodedBigInt {
  readonly $repoWriteType: "bigint"; readonly encoding: "decimal"; readonly text: string;
}
export interface RepoWriteEncodedBytes {
  readonly $repoWriteType: "bytes"; readonly encoding: "base64url"; readonly text: string;
}

export interface RepoWriteCommandDto {
  readonly commandName: string;
  readonly actor: RepoWriteJsonObject;
  readonly context: RepoWriteJsonObject;
  readonly payload: RepoWriteJsonObject;
}
interface RepoWriteFrameBase {
  readonly protocol: typeof repoWriteProtocolType;
  readonly repoId: string;
  readonly generation: number;
}
interface RepoWriteRequestFrame<K extends string> extends RepoWriteFrameBase {
  readonly kind: K;
  readonly requestId: string;
}
type RepoWriteOperationFrame<K extends string> = RepoWriteRequestFrame<K> & { readonly opId: string };

export interface RepoWriteSubmitFrame extends RepoWriteRequestFrame<"submit"> {
  readonly command: RepoWriteCommandDto;
}
export type RepoWriteProceedFrame = RepoWriteOperationFrame<"proceed">;
export type RepoWriteStatusRequestFrame = RepoWriteOperationFrame<"status">;
export type RepoWriteShutdownFrame = RepoWriteRequestFrame<"shutdown">;

export type RepoWriteParentMessage =
  RepoWriteSubmitFrame | RepoWriteProceedFrame | RepoWriteStatusRequestFrame | RepoWriteShutdownFrame;
export type RepoWritePreparedFrame = RepoWriteOperationFrame<"prepared">;
export type RepoWriteDrainedFrame = RepoWriteRequestFrame<"drained">;
export type RepoWriteReadyFrame = RepoWriteFrameBase & {
  readonly kind: "ready";
  readonly artifactIdentity: string;
};
export type RepoWriteTerminalOutcome = "committed" | "rejected";
export interface RepoWriteTerminalFrame extends RepoWriteOperationFrame<"terminal"> {
  readonly outcome: RepoWriteTerminalOutcome;
  readonly receipt: RepoWriteJsonObject;
}

/**
 * A failure before `proceed` proves that canonical mutation did not start.
 * `opId` is present when preparation completed before the failure.
 */
export interface RepoWriteNotStartedFailureFrame extends RepoWriteRequestFrame<"failure"> {
  readonly phase: "before-proceed";
  readonly outcome: "not-started";
  readonly replay: "caller-may-retry";
  readonly opId?: string;
  readonly code: string;
  readonly diagnostic: string;
}

/**
 * A failure after `proceed` cannot be replayed. The stable `opId` is the only
 * recovery handle until a new capsule can report the canonical outcome.
 */
export interface RepoWriteOutcomeUnknownFailureFrame extends RepoWriteOperationFrame<"failure"> {
  readonly phase: "after-proceed";
  readonly outcome: "unknown";
  readonly replay: "forbidden";
  readonly code: string;
  readonly diagnostic: string;
}
export type RepoWriteFailureFrame = RepoWriteNotStartedFailureFrame | RepoWriteOutcomeUnknownFailureFrame;
export type RepoWriteOperationState =
  "not-found" | "prepared" | "proceeding" | RepoWriteTerminalOutcome | "failed" | "unknown";

export type RepoWriteOperationLookupResult =
  | { readonly state: Exclude<RepoWriteOperationState, RepoWriteTerminalOutcome> }
  | {
      readonly state: "committed";
      readonly outcome: "committed";
      readonly receipt: RepoWriteJsonObject;
    }
  | {
      readonly state: "rejected";
      readonly outcome: "rejected";
      readonly receipt: RepoWriteJsonObject;
    };

export type RepoWriteStatusFrame = RepoWriteOperationFrame<"status"> & RepoWriteOperationLookupResult;
export type RepoWriteTelemetryPhase =
  "queue" | "compile" | "journal" | "git" | "fsync" | "materializer" | "projection" | "total";

export interface RepoWriteTelemetryFrame extends RepoWriteRequestFrame<"telemetry"> {
  readonly opId?: string;
  readonly phase: RepoWriteTelemetryPhase;
  readonly elapsedMs: number;
}

export type RepoWriteChildMessage =
  RepoWriteReadyFrame | RepoWritePreparedFrame | RepoWriteTerminalFrame | RepoWriteFailureFrame
  | RepoWriteStatusFrame | RepoWriteTelemetryFrame | RepoWriteDrainedFrame;

export type RepoWriteMessage = RepoWriteParentMessage | RepoWriteChildMessage;
export class RepoWriteProtocolDecodeError extends Error {
  readonly code: "REPO_WRITE_PROTOCOL_INVALID" | "REPO_WRITE_PROTOCOL_LIMIT";

  constructor(code: RepoWriteProtocolDecodeError["code"], message: string) {
    super(message);
    this.name = "RepoWriteProtocolDecodeError";
    this.code = code;
  }
}

export function encodeRepoWriteBigInt(value: bigint): RepoWriteEncodedBigInt {
  return { $repoWriteType: "bigint", encoding: "decimal", text: value.toString(10) };
}
export function decodeRepoWriteBigInt(value: unknown): bigint {
  const record = recordAt(value, "$");
  assertExactKeys(record, ["$repoWriteType", "encoding", "text"], [], "$");
  if (record.$repoWriteType !== "bigint" || record.encoding !== "decimal") invalid("$", "encoded bigint");
  const text = stringAt(record.text, "$.text", defaultRepoWriteProtocolLimits.maxStringBytes);
  if (!/^(?:0|-[1-9]\d*|[1-9]\d*)$/u.test(text) || text.length > 4_096) {
    invalid("$.text", "canonical bounded decimal bigint");
  }
  return BigInt(text);
}

export function encodeRepoWriteBytes(value: Uint8Array): RepoWriteEncodedBytes {
  return {
    $repoWriteType: "bytes",
    encoding: "base64url",
    text: Buffer.from(value).toString("base64url")
  };
}
export function decodeRepoWriteBytes(value: unknown): Uint8Array {
  const record = recordAt(value, "$");
  assertExactKeys(record, ["$repoWriteType", "encoding", "text"], [], "$");
  if (record.$repoWriteType !== "bytes" || record.encoding !== "base64url") invalid("$", "encoded bytes");
  const text = stringAt(record.text, "$.text", defaultRepoWriteProtocolLimits.maxStringBytes);
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) invalid("$.text", "canonical base64url bytes");
  const decoded = Buffer.from(text, "base64url");
  if (decoded.toString("base64url") !== text) invalid("$.text", "canonical base64url bytes");
  return new Uint8Array(decoded);
}

export function parseRepoWriteParentMessage(
  text: string, limits: Partial<RepoWriteProtocolLimits> = {}
): RepoWriteParentMessage {
  return decodeRepoWriteParentMessage(parseFrame(text, resolveLimits(limits)), limits);
}
export function parseRepoWriteChildMessage(
  text: string, limits: Partial<RepoWriteProtocolLimits> = {}
): RepoWriteChildMessage {
  return decodeRepoWriteChildMessage(parseFrame(text, resolveLimits(limits)), limits);
}
export function stringifyRepoWriteParentMessage(
  message: RepoWriteParentMessage, limits: Partial<RepoWriteProtocolLimits> = {}
): string {
  return stringifyFrame(decodeRepoWriteParentMessage(message, limits), resolveLimits(limits));
}
export function stringifyRepoWriteChildMessage(
  message: RepoWriteChildMessage, limits: Partial<RepoWriteProtocolLimits> = {}
): string {
  return stringifyFrame(decodeRepoWriteChildMessage(message, limits), resolveLimits(limits));
}
export function decodeRepoWriteParentMessage(
  value: unknown, overrides: Partial<RepoWriteProtocolLimits> = {}
): RepoWriteParentMessage {
  const limits = resolveLimits(overrides);
  const budget = { nodes: 0 };
  const frame = frameBase(value, limits, budget);
  if (frame.kind === "submit") return decodeSubmit(frame, limits, budget);
  if (frame.kind === "proceed") return decodeOperationFrame(frame, limits, "proceed");
  if (frame.kind === "status") return decodeOperationFrame(frame, limits, "status");
  if (frame.kind === "shutdown") return decodeRequestFrame(frame, limits, "shutdown");
  invalid("$.kind", "parent message kind");
}
export function decodeRepoWriteChildMessage(
  value: unknown, overrides: Partial<RepoWriteProtocolLimits> = {}
): RepoWriteChildMessage {
  const limits = resolveLimits(overrides);
  const budget = { nodes: 0 };
  const frame = frameBase(value, limits, budget);
  if (frame.kind === "ready") return decodeReady(frame, limits);
  if (frame.kind === "prepared") return decodeOperationFrame(frame, limits, "prepared");
  if (frame.kind === "terminal") return decodeTerminal(frame, limits, budget);
  if (frame.kind === "failure") return decodeFailure(frame, limits);
  if (frame.kind === "status") return decodeStatus(frame, limits, budget);
  if (frame.kind === "telemetry") return decodeTelemetry(frame, limits);
  if (frame.kind === "drained") return decodeRequestFrame(frame, limits, "drained");
  invalid("$.kind", "child message kind");
}

export function boundedRepoWriteDiagnostic(
  error: unknown, maxBytes = defaultRepoWriteProtocolLimits.maxDiagnosticBytes
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  const source = error instanceof Error
    ? `${error.name || "Error"}: ${error.message || "writer failure"}`
    : "Unknown writer failure";
  const sanitized = source
    .slice(0, maxBytes * 4 + 1)
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim();
  return truncateUtf8(sanitized || "writer failure", maxBytes);
}

type FrameRecord = Record<string, unknown> & {
  readonly protocol: typeof repoWriteProtocolType;
  readonly repoId: string;
  readonly generation: number;
  readonly kind: string;
};
function decodeSubmit(
  frame: FrameRecord, limits: RepoWriteProtocolLimits, budget: { nodes: number }
): RepoWriteSubmitFrame {
  assertExactKeys(frame, baseKeys(["requestId", "command"]), [], "$");
  const command = recordAt(frame.command, "$.command");
  assertExactKeys(command, ["commandName", "actor", "context", "payload"], [], "$.command");
  const decoded: RepoWriteSubmitFrame = {
    ...baseFields(frame),
    kind: "submit",
    requestId: identifier(frame.requestId, "$.requestId", limits),
    command: {
      commandName: identifier(command.commandName, "$.command.commandName", limits),
      actor: jsonObject(command.actor, "$.command.actor", limits, budget, 1),
      context: jsonObject(command.context, "$.command.context", limits, budget, 1),
      payload: jsonObject(command.payload, "$.command.payload", limits, budget, 1)
    }
  };
  return decoded;
}
function decodeOperationFrame<K extends "proceed" | "status" | "prepared">(
  frame: FrameRecord, limits: RepoWriteProtocolLimits, kind: K
): RepoWriteOperationFrame<K> {
  assertExactKeys(frame, baseKeys(["requestId", "opId"]), [], "$");
  return {
    ...baseFields(frame),
    kind,
    requestId: identifier(frame.requestId, "$.requestId", limits),
    opId: identifier(frame.opId, "$.opId", limits)
  };
}
function decodeRequestFrame<K extends "shutdown" | "drained">(
  frame: FrameRecord, limits: RepoWriteProtocolLimits, kind: K
): RepoWriteRequestFrame<K> {
  assertExactKeys(frame, baseKeys(["requestId"]), [], "$");
  return { ...baseFields(frame), kind, requestId: identifier(frame.requestId, "$.requestId", limits) };
}
function decodeReady(
  frame: FrameRecord,
  limits: RepoWriteProtocolLimits
): RepoWriteReadyFrame {
  assertExactKeys(frame, baseKeys(["artifactIdentity"]), [], "$");
  const artifactIdentity = stringAt(
    frame.artifactIdentity,
    "$.artifactIdentity",
    limits.maxStringBytes
  );
  if (!/^sha256:[a-f0-9]{64}$/u.test(artifactIdentity)) {
    invalid("$.artifactIdentity", "sha256 artifact identity");
  }
  return { ...baseFields(frame), kind: "ready", artifactIdentity };
}
function decodeTerminal(
  frame: FrameRecord, limits: RepoWriteProtocolLimits, budget: { nodes: number }
): RepoWriteTerminalFrame {
  assertExactKeys(frame, baseKeys(["requestId", "opId", "outcome", "receipt"]), [], "$");
  const outcome = terminalOutcome(frame.outcome, "$.outcome");
  const receipt = jsonObject(frame.receipt, "$.receipt", limits, budget, 1);
  assertTerminalReceipt(outcome, receipt, "$.receipt");
  return {
    ...baseFields(frame),
    kind: "terminal",
    requestId: identifier(frame.requestId, "$.requestId", limits),
    opId: identifier(frame.opId, "$.opId", limits),
    outcome,
    receipt
  };
}

function decodeFailure(frame: FrameRecord, limits: RepoWriteProtocolLimits): RepoWriteFailureFrame {
  assertExactKeys(frame, baseKeys(["requestId", "phase", "outcome", "replay", "code", "diagnostic"]), ["opId"], "$");
  const common = {
    ...baseFields(frame),
    kind: "failure" as const,
    requestId: identifier(frame.requestId, "$.requestId", limits),
    code: identifier(frame.code, "$.code", limits),
    diagnostic: stringAt(frame.diagnostic, "$.diagnostic", limits.maxDiagnosticBytes)
  };
  if (frame.phase === "before-proceed") {
    if (frame.outcome !== "not-started" || frame.replay !== "caller-may-retry") {
      invalid("$", "before-proceed not-started failure");
    }
    return {
      ...common,
      phase: "before-proceed",
      outcome: "not-started",
      replay: "caller-may-retry",
      ...("opId" in frame ? { opId: identifier(frame.opId, "$.opId", limits) } : {})
    };
  }
  if (frame.phase === "after-proceed") {
    if (frame.outcome !== "unknown" || frame.replay !== "forbidden") {
      invalid("$", "after-proceed outcome-unknown failure");
    }
    return {
      ...common,
      phase: "after-proceed",
      outcome: "unknown",
      replay: "forbidden",
      opId: identifier(frame.opId, "$.opId", limits)
    };
  }
  invalid("$.phase", "failure phase");
}
function decodeStatus(
  frame: FrameRecord,
  limits: RepoWriteProtocolLimits,
  budget: { nodes: number }
): RepoWriteStatusFrame {
  const states: ReadonlyArray<RepoWriteOperationState> = [
    "not-found", "prepared", "proceeding", "committed", "rejected", "failed", "unknown"
  ];
  if (!states.includes(frame.state as RepoWriteOperationState)) invalid("$.state", "operation state");
  const common = {
    ...baseFields(frame),
    kind: "status" as const,
    requestId: identifier(frame.requestId, "$.requestId", limits),
    opId: identifier(frame.opId, "$.opId", limits)
  };
  if (frame.state === "committed" || frame.state === "rejected") {
    assertExactKeys(frame, baseKeys(["requestId", "opId", "state", "outcome", "receipt"]), [], "$");
    const outcome = terminalOutcome(frame.outcome, "$.outcome");
    if (outcome !== frame.state) invalid("$.outcome", "terminal outcome matching state");
    const receipt = jsonObject(frame.receipt, "$.receipt", limits, budget, 1);
    assertTerminalReceipt(outcome, receipt, "$.receipt");
    const terminal = {
      ...common,
      state: frame.state,
      outcome,
      receipt
    };
    return frame.state === "committed"
      ? { ...terminal, state: "committed", outcome: "committed" }
      : { ...terminal, state: "rejected", outcome: "rejected" };
  }
  assertExactKeys(frame, baseKeys(["requestId", "opId", "state"]), [], "$");
  return {
    ...common,
    state: frame.state as Exclude<RepoWriteOperationState, RepoWriteTerminalOutcome>
  };
}

function terminalOutcome(value: unknown, path: string): RepoWriteTerminalOutcome {
  if (value !== "committed" && value !== "rejected") invalid(path, "terminal outcome");
  return value;
}

function assertTerminalReceipt(
  outcome: RepoWriteTerminalOutcome,
  receipt: RepoWriteJsonObject,
  path: string
): void {
  if (!repoWriteTerminalReceiptMatches(outcome, receipt)) {
    invalid(path, "exact command-receipt/v2");
  }
}
function decodeTelemetry(frame: FrameRecord, limits: RepoWriteProtocolLimits): RepoWriteTelemetryFrame {
  assertExactKeys(frame, baseKeys(["requestId", "phase", "elapsedMs"]), ["opId"], "$");
  const phases: ReadonlyArray<RepoWriteTelemetryPhase> = [
    "queue", "compile", "journal", "git", "fsync", "materializer", "projection", "total"
  ];
  if (!phases.includes(frame.phase as RepoWriteTelemetryPhase)) invalid("$.phase", "telemetry phase");
  if (typeof frame.elapsedMs !== "number" || !Number.isFinite(frame.elapsedMs) || frame.elapsedMs < 0) {
    invalid("$.elapsedMs", "non-negative finite duration");
  }
  return {
    ...baseFields(frame),
    kind: "telemetry",
    requestId: identifier(frame.requestId, "$.requestId", limits),
    ...("opId" in frame ? { opId: identifier(frame.opId, "$.opId", limits) } : {}),
    phase: frame.phase as RepoWriteTelemetryPhase,
    elapsedMs: frame.elapsedMs
  };
}
function frameBase(value: unknown, limits: RepoWriteProtocolLimits, budget: { nodes: number }): FrameRecord {
  const frame = recordAt(value, "$");
  budget.nodes += 1;
  if (frame.protocol !== repoWriteProtocolType) invalid("$.protocol", repoWriteProtocolType);
  const repoId = identifier(frame.repoId, "$.repoId", limits);
  if (typeof frame.generation !== "number"
    || !Number.isSafeInteger(frame.generation)
    || frame.generation < 1) {
    invalid("$.generation", "positive safe integer");
  }
  if (typeof frame.kind !== "string") invalid("$.kind", "message kind");
  return {
    ...frame,
    protocol: repoWriteProtocolType,
    repoId,
    generation: frame.generation,
    kind: frame.kind
  };
}
function baseFields(frame: FrameRecord): RepoWriteFrameBase {
  return {
    protocol: repoWriteProtocolType,
    repoId: frame.repoId,
    generation: frame.generation
  };
}
function baseKeys(keys: ReadonlyArray<string>): ReadonlyArray<string> {
  return ["protocol", "repoId", "generation", "kind", ...keys];
}
function jsonObject(
  value: unknown, path: string, limits: RepoWriteProtocolLimits, budget: { nodes: number }, depth: number
): RepoWriteJsonObject {
  const decoded = jsonValue(value, path, limits, budget, depth);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    invalid(path, "JSON object");
  }
  return decoded as RepoWriteJsonObject;
}
function jsonValue(
  value: unknown, path: string, limits: RepoWriteProtocolLimits, budget: { nodes: number }, depth: number
): RepoWriteJsonValue {
  budget.nodes += 1;
  if (budget.nodes > limits.maxNodes) limit(path, "node count");
  if (depth > limits.maxDepth) limit(path, "nesting depth");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return stringAt(value, path, limits.maxStringBytes);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(path, "finite JSON number");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayItems) limit(path, "array item count");
    return value.map((item, index) => jsonValue(item, `${path}[${index}]`, limits, budget, depth + 1));
  }
  const record = recordAt(value, path);
  const entries = Object.entries(record);
  if (entries.length > limits.maxObjectKeys) limit(path, "object key count");
  const result: Record<string, RepoWriteJsonValue> = {};
  for (const [key, item] of entries) {
    stringAt(key, `${path} key`, limits.maxStringBytes);
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      invalid(path, "safe JSON object keys");
    }
    result[key] = jsonValue(item, `${path}.${boundedPathSegment(key)}`, limits, budget, depth + 1);
  }
  if ("$repoWriteType" in result) {
    if (result.$repoWriteType === "bigint") decodeRepoWriteBigInt(result);
    else if (result.$repoWriteType === "bytes") decodeRepoWriteBytes(result);
    else invalid(`${path}.$repoWriteType`, "known explicit text encoding");
  }
  return result;
}
function parseFrame(text: string, limits: RepoWriteProtocolLimits): unknown {
  if (typeof text !== "string") invalid("$", "JSON text");
  if (utf8Bytes(text) > limits.maxFrameBytes) limit("$", "frame byte length");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    invalid("$", "valid JSON");
  }
}
function stringifyFrame(message: RepoWriteMessage, limits: RepoWriteProtocolLimits): string {
  const text = JSON.stringify(message);
  if (utf8Bytes(text) > limits.maxFrameBytes) limit("$", "frame byte length");
  return text;
}
function resolveLimits(overrides: Partial<RepoWriteProtocolLimits>): RepoWriteProtocolLimits {
  const limits = { ...defaultRepoWriteProtocolLimits, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  }
  return limits;
}
function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, "object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path, "plain object");
  return value as Record<string, unknown>;
}
function assertExactKeys(
  record: Record<string, unknown>, required: ReadonlyArray<string>, optional: ReadonlyArray<string>, path: string
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key))
    || Object.keys(record).some((key) => !allowed.has(key))) {
    invalid(path, "exact message fields");
  }
}
function identifier(value: unknown, path: string, limits: RepoWriteProtocolLimits): string {
  const text = stringAt(value, path, Math.min(limits.maxStringBytes, 4_096));
  if (!text.trim()) invalid(path, "non-empty identifier");
  return text;
}
function stringAt(value: unknown, path: string, maxBytes: number): string {
  if (typeof value !== "string") invalid(path, "string");
  if (utf8Bytes(value) > maxBytes) limit(path, "string byte length");
  return value;
}
function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const width = utf8Bytes(character);
    if (bytes + width > maxBytes) break;
    result += character;
    bytes += width;
  }
  return result;
}
function boundedPathSegment(value: string): string {
  return value.length <= 48 ? value : `${value.slice(0, 45)}...`;
}
function invalid(path: string, expected: string): never {
  throw new RepoWriteProtocolDecodeError(
    "REPO_WRITE_PROTOCOL_INVALID",
    `Invalid repo writer IPC at ${boundedProtocolPath(path)}: expected ${expected}.`
  );
}
function limit(path: string, boundary: string): never {
  throw new RepoWriteProtocolDecodeError(
    "REPO_WRITE_PROTOCOL_LIMIT",
    `Repo writer IPC limit exceeded at ${boundedProtocolPath(path)}: ${boundary}.`
  );
}
function boundedProtocolPath(path: string): string {
  return path.length <= 160 ? path : `${path.slice(0, 157)}...`;
}
