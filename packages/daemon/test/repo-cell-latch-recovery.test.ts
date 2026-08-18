// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, REPLAY_TASK_GRAPH, taskLifecycleWritePlan, type TaskEventV1 } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell, type RepoCell } from "../src/repo-cell.ts";

const actor = { principal: { personId: "person-latch" }, executor: null } as const;

test("an invalid_store latch re-attaches on the next command after the ledger is repaired", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-latch-heal-")); let clock = "2026-08-18T00:00:00.000Z"; let cell: RepoCell | undefined;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("latch-heal"), rootDir: canonicalRoot(rootDir), ownerId: "latch-heal-one", now: () => clock }); const binding = { actor, source: "local" as const };
    assert.equal((await cell.run({ kind: "task-create", taskId: "task_heal", title: "Heal" }, binding)).outcome, "applied");
    await cell.close(); cell = undefined;
    // One more event lands after the daemon's projection cut (the kty-web lag shape), then a flat
    // entry lands in the sharded events root: the next catch-up scan must judge the mixed layout.
    appendRawEvent(rootDir, "latch-heal", "task_lagging", 2);
    const stray = "harness/events/migration-stray.json";
    writeFileSync(path.join(rootDir, stray), "{}\n"); git(rootDir, "add", stray); git(rootDir, "commit", "-qm", "corrupt: flat entry in sharded events root"); git(rootDir, "update-ref", "refs/ha/canonical", "HEAD");
    cell = await openRepoCell({ repoId: workspaceId("latch-heal"), rootDir: canonicalRoot(rootDir), ownerId: "latch-heal-two", now: () => clock });
    assert.equal(cell.status().state, "attached"); // the open is lazy; the first ledger read latches
    const latchedList = await cell.run({ kind: "task-list" }, binding);
    assert.equal(latchedList.outcome, "rejected"); assert.equal(latchedList.code, "invalid_store");
    assert.match(String(latchedList.nextAction), /events root mixes .* flat\/v1 .* sharded entries; run ha migrate ledger/u);
    assert.equal(cell.status().state, "unavailable"); assert.equal(cell.status().causeClass, "data-shape");
    // The fault persists: the next command re-probes, fails the same judgment, and keeps rejecting.
    clock = "2026-08-18T00:00:06.000Z";
    const stillLatched = await cell.run({ kind: "task-list" }, binding);
    assert.equal(stillLatched.outcome, "rejected"); assert.equal(stillLatched.code, "repo_unavailable");
    assert.match(String(stillLatched.nextAction), /stays latched until its ledger data verifies/u);
    assert.match(String(stillLatched.nextAction), /flat\/v1 .* sharded entries/u);
    assert.equal(cell.status().state, "unavailable");
    // Repair the data underneath the live cell; the next command re-attaches without a reopen.
    git(rootDir, "rm", "-q", stray); git(rootDir, "commit", "-qm", "repair: restore pure sharded events root"); git(rootDir, "update-ref", "refs/ha/canonical", "HEAD");
    clock = "2026-08-18T00:00:12.000Z";
    const healed = await cell.run({ kind: "task-list" }, binding);
    assert.equal(healed.outcome, "applied", JSON.stringify(healed));
    assert.match(String(healed.evidence), /task_lagging/u);
    assert.equal(cell.status().state, "attached"); assert.equal(cell.status().lastError, null); assert.equal(cell.status().causeClass, null);
    // Healing rebinds the replica cut source; the cell must expose the live one, not the closed one.
    assert.doesNotThrow(() => cell!.replica.latest());
    assert.equal((await cell.run({ kind: "task-create", taskId: "task_after_heal", title: "After heal" }, binding)).outcome, "applied");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("the latch re-probe is throttled to one attempt per interval", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-latch-throttle-")); let clock = "2026-08-18T00:00:00.000Z"; let cell: RepoCell | undefined;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("latch-throttle"), rootDir: canonicalRoot(rootDir), ownerId: "latch-throttle-one", now: () => clock }); const binding = { actor, source: "local" as const };
    await cell.run({ kind: "task-create", taskId: "task_throttle", title: "Throttle" }, binding);
    await cell.close(); cell = undefined;
    appendRawEvent(rootDir, "latch-throttle", "task_lagging", 2);
    const stray = "harness/events/migration-stray.json";
    writeFileSync(path.join(rootDir, stray), "{}\n"); git(rootDir, "add", stray); git(rootDir, "commit", "-qm", "corrupt: flat entry in sharded events root"); git(rootDir, "update-ref", "refs/ha/canonical", "HEAD");
    cell = await openRepoCell({ repoId: workspaceId("latch-throttle"), rootDir: canonicalRoot(rootDir), ownerId: "latch-throttle-two", now: () => clock });
    await cell.run({ kind: "task-list" }, binding); // latches on the mixed layout
    const firstProbe = await cell.run({ kind: "task-list" }, binding); // probe 1 fails on the same fault
    assert.equal(firstProbe.outcome, "rejected"); assert.equal(firstProbe.code, "repo_unavailable");
    git(rootDir, "rm", "-q", stray); git(rootDir, "commit", "-qm", "repair: restore pure sharded events root"); git(rootDir, "update-ref", "refs/ha/canonical", "HEAD");
    clock = "2026-08-18T00:00:01.000Z"; // inside the throttle window of probe 1
    const throttled = await cell.run({ kind: "task-list" }, binding);
    assert.equal(throttled.outcome, "rejected"); assert.equal(throttled.code, "repo_unavailable"); // no probe ran: healthy data is not yet re-examined
    assert.equal(cell.status().state, "unavailable");
    clock = "2026-08-18T00:00:06.000Z"; // past the throttle window
    const healed = await cell.run({ kind: "task-list" }, binding);
    assert.equal(healed.outcome, "applied", JSON.stringify(healed));
    assert.equal(cell.status().state, "attached");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("a publication_indeterminate latch reports the infrastructure class and heals after the authored branch is restored", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-latch-infra-")); let clock = "2026-08-18T00:00:00.000Z"; let cell: RepoCell | undefined;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("latch-infra"), rootDir: canonicalRoot(rootDir), ownerId: "latch-infra-one", now: () => clock }); const binding = { actor, source: "local" as const };
    await cell.run({ kind: "task-create", taskId: "task_infra", title: "Infra" }, binding);
    mkdirSync(path.join(rootDir, "harness/context"), { recursive: true }); writeFileSync(path.join(rootDir, "harness/context/notes.md"), "# Notes\n");
    git(rootDir, "commit", "--allow-empty", "-qm", "external advance"); // moves the authored branch off the canonical cut
    const indeterminate = await cell.run({ kind: "doc-submit", paths: ["context/notes.md"] }, binding);
    assert.equal(indeterminate.outcome, "indeterminate"); assert.equal(indeterminate.code, "publication_indeterminate");
    assert.equal(cell.status().state, "unavailable"); assert.equal(cell.status().causeClass, "infrastructure");
    // Repair per the embedded recovery command: point the authored branch back at the canonical cut.
    git(rootDir, "update-ref", git(rootDir, "symbolic-ref", "HEAD"), "refs/ha/canonical");
    clock = "2026-08-18T00:00:06.000Z";
    const healed = await cell.run({ kind: "task-list" }, binding);
    assert.equal(healed.outcome, "applied", JSON.stringify(healed));
    assert.equal(cell.status().state, "attached"); assert.equal(cell.status().causeClass, null);
    assert.equal((await cell.run({ kind: "task-create", taskId: "task_infra_after", title: "After infra heal" }, binding)).outcome, "applied");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

function appendRawEvent(rootDir: string, repoId: string, taskId: string, revision: number): void {
  const event: TaskEventV1 = { schema: "task-event/v1", eventId: `event-${taskId}`, workspaceRevision: revision, opId: `op-${taskId}`, taskId, type: "task_created", actor, source: "local", occurredAt: "2026-08-18T00:00:00.000Z", payload: { task: { schema: "task/v1", taskId, title: "Lagging append", taskClass: "standard", status: "planned", graph: REPLAY_TASK_GRAPH, currentNode: "implementation", iteration: 0, createdBy: actor, completionGateIds: [], presetSnapshotDigest: null } } };
  makeTaskEventStore({ repoId, rootDir }).append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
}
function initRepo(rootDir: string): void { git(rootDir, "init", "-q"); git(rootDir, "config", "user.name", "Latch Recovery Test"); git(rootDir, "config", "user.email", "latch-recovery@example.invalid"); git(rootDir, "commit", "--allow-empty", "-qm", "base"); }
function git(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim(); }
