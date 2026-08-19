#!/usr/bin/env node
// W4 acceptance: mechanical assertions against the CANONICAL ledger inside the
// center container. Reads the receipts manifest (JSON lines of applied write
// receipts collected from every edge worker and host-driven round) and checks:
//   1. no lost update — every applied receipt's event is present in the
//      canonical event stream exactly once (identity match on eventId, with
//      opId as the fallback identity for receipts that carry no eventId);
//   2. no duplicate revision — the event stream's workspaceRevision values are
//      exactly 1..head, each once: strictly monotonic with no gap and no dup;
//   3. head truth — prints headRevision plus the headDigest (sha256 over the
//      serialized events/head.json, the same bytes the fleet cut digest covers)
//      so the host can require every edge's synced cut to match byte-for-byte.
// Optional: --expect-lease-released <task-id> requires an orphan-reap audit
// event (type lease_released) for that task. Exits non-zero on any violation.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const LEDGER = "/data/workspace/harness";
const REF = "refs/ha/canonical";
const option = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : null;
};
const receiptsFile = option("--receipts");
if (!receiptsFile) { console.error("usage: acceptance-w4-verify.mjs --receipts <jsonl> [--expect-lease-released <task-id>]"); process.exit(2); }
const expectReleasedTask = option("--expect-lease-released");

const git = (args) => spawnSync("git", ["-C", LEDGER, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const headCommit = git(["rev-parse", REF]);
if (headCommit.status !== 0) fail(`git rev-parse ${REF} failed: ${headCommit.stderr.trim()}`);

// Full canonical event inventory straight from git objects (not the worktree).
const tree = git(["ls-tree", "-r", "-z", "--name-only", REF, "--", "events"]);
if (tree.status !== 0) fail(`git ls-tree failed: ${tree.stderr.trim()}`);
const paths = tree.stdout.split("\0").filter((path) => path.endsWith(".json") && path !== "events/head.json");
const blobs = await catFileBatch([`${REF}:events/head.json`, ...paths.map((path) => `${REF}:${path}`)]);
const headBody = blobs[0];
if (typeof headBody !== "string") fail("events/head.json is missing from the canonical ref");
const head = JSON.parse(headBody);
const events = blobs.slice(1).map((body, index) => {
  if (typeof body !== "string") fail(`event object missing at ${paths[index]}`);
  try { return JSON.parse(body); } catch (error) { fail(`event object ${paths[index]} is not JSON: ${error.message}`); }
});

// 2. revision integrity: strictly monotonic 1..head, each exactly once.
const violations = [];
const revisionSeen = new Map();
for (const [index, event] of events.entries()) {
  const revision = event.workspaceRevision;
  if (!Number.isInteger(revision) || revision < 1) { violations.push(`event ${paths[index]} has non-positive revision ${revision}`); continue; }
  const prior = revisionSeen.get(revision);
  if (prior !== undefined) violations.push(`revision ${revision} appears twice: ${prior} and ${paths[index]}`);
  else revisionSeen.set(revision, paths[index]);
}
for (let revision = 1; revision <= head.revision; revision += 1) {
  if (!revisionSeen.has(revision)) violations.push(`revision ${revision} is missing from the canonical event stream (head ${head.revision})`);
}
if (revisionSeen.size !== events.length) violations.push(`event count ${events.length} does not match distinct revisions ${revisionSeen.size}`);
if (events.length !== head.revision) violations.push(`event count ${events.length} does not match head revision ${head.revision}`);

// 1. no lost update: identity-locate every applied receipt exactly once.
const byEventId = new Map(), byOpId = new Map();
for (const [index, event] of events.entries()) {
  if (typeof event.eventId === "string") byEventId.set(event.eventId, [...(byEventId.get(event.eventId) ?? []), index]);
  if (typeof event.opId === "string") byOpId.set(event.opId, [...(byOpId.get(event.opId) ?? []), index]);
}
const receipts = readFileSync(receiptsFile, "utf8").split("\n").filter((line) => line.trim().length > 0).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return [{ malformed: line.slice(0, 200) }]; }
});
let checked = 0, missing = 0;
for (const receipt of receipts) {
  const identity = receipt.eventId ?? receipt.opId;
  if (typeof identity !== "string" || identity.length === 0) { violations.push(`receipt record without identity: ${JSON.stringify(receipt).slice(0, 200)}`); continue; }
  const hits = receipt.eventId ? byEventId.get(receipt.eventId) : byOpId.get(receipt.opId);
  checked += 1;
  if (hits === undefined || hits.length === 0) { missing += 1; violations.push(`LOST UPDATE: applied receipt ${identity} has no event in canonical`); continue; }
  if (hits.length > 1) violations.push(`DUPLICATE EVENT: ${identity} matches ${hits.length} canonical events (${hits.map((index) => paths[index]).join(", ")})`);
  if (receipt.opId && byOpId.get(receipt.opId)?.[0] !== hits[0]) violations.push(`receipt ${receipt.opId} identity disagrees with its event`);
}

// Optional orphan-reap audit: the reaper writes a lease_released task event.
if (expectReleasedTask !== null) {
  const released = events.some((event) => event.type === "lease_released" && event.taskId === expectReleasedTask);
  if (!released) violations.push(`no lease_released audit event for ${expectReleasedTask} (orphan reap missing)`);
}

const headDigest = `sha256:${createHash("sha256").update(headBody, "utf8").digest("hex")}`;
const report = {
  ok: violations.length === 0,
  canonicalCommit: headCommit.stdout.trim(),
  headRevision: head.revision,
  headDigest,
  events: events.length,
  receiptsChecked: checked,
  receiptsMissing: missing,
  ...(expectReleasedTask !== null ? { leaseReleasedAudit: events.some((event) => event.type === "lease_released" && event.taskId === expectReleasedTask) } : {}),
  violations: violations.slice(0, 20)
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (violations.length !== 0) process.exit(1);

function fail(message) { console.error(`acceptance-w4-verify: ${message}`); process.exit(1); }

// git cat-file --batch reader: feeds `<ref>:<path>` specs on stdin and returns
// the blob bodies in order. Event objects are UTF-8 JSON, so text frames are
// safe here; sizes come from the batch headers.
function catFileBatch(specs) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", LEDGER, "cat-file", "--batch"]);
    let buffer = Buffer.alloc(0);
    const bodies = [];
    child.stdin.on("error", () => {});
    child.stdin.end(specs.join("\n") + "\n");
    child.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        const header = buffer.subarray(0, newline).toString("utf8").split(" ");
        if (header.length === 2 && header[1] === "missing") { bodies.push(null); buffer = buffer.subarray(newline + 1); continue; }
        const size = Number(header[2]);
        if (!Number.isInteger(size)) { child.kill(); reject(new Error(`unparsable cat-file header '${header.join(" ")}'`)); return; }
        if (buffer.length < newline + 1 + size + 1) return;
        bodies.push(buffer.subarray(newline + 1, newline + 1 + size).toString("utf8"));
        buffer = buffer.subarray(newline + 1 + size + 1);
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => { if (code === 0) resolve(bodies); else reject(new Error(`git cat-file --batch exited ${code} after ${bodies.length} bodies`)); });
  });
}
