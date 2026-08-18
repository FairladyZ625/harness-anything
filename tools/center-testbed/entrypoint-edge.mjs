#!/usr/bin/env node
// Edge-container entrypoint. Each edge runs its own daemon in its own socket
// namespace and stays resident; the read-path smoke (`smoke-edge.mjs`) then
// drives `ha daemon fleet edge sync` through this daemon on demand. Edge views
// under /data/view survive restarts so re-runs exercise the delta/current
// replica paths instead of always resnapshotting.

import { existsSync, rmSync } from "node:fs";
import { fail, log, startDaemon } from "./lib/testbed.mjs";

const userRoot = "/data/daemon-user";
const nodeId = process.env.TESTBED_NODE_ID;

if (!nodeId) fail("env", "TESTBED_NODE_ID is required (set per edge service in docker-compose.yml).");
if (existsSync(userRoot)) rmSync(userRoot, { recursive: true, force: true });

const daemon = startDaemon("edge", userRoot, nodeId);
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => daemon.kill(signal));
}
log("edge", `READY: edge ${nodeId} daemon resident; run the smoke to pull a replica view`);

const exitCode = await new Promise((resolve) => daemon.once("exit", (code, signal) => resolve(signal ? 0 : code ?? 0)));
process.exit(exitCode);
