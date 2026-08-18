// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskProjection, registerDaemonRepo } from "../../kernel/src/index.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

const auth = { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0, source: "unix-socket-filesystem-owner-boundary" } } as const;

test("a startup-failed repo self-heals on the next command and reports honest status", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-heal-")), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user");
  rosterRepo(rootDir, "host-heal");
  const root = canonicalRoot(rootDir), lockPath = `${root}.harness-anything-writer.lock`;
  registerDaemonRepo({ canonicalRoot: root, repoId: "host-heal", userRoot, createConvenienceLinks: false });
  let clock = "2026-08-18T00:00:00.000Z";
  writeFileSync(lockPath, `${process.pid}\n`); // a live lock holder: the startup open must fail
  const host = await openDaemonHost({ daemonId: "host-heal", userRoot, now: () => clock });
  try {
    const latched = host.status().repos.find((repo) => repo.repoId === "host-heal");
    assert.ok(latched, "startup failure must park the repo in the status list");
    assert.equal(latched.state, "unavailable"); assert.equal(latched.causeClass, "infrastructure");
    assert.match(String(latched.lastError), /writer lock/u);
    assert.equal(latched.generation, null); assert.equal(latched.queueDepth, null); assert.equal(latched.recoveryMs, null);
    const systemLatched = systemRow(host, "host-heal");
    assert.equal(systemLatched.cellState, "unavailable");
    assert.equal(systemLatched.generation, null); assert.equal(systemLatched.queueDepth, null);
    // Repair the workspace underneath the live daemon; the next command re-attaches it.
    rmSync(lockPath); clock = "2026-08-18T00:00:01.000Z"; // fresh latch earned one immediate probe
    const healed = await host.run("host-heal", { kind: "task-create", taskId: "task_host_heal", title: "Host heal" }, auth);
    assert.equal(healed.outcome, "applied", JSON.stringify(healed));
    const attached = host.status().repos.find((repo) => repo.repoId === "host-heal")!;
    assert.equal(attached.state, "attached"); assert.equal(attached.lastError, null);
    assert.equal(typeof attached.generation, "number"); assert.ok(attached.generation! > 0);
    assert.equal(typeof attached.queueDepth, "number");
    const systemAttached = systemRow(host, "host-heal");
    assert.equal(systemAttached.cellState, "attached"); assert.equal(typeof systemAttached.generation, "number");
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("startup records each repository attach outcome with duration and ordinal", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-lifecycle-")), userRoot = path.join(parent, "user"), live = path.join(parent, "live"), dead = path.join(parent, "dead"), records: Record<string, unknown>[] = [];
  rosterRepo(live, "lifecycle-live"); rosterRepo(dead, "lifecycle-dead"); registerDaemonRepo({ canonicalRoot: live, repoId: "lifecycle-live", userRoot, createConvenienceLinks: false });
  registerDaemonRepo({ canonicalRoot: dead, repoId: "lifecycle-dead", userRoot, createConvenienceLinks: false }); rmSync(dead, { recursive: true, force: true });
  const host = await openDaemonHost({ daemonId: "host-lifecycle", userRoot, recordLifecycle: (record) => records.push(record) });
  try {
    assert.deepEqual(records.filter((record) => record.event === "repo_attach_started").map((record) => record.repoId).sort(), ["lifecycle-dead", "lifecycle-live"]);
    const settled = records.filter((record) => record.event === "repo_attach_completed" || record.event === "repo_attach_failed");
    assert.equal(settled.length, 2); assert.deepEqual(settled.map((record) => record.attachTotal), [2, 2]);
    assert.deepEqual(settled.map((record) => record.attachIndex), [1, 2]); assert.equal(settled.every((record) => typeof record.durationMs === "number"), true);
    assert.equal(settled.some((record) => record.event === "repo_attach_completed" && record.repoId === "lifecycle-live"), true);
    assert.equal(settled.some((record) => record.event === "repo_attach_failed" && record.repoId === "lifecycle-dead" && typeof record.error === "string"), true);
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("the host-level re-probe is throttled to one attempt per interval", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-throttle-")), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user");
  rosterRepo(rootDir, "host-throttle");
  const root = canonicalRoot(rootDir), lockPath = `${root}.harness-anything-writer.lock`;
  registerDaemonRepo({ canonicalRoot: root, repoId: "host-throttle", userRoot, createConvenienceLinks: false });
  let clock = "2026-08-18T00:00:00.000Z";
  writeFileSync(lockPath, `${process.pid}\n`);
  const host = await openDaemonHost({ daemonId: "host-throttle", userRoot, now: () => clock });
  try {
    const rejected = await host.run("host-throttle", { kind: "task-list" }, auth); // probe 1 fails on the live lock
    assert.equal(rejected.outcome, "op_rejected"); assert.equal(rejected.code, "repo_unavailable");
    assert.equal(host.status().repos.find((repo) => repo.repoId === "host-throttle")!.state, "unavailable");
    rmSync(lockPath);
    clock = "2026-08-18T00:00:01.000Z"; // inside the throttle window of probe 1
    const throttled = await host.run("host-throttle", { kind: "task-list" }, auth);
    assert.equal(throttled.outcome, "op_rejected"); assert.equal(throttled.code, "repo_unavailable"); // no probe ran
    clock = "2026-08-18T00:00:06.000Z"; // past the throttle window
    const healed = await host.run("host-throttle", { kind: "task-list" }, auth);
    assert.equal(healed.outcome, "applied", JSON.stringify(healed));
    assert.equal(host.status().repos.find((repo) => repo.repoId === "host-throttle")!.state, "attached");
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("repository modes close local, center-assignment, and edge command families", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-modes-")), userRoot = path.join(parent, "user"), roots = Object.fromEntries(["local", "center", "edge"].map((name) => [name, path.join(parent, name)]));
  for (const [name, rootDir] of Object.entries(roots)) { rosterRepo(rootDir, name); registerDaemonRepo({ canonicalRoot: rootDir, repoId: name, mode: name === "center" ? "remote-center" : name === "edge" ? "remote-edge" : "local", userRoot, createConvenienceLinks: false }); }
  const host = await openDaemonHost({ daemonId: "host-modes", userRoot });
  const assignment = (repoId: string) => ({ transportKind: "unix-socket", assignmentBinding: { nodeId: "node-mode", repoId, taskId: "task-mode", executionId: "execution-mode", assignmentId: `assignment-${repoId}`, paths: [], actor: { principal: { personId: "writer" }, executor: null } } } as const);
  try {
    assert.deepEqual(host.status().repos.map(({ repoId, mode }) => [repoId, mode]), [["center", "remote-center"], ["edge", "remote-edge"], ["local", "local"]]);
    assert.match(host.status().summary, /repos=3$/u);
    assert.equal((await host.run("local", { kind: "task-create", taskId: "task-local", title: "Local" }, auth)).outcome, "applied");
    assert.equal((await host.run("local", { kind: "task-create", taskId: "task-local-remote", title: "Assignment on local" }, assignment("local"))).outcome, "applied");
    assert.equal((await host.run("center", { kind: "task-create", taskId: "task-center-local", title: "Wrong ingress" }, auth)).code, "repo_mode_requires_center_ingress");
    assert.equal((await host.run("center", { kind: "task-create", taskId: "task-center", title: "Center" }, assignment("center"))).outcome, "applied");
    assert.equal((await host.run("edge", { kind: "task-list" }, auth)).outcome, "applied");
    assert.equal((await host.run("edge", { kind: "task-create", taskId: "task-edge", title: "Edge" }, auth)).code, "repo_mode_read_only");
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("a dist orphan from an old build graph does not reject the resident daemon", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-dist-orphan-admission-")), rootDir = path.join(parent, "repo"), runtimeRoot = path.join(parent, "runtime"), runtimeFile = builtRuntime(runtimeRoot, "build-a");
  const source = path.join(runtimeRoot, "packages/application/src/record.ts"), orphan = path.join(runtimeRoot, "packages/cli/dist/application/src/record.js"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    rosterRepo(rootDir, "dist-orphan-admission"); for (const file of [source, orphan]) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `${path.basename(file)}\n`); }
    const old = Date.now() / 1_000 - 10, current = old + 5; utimesSync(orphan, old, old); utimesSync(source, current, current);
    cell = await openRepoCell({ repoId: workspaceId("dist-orphan-admission"), rootDir: canonicalRoot(rootDir), ownerId: "dist-orphan-admission", runtimeFile });
    assert.equal((await cell.run({ kind: "task-create", taskId: "task_dist_orphan", title: "Dist orphan" }, writerBinding)).outcome, "applied");
  } finally { await cell?.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("an uncommitted canonical source edit does not reject the unchanged daemon process", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-dirty-source-admission-")), rootDir = path.join(parent, "repo"), runtimeRoot = path.join(parent, "runtime"), runtimeFile = builtRuntime(runtimeRoot, "build-a");
  const source = path.join(runtimeRoot, "packages/cli/src/cli/thin-command.ts"), output = path.join(runtimeRoot, "packages/cli/dist/cli/src/cli/thin-command.js"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    rosterRepo(rootDir, "dirty-source-admission"); for (const file of [source, output]) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `${path.basename(file)}\n`); }
    const old = Date.now() / 1_000 - 10, current = old + 5; utimesSync(output, old, old); utimesSync(source, current, current);
    cell = await openRepoCell({ repoId: workspaceId("dirty-source-admission"), rootDir: canonicalRoot(rootDir), ownerId: "dirty-source-admission", runtimeFile });
    assert.equal((await cell.run({ kind: "task-create", taskId: "task_dirty_source", title: "Dirty source" }, writerBinding)).outcome, "applied");
  } finally { await cell?.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("a dist rebuild after process start rejects writes until the daemon restarts", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-rebuilt-dist-admission-")), rootDir = path.join(parent, "repo"), runtimeRoot = path.join(parent, "runtime"), runtimeFile = builtRuntime(runtimeRoot, "build-a"), buildId = path.join(runtimeRoot, "packages/cli/dist/build-id.txt"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    rosterRepo(rootDir, "rebuilt-dist-admission"); cell = await openRepoCell({ repoId: workspaceId("rebuilt-dist-admission"), rootDir: canonicalRoot(rootDir), ownerId: "rebuilt-dist-admission", runtimeFile });
    assert.equal((await cell.run({ kind: "task-create", taskId: "task_before_rebuild", title: "Before rebuild" }, writerBinding)).outcome, "applied");
    writeFileSync(buildId, "build-b\n");
    const rejected = await cell.run({ kind: "task-create", taskId: "task_after_rebuild", title: "After rebuild" }, writerBinding);
    assert.equal(rejected.outcome, "op_rejected"); assert.equal(rejected.code, "daemon_build_stale"); assert.equal(cell.status().state, "unavailable");
  } finally { await cell?.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("registry mode is authoritative before refresh and refresh replaces a drifted Cell", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-mode-refresh-")), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user");
  rosterRepo(rootDir, "mode-refresh"); registerDaemonRepo({ canonicalRoot: rootDir, repoId: "mode-refresh", mode: "local", userRoot, createConvenienceLinks: false });
  const host = await openDaemonHost({ daemonId: "mode-refresh", userRoot });
  try {
    const generation = host.status().repos[0]?.generation; registerDaemonRepo({ canonicalRoot: rootDir, repoId: "mode-refresh", mode: "remote-edge", userRoot, createConvenienceLinks: false });
    const denied = await host.run("mode-refresh", { kind: "task-create", taskId: "task_mode_drift", title: "Mode drift" }, auth);
    assert.equal(denied.outcome, "op_rejected"); assert.equal(denied.code, "repo_mode_read_only");
    const refresh = await host.requestControl({ kind: "refresh", authorityRepoId: "mode-refresh" }, auth); assert.equal(refresh.outcome, "pending");
    const settled = await waitControl(host, refresh.operationId); assert.equal(settled.phase, "settled");
    const status = host.status().repos[0]!; assert.equal(status.mode, "remote-edge"); assert.notEqual(status.generation, generation);
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("remote-edge Cell terminal side effects require Cell-level mode admission", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-cell-terminal-mode-")), rootDir = path.join(parent, "repo"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    rosterRepo(rootDir, "cell-terminal-mode"); cell = await openRepoCell({ repoId: workspaceId("cell-terminal-mode"), rootDir: canonicalRoot(rootDir), ownerId: "cell-terminal-mode", mode: "remote-edge" }); const binding = { actor: { principal: { personId: "writer" }, executor: null }, source: "local" as const };
    assert.throws(() => cell!.terminal.spawn({}, binding), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "repo_mode_read_only");
    assert.throws(() => cell!.terminal.spawnTrusted({} as never, binding), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "repo_mode_read_only");
  } finally { await cell?.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("daemon admission rejects a mismatched kernel projection schema and recovers after rebuild", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-schema-admission-")), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user");
  rosterRepo(rootDir, "schema-admission"); registerDaemonRepo({ canonicalRoot: rootDir, repoId: "schema-admission", userRoot, createConvenienceLinks: false });
  const cache = path.join(rootDir, ".harness/cache/task.sqlite"); makeTaskProjection({ rootDir, eventStore: { readHead: () => null, readBatch: () => ({ sourceRevision: 0, events: [], cursor: null, done: true, accessedItems: 0 }), readContentBlob: () => null } }).list(); const db = new DatabaseSync(cache); db.exec("UPDATE projection_meta SET schema_version = 999 WHERE singleton = 1;"); db.close();
  let clock = "2026-08-18T00:00:00.000Z";
  const host = await openDaemonHost({ daemonId: "schema-admission", userRoot, now: () => clock });
  try {
    const unavailable = host.status().repos.find((repo) => repo.repoId === "schema-admission")!;
    assert.equal(unavailable.state, "unavailable"); assert.equal(unavailable.causeClass, "data-shape"); assert.match(String(unavailable.lastError), /kernel projection schema 999/u);
    assert.equal((await host.run("schema-admission", { kind: "task-list" }, auth)).code, "repo_unavailable");
    const repaired = new DatabaseSync(cache); repaired.exec("UPDATE projection_meta SET schema_version = 2 WHERE singleton = 1;"); repaired.close(); clock = "2026-08-18T00:00:06.000Z";
    assert.equal((await host.run("schema-admission", { kind: "task-list" }, auth)).outcome, "applied");
    assert.equal(host.status().repos.find((repo) => repo.repoId === "schema-admission")?.state, "attached");
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

function systemRow(host: Awaited<ReturnType<typeof openDaemonHost>>, repoId: string): Record<string, unknown> {
  const system = host.system(auth) as { readonly repos: readonly Record<string, unknown>[] };
  const row = system.repos.find((repo) => repo.repoId === repoId);
  assert.ok(row, `gui-system-status must list ${repoId}`);
  return row;
}
const writerBinding = { actor: { principal: { personId: "writer" }, executor: null }, source: "local" as const };
function builtRuntime(runtimeRoot: string, buildId: string): string {
  const runtimeFile = path.join(runtimeRoot, "packages/cli/dist/daemon/src/runtime-admission.js"), marker = path.join(runtimeRoot, "packages/cli/dist/build-id.txt");
  for (const [file, body] of [[runtimeFile, "runtime\n"], [marker, `${buildId}\n`]] as const) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body); }
  return runtimeFile;
}
function rosterRepo(rootDir: string, repoId: string): void {
  mkdirSync(rootDir, { recursive: true });
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Host Recovery Test");
  git(rootDir, "config", "user.email", "host-recovery@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
  mkdirSync(path.join(rootDir, "harness"));
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), `schema: harness-anything/v1\nname: ${repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`);
  const people = [{ personId: "writer", displayName: "writer", roles: ["writer"], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(process.getuid?.() ?? 0) }] }];
  const roles = [{ roleId: "writer", commandClasses: ["repo-read", "repo-write", "admin"] }];
  writeFileSync(path.join(rootDir, "harness/people.yaml"), `${JSON.stringify({ schema: "harness-people/v1", people, roles }, null, 2)}\n`);
  git(rootDir, "add", "harness"); git(rootDir, "commit", "--quiet", "-m", "add roster fixture");
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
async function waitControl(host: Awaited<ReturnType<typeof openDaemonHost>>, operationId: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) { const receipt = host.controlReceipt(operationId, auth); if (receipt.phase === "settled" || receipt.phase === "failed") return receipt; await new Promise<void>((resolve) => setImmediate(resolve)); }
  assert.fail(`control ${operationId} did not settle`);
}
