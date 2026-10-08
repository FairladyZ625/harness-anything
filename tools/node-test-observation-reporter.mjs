import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { boundedCiSummary } from "./node-test-runner-lib.mjs";

export default async function* reportTestObservations(source) {
  const destination = process.env.HARNESS_CI_NODE_TEST_RESULTS ?? process.env.HARNESS_CI_OBSERVATION_RAW;
  if (!destination) {
    for await (const _event of source) yield "";
    return;
  }
  mkdirSync(destination, { recursive: true });
  const output = path.join(destination, `tests-${process.pid}.jsonl`);
  const tierManifest = JSON.parse(process.env.HARNESS_TEST_TIER_MANIFEST ?? "{}");
  const suites = new Map(),
    ordinals = new Map();
  for await (const event of source) {
    const data = event.data;
    if (!data || typeof data.file !== "string" || typeof data.name !== "string") continue;
    const file = repoRelative(data.file);
    if (event.type === "test:dequeue" && data.type === "suite") suites.set(`${file}:${data.nesting}`, data.name);
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    if (data.details?.type === "suite") continue;
    const fileEnvelope = data.name === data.file || data.name === file;
    const status = ciTestOutcome(
      event.type === "test:pass"
        ? "passed"
        : data.details?.error?.failureType === "cancelledByParent"
          ? "cancelled"
          : "failed",
      data.skip ?? data.details?.skip,
      data.todo ?? data.details?.todo,
    );
    if (fileEnvelope) {
      if (status === "failed") {
        const diagnostic = ciFailureDiagnostic(data.details?.error);
        appendFileSync(
          output,
          `${JSON.stringify({ kind: "file", file, outcome: "crashed", reason: "file envelope failed", stallSummary: diagnostic.failureSummary, truncated: diagnostic.truncated, error: diagnostic.error })}\n`,
        );
      }
      continue;
    }
    const suite = [];
    for (let depth = 0; depth < data.nesting; depth++) {
      const name = suites.get(`${file}:${depth}`);
      if (name) suite.push(name);
    }
    const key = JSON.stringify([file, suite, data.name, data.line ?? null, data.column ?? null]);
    const ordinal = (ordinals.get(key) ?? 0) + 1;
    ordinals.set(key, ordinal);
    const error = data.details?.error;
    const observation = {
      kind: "test",
      file,
      name: data.name,
      suite,
      testKey: `${key}:${ordinal}`,
      executionOrdinal: ordinal,
      declarationLocation: { line: data.line ?? null, column: data.column ?? null },
      failureLocation: ciFailureLocation(error, process.cwd()),
      tier: ["fast", "contract", "integration"].find((tier) => tierManifest[tier]?.includes(file)) ?? "unknown",
      shard: process.env.HARNESS_TEST_SHARD ? Number(process.env.HARNESS_TEST_SHARD) : null,
      durationMs: data.details?.duration_ms ?? 0,
      status,
      ...(status === "failed" ? ciFailureDiagnostic(error) : {}),
    };
    appendFileSync(output, `${JSON.stringify(observation)}\n`);
  }
}
function repoRelative(file) {
  const normalized = file.replaceAll("\\", "/"),
    root = `${process.cwd().replaceAll("\\", "/")}/`;
  return normalized.startsWith(root) ? normalized.slice(root.length) : normalized;
}

export function ciTestOutcome(status, skip, todo) {
  if (skip !== undefined || todo !== undefined || ["pending", "todo", "skipped"].includes(status)) return "skipped";
  if (status === "cancelled") return "cancelled";
  if (status === "passed" || status === "failed") return status;
  throw new Error(`Unknown CI test outcome: ${status}`);
}

function ciErrorDetail(error, seen = new Set()) {
  if (error === undefined || error === null) return null;
  if (seen.has(error)) return { name: "Error", message: "circular cause", stack: null, cause: null };
  seen.add(error);
  if (typeof error !== "object") return { name: "Error", message: String(error), stack: null, cause: null };
  const value = error;
  return {
    name: typeof value.name === "string" ? value.name : "Error",
    message: typeof value.message === "string" ? value.message : "",
    stack: typeof value.stack === "string" ? value.stack : null,
    cause: ciErrorDetail(value.cause, seen),
  };
}

export function ciFailureDiagnostic(error) {
  const detail = ciErrorDetail(error);
  let cursor =
    typeof error === "object" && error !== null && "code" in error && error.code === "ERR_TEST_FAILURE" && detail?.cause
      ? detail.cause
      : detail;
  while (cursor && !cursor.message.trim()) cursor = cursor.cause;
  const { summary, truncated } = boundedCiSummary(
    cursor?.message.split(/\r?\n/u).find((line) => line.trim()) ?? "unavailable",
  );
  return { failureSummary: summary, truncated, error: detail };
}

export function ciFailureLocation(error, root) {
  const cause = error?.cause;
  const stack = typeof cause === "object" && cause !== null && "stack" in cause ? cause.stack : error?.stack;
  const match = typeof stack === "string" ? /(?:file:\/\/)?([^\s()]+):(\d+):(\d+)/u.exec(stack) : null;
  if (!match) return null;
  const file = match[1].replaceAll("\\", "/"),
    prefix = `${root.replaceAll("\\", "/")}/`;
  return {
    file: file.startsWith(prefix) ? file.slice(prefix.length) : file,
    line: Number(match[2]),
    column: Number(match[3]),
  };
}
