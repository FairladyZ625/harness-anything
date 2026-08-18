// Shared runtime helpers for the PLT-Center Docker testbed. Everything here runs
// INSIDE a testbed container against the baked-in harness-anything source tree;
// the host only ever drives `docker compose` and the smoke script.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const TESTBED = Object.freeze({
  sourceRoot: "/opt/harness-anything",
  testbedRoot: "/opt/testbed",
  sharedRoot: "/data/shared",
  stateFile: "/data/shared/testbed-state.json",
  fleetPort: 7443,
  fleetQuotaBytes: 268_435_456,
  repoId: "plt-center-testbed",
  personId: "testbed-owner",
  actor: "agent:plt-center-testbed",
  gitAuthor: { name: "PLT Center Testbed", email: "plt-center-testbed@invalid" },
  gitlabUrl: (process.env.GITLAB_URL ?? "http://43.142.81.196:8929").replace(/\/+$/u, ""),
  gitlabProject: process.env.TESTBED_GITLAB_PROJECT ?? "plt-center-testbed"
});

export function log(step, message) {
  console.log(`[testbed:${step}] ${message}`);
}

export function fail(step, message) {
  console.error(`[testbed:${step}] FAILED: ${message}`);
  process.exit(1);
}

// The CLI entry prefers the built dist (the same artifact CI and the coldstart
// benchmark image run) and falls back to source when dist has not been built.
export function cliEntry() {
  const dist = path.join(TESTBED.sourceRoot, "packages/cli/dist/cli/src/index.js");
  const source = path.join(TESTBED.sourceRoot, "packages/cli/src/index.ts");
  if (existsSync(dist)) return dist;
  if (existsSync(source)) return source;
  throw new Error(`harness-anything CLI entry is missing at ${TESTBED.sourceRoot}`);
}

export function harnessEnv(extra = {}) {
  const { name, email } = TESTBED.gitAuthor;
  return {
    ...process.env,
    HARNESS_ACTOR: TESTBED.actor,
    HARNESS_GIT_AUTHOR_NAME: name,
    HARNESS_GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    ...extra
  };
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

export function mustRun(step, command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    fail(step, `${command} ${args.join(" ")} exited ${result.status}: ${result.stderr.trim().slice(0, 2000)}`);
  }
  return result.stdout;
}

// `ha --json` emits command receipts whose payload lives under details.data plus
// a paths map; flatten both so callers read receipt.taskId-style fields directly.
// Path overrides only apply when the envelope actually carries a paths map —
// receipts like task-create already expose packagePath at the top level.
export function unwrapReceipt(value) {
  const data = value?.details?.data && typeof value.details.data === "object" ? value.details.data : {};
  const paths = Object.fromEntries(Array.isArray(value?.paths) ? value.paths.map((entry) => [entry.role, entry.path]) : []);
  const flattened = { ...value, ...data };
  if (paths.package) flattened.packagePath = paths.package;
  if (paths.primary) flattened.primaryPath = paths.primary;
  return flattened;
}

export function ha(step, env, args, options = {}) {
  const argv = ["--json", ...args];
  const result = run(process.execPath, [cliEntry(), ...argv], { ...options, env });
  if (result.status !== 0) {
    const hint = parseReceiptHint(result.stdout) ?? result.stderr.trim().slice(0, 2000);
    fail(step, `ha ${args.join(" ")} exited ${result.status}: ${hint}`);
  }
  const receipt = unwrapReceipt(JSON.parse(result.stdout));
  if (receipt.ok !== true) {
    fail(step, `ha ${args.join(" ")} rejected: ${parseReceiptHint(result.stdout) ?? JSON.stringify(receipt).slice(0, 2000)}`);
  }
  return receipt;
}

function parseReceiptHint(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed?.error?.hint ?? parsed?.details?.data?.error?.hint ?? null;
  } catch {
    return null;
  }
}

// The resident daemon is the container's main long-running process; entrypoints
// spawn it and own its lifecycle, so this helper only waits for the socket.
export function startDaemon(step, userRoot, daemonId) {
  const child = spawn(process.execPath, [cliEntry(), "daemon", "serve", "--user-root", userRoot, "--daemon-id", daemonId], {
    env: harnessEnv({ HARNESS_DAEMON_USER_ROOT: userRoot, HARNESS_DAEMON_ID: daemonId }),
    stdio: ["ignore", "inherit", "inherit"],
    detached: false
  });
  child.on("error", (error) => fail(step, `daemon serve could not start: ${error.message}`));
  waitForDaemon(step, userRoot, daemonId, 120_000);
  log(step, `daemon serving (pid ${child.pid ?? "unknown"}, user-root ${userRoot})`);
  return child;
}

export function waitForDaemon(step, userRoot, daemonId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = run(process.execPath, [cliEntry(), "--json", "daemon", "status", "--user-root", userRoot, "--daemon-id", daemonId], {
      env: harnessEnv({ HARNESS_DAEMON_USER_ROOT: userRoot, HARNESS_DAEMON_ID: daemonId })
    });
    if (result.status === 0) return;
    if (Date.now() > deadline) fail(step, `daemon did not accept connections within ${timeoutMs}ms: ${result.stderr.trim().slice(0, 500)}`);
    sleepMs(500);
  }
}

export function daemonStatus(userRoot, daemonId) {
  const result = run(process.execPath, [cliEntry(), "--json", "daemon", "status", "--user-root", userRoot, "--daemon-id", daemonId], {
    env: harnessEnv({ HARNESS_DAEMON_USER_ROOT: userRoot, HARNESS_DAEMON_ID: daemonId })
  });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function readState() {
  return JSON.parse(readFileSync(TESTBED.stateFile, "utf8"));
}

export function fleetEnv(userRoot, daemonId) {
  return harnessEnv({ HARNESS_DAEMON_USER_ROOT: userRoot, HARNESS_DAEMON_ID: daemonId });
}

// One-shot git credential helper: hands the token to git without persisting it
// into any .git/config (the config only ever records the clean http URL).
export function gitCredentialArgs() {
  return ["-c", `credential.helper=!f() { echo username=oauth2; echo password=$GITLAB_TOKEN; }; f`];
}
