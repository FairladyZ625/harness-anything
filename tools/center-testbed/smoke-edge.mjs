#!/usr/bin/env node
// Per-edge read-path smoke, run INSIDE an edge container:
//   node /opt/testbed/smoke-edge.mjs edge-1
// Pulls the center replica through this edge's daemon, asserts the seeded task,
// decision, and fact documents are readable from the local view, then re-syncs
// to prove idempotency (second pull answers "current", zero transfer).

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TESTBED, fail, fleetEnv, ha, log } from "./lib/testbed.mjs";

const nodeId = process.argv[2];
if (!nodeId) fail("usage", "node smoke-edge.mjs <node-id> (e.g. edge-1)");

const state = JSON.parse(readFileSync(TESTBED.stateFile, "utf8"));
const roster = JSON.parse(readFileSync(state.fleet.rosterPath, "utf8"));
const node = roster.nodes.find((entry) => entry.nodeId === nodeId);
const assignment = roster.assignments.find((entry) => entry.nodeId === nodeId);
if (!node || !assignment) fail("roster", `node ${nodeId} is not present in ${state.fleet.rosterPath}`);

const userRoot = "/data/daemon-user";
const viewRoot = "/data/view";
const env = fleetEnv(userRoot, nodeId);

// A reseed replaces ledger history; retained cuts from an older generation can
// collide by revision number and fail the edge's atomic view verification. The
// generation marker wipes the view only when the canonical head actually
// changed, so re-runs within one generation still exercise delta/current.
const generationFile = path.join(viewRoot, "generation.json");
const generation = existsSync(generationFile) ? JSON.parse(readFileSync(generationFile, "utf8")) : null;
if (generation?.canonicalHead !== state.canonicalHead) {
  if (existsSync(viewRoot)) for (const entry of readdirSync(viewRoot)) rmSync(path.join(viewRoot, entry), { recursive: true, force: true });
  writeFileSync(generationFile, `${JSON.stringify({ canonicalHead: state.canonicalHead }, null, 2)}\n`);
  log("view", `ledger generation changed; view reset for canonical ${state.canonicalHead.slice(0, 12)}`);
}
const syncArgs = [
  "daemon", "fleet", "edge", "sync",
  "--host", "center", "--port", String(state.fleet.port), "--ca", state.fleet.certPath,
  "--node-id", nodeId, "--credential", node.credential, "--assignment", assignment.assignmentId,
  "--view-root", viewRoot, "--quota-bytes", String(state.fleet.quotaBytes)
];

const first = ha("sync", env, syncArgs);
// A fresh center answers with a real transfer (fleet.ack.result/v1); a smoke
// re-run against an already-current view legitimately answers "current". Both
// must land on the seeded cut — the document assertions below catch a stale or
// empty view either way.
const firstStatuses = ["fleet.ack.result/v1", "fleet.replica.current/v1"];
if (!firstStatuses.includes(first.status)) fail("sync", `pull #1 returned unexpected status ${first.status}`);
log("sync", `pull #1 ok: status ${first.status} ackCut ${first.ackCut} (center cut revision ${first.cut.revision})`);

const view = path.join(viewRoot, "repos", state.repoId, "views", assignment.viewId);
const current = JSON.parse(readFileSync(path.join(view, "current.json"), "utf8"));
if (current.cut.revision < state.seedRevision) fail("view", `view cut ${current.cut.revision} is behind the seed revision ${state.seedRevision}`);
const cutFiles = path.join(view, "cuts", String(current.cut.revision), "files");

const taskDoc = readText(path.join(cutFiles, `${state.packagePath}/task_plan.md`));
assertContains("task doc", taskDoc, state.taskTitle);
const decisionDoc = readText(path.join(cutFiles, state.decisionPath));
assertContains("decision doc", decisionDoc, "The center daemon owns the canonical ledger");
const factsDoc = readText(path.join(cutFiles, `${state.packagePath}/facts.md`));
assertContains("facts doc", factsDoc, "The testbed bootstrap wrote a task, a decision, and a fact");
log("view", `edge view serves cut ${current.cut.revision} with task, decision, and fact documents`);

const second = ha("resync", env, syncArgs);
if (second.status !== "fleet.replica.current/v1") fail("resync", `expected idempotent fleet.replica.current/v1, got ${second.status}`);
log("resync", `pull #2 ok: center confirms the view is current at cut ${second.cut.revision} (no transfer)`);

log("smoke", `SMOKE PASS: edge ${nodeId} reads the center ledger projection through fleet TLS`);

function readText(file) {
  if (!existsSync(file)) fail("view", `expected view file ${file} is missing`);
  return readFileSync(file, "utf8");
}

function assertContains(label, body, marker) {
  if (!body.includes(marker)) fail("view", `${label} does not contain the seeded marker "${marker}"`);
}
