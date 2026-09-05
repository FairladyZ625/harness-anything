#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonProcessAlive } from "../src/daemon-singleton.ts";
import { readDaemonPid } from "../src/runtime.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  cli = path.join(repositoryRoot, "packages/cli/src/index.ts");

export async function reproduceRegistryWalRestart(arm, options = {}) {
  if (arm !== "graceful-stop" && arm !== "sigkill") throw new Error(`unknown reproduction arm: ${arm}`);
  const fixtureRoot = options.fixtureRoot ?? mkdtempSync(path.join(tmpdir(), `ha-daemon-wal-${arm}-`)),
    rootDir = path.join(fixtureRoot, "repository"),
    userRoot = path.join(fixtureRoot, "user-root"),
    repoId = `registry-wal-${arm}`,
    daemonId = `registry-wal-${arm}`,
    fixture = { fixtureRoot, rootDir, userRoot, repoId, daemonId };
  rosterRepo(rootDir, repoId);
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  downgradeRegistryToV1(userRoot);
  startDaemon(fixture);
  await waitForAttached(fixture);
  const taskReceipt = runCli(fixture, ["task", "create", "--title", `Daemon WAL ${arm}`]),
    taskId = String(taskReceipt.taskId),
    factReceipt = runCli(fixture, [
      "fact",
      "record",
      taskId,
      "--statement",
      `Daemon WAL ${arm} fact`,
      "--source",
      `test:registry-wal-${arm}`,
      "--confidence",
      "high",
    ]),
    before = observeBefore(fixture, taskReceipt, factReceipt);
  assert.equal(taskReceipt.commitSha, null, JSON.stringify(taskReceipt));
  assert.equal(factReceipt.commitSha, null, JSON.stringify(factReceipt));
  assert.ok(before.walLines >= 2, JSON.stringify(before));
  if (arm === "graceful-stop") runCli(fixture, ["daemon", "stop"]);
  else killDaemon(fixture);
  await waitForStopped(fixture);
  startDaemon(fixture);
  await waitForAttached(fixture);
  const task = runCli(fixture, ["task", "show", taskId]),
    fact = runCli(fixture, ["fact", "show", "--id", String(factReceipt.factId)]),
    after = observeAfter(fixture, taskId, String(factReceipt.factId), String(taskReceipt.packagePath), task, fact);
  runCli(fixture, ["daemon", "stop"]);
  await waitForStopped(fixture);
  return { arm, fixtureRoot, before, after };
}

function observeBefore(fixture, taskReceipt, factReceipt) {
  return {
    registrySchema: registrySchema(fixture),
    canonicalEventHead: canonicalHead(fixture.rootDir),
    walLines: walLines(fixture.rootDir),
    taskPackageExists: packageExists(fixture.rootDir, String(taskReceipt.packagePath)),
    receipts: { taskReceipt, factReceipt },
  };
}
function observeAfter(fixture, taskId, factId, packagePath, task, fact) {
  const taskEvidence = JSON.parse(String(task.evidence)),
    factEvidence = JSON.parse(String(fact.evidence));
  return {
    registrySchema: registrySchema(fixture),
    canonicalEventHead: canonicalHead(fixture.rootDir),
    walLines: walLines(fixture.rootDir),
    taskPackageExists: packageExists(fixture.rootDir, packagePath),
    taskId: taskEvidence.task.taskId,
    factId: factEvidence.fact.factId,
    expectedTaskId: taskId,
    expectedFactId: factId,
  };
}
function startDaemon(fixture) {
  const result = runCliResult(fixture, ["daemon", "start", "--service"]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\n${daemonLog(fixture)}`);
}
function killDaemon(fixture) {
  const pid = readDaemonPid(fixture.userRoot, fixture.daemonId);
  assert.notEqual(pid, null, "isolated daemon must publish its pid before SIGKILL");
  process.kill(pid, "SIGKILL");
}
async function waitForAttached(fixture) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const result = runCliResult(fixture, ["daemon", "status"]);
    if (
      result.status === 0 &&
      JSON.parse(result.stdout).repos?.some((repo) => repo.repoId === fixture.repoId && repo.state === "attached")
    )
      return;
    if (Date.now() > deadline)
      throw new Error(`daemon did not attach: ${result.stderr}\n${result.stdout}\n${daemonLog(fixture)}`);
    await delay(50);
  }
}
async function waitForStopped(fixture) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const pid = readDaemonPid(fixture.userRoot, fixture.daemonId);
    if (pid === null || !daemonProcessAlive(pid)) return;
    if (Date.now() > deadline) throw new Error(`daemon ${fixture.daemonId} did not stop`);
    await delay(50);
  }
}
function runCli(fixture, args) {
  const result = runCliResult(fixture, args);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\n${daemonLog(fixture)}`);
  return JSON.parse(result.stdout);
}
function runCliResult(fixture, args) {
  return spawnSync(process.execPath, [cli, "--root", fixture.rootDir, "--json", ...args], {
    encoding: "utf8",
    env: isolatedEnvironment(fixture),
    timeout: 60_000,
  });
}
function isolatedEnvironment(fixture) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("HARNESS_")) delete env[key];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    HARNESS_ACTOR: "agent:harness-test",
    HARNESS_DAEMON_ID: fixture.daemonId,
    HARNESS_DAEMON_REPO_ID: fixture.repoId,
    HARNESS_DAEMON_USER_ROOT: fixture.userRoot,
  };
}
function daemonLog(fixture) {
  const log = path.join(fixture.userRoot, "logs", `daemon-${fixture.daemonId}.log`);
  return existsSync(log) ? readFileSync(log, "utf8") : "daemon log absent";
}
function downgradeRegistryToV1(userRoot) {
  const registryPath = path.join(userRoot, "registry.json"),
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  writeFileSync(
    registryPath,
    `${JSON.stringify({
      schema: "harness-daemon-registry/v1",
      repos: registry.repos.map(({ mode: _mode, connectionId: _connectionId, ...repo }) => repo),
    })}\n`,
  );
}
function registrySchema(fixture) {
  return JSON.parse(readFileSync(path.join(fixture.userRoot, "registry.json"), "utf8")).schema;
}
function packageExists(rootDir, packagePath) {
  return existsSync(path.join(rootDir, packagePath)) || existsSync(path.join(rootDir, "harness", packagePath));
}
function walLines(rootDir) {
  const segment = path.join(rootDir, ".harness/wal/seg-000000.log");
  return existsSync(segment) ? readFileSync(segment, "utf8").trim().split("\n").filter(Boolean).length : 0;
}
function canonicalHead(rootDir) {
  try {
    return JSON.parse(git(rootDir, "show", "refs/ha/canonical:harness/events/head.json")).revision;
  } catch {
    return 0;
  }
}
function rosterRepo(rootDir, repoId) {
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Registry WAL Daemon Test");
  git(rootDir, "config", "user.email", "registry-wal-daemon@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    [
      "schema: harness-anything/v1",
      `name: ${repoId}`,
      "layout:",
      "  authoredRoot: harness",
      "  localRoot: .harness",
      "settings:",
      "  walFlush:",
      "    adaptive: false",
      "    events: 256",
      "    bytes: 8388608",
      "    milliseconds: 3600000",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(rootDir, "harness/people.yaml"),
    `${JSON.stringify({
      schema: "harness-people/v1",
      people: [
        {
          personId: "writer",
          displayName: "writer",
          roles: ["writer"],
          credentials: [
            {
              kind: "unix-socket-owner-boundary",
              issuer: `host:${hostname()}`,
              subject: String(process.getuid?.() ?? 0),
            },
          ],
        },
      ],
      roles: [{ roleId: "writer", commandClasses: ["repo-read", "repo-write", "admin"] }],
    })}\n`,
  );
  git(rootDir, "add", "harness");
  git(rootDir, "commit", "--quiet", "-m", "fixture base");
}
function git(rootDir, ...args) {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const requestedArm = process.argv[2],
    arms = requestedArm ? [requestedArm] : ["graceful-stop", "sigkill"];
  for (const arm of arms) process.stdout.write(`${JSON.stringify(await reproduceRegistryWalRestart(arm), null, 2)}\n`);
}
