// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { daemonSingletonLockPath } from "../../daemon/src/daemon-singleton.ts";
import { localUserDaemonEndpoint } from "../../daemon/src/client/local-daemon-target.ts";
import { daemonPidPath, readDaemonPid } from "../../daemon/src/runtime.ts";

const cli = path.resolve("packages/cli/src/index.ts");

// #1565: on Windows nothing delivers SIGTERM -- process.kill terminates unconditionally and the
// daemon's shutdown never runs, so its pid file outlives it. `daemon stop` waited on that file and
// reported daemon_stop_timeout for a daemon that had already stopped. SIGKILL reproduces the same
// condition here: the handler does not run, and the file is left behind exactly as on Windows.
test("#1565: a daemon whose shutdown never ran still yields a successful stop receipt", async () => {
  const fixture = setup();
  try {
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    const pid = readDaemonPid(fixture.userRoot, "default");
    assert.ok(pid, "the resident daemon must have published a pid");
    process.kill(pid as number, "SIGKILL");
    await waitForProcessExit(pid as number, 5_000);
    assert.equal(existsSync(daemonPidPath(fixture.userRoot, "default")), true, "an ungraceful exit leaves the pid file behind");
    assert.equal(existsSync(daemonSingletonLockPath(fixture.userRoot, "default")), true, "an ungraceful exit leaves the singleton lock behind");

    const stopped = run(fixture.root, fixture.userRoot, ["daemon", "stop"]);
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    assert.notEqual(stopped.code, "daemon_stop_timeout");
    assert.equal(existsSync(daemonPidPath(fixture.userRoot, "default")), false, "stop must clear the bookkeeping it outlived");
    assert.equal(existsSync(daemonSingletonLockPath(fixture.userRoot, "default")), false, "stop must clear the singleton lock it outlived");
  } finally { rmSync(fixture.parent, { recursive: true, force: true }); }
});

test("two concurrent daemon serves yield exactly one resident daemon and one deferral receipt", async () => {
  const fixture = setup();
  try {
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    register(fixture.root, fixture.userRoot, "singleton-race");
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "create", "--id", "task-singleton", "--admin", "--title", "Singleton"]).outcome, "applied");
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
    waitForDaemonDown(fixture.userRoot);

    const first = spawnServe(fixture.userRoot), second = spawnServe(fixture.userRoot);
    try {
      const deferred = await firstDeferral([first, second]), survivorPid = await residentPid(fixture.userRoot);
      assert.equal(deferred.ok, true, JSON.stringify(deferred));
      assert.equal(deferred.outcome, "deferred");
      assert.equal(deferred.incumbent?.pid, survivorPid, "the deferral receipt must point at the serving incumbent");
      assert.equal((await firstExit([first, second])).code, 0, "the yielding serve must exit 0");
      // One holder owns both surfaces: the socket answers and the workspace writer lock is not rejected.
      assert.equal(run(fixture.root, fixture.userRoot, ["task", "list"]).outcome, "applied");
      assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
      waitForDaemonDown(fixture.userRoot);
      assert.equal(existsSync(daemonSingletonLockPath(fixture.userRoot, "default")), false, "a stopped daemon must release the singleton lock");
    } finally { reap(first); reap(second); }
  } finally { stop(fixture.userRoot); cleanup(fixture.parent); }
});

test("SIGTERM during a long migration replay exits the daemon in bounded time and releases every lock", async () => {
  const fixture = setup(), legacyRoot = path.join(fixture.parent, "legacy");
  try {
    legacyFixture(legacyRoot, 150);
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    register(fixture.root, fixture.userRoot, "singleton-import");

    const migration = spawn(process.execPath, [cli, "--root", fixture.root, "--json", "migrate", "import", "--source", legacyRoot], { encoding: "utf8", env: cliEnv(fixture.root, fixture.userRoot) });
    await waitForImportProgress(fixture.root, 3);
    const pid = readDaemonPid(fixture.userRoot, "default");
    assert.ok(pid, "a resident daemon pid file must exist mid-replay");
    const termAt = Date.now();
    process.kill(pid, "SIGTERM");
    await waitForProcessExit(pid, 20_000);
    const exitMs = Date.now() - termAt;
    assert.ok(exitMs < 20_000, `daemon must exit in bounded time, took ${exitMs}ms`);
    const migrationResult = await closeOf(migration);
    assert.notEqual(migrationResult.code, 0, "an interrupted migration must not report success");
    assert.equal(existsSync(daemonSingletonLockPath(fixture.userRoot, "default")), false, "SIGTERM exit must release the singleton lock");
    assert.equal(existsSync(`${fixture.root}.harness-anything-writer.lock`), false, "SIGTERM exit must release the workspace writer lock");
    assert.equal(existsSync(localUserDaemonEndpoint(fixture.userRoot, "default")), false, "SIGTERM exit must remove the socket");

    // A clean restart takes the slot back over: no wedge, no stale incumbent.
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "status"]).ok, true);
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
  } finally { stop(fixture.userRoot); cleanup(fixture.parent); }
});

const serveOutput = new WeakMap<ChildProcess, string>();
function spawnServe(userRoot: string): ChildProcess {
  const child = spawn(process.execPath, [cli, "daemon", "serve", "--user-root", userRoot, "--daemon-id", "default", "--json"], { env: cliEnv(userRoot, userRoot) });
  serveOutput.set(child, "");
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => serveOutput.set(child, `${serveOutput.get(child) ?? ""}${chunk.toString("utf8")}`));
  return child;
}
async function firstDeferral(children: readonly ChildProcess[]): Promise<{ readonly ok?: boolean; readonly outcome?: string; readonly incumbent?: { readonly pid?: number } }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const child of children) if (child.exitCode === 0) return parseReceipt(child);
    await delay(50);
  }
  throw new Error("neither serve deferred within 30s");
}
async function firstExit(children: readonly ChildProcess[]): Promise<{ readonly code: number | null }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { const exited = children.find((child) => child.exitCode !== null); if (exited) return { code: exited.exitCode }; await delay(50); }
  throw new Error("no serve exited within 30s");
}
function parseReceipt(child: ChildProcess): { readonly ok?: boolean; readonly outcome?: string; readonly incumbent?: { readonly pid?: number } } { const line = (serveOutput.get(child) ?? "").split("\n").find((candidate) => candidate.startsWith("{")); return line ? JSON.parse(line) as Record<string, unknown> as { ok?: boolean; outcome?: string; incumbent?: { pid?: number } } : {}; }
async function residentPid(userRoot: string): Promise<number> {
  for (let attempt = 0; attempt < 300; attempt += 1) { const pid = readDaemonPid(userRoot, "default"); if (pid !== null) return pid; await delay(50); }
  throw new Error("no resident daemon pid appeared");
}
async function waitForImportProgress(root: string, minimumRevisions: number): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) { if (git(root, "rev-list", "--count", "HEAD") - 1 >= minimumRevisions) return; await delay(100); }
  throw new Error("migration replay did not start committing events");
}
async function waitForProcessExit(pid: number, boundMs: number): Promise<void> {
  for (const deadline = Date.now() + boundMs; Date.now() < deadline;) { try { process.kill(pid, 0); } catch { return; } await delay(50); }
  throw new Error(`process ${pid} did not exit within ${boundMs}ms`);
}
function closeOf(child: ChildProcess): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> { return new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode }); else child.once("close", (code, signal) => resolve({ code, signal })); }); }
function reap(child: ChildProcess): void { void closeOf(child).then(() => undefined, () => undefined); try { child.kill("SIGKILL"); } catch { /* already gone */ } }
function cliEnv(root: string, userRoot: string): NodeJS.ProcessEnv { const { HARNESS_ACTOR: _actor, ...base } = process.env; return { ...base, HOME: path.join(root, ".home"), GIT_CONFIG_GLOBAL: "/dev/null", HARNESS_DAEMON_USER_ROOT: userRoot }; }
function setup(): { parent: string; root: string; userRoot: string } { const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-singleton-cli-")), root = path.join(parent, "repo"), userRoot = path.join(parent, "user");
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# Fixture\n", "utf8");
  writeFileSync(path.join(root, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\n", "utf8");
  writeFileSync(path.join(root, "harness/people.yaml"), `schema: harness-people/v1\npeople:\n  - personId: owner\n    displayName: Owner\n    primaryEmail: owner@example.test\n    roles: [owner]\n    credentials:\n      - kind: unix-socket-owner-boundary\n        issuer: host:${hostname()}\n        subject: ${process.getuid?.() ?? 0}\nroles:\n  - roleId: owner\n    commandClasses: [admin, repo-write, repo-read, arbiter]\n`, "utf8");
  git(root, "init", "--quiet"); git(root, "config", "user.name", "Singleton Test"); git(root, "config", "user.email", "singleton@example.test");
  git(root, "add", "README.md", "harness/harness.yaml", "harness/people.yaml"); git(root, "commit", "--quiet", "-m", "fixture"); return { parent, root, userRoot }; }
function legacyFixture(root: string, taskCount: number): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "harness/harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n", "utf8");
  for (let index = 0; index < taskCount; index += 1) {
    const taskId = `task_legacy_bulk_${index}`, taskRoot = path.join(root, "harness/tasks", taskId);
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), `---\nschema: task-package/v2\ntask_id: ${taskId}\ntitle: Bulk legacy task ${index}\nlifecycle:\n  status: done\n  engine: local\n  bindingCreatedAt: 2026-01-0${1 + (index % 8)}T00:00:00.000Z\n---\n\n# Bulk legacy task ${index}\n`, "utf8");
  }
  git(root, "init", "--quiet"); git(root, "config", "user.name", "Legacy Fixture"); git(root, "config", "user.email", "legacy@example.test");
  git(root, "add", "."); git(root, "commit", "--quiet", "-m", "legacy bulk fixture");
}
function register(root: string, userRoot: string, repoId: string): void { assert.equal(run(root, userRoot, ["daemon", "repo", "register", "--repo-id", repoId, "--root", root, "--no-link"]).ok, true); }
function run(root: string, userRoot: string, args: readonly string[]): Record<string, unknown> {
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], { encoding: "utf8", env: cliEnv(root, userRoot) });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`); return JSON.parse(result.stdout) as Record<string, unknown>; }
function stop(userRoot: string): void {
  const pid = readDaemonPid(userRoot, "default"); if (pid === null) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  // A killed daemon leaves its pid file and socket file behind; remove both so
  // a failure-path cleanup cannot leak a stale endpoint into the next run.
  rmSync(daemonPidPath(userRoot, "default"), { force: true }); rmSync(localUserDaemonEndpoint(userRoot, "default"), { force: true });
}
function cleanup(parent: string): void { for (let attempt = 0; ; attempt += 1) { try { rmSync(parent, { recursive: true, force: true }); return; } catch (error) { if (attempt >= 10) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } } }
function waitForDaemonDown(userRoot: string): void { const socketPath = localUserDaemonEndpoint(userRoot, "default");
  for (let attempt = 0; attempt < 200; attempt += 1) { if (readDaemonPid(userRoot, "default") === null && !existsSync(socketPath)) return; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
  throw new Error("previous daemon did not drain before the next probe"); }
function git(root: string, ...args: string[]): number { return Number(execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
