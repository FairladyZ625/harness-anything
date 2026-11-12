// Compare-and-steer (#4372). A steer names its target by selector, but a caller that read the
// runtime first can also say what it saw: the repository, the task/execution or an explicitly
// taskless conversation, the dispatch leaf, and the leaf's steer version. The daemon compares that
// expectation with the target it is about to write to, in the same synchronous section as the
// append, and refuses with the current target instead of re-selecting it. Callers that state no
// expectation keep the selector-only behaviour of the previous protocol window.
import { StringDecoder } from "node:string_decoder";
import type { RuntimeSteerLiveness } from "@harness-anything/kernel/internal/domain/operational-status.ts";
import { isJsonObject, unknownFieldViolation, type JsonObject } from "./protocol/json-rpc-types.ts";
import {
  dispatchStreamPath,
  parseRecord,
  readDispatchStreamHeaders,
  readRuntimeWorkerChunk,
  type DispatchStreamHeader,
} from "./dispatch-stream.ts";
import { runtimeSpawnError } from "./runtime-spawn-errors.ts";

export interface RuntimeSteerExpectation {
  readonly repoId?: string;
  /** The caller saw a conversation that belongs to no task; a task-bound target is a mismatch. */
  readonly taskless?: true;
  readonly taskId?: string;
  readonly executionId?: string;
  /** The dispatch leaf the caller saw. A selector whose current leaf differs is refused, not re-targeted. */
  readonly dispatchId?: string;
  /** Steer requests already appended to that leaf when the caller looked. */
  readonly version?: number;
}

export type RuntimeSteerSelector = { readonly dispatchId: string } | { readonly runtimeSessionId: string };

export type { RuntimeSteerLiveness };

/** What the daemon currently sees at the steer target; returned on every refusal so the caller can re-read. */
export interface RuntimeSteerTarget {
  readonly repoId: string;
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly leafDispatchId: string;
  readonly taskless: boolean;
  readonly taskId: string | null;
  readonly executionId: string | null;
  readonly liveness: RuntimeSteerLiveness;
  readonly version: number;
}

const expectationTextFields = ["repoId", "taskId", "executionId", "dispatchId"] as const;

export function parseRuntimeSteerExpectation(value: unknown): RuntimeSteerExpectation | null {
  if (value === undefined) return null;
  if (!isJsonObject(value)) throw invalidExpectation("expected must be an object.");
  const unknownField = unknownFieldViolation(value, [...expectationTextFields, "taskless", "version"]);
  if (unknownField) throw invalidExpectation(`expected contains an ${unknownField}`);
  if (Object.keys(value).length === 0) throw invalidExpectation("expected must name at least one field.");
  for (const field of expectationTextFields)
    if (value[field] !== undefined && (typeof value[field] !== "string" || value[field] === ""))
      throw invalidExpectation(`expected.${field} must be a non-empty string.`);
  if (value.taskless !== undefined && value.taskless !== true)
    throw invalidExpectation("expected.taskless must be true when present.");
  if (value.taskless === true && (value.taskId !== undefined || value.executionId !== undefined))
    throw invalidExpectation("expected.taskless cannot also name a task or execution.");
  if (value.version !== undefined && !(Number.isSafeInteger(value.version) && Number(value.version) >= 0))
    throw invalidExpectation("expected.version must be a non-negative integer.");
  return value as RuntimeSteerExpectation;
}

/** The stream a selector steers: a taskless conversation addressed by any of its dispatches
 * steers its current leaf round; task-bound dispatches keep direct addressing. */
export function resolveRuntimeSteerHeader(rootDir: string, selector: RuntimeSteerSelector): DispatchStreamHeader {
  const headers = readDispatchStreamHeaders(rootDir),
    header = headers.find((entry) =>
      "dispatchId" in selector
        ? entry.dispatchId === selector.dispatchId
        : entry.runtimeSessionId === selector.runtimeSessionId,
    );
  if (!header) throw runtimeSpawnError("runtime_not_running", "Runtime dispatch was not found.");
  // An earlier round's process has exited by the time a later round runs, and only the leaf can be live.
  return "dispatchId" in selector && header.taskId === null ? leafOf(headers, header) : header;
}

export function runtimeSteerTarget(
  rootDir: string,
  repoId: string,
  header: DispatchStreamHeader,
  liveness: RuntimeSteerLiveness,
): RuntimeSteerTarget {
  return {
    repoId,
    dispatchId: header.dispatchId,
    runtimeSessionId: header.runtimeSessionId,
    leafDispatchId: leafOf(readDispatchStreamHeaders(rootDir), header).dispatchId,
    taskless: header.taskId === null,
    taskId: header.taskId,
    executionId: header.executionId,
    liveness,
    version: readRuntimeSteerVersion(rootDir, header.dispatchId),
  };
}

/** The first expectation the current target contradicts, or null when every stated field matches. */
export function runtimeSteerMismatch(
  expected: RuntimeSteerExpectation,
  target: RuntimeSteerTarget,
): { readonly field: string; readonly expected: string } | null {
  const checks: readonly (readonly [string, unknown, unknown])[] = [
    ["repoId", expected.repoId, target.repoId],
    ["taskless", expected.taskless, target.taskless],
    ["taskId", expected.taskId, target.taskId],
    ["executionId", expected.executionId, target.executionId],
    // The leaf, not the selected dispatch: a target that is no longer its conversation's leaf is
    // stale even when the selector names it directly.
    ["dispatchId", expected.dispatchId, target.dispatchId],
    ["dispatchId", expected.dispatchId, target.leafDispatchId],
    ["version", expected.version, target.version],
  ];
  for (const [field, want, actual] of checks)
    if (want !== undefined && want !== actual) return { field, expected: String(want) };
  return null;
}

/** A refusal that carries the current target; nothing has been appended when it is thrown. */
export function runtimeSteerRefusal(
  code: string,
  message: string,
  target: RuntimeSteerTarget,
  field = "target",
  expected?: string,
): Error {
  const current = JSON.stringify(target);
  return runtimeSpawnError(code, `${message} Current target: ${current}. Re-read the runtime and retry.`, {
    kind: "validation",
    entity: `dispatch ${target.dispatchId}`,
    field: field === "target" ? field : `expected.${field}`,
    actual: current,
    expectation:
      expected === undefined
        ? "A running steer target."
        : `expected.${field}=${expected}; re-read the runtime and retry with the current values.`,
  });
}

/** The leaf's steer version: how many steer requests its dispatch stream already carries. Only
 * the daemon appends `steer_requested`, inside the same synchronous section that compares it. */
export function readRuntimeSteerVersion(rootDir: string, dispatchId: string): number {
  const target = dispatchStreamPath(rootDir, dispatchId),
    decoder = new StringDecoder("utf8"),
    marker = '"kind":"steer_requested"';
  let offset = 0,
    tail = "",
    count = 0;
  const countLine = (line: string): void => {
    // The marker is a cheap prefilter; provider transcripts embed JSON only as escaped strings.
    if (line.includes(marker) && parseRecord(line)?.kind === "steer_requested") count += 1;
  };
  for (;;) {
    const bytes = readRuntimeWorkerChunk(target, offset);
    if (bytes.length === 0) break;
    offset += bytes.length;
    const lines = (tail + decoder.write(bytes)).split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) countLine(line);
  }
  countLine(tail + decoder.end());
  return count;
}

export function runtimeSteerReceiptTarget(target: RuntimeSteerTarget): JsonObject {
  const { leafDispatchId: _leaf, liveness: _liveness, ...locked } = target;
  return { ...locked, delivery: "requested" } as unknown as JsonObject;
}

function leafOf(headers: readonly DispatchStreamHeader[], header: DispatchStreamHeader): DispatchStreamHeader {
  const seen = new Set([header.dispatchId]);
  let current = header;
  for (;;) {
    const child = headers.find((entry) => entry.resumedFromDispatchId === current.dispatchId);
    if (!child || seen.has(child.dispatchId)) return current;
    seen.add(child.dispatchId);
    current = child;
  }
}

function invalidExpectation(message: string): Error {
  return runtimeSpawnError("invalid_runtime_steer", message);
}
