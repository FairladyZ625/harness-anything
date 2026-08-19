#!/usr/bin/env node
// W4 acceptance: one concurrent collaborator writer, run INSIDE an edge
// container against its remote-edge workspace. Every `ha` call goes through
// the real fleet channel (lease broker, epoch-fenced center writer, mirror
// auto-pull); nothing here mocks or bypasses the product write path.
//
// The worker prints one JSON record per line on stdout for the host to
// capture; the mechanical acceptance assertions consume those records:
//   own    — start (or create+start) a task this node owns, then append
//            progress entries until rounds/deadline.
//   shared — contend for ONE shared task with the other edges: start (parks
//            in the center FIFO queue while another collaborator holds),
//            optionally hold, append, release — round after round.
//
// Failure policy: transient transport/queue outcomes are retried in place
// (same opId semantics as the product client); a final non-applied outcome is
// recorded as {ok:false} and the worker moves on. The acceptance assertions
// only ever count receipts that reported applied — the center is the judge.

import { spawnSync } from "node:child_process";

const WORKSPACE = "/data/workspace";
// Codes the product client itself treats as retry-in-place: the command may
// still settle, so re-issuing must not invent a second logical write.
const RETRYABLE = new Set([
  "center_closing", "client_disconnected", "lease_state_unavailable",
  "op_in_flight", "wait_expired", "daemon_disconnect"
]);
const ATTEMPTS = 4;

const option = (name, fallback = null) => {
  const at = process.argv.indexOf(name);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
};
const nodeId = option("--node");
const mode = option("--mode");
const tag = option("--tag") ?? "w4";
const rounds = Number(option("--rounds", "4"));
const appends = Number(option("--appends", "2"));
const gapMs = Number(option("--gap-ms", "200"));
const holdMs = Number(option("--hold-ms", "0"));
const ttlMs = option("--ttl-ms");
const deadlineMs = Number(option("--deadline-epoch-ms", "0"));

if (!nodeId || (mode !== "own" && mode !== "shared")) {
  console.error("usage: node acceptance-w4-worker.mjs --node edge-1 --mode own|shared --tag <run-tag> [--task <id>] [--rounds N] [--appends K] [--gap-ms N] [--hold-ms N] [--ttl-ms N] [--deadline-epoch-ms N]");
  process.exit(2);
}
const timeLeft = () => deadlineMs === 0 || Date.now() < deadlineMs;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

let applied = 0, failed = 0;
emit({ t: "worker-start", node: nodeId, mode, tag });

function ha(args) {
  for (let attempt = 1; ; attempt += 1) {
    // Bound the fleet wait so a queued command can never park this CLI process
    // for the center-side default (30min): a worker death while queued would
    // otherwise leave a dead FIFO head behind. The product client re-attaches
    // with the same opId within this budget; the sweep clears stale items at
    // the same deadline.
    const result = spawnSync("ha", ["--json", "--root", WORKSPACE, ...args], {
      encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 5 * 60 * 1000,
      env: { ...process.env, HARNESS_TASK_WAIT_TIMEOUT_MS: "120000" }
    });
    let receipt = null;
    try { receipt = JSON.parse(result.stdout); } catch { /* not a receipt */ }
    if (result.status === 0 && receipt?.ok === true) return { ok: true, receipt };
    const code = receipt?.code ?? receipt?.error?.code ?? null;
    if (attempt < ATTEMPTS && (code === null || RETRYABLE.has(code))) { sleep(400 * attempt); continue; }
    return { ok: false, receipt: receipt ?? null, code, stderr: String(result.stderr ?? "").slice(0, 400), status: result.status };
  }
}

function record(entry) {
  if (entry.ok) applied += 1; else failed += 1;
  emit(entry);
}

function emit(value) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`);
}

function createTask() {
  const title = `W4 ${mode} ${nodeId} ${tag}`;
  const result = ha(["task", "create", "--title", title, "--preset", "standard-task"]);
  record({ t: "create", ok: result.ok, opId: result.receipt?.opId ?? null, taskId: result.receipt?.taskId ?? null, title, ...(result.ok ? {} : { code: result.code, stderr: result.stderr }) });
  return result.ok ? result.receipt.taskId : null;
}

function startTask(taskId) {
  const result = ha(["task", "start", taskId, ...(ttlMs ? ["--ttl-ms", ttlMs] : [])]);
  record({
    t: "start", ok: result.ok, opId: result.receipt?.opId ?? null, taskId,
    executionId: result.receipt?.executionId ?? null,
    leaseAssignment: result.receipt?.fleet?.lease?.assignmentId ?? null,
    ...(result.ok ? {} : { code: result.code, stderr: result.stderr })
  });
  return result.ok;
}

function appendProgress(taskId, label) {
  const text = `W4 ${nodeId} ${tag} ${label}`;
  const result = ha(["task", "progress", "append", taskId, "--text", text]);
  record({
    t: "append", ok: result.ok, opId: result.receipt?.opId ?? null, eventId: result.receipt?.eventId ?? null,
    revision: result.receipt?.revision ?? null, taskId, text, mirrorOutcome: result.receipt?.mirrorOutcome ?? null,
    ...(result.ok ? {} : { code: result.code, stderr: result.stderr })
  });
}

function releaseTask(taskId) {
  const result = ha(["task", "release", taskId, "--reason", `W4 ${tag}: handing the shared task to the next collaborator`]);
  record({ t: "release", ok: result.ok, opId: result.receipt?.opId ?? null, taskId, ...(result.ok ? {} : { code: result.code, stderr: result.stderr }) });
}

if (mode === "own") {
  const taskId = option("--task") ?? createTask();
  if (taskId === null) { emit({ t: "summary", node: nodeId, mode, applied, failed, fatal: "task create failed" }); process.exit(1); }
  if (!startTask(taskId)) { emit({ t: "summary", node: nodeId, mode, applied, failed, fatal: "task start failed" }); process.exit(1); }
  for (let round = 1; round <= rounds && timeLeft(); round += 1) {
    for (let entry = 1; entry <= appends && timeLeft(); entry += 1) {
      appendProgress(taskId, `r${round}a${entry}`);
      if (gapMs > 0) sleep(gapMs);
    }
  }
} else {
  const taskId = option("--task");
  if (!taskId) { console.error("shared mode requires --task"); process.exit(2); }
  for (let round = 1; round <= rounds && timeLeft(); round += 1) {
    if (!startTask(taskId)) continue;
    if (holdMs > 0) sleep(holdMs);
    for (let entry = 1; entry <= appends && timeLeft(); entry += 1) appendProgress(taskId, `r${round}a${entry}`);
    releaseTask(taskId);
  }
}

emit({ t: "summary", node: nodeId, mode, applied, failed });
