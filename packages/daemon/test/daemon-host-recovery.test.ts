// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskProjection, readDaemonRegistry, registerDaemonRepo } from "../../kernel/src/index.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { readDaemonLifecycleRecords } from "../src/lifecycle-log.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { startDaemon } from "../src/runtime.ts";

const auth = { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0, source: "unix-socket-filesystem-owner-boundary" } } as const;

test("a startup-failed repo self-heals on the next command and reports honest status", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-heal-")), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user");
  rosterRepo(rootDir, "host-heal");
  const root = canonicalRoot(rootDir), lockPath = `${root}.harness-anything-writer.lock`;
  registerDaemonRepo({ canonicalRoot: root, repoId: "host-heal", userRoot, createConvenienceLinks: false });
  let clock = "2026-08-18T00:00:00.000Z";
  writeFileSync(lockPath, `${process.pid}\n`); // a live lock holder: the startup open must fail
  const host = await openDaemonHost({ daemonId: "host-heal", userRoot, now: () => clock }); await host.attachmentsSettled();
  try {
    const latched = host.status().repos.find((repo) => repo.repoId === "host-heal");
    assert.ok(latched, "startup failure must park the repo in the status list");
    assert.equal(latched.state, "unavailable"); assert.equal(latched.causeClass, "infrastructure");
    assert.match(String(latched.lastError), /writer lock/u);
    assert.equal(latched.generation, null); assert.equal(latched.queueDepth, null); assert.equal(latched.recoveryMs, null);
    const systemLatched = systemRow(host, "host-heal");
    assert.equal(systemLatched.cellState, "unavailable");
    assert.equal(systemLatched.generation, null); assert.equal(systemLatched.queueDepth, null);
    assert.match(String(systemLatched.unavailableReason), /writer lock/u);
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
    assert.equal(systemAttached.unavailableReason, null);
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("startup retires a registered root that no longer exists and records the attach outcomes that remain", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-lifecycle-")), userRoot = path.join(parent, "user"), live = path.join(parent, "live"), dead = path.join(parent, "dead"), records: Record<string, unknown>[] = [];
  rosterRepo(live, "lifecycle-live"); rosterRepo(dead, "lifecycle-dead"); registerDaemonRepo({ canonicalRoot: live, repoId: "lifecycle-live", userRoot, createConvenienceLinks: false });
  const deadRow = registerDaemonRepo({ canonicalRoot: dead, repoId: "lifecycle-dead", userRoot, createConvenienceLinks: false }).repo; rmSync(dead, { recursive: true, force: true });
  const host = await openDaemonHost({ daemonId: "host-lifecycle", userRoot, recordLifecycle: (record) => records.push(record) }); await host.attachmentsSettled();
  try {
    const pruned = records.filter((record) => record.event === "repo_registry_pruned");
    assert.equal(pruned.length, 1); assert.equal(pruned[0]?.repoId, "lifecycle-dead"); assert.equal(pruned[0]?.rootDir, deadRow.canonicalRoot);
    assert.equal(typeof pruned[0]?.registeredAt, "string");
    assert.deepEqual(records.filter((record) => record.event === "repo_attach_started").map((record) => record.repoId), ["lifecycle-live"]);
    const settled = records.filter((record) => record.event === "repo_attach_completed");
    assert.equal(settled.length, 1); assert.equal(settled[0]?.repoId, "lifecycle-live");
    assert.equal(settled[0]?.attachTotal, 2); assert.equal(settled[0]?.attachIndex, 2); assert.equal(typeof settled[0]?.durationMs, "number");
    const summary = records.find((record) => record.event === "attachments_settled");
    assert.equal(summary?.attachTotal, 2); assert.equal(summary?.attached, 1); assert.equal(summary?.unavailable, 0); assert.equal(summary?.pruned, 1);
    const registry = readDaemonRegistry({ userRoot }), row = registry.repos.find((repo) => repo.repoId === "lifecycle-dead");
    assert.equal(row?.state, "disabled"); assert.equal(host.status().repos.some((repo) => repo.repoId === "lifecycle-dead"), false);
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("a request arriving while a registered repo warms parks until background attachment settles", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-warming-")), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user"); rosterRepo(rootDir, "host-warming"); registerDaemonRepo({ canonicalRoot: rootDir, repoId: "host-warming", userRoot, createConvenienceLinks: false });
  const host = await openDaemonHost({ daemonId: "host-warming", userRoot });
  try {
    assert.equal(host.status().repos.find((repo) => repo.repoId === "host-warming")?.state, "warming");
    const receipt = await host.run("host-warming", { kind: "task-list" }, auth); assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.equal(host.status().repos.find((repo) => repo.repoId === "host-warming")?.state, "attached");
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("a request parked behind a non-settling initial attachment times out as repo_warming", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-warming-timeout-")), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user"); rosterRepo(rootDir, "host-warming-timeout"); registerDaemonRepo({ canonicalRoot: rootDir, repoId: "host-warming-timeout", userRoot, createConvenienceLinks: false });
  const host = await openDaemonHost({ daemonId: "host-warming-timeout", userRoot, shutdownRequested: () => true });
  try {
    const started = performance.now(), receipt = await host.run("host-warming-timeout", { kind: "task-list" }, auth), elapsedMs = performance.now() - started;
    assert.equal(receipt.outcome, "op_rejected"); assert.equal(receipt.code, "repo_warming"); assert.ok(elapsedMs >= 4_500, `warming timeout returned too early: ${elapsedMs.toFixed(1)}ms`); assert.ok(elapsedMs < 8_000, `warming timeout exceeded its bounded window: ${elapsedMs.toFixed(1)}ms`);
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("a dead warming repository can be unregistered through daemon-level local authority", async () => {  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-unregister-warming-")), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user"); rosterRepo(rootDir, "host-unregister-warming"); registerDaemonRepo({ canonicalRoot: rootDir, repoId: "host-unregister-warming", userRoot, createConvenienceLinks: false }); rmSync(rootDir, { recursive: true, force: true });
  const host = await openDaemonHost({ daemonId: "host-unregister-warming", userRoot });
  try {
    const receipt = await host.admin({ kind: "unregister", repoId: "host-unregister-warming" }, auth); assert.equal(receipt.outcome, "applied");
    await host.attachmentsSettled(); assert.equal(host.status().repos.some((repo) => repo.repoId === "host-unregister-warming"), false);
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("a repository whose open never settles is bounded by an attach budget while the rest attach and serve", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-attach-budget-")), userRoot = path.join(parent, "user"), hung = path.join(parent, "aaa-hung"), live = path.join(parent, "zzz-live"), records: Record<string, unknown>[] = [];
  rosterRepo(hung, "aaa-hung"); rosterRepo(live, "zzz-live");
  registerDaemonRepo({ canonicalRoot: hung, repoId: "aaa-hung", userRoot, createConvenienceLinks: false });
  registerDaemonRepo({ canonicalRoot: live, repoId: "zzz-live", userRoot, createConvenienceLinks: false });
  const hungOpens: Array<(cell: Awaited<ReturnType<typeof openRepoCell>>) => void> = [];
  const openCell: typeof openRepoCell = async (cellInput) => cellInput.repoId === workspaceId("aaa-hung")
    ? new Promise((resolve) => { hungOpens.push(resolve); })
    : openRepoCell(cellInput);
  const host = await openDaemonHost({ daemonId: "attach-budget", userRoot, attachTimeoutMs: 150, openCell, recordLifecycle: (record) => records.push(record) });
  try {
    await host.attachmentsSettled();
    assert.equal(records.some((record) => record.event === "repo_attach_timed_out" && record.repoId === "aaa-hung" && record.durationMs === 150), true);
    assert.equal(records.some((record) => record.event === "attachments_settled" && record.attached === 1 && record.unavailable === 1), true);
    const latched = host.status().repos.find((repo) => repo.repoId === "aaa-hung")!;
    assert.equal(latched.state, "unavailable"); assert.match(String(latched.lastError), /did not finish attaching within 150ms/u);
    assert.equal((await host.run("aaa-hung", { kind: "task-list" }, auth)).code, "repo_unavailable");
    assert.equal((await host.run("zzz-live", { kind: "task-list" }, auth)).outcome, "applied");
    hungOpens[0]!(await openRepoCell({ repoId: workspaceId("aaa-hung"), rootDir: canonicalRoot(hung), ownerId: "attach-budget" }));
    for (let attempt = 0; attempt < 100 && host.status().repos.find((repo) => repo.repoId === "aaa-hung")?.state !== "attached"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(host.status().repos.find((repo) => repo.repoId === "aaa-hung")?.state, "attached", "a late open completion must heal the timed-out latch");
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("production-shaped cold restarts keep socket p95 below ten seconds and report attach separately", async (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-restart-budget-")), userRoot = path.join(parent, "user"), liveRoots: string[] = [];
  try {
    for (let index = 0; index < 4; index += 1) { const rootDir = path.join(parent, `live-${index}`); liveRoots.push(rootDir); rosterRepo(rootDir, `live-${index}`); for (let directory = 0; directory < 250; directory += 1) mkdirSync(path.join(rootDir, "harness", `directory-${directory}`)); registerDaemonRepo({ canonicalRoot: rootDir, repoId: `live-${index}`, userRoot, createConvenienceLinks: false }); }
    const deadRoot = path.join(parent, "dead");
    const withDeadEntry = () => { rosterRepo(deadRoot, "dead"); registerDaemonRepo({ canonicalRoot: deadRoot, repoId: "dead", userRoot, createConvenienceLinks: false }); rmSync(deadRoot, { recursive: true, force: true }); };
    const full = await restartSamples("budget-full", 20, withDeadEntry, 4, true); const liveOnly = await restartSamples("budget-live", 20, () => undefined, 4, false);
    context.diagnostic(`restart-budget full=${JSON.stringify(summary(full))}`); context.diagnostic(`restart-budget live-only=${JSON.stringify(summary(liveOnly))}`);
    assert.ok(p95(full.map((sample) => sample.socketMs)) <= 10_000); assert.ok(p95(liveOnly.map((sample) => sample.socketMs)) <= 10_000);
  } finally { rmSync(parent, { recursive: true, force: true }); }

  async function restartSamples(daemonId: string, count: number, prepare: () => void, expectedRepos: number, expectPrune: boolean): Promise<Array<{ socketMs: number; attachMs: number; maxRepoAttachMs: number }>> {
    const samples: Array<{ socketMs: number; attachMs: number; maxRepoAttachMs: number }> = [];
    for (let sample = 0; sample < count; sample += 1) {
      prepare();
      for (const rootDir of liveRoots) rmSync(path.join(rootDir, ".harness/cache"), { recursive: true, force: true });
      const before = readDaemonLifecycleRecords(userRoot, daemonId).length, started = performance.now(), daemon = await startDaemon({ userRoot, daemonId }), bound = performance.now(); assert.ok("stop" in daemon);
      for (;;) { const status = await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.status", {}, 1_000) as { readonly repos: readonly { readonly state: string }[] }; if (status.repos.length === expectedRepos && status.repos.every((repo) => repo.state !== "warming")) break; await new Promise((resolve) => setTimeout(resolve, 2)); }
      const settled = performance.now(), generation = readDaemonLifecycleRecords(userRoot, daemonId).slice(before), attachDurations = generation.filter((record) => record.event === "repo_attach_completed" || record.event === "repo_attach_failed").map((record) => record.durationMs ?? 0); assert.equal(attachDurations.length, expectedRepos);
      assert.equal(generation.some((record) => record.event === "repo_registry_pruned" && record.repoId === "dead"), expectPrune);
      samples.push({ socketMs: bound - started, attachMs: settled - bound, maxRepoAttachMs: Math.max(...attachDurations) }); await daemon.stop();
    }
    return samples;
  }
});

test("the host-level re-probe is throttled to one attempt per interval", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-throttle-")), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user");
  rosterRepo(rootDir, "host-throttle");
  const root = canonicalRoot(rootDir), lockPath = `${root}.harness-anything-writer.lock`;
  registerDaemonRepo({ canonicalRoot: root, repoId: "host-throttle", userRoot, createConvenienceLinks: false });
  let clock = "2026-08-18T00:00:00.000Z";
  writeFileSync(lockPath, `${process.pid}\n`);
  const host = await openDaemonHost({ daemonId: "host-throttle", userRoot, now: () => clock }); await host.attachmentsSettled();
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
  const host = await openDaemonHost({ daemonId: "host-modes", userRoot }); await host.attachmentsSettled();
  const assignment = (repoId: string) => ({ transportKind: "unix-socket", assignmentBinding: { nodeId: "node-mode", repoId, taskId: "task-mode", executionId: "execution-mode", assignmentId: `assignment-${repoId}`, paths: [], actor: { principal: { personId: "writer" }, executor: null } } } as const);
  try {
    assert.deepEqual(host.status().repos.map(({ repoId, mode }) => [repoId, mode]), [["center", "remote-center"], ["edge", "remote-edge"], ["local", "local"]]);
    assert.match(host.status().summary, /repos=3$/u);
    assert.equal((await host.run("local", { kind: "task-create", taskId: "task-local", title: "Local" }, auth)).outcome, "applied");
    assert.equal((await host.run("local", { kind: "task-create", taskId: "task-local-remote", title: "Assignment on local" }, assignment("local"))).outcome, "applied");
    assert.equal((await host.run("center", { kind: "task-create", taskId: "task-center-local", title: "Wrong ingress" }, auth)).code, "repo_mode_requires_center_ingress");
    const mismatchedLocalAuth = { ...auth, unixSocketOwnerBoundary: { ...auth.unixSocketOwnerBoundary, ownerUid: (process.getuid?.() ?? 0) + 1_000 } };
    assert.equal((await host.run("center", { kind: "task-list" }, mismatchedLocalAuth)).code, "credential_unknown");
    assert.equal((await host.run("center", { kind: "projection-rebuild" }, mismatchedLocalAuth)).outcome, "applied");
    assert.equal((await host.run("center", { kind: "task-create", taskId: "task-center", title: "Center" }, assignment("center"))).outcome, "applied");
    assert.equal((await host.run("edge", { kind: "task-list" }, auth)).outcome, "applied");
    assert.equal((await host.run("edge", { kind: "task-create", taskId: "task-edge", title: "Edge" }, auth)).code, "repo_mode_read_only");
    assert.equal((await host.run("edge", { kind: "projection-rebuild" }, auth)).code, "repo_mode_read_only");
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("registry mode is authoritative before refresh and refresh replaces a drifted Cell", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-mode-refresh-")), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user");
  rosterRepo(rootDir, "mode-refresh"); registerDaemonRepo({ canonicalRoot: rootDir, repoId: "mode-refresh", mode: "local", userRoot, createConvenienceLinks: false });
  const host = await openDaemonHost({ daemonId: "mode-refresh", userRoot }); await host.attachmentsSettled();
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
  const cache = path.join(rootDir, ".harness/cache/task.sqlite"); const projection = makeTaskProjection({ rootDir, eventStore: { readHead: () => null, readBatch: () => ({ sourceRevision: 0, events: [], cursor: null, done: true, accessedItems: 0 }), readContentBlob: () => null } }); projection.list(); projection.close(); const db = new DatabaseSync(cache); db.exec("UPDATE projection_meta SET schema_version = 999 WHERE singleton = 1;"); db.close();
  let clock = "2026-08-18T00:00:00.000Z";
  const host = await openDaemonHost({ daemonId: "schema-admission", userRoot, now: () => clock }); await host.attachmentsSettled();
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
function p95(values: readonly number[]): number { const sorted = [...values].sort((left, right) => left - right); return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0; }
function summary(samples: readonly { socketMs: number; attachMs: number; maxRepoAttachMs: number }[]) { return { samples: samples.length, socketP95Ms: Number(p95(samples.map((sample) => sample.socketMs)).toFixed(3)), attachP95Ms: Number(p95(samples.map((sample) => sample.attachMs)).toFixed(3)), maxRepoAttachP95Ms: Number(p95(samples.map((sample) => sample.maxRepoAttachMs)).toFixed(3)) }; }
