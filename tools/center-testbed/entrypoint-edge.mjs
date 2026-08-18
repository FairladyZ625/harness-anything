#!/usr/bin/env node
// Edge-container entrypoint. Each edge runs its own daemon in its own socket
// namespace and stays resident. The read-path smoke (`smoke-edge.mjs`) pulls
// replica views on demand; the write path marks the workspace as a remote-edge
// mirror by dropping fleet-edge.json (the machine credential itself stays only
// in the shared roster; the daemon resolves it at run time). Edge views under
// /data/view survive restarts so re-runs exercise the delta/current replica
// paths instead of always resnapshotting.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { TESTBED, fail, log, readState, startDaemon } from "./lib/testbed.mjs";

const userRoot = "/data/daemon-user";
const workspace = "/data/workspace";
const nodeId = process.env.TESTBED_NODE_ID;

if (!nodeId) fail("env", "TESTBED_NODE_ID is required (set per edge service in docker-compose.yml).");
if (existsSync(userRoot)) rmSync(userRoot, { recursive: true, force: true });
// The mirror root must exist before any consumer (sync, smoke) walks it; on a
// fresh named volume /data/view is absent and a first-run generation check
// would otherwise ENOENT.
mkdirSync("/data/view", { recursive: true });

writeEdgeConfig();

const daemon = startDaemon("edge", userRoot, nodeId);
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => daemon.kill(signal));
}
log("edge", `READY: edge ${nodeId} daemon resident; ha task writes in ${workspace} route to the center automatically`);

const exitCode = await new Promise((resolve) => daemon.once("exit", (code, signal) => resolve(signal ? 0 : code ?? 0)));
process.exit(exitCode);

function writeEdgeConfig() {
  const state = readState();
  const roster = JSON.parse(readFileSync(state.fleet.rosterPath, "utf8"));
  const assignment = roster.assignments.find((entry) => entry.nodeId === nodeId);
  if (!assignment) fail("roster", `no assignment for node ${nodeId} in ${state.fleet.rosterPath}`);
  mkdirSync(workspace, { recursive: true });
  const config = {
    schema: "fleet-edge-config/v1",
    repoId: state.repoId,
    host: "center",
    port: state.fleet.port,
    caPath: state.fleet.certPath,
    nodeId,
    rosterPath: state.fleet.rosterPath,
    assignmentId: assignment.assignmentId,
    viewRoot: "/data/view",
    quotaBytes: state.fleet.quotaBytes
  };
  const staging = `${workspace}/fleet-edge.json.staging`;
  writeFileSync(staging, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(staging, `${workspace}/fleet-edge.json`);
}
