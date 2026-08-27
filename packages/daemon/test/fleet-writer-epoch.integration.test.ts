// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";

function probeGit(repo: string, ...args: string[]): string { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim(); }
function probeRepo(root: string): string { const repo = path.join(root, "repo"); mkdirSync(path.join(repo, "harness"), { recursive: true }); probeGit(repo, "init", "-q"); probeGit(repo, "config", "user.name", "W3A Probe"); probeGit(repo, "config", "user.email", "w3a@example.invalid"); probeGit(repo, "commit", "--allow-empty", "-qm", "base"); writeFileSync(path.join(repo, "harness", "harness.yaml"), "schema: harness-anything/v1\nname: probe\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n"); probeGit(repo, "add", "harness"); probeGit(repo, "commit", "-qm", "harness"); return repo; }
const probeBinding = (assertWriterEpoch: () => void) => ({ actor: { principal: { personId: "writer" }, executor: { kind: "agent" as const, id: "probe" } }, source: { kind: "assignment" as const, nodeId: "node", assignmentId: "assignment" }, assertWriterEpoch });

function childEpoch(source: string, root: string, holderId: string, readyFile = ""): Promise<{ readonly code: number | null; readonly lease: { readonly epoch: number; readonly holderId: string } | null }> {
  const code = `import { writeFileSync } from "node:fs"; import { openPersistentWriterEpoch } from ${JSON.stringify(pathToFileURL(source).href)}; const [root, holder, ready] = process.argv.slice(1); const authority = openPersistentWriterEpoch({ stateRoot: root, holderId: holder }); if (ready) writeFileSync(ready, "ready\\n"); console.log(JSON.stringify(authority.acquire("repo")));`;
  return new Promise((resolve, reject) => { const child = spawn(process.execPath, ["--input-type=module", "-e", code, root, holderId, readyFile], { stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.on("error", reject); child.on("close", (exitCode) => { if (exitCode !== 0) return reject(new Error(stderr)); resolve({ code: exitCode, lease: JSON.parse(stdout.trim()) }); }); });
}

async function holdEpochLock(root: string, readyFile: string, holdMs: number): Promise<() => Promise<void>> {
  const file = path.join(root, "writer-epochs.lock");
  const code = `import { closeSync, existsSync, fsyncSync, openSync, unlinkSync, writeFileSync } from "node:fs"; const [file, ready, hold] = process.argv.slice(1); const fd = openSync(file, "wx", 0o600); writeFileSync(fd, process.pid + "\\n"); fsyncSync(fd); console.log("locked"); const deadline = Date.now() + 10_000; while (!existsSync(ready)) { if (Date.now() >= deadline) throw new Error("waiter did not become ready"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(hold)); closeSync(fd); unlinkSync(file);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, file, readyFile, String(holdMs)], { stdio: ["ignore", "pipe", "pipe"] }); let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", (exitCode) => exitCode === 0 ? resolve() : reject(new Error(stderr))); });
  await new Promise<void>((resolve, reject) => { child.stdout.once("data", (chunk) => chunk.toString().includes("locked") ? resolve() : reject(new Error(`lock holder did not become ready: ${chunk.toString()}`))); child.once("error", reject); child.once("close", (exitCode) => { if (exitCode !== 0) reject(new Error(stderr)); }); });
  return () => done;
}

test("persistent writer epochs allocate monotonically and fence a stale holder", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-writer-epoch-"));
  try {
    const first = openPersistentWriterEpoch({ stateRoot: root, holderId: "center-a", now: () => "2026-08-19T00:00:00.000Z" });
    const leaseA = first.acquire("repo");
    assert.equal(leaseA.epoch, 1);
    const second = openPersistentWriterEpoch({ stateRoot: root, holderId: "center-b", now: () => "2026-08-19T00:00:01.000Z" });
    const leaseB = second.acquire("repo");
    assert.equal(leaseB.epoch, 2);
    assert.throws(() => first.assert("repo", leaseA.epoch), (error: unknown) => error instanceof Error && "code" in error && error.code === "writer_epoch_stale");
    second.close();
    first.close();
    const persisted = JSON.parse(readFileSync(path.join(root, "writer-epochs.json"), "utf8")) as { repos: Record<string, { epoch: number }> };
    assert.equal(persisted.repos.repo.epoch, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent processes allocate unique epochs through the same critical section", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-writer-epoch-race-"));
  try {
    const source = path.resolve("packages/daemon/src/writer-epoch.ts"), results = await Promise.all(Array.from({ length: 12 }, (_value, index) => childEpoch(source, root, `worker-${index}`)));
    const epochs = results.map((result) => result.lease!.epoch).sort((left, right) => left - right);
    assert.deepEqual(epochs, Array.from({ length: 12 }, (_value, index) => index + 1));
    assert.equal(new Set(results.map((result) => result.lease!.holderId)).size, 12);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("writer epoch acquisition waits for a live lock owner", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-writer-epoch-wait-")), readyFile = path.join(root, "waiter-ready");
  const waitForHolder = await holdEpochLock(root, readyFile, 1_000);
  try {
    const source = path.resolve("packages/daemon/src/writer-epoch.ts"), result = await childEpoch(source, root, "waiting-worker", readyFile);
    assert.equal(result.lease?.epoch, 1);
  } finally { await waitForHolder(); rmSync(root, { recursive: true, force: true }); }
});

test("restoring an older state file cannot reuse a historical epoch", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-writer-epoch-floor-"));
  try {
    const file = path.join(root, "writer-epochs.json"), first = openPersistentWriterEpoch({ stateRoot: root, holderId: "center" }), leaseOne = first.acquire("repo"), backup = readFileSync(file);
    const leaseTwo = first.acquire("repo");
    writeFileSync(file, backup);
    const replacement = openPersistentWriterEpoch({ stateRoot: root, holderId: "center" }), leaseThree = replacement.acquire("repo");
    assert.equal(leaseOne.epoch, 1); assert.equal(leaseTwo.epoch, 2); assert.equal(leaseThree.epoch, 3);
    assert.throws(() => first.assert("repo", leaseTwo.epoch, leaseTwo.holderId), (error: unknown) => error instanceof Error && "code" in error && error.code === "writer_epoch_stale");
    replacement.close(); first.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("append rechecks the epoch after a successor is allocated", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-writer-epoch-append-gap-")), repo = probeRepo(root), stateRoot = path.join(root, "state"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    const oldAuthority = openPersistentWriterEpoch({ stateRoot, holderId: "old-center" }), newAuthority = openPersistentWriterEpoch({ stateRoot, holderId: "new-center" }), oldLease = oldAuthority.acquire("probe-repo"); let successorEpoch: number | null = null, triggered = false;
    cell = await openRepoCell({ repoId: "probe-repo" as never, rootDir: repo as never, ownerId: "probe-cell", mode: "remote-center", killpoint: (point) => { if (point === "before_event_write" && !triggered) { triggered = true; successorEpoch = newAuthority.acquire("probe-repo").epoch; } } });
    const before = Number(probeGit(repo, "rev-list", "--count", "refs/ha/canonical"));
    const receipt = await cell.run({ kind: "task-create", taskId: "task_probe_epoch", title: "stale append window" }, probeBinding(() => oldAuthority.assert("probe-repo", oldLease.epoch, oldLease.holderId)));
    assert.equal(successorEpoch, 2); assert.equal(receipt.outcome, "op_rejected"); assert.equal(receipt.code, "writer_epoch_stale"); assert.equal(Number(probeGit(repo, "rev-list", "--count", "refs/ha/canonical")), before);
    newAuthority.close(); oldAuthority.close();
  } finally { await cell?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("remote-center recovery leaves no legacy prepared publication after fencing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-writer-epoch-prepared-")), repo = probeRepo(root), stateRoot = path.join(root, "state"); let oldCell: Awaited<ReturnType<typeof openRepoCell>> | undefined, recoveryCell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    const oldAuthority = openPersistentWriterEpoch({ stateRoot, holderId: "old-center" }), newAuthority = openPersistentWriterEpoch({ stateRoot, holderId: "new-center" }), oldLease = oldAuthority.acquire("probe-repo"); let triggered = false;
    oldCell = await openRepoCell({ repoId: "probe-repo" as never, rootDir: repo as never, ownerId: "old-cell", mode: "remote-center", killpoint: (point) => { if (point === "after_head_write" && !triggered) { triggered = true; newAuthority.acquire("probe-repo"); throw new Error("simulated process death after prepared event"); } } });
    const failed = await oldCell.run({ kind: "task-create", taskId: "task_probe_prepared", title: "prepared stale recovery" }, probeBinding(() => oldAuthority.assert("probe-repo", oldLease.epoch, oldLease.holderId)));
    assert.equal(failed.outcome, "op_rejected"); assert.equal(failed.code, "service_rejected"); assert.equal(probeGit(repo, "for-each-ref", "--format=%(refname)", "refs/ha-event-prepared/").trim(), ""); await oldCell.close(); oldCell = undefined;
    recoveryCell = await openRepoCell({ repoId: "probe-repo" as never, rootDir: repo as never, ownerId: "new-cell", mode: "remote-center" });
    assert.equal(recoveryCell.status().state, "attached"); assert.equal(probeGit(repo, "for-each-ref", "--format=%(refname)", "refs/ha-event-prepared/").trim(), ""); assert.equal(probeGit(repo, "rev-parse", "refs/ha/canonical"), probeGit(repo, "rev-parse", "HEAD"));
    newAuthority.close(); oldAuthority.close();
  } finally { await recoveryCell?.close(); await oldCell?.close(); rmSync(root, { recursive: true, force: true }); }
});
