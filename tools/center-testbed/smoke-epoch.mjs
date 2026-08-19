#!/usr/bin/env node
// Run inside the center container. A separate writer-candidate process uses
// the same durable state to CAS a successor epoch while the serving center
// remains alive on :7443. The old endpoint is then exercised without a
// caller-supplied epoch, proving that it cannot adopt its successor's row and
// append to the canonical ledger. A real center cannot simultaneously attach
// the canonical RepoCell (its physical writer lock correctly blocks it), so
// this candidate process is the exact center-CAS contention seam; the shell
// wrapper restarts the center afterward to prove a fresh CellWriter proceeds.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runFleetTaskCommandClient } from "/opt/harness-anything/packages/daemon/src/fleet/edge.ts";
import { readFleetRosterFile } from "/opt/harness-anything/packages/daemon/src/fleet-center-admission.ts";
import { openPersistentWriterEpoch } from "/opt/harness-anything/packages/daemon/src/writer-epoch.ts";

const workspace = "/data/workspace";
const stateRoot = "/data/fleet-state";
const state = JSON.parse(readFileSync("/data/shared/testbed-state.json", "utf8"));
const roster = readFleetRosterFile(state.fleet.rosterPath);
const assignment = roster.assignments.find((entry) => entry.nodeId === "edge-1");
const taskId = process.env.TESTBED_EPOCH_TASK_ID;
if (!assignment || typeof taskId !== "string" || taskId.length === 0) throw new Error("epoch smoke needs the edge-1 assignment and TESTBED_EPOCH_TASK_ID");

const credentials = new Map(roster.nodes.map((node) => [node.nodeId, node.credential]));
const cert = readFileSync(state.fleet.certPath);
const epochAuthority = openPersistentWriterEpoch({ stateRoot, holderId: "testbed-fencing-candidate" });
const successor = epochAuthority.acquire(state.repoId);

const git = (...args) => execFileSync("git", ["-C", path.join(workspace, "harness"), ...args], { encoding: "utf8" }).trim();
const commitsBefore = Number(git("rev-list", "--count", "refs/ha/canonical"));
const peer = {
  ca: cert.toString("utf8"),
  servername: "localhost",
  nodeId: assignment.nodeId,
  credential: credentials.get(assignment.nodeId),
  assignmentId: assignment.assignmentId,
  repoId: state.repoId,
  taskId,
  waitMs: 5_000
};
const stale = await runFleetTaskCommandClient({
  ...peer,
  hostname: "127.0.0.1",
  port: state.fleet.port,
  opId: `epoch-fence-stale-${Date.now()}`,
  action: { kind: "task-progress-append", taskId, text: "stale center must produce zero writes" }
});
if (stale.outcome !== "op_rejected" || stale.code !== "writer_epoch_stale") throw new Error(`stale center was not fenced: ${JSON.stringify(stale)}`);
const commitsAfterStale = Number(git("rev-list", "--count", "refs/ha/canonical"));
if (commitsAfterStale !== commitsBefore) throw new Error(`stale center appended ${commitsAfterStale - commitsBefore} canonical commits`);

const durable = JSON.parse(readFileSync(path.join(stateRoot, "writer-epochs.json"), "utf8"));
const row = durable.repos[state.repoId];
if (!row || row.epoch !== successor.epoch || row.holderId !== successor.holderId) throw new Error(`writer epoch did not persist the successor allocation: ${JSON.stringify(durable)}`);

epochAuthority.close();
console.log(`TESTBED EPOCH FENCING PASS: candidate epoch ${row.epoch} fenced the stale center with zero canonical writes`);
