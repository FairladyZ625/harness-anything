/**
 * Shared census/replay walk for the CH3 status-word rename drill.
 *
 * One ruler for both sides: `census.mjs` counts and `replay.mjs` transforms
 * through the SAME typed-path rule table in this module. Any status-ish field
 * the walk meets that the table does not classify makes the walk fail closed —
 * an unclassified path can never be silently skipped or silently rewritten.
 *
 * Read-only against any ledger Git repo; never writes, never touches a daemon.
 */
import { spawn } from "node:child_process";

export const STATUS_KEYS = new Set(["phase", "state", "targetState", "status", "originalStatus", "outcome"]);

/**
 * The rename contract (approved CH3 groups 1-4). Group 5 (operation outcome
 * `rejected` -> `op_rejected`) is a wire-only release with zero stored ledger
 * data, so it is censused but never replayed.
 */
export const WORD_MAP = Object.freeze({
  leasePhase: Object.freeze({ active: "held" }),
  decisionState: Object.freeze({ active: "in_effect", retired: "outcome_retired" }),
  relationState: Object.freeze({ retired: "edge_retired" }),
  factState: Object.freeze({ live: "standing", retired: "superseded_fact" }),
});

/**
 * Typed-path classification. `path` uses dot separation with array positions
 * normalized to `[]`. Returns one of the WORD_MAP keys, `"out-of-scope"` for
 * status fields that belong to vocabularries this rename does not touch, or
 * `null` when the walk must fail closed.
 */
export function classifyStatusPath(schema, type, path) {
  const key = path.split(".").at(-1);
  if (key === "phase") {
    if (schema === "task-event/v1" && (path === "payload.lease.phase" || path === "payload.releasedLease.phase")) return "leasePhase";
    return null;
  }
  if (key === "targetState") {
    if (schema === "decision-event/v1" && path === "payload.judgmentConsent.targetState") return "decisionState";
    if (schema === "migration-import-event/v1" && path === "payload.entity.decision.judgmentConsents[].targetState") return "decisionState";
    return null;
  }
  if (key === "state") {
    if (schema === "decision-event/v1" && path === "payload.contentPin.state") return "decisionState";
    if (schema === "migration-import-event/v1" && path === "payload.entity.decision.state") return "decisionState";
    if (schema === "migration-import-event/v1" && path === "payload.entity.decision.contentPins[].state") return "decisionState";
    if (schema === "decision-event/v1" && path === "payload.relation.state") return "relationState";
    if (schema === "decision-event/v1" && path === "payload.replacement.state") return "relationState";
    if (schema === "migration-import-event/v1" && path === "payload.entity.relation.state") return "relationState";
    if (schema === "task-event/v1" && path === "payload.task.relations[].state") return "relationState";
    if (schema === "task-event/v1" && path === "payload.execution.state") return "out-of-scope";
    if (schema === "migration-import-event/v1" && path === "payload.entity.execution.state") return "out-of-scope";
    if (schema === "agent-runtime-event/v1") return "out-of-scope";
    return null;
  }
  if (key === "status") {
    // Task/execution/review statuses are not part of the approved rename.
    if (schema === "task-event/v1" || schema === "migration-import-event/v1" || schema === "task-bootstrap-event/v1" || schema === "preset-snapshot-upgrade-event/v1" || schema === "agent-runtime-event/v1") return "out-of-scope";
    return null;
  }
  if (key === "originalStatus") {
    if (schema === "migration-import-event/v1" && path === "payload.entity.originalStatus") return "out-of-scope";
    return null;
  }
  if (key === "outcome") return "out-of-scope";
  return null;
}

/** Recursively record status-key occurrences; array positions render as `[]`. */
export function walkStatusFields(value, schema, type, callback, path = "") {
  if (Array.isArray(value)) {
    for (const item of value) walkStatusFields(item, schema, type, callback, path);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (Array.isArray(child)) {
      walkStatusFields(child, schema, type, callback, `${childPath}[]`);
      continue;
    }
    if (STATUS_KEYS.has(key) && (typeof child === "string" || typeof child === "number")) {
      callback(schema, type, childPath, child);
      continue;
    }
    walkStatusFields(child, schema, type, callback, childPath);
  }
}

export function git(repo, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`))));
  });
}

/** Stream `{ path, body }` for every blob under `prefix` at `ref`, in tree order. */
export async function* streamTreeBlobs(repo, ref, prefix) {
  const listing = await git(repo, ["ls-tree", "-r", "-z", ref, "--", prefix]);
  const wanted = listing.split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    const oid = entry.slice(0, tab).split(" ").at(-1);
    return { oid, type: entry.slice(0, tab).split(" ")[1], path: entry.slice(tab + 1) };
  }).filter(({ type }) => type === "blob");
  const batchSize = 512;
  for (let start = 0; start < wanted.length; start += batchSize) {
    const batch = wanted.slice(start, start + batchSize);
    const child = spawn("git", ["-C", repo, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "ignore"] });
    const pending = [];
    child.stdin.write(batch.map(({ oid }) => oid).join("\n") + "\n");
    child.stdin.end();
    let buffer = Buffer.alloc(0), closed = false;
    child.stdout.on("close", () => { closed = true; drainOrHang(); });
    child.stdout.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); pump(); });
    child.on("error", (error) => { while (pending.length) pending.shift().reject(error); });
    function drainOrHang() {
      if (closed && pending.length > 0) { const next = pending.shift(); next.reject(new Error(`cat-file stream ended before ${next.path}`)); }
    }
    for (const { oid, path } of batch) {
      const body = await new Promise((resolve, reject) => {
        pending.push({ oid, path, resolve, reject });
        pump();
      });
      yield { path, body };
    }
    function pump() {
      while (pending.length > 0) {
        const next = pending[0];
        const headerEnd = buffer.indexOf(10);
        if (headerEnd < 0) return;
        const header = buffer.subarray(0, headerEnd).toString("utf8");
        const size = Number(header.split(" ")[2]);
        if (Number.isNaN(size)) { pending.shift(); next.reject(new Error(`cat-file returned "${header}"`)); continue; }
        if (buffer.length < headerEnd + 1 + size + 1) return;
        next.resolve(buffer.subarray(headerEnd + 1, headerEnd + 1 + size).toString("utf8"));
        buffer = buffer.subarray(headerEnd + 1 + size + 1);
        pending.shift();
      }
    }
    await new Promise((resolve) => child.on("close", resolve));
  }
}

/** Every canonical event at `ref`, in ascending workspaceRevision order. */
export async function readAllEvents(repo, ref) {
  const events = [];
  for await (const { path, body } of streamTreeBlobs(repo, ref, "events")) {
    if (path.endsWith("/head.json") || path === "events/head.json") continue;
    const event = JSON.parse(body);
    if (event.opId !== path.split("/").at(-1).slice(0, -5)) throw new Error(`event object name mismatch at ${path}`);
    events.push(event);
  }
  events.sort((a, b) => a.workspaceRevision - b.workspaceRevision);
  for (const [index, event] of events.entries()) if (event.workspaceRevision !== index + 1) throw new Error(`revision ${event.workspaceRevision} is not contiguous at index ${index}`);
  return events;
}
