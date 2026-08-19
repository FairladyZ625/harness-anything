#!/usr/bin/env node
// Center-container entrypoint. Owns the resident daemon, attaches the canonical
// ledger (cloned from GitLab on a cold boot), drives the projection rebuild,
// then starts the fleet TLS center the edge containers replicate from and
// write through. A marker file flips the compose healthcheck once the fleet
// center is listening.
//
// Cold vs warm: the first boot (or any boot after a reseed bumped the shared
// generation) deterministically re-clones and wipes local state. A restart
// within the same generation keeps the workspace, the daemon registry, and the
// fleet lease/queue state under /data/fleet-state, so the restart-survival
// scenario exercises a real warm restart rather than a reseed.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TESTBED, cliEntry, daemonStatus, fail, fleetEnv, gitCredentialArgs, ha, harnessEnv, log, mustRun, run, sleepMs, startDaemon } from "./lib/testbed.mjs";

const workspace = "/data/workspace";
const userRoot = "/data/daemon-user";
const fleetStateRoot = "/data/fleet-state";
const bootMarker = "/data/center-boot.json";
const readyMarker = "/data/center-ready";

await main();

async function main() {
  if (!process.env.GITLAB_TOKEN) fail("env", "GITLAB_TOKEN is required for the center clone.");
  if (!existsSync(TESTBED.stateFile)) fail("env", `${TESTBED.stateFile} is missing; the seed bootstrap must complete first.`);
  // The marker survives on the volume; without this wipe a restarting center
  // would report healthy from the previous boot while still rebuilding.
  rmSync(readyMarker, { force: true });
  const state = JSON.parse(readFileSync(TESTBED.stateFile, "utf8"));
  const warm = warmBoot(state);
  // Same rationale as the edge entrypoint: a hard-killed daemon leaves the
  // workspace writer lock behind and a fresh container PID namespace can
  // recycle the recorded pid, defeating the stale-lock heuristic. Cold boots
  // wipe the whole /data volume anyway; only warm boots need this.
  const writerLock = `${workspace}.harness-anything-writer.lock`;
  if (warm && existsSync(writerLock)) rmSync(writerLock, { force: true });

  const daemon = startDaemon("center", userRoot, "center");
  forwardSignals(daemon);

  if (!warm) coldBoot(state);
  await waitForProjection();
  startFleetCenter(state);
  if (!warm) writeFileSync(bootMarker, `${JSON.stringify({ generation: state.generation }, null, 2)}\n`);
  writeFileSync(readyMarker, `${new Date().toISOString()}\n`);
  log("center", `READY: fleet center listening on 0.0.0.0:${TESTBED.fleetPort} (${warm ? "warm restart; lease state kept" : "cold boot"} at ${fleetStateRoot}); marker ${readyMarker}`);

  const exitCode = await new Promise((resolve) => daemon.once("exit", (code, signal) => resolve(signal ? 0 : code ?? 0)));
  process.exit(exitCode);
}

// Warm boot iff the ledger generation is unchanged, the cloned ledger is still
// present, and the daemon registry survived. Anything else re-clones.
function warmBoot(state) {
  if (!existsSync(bootMarker) || !existsSync(path.join(workspace, "harness", ".git")) || !existsSync(path.join(userRoot, "registry.json"))) return false;
  try {
    const marker = JSON.parse(readFileSync(bootMarker, "utf8"));
    return marker.generation === state.generation;
  } catch {
    return false;
  }
}

function coldBoot(state) {
  for (const target of [workspace, userRoot, fleetStateRoot]) {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(workspace, { recursive: true });
  cloneLedger(state);
  registerRepo();
}

function forwardSignals(daemon) {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => daemon.kill(signal));
  }
}

function cloneLedger(state) {
  const env = harnessEnv({ GITLAB_TOKEN: process.env.GITLAB_TOKEN }), ledger = path.join(workspace, "harness");
  mustRun("clone", "git", [...gitCredentialArgs(), "clone", "--branch", "main", state.gitlab.httpUrl, ledger], { env });
  // A branch checkout does not transfer non-branch refs; the canonical anchor
  // rides its own ref and must be fetched explicitly.
  mustRun("clone", "git", ["-C", ledger, ...gitCredentialArgs(), "fetch", "origin", "refs/ha/canonical:refs/ha/canonical"], { env });
  const head = mustRun("clone", "git", ["-C", ledger, "rev-parse", "refs/ha/canonical"], { env: harnessEnv() }).trim();
  if (head !== state.canonicalHead) fail("clone", `cloned canonical head ${head} does not match the seeded head ${state.canonicalHead}`);
  log("clone", `ledger cloned from GitLab at canonical ${head.slice(0, 12)} (seed revision ${state.seedRevision})`);
}

function registerRepo() {
  ha("register", fleetEnv(userRoot, "center"), ["daemon", "repo", "register", "--repo-id", TESTBED.repoId, "--root", workspace]);
  log("register", `repo ${TESTBED.repoId} registered at ${workspace}`);
}

async function waitForProjection() {
  const env = fleetEnv(userRoot, "center"), deadline = Date.now() + 300_000;
  for (;;) {
    const status = daemonStatus(userRoot, "center");
    const repos = status?.repos ?? [];
    const attached = repos.length === 1 && repos[0].repoId === TESTBED.repoId && repos[0].state === "attached";
    if (attached) {
      // The replica cut source only becomes exact once the projection has
      // caught up; drive it with a read and require a non-zero revision.
      const probe = run(process.execPath, [cliEntry(), "--json", "--root", workspace, "task", "list"], { env });
      if (probe.status === 0) {
        const receipt = JSON.parse(probe.stdout);
        if (receipt.ok === true && Number(receipt.revision ?? 0) > 0) {
          log("projection", `projection ready at revision ${receipt.revision}`);
          return;
        }
      }
    }
    if (Date.now() > deadline) fail("projection", `projection did not become ready within 300s: ${JSON.stringify(repos).slice(0, 400)}`);
    sleepMs(2_000);
  }
}

function startFleetCenter(state) {
  const fleet = path.join(TESTBED.sharedRoot, "fleet");
  ha("fleet", fleetEnv(userRoot, "center"), [
    "daemon", "fleet", "center", "start",
    "--port", String(TESTBED.fleetPort), "--bind", "0.0.0.0",
    "--key", path.join(fleet, "fleet.key"), "--cert", path.join(fleet, "fleet.crt"),
    "--roster", state.fleet.rosterPath, "--quota-bytes", String(TESTBED.fleetQuotaBytes),
    "--state-root", fleetStateRoot
  ]);
  log("fleet", `fleet TLS center started for ${state.fleet.nodes.length} roster nodes`);
}
