// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "../../daemon/src/client/local-daemon-target.ts";
import { readDaemonPid } from "../../daemon/src/runtime.ts";

const cli = path.resolve("packages/cli/src/index.ts");

test("registered workspace CLI command auto-starts the daemon, retries, and succeeds", () => {
  const fixture = setup();
  try {
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    register(fixture.root, fixture.userRoot, "autostart");
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "create", "--id", "task-autostart", "--admin", "--title", "Auto"]).outcome, "applied");
    const previousPid = readDaemonPid(fixture.userRoot, "default"); assert.ok(previousPid);
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
    waitForDaemonDown(fixture.userRoot);
    // The daemon is gone; a plain CLI command must bring it back and still answer.
    const result = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "task", "list"], { encoding: "utf8", env: cliEnv(fixture.root, fixture.userRoot) });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const receipt = JSON.parse(result.stdout) as { ok: boolean; outcome: string; error?: { code: string } };
    assert.equal(receipt.ok, true, JSON.stringify(receipt)); assert.equal(receipt.outcome, "applied");
    const restartedPid = readDaemonPid(fixture.userRoot, "default");
    assert.ok(restartedPid, "autostart must leave a resident daemon pid file"); assert.notEqual(restartedPid, previousPid);
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
  } finally { rmSync(fixture.parent, { recursive: true, force: true }); }
});

test("autostart gives up after two attempts with a classified bind-timeout error", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "requires POSIX non-root permission semantics" : false }, () => {
  const fixture = setup();
  try {
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    register(fixture.root, fixture.userRoot, "autostart-fail");
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
    waitForDaemonDown(fixture.userRoot);
    // A read-only user root makes every spawned `daemon serve` die on its pid write,
    // so the autostart loop exhausts its two attempts and reports why.
    chmodSync(fixture.userRoot, 0o555);
    const result = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "task", "list"], { encoding: "utf8", env: cliEnv(fixture.root, fixture.userRoot) });
    assert.notEqual(result.status, 0);
    const receipt = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; hint: string } };
    assert.equal(receipt.ok, false);
    assert.equal(receipt.error.code, "daemon_bind_timeout");
    assert.match(receipt.error.hint, /did not accept connections/u);
    assert.match(receipt.error.hint, /daemon serve/u);
    assert.equal(readDaemonPid(fixture.userRoot, "default"), null, "no daemon may claim to be resident after failed starts");
  } finally { chmodSync(fixture.userRoot, 0o755); rmSync(fixture.parent, { recursive: true, force: true }); }
});

function cliEnv(root: string, userRoot: string): NodeJS.ProcessEnv { return { ...process.env, HOME: path.join(root, ".home"), GIT_CONFIG_GLOBAL: "/dev/null", HARNESS_DAEMON_USER_ROOT: userRoot }; }
function setup(): { parent: string; root: string; userRoot: string } { const parent = mkdtempSync(path.join(tmpdir(), "ha-autostart-")), root = path.join(parent, "repo"), userRoot = path.join(parent, "user");
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\n", "utf8");
  writeFileSync(path.join(root, "harness/people.yaml"), `schema: harness-people/v1\npeople:\n  - personId: owner\n    displayName: Owner\n    primaryEmail: owner@example.test\n    roles: [owner]\n    credentials:\n      - kind: unix-socket-owner-boundary\n        issuer: host:${hostname()}\n        subject: ${process.getuid?.() ?? 0}\nroles:\n  - roleId: owner\n    commandClasses: [admin, repo-write, repo-read, arbiter]\n`, "utf8");
  git(root, "init", "--quiet"); git(root, "config", "user.name", "Autostart Test"); git(root, "config", "user.email", "autostart@example.test");
  git(root, "add", "harness/harness.yaml", "harness/people.yaml"); git(root, "commit", "--quiet", "-m", "fixture"); return { parent, root, userRoot }; }
function register(root: string, userRoot: string, repoId: string): void { assert.equal(run(root, userRoot, ["daemon", "repo", "register", "--repo-id", repoId, "--root", root, "--no-link"]).ok, true); }
function run(root: string, userRoot: string, args: readonly string[]): Record<string, unknown> {
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], { encoding: "utf8", env: cliEnv(root, userRoot) });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`); return JSON.parse(result.stdout) as Record<string, unknown>; }
function waitForDaemonDown(userRoot: string): void { const socketPath = localUserDaemonEndpoint(userRoot, "default");
  for (let attempt = 0; attempt < 200; attempt += 1) { if (readDaemonPid(userRoot, "default") === null && !existsSync(socketPath)) return; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
  throw new Error("previous daemon did not drain before the autostart probe"); }
function git(root: string, ...args: string[]): string { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }
