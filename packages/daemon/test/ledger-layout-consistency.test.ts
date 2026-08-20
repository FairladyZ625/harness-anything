// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { REPLAY_TASK_GRAPH, serializeCanonicalEvent, serializeEventHead, sha256Text, type TaskEventV1 } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";
const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;

test("a flat ledger keeps working end to end, advertises migration, and migrates with a cold restart", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-ledger-flat-consistency-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    const flatEvent = flatTaskEvent(1, "task_flat_one");
    initFlatLedger(rootDir, [flatEvent]);
    cell = await openRepoCell({ repoId: workspaceId("ledger-flat-consistency"), rootDir: canonicalRoot(rootDir), ownerId: "ledger-flat-consistency", now: () => "2026-08-18T00:00:01.000Z" });
    const listed = await cell.read("repo.tasks.list");
    assert.equal(listed.status, "ready");
    assert.equal(listed.rows.some(({ taskId }) => taskId === flatEvent.taskId), true);
    const archived = await cell.run({ kind: "task-archive", taskId: flatEvent.taskId, reason: "flat layout drill" }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(archived.outcome, "applied", JSON.stringify(archived));
    assert.equal(archived.commitSha, null);
    assert.equal(String(archived.summary).includes("ha migrate ledger"), true);
    assert.deepEqual(listTree(rootDir, "harness/events").filter((name) => /^[0-9a-f]{2}$/u.test(name)), []);
    assert.equal(listTree(rootDir, "harness/events").filter((name) => name.endsWith(".json")).length, 2);
    const migrated = await cell.run({ kind: "ledger-migrate" }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(migrated.outcome, "applied", JSON.stringify(migrated));
    assert.deepEqual(listTree(rootDir, "harness/events").filter((name) => name.endsWith(".json")), ["head.json"]);
    await cell.close(); cell = undefined;
    const restarted = await openRepoCell({ repoId: workspaceId("ledger-flat-consistency"), rootDir: canonicalRoot(rootDir), ownerId: "ledger-flat-consistency", now: () => "2026-08-18T00:00:02.000Z" });
    cell = restarted;
    const projected = await restarted.read("repo.tasks.list");
    assert.equal(projected.status, "ready");
    assert.equal(projected.rows.some(({ taskId }) => taskId === flatEvent.taskId), true);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("a mixed ledger is repaired by ha migrate ledger, replays idempotently, and reattaches cold", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-ledger-mixed-consistency-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    const flatEvents = [flatTaskEvent(1, "task_mixed_one"), flatTaskEvent(2, "task_mixed_two")], shardedEvent = flatTaskEvent(3, "task_mixed_three");
    initMixedLedger(rootDir, flatEvents, shardedEvent);
    cell = await openRepoCell({ repoId: workspaceId("ledger-mixed-consistency"), rootDir: canonicalRoot(rootDir), ownerId: "ledger-mixed-consistency", now: () => "2026-08-18T00:00:01.000Z" });
    const migrated = await cell.run({ kind: "ledger-migrate" }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(migrated.outcome, "applied", JSON.stringify(migrated));
    assert.equal(migrated.revision, 4);
    assert.deepEqual(listTree(rootDir, "harness/events").filter((name) => name.endsWith(".json")), ["head.json"]);
    assert.equal(show(rootDir, `HEAD:harness/${shardedEventRelativePath(shardedEvent.opId)}`), serializeCanonicalEvent(shardedEvent).trimEnd());
    const repeated = await cell.run({ kind: "ledger-migrate" }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(repeated.commitSha, migrated.commitSha);
    await cell.close(); cell = undefined;
    const restarted = await openRepoCell({ repoId: workspaceId("ledger-mixed-consistency"), rootDir: canonicalRoot(rootDir), ownerId: "ledger-mixed-consistency", now: () => "2026-08-18T00:00:02.000Z" });
    cell = restarted;
    const projected = await restarted.read("repo.tasks.list");
    assert.equal(projected.status, "ready");
    assert.deepEqual(new Set(projected.rows.map(({ taskId }) => taskId)), new Set([...flatEvents, shardedEvent].map((value) => value.taskId)));
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("ha migrate ledger runs through a data-shape latch instead of being rejected by it", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-ledger-latched-migrate-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    const flatEvents = [flatTaskEvent(1, "task_latched_one")], shardedEvent = flatTaskEvent(2, "task_latched_two");
    initMixedLedger(rootDir, flatEvents, shardedEvent);
    cell = await openRepoCell({ repoId: workspaceId("ledger-latched-migrate"), rootDir: canonicalRoot(rootDir), ownerId: "ledger-latched-migrate", now: () => "2026-08-18T00:00:01.000Z" });
    // A read latches the cell on the mixed layout first — the shape the CLI hits in the field,
    // where the latch message itself routes the operator to ha migrate ledger.
    const latchedTaskList = await cell.run({ kind: "task-list" }, { actor, source: "local" });
    assert.equal(latchedTaskList.outcome, "op_rejected");
    assert.equal(cell.status().state, "unavailable"); assert.equal(cell.status().causeClass, "data-shape");
    const migrated = await cell.run({ kind: "ledger-migrate" }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(migrated.outcome, "applied", JSON.stringify(migrated));
    assert.equal(cell.status().state, "attached"); assert.equal(cell.status().lastError, null);
    const listed = await cell.run({ kind: "task-list" }, { actor, source: "local" });
    assert.equal(listed.outcome, "applied", JSON.stringify(listed));
    assert.match(String(listed.evidence), /task_latched_two/u);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

function flatTaskEvent(revision: number, taskId: string): TaskEventV1 {
  const opId = `op_flat_${String(revision).padStart(5, "0")}`;
  return { schema: "task-event/v1", eventId: `event-flat-${revision}`, workspaceRevision: revision, opId, taskId, type: "task_created", actor, source: "local", occurredAt: "2026-08-18T00:00:00.000Z", payload: { task: { schema: "task/v1", taskId, title: `Flat task ${revision}`, taskClass: "standard", status: "planned", graph: REPLAY_TASK_GRAPH, currentNode: "implementation", iteration: 0, createdBy: actor, completionGateIds: [], presetSnapshotDigest: null } } } as TaskEventV1;
}
function initRepo(rootDir: string): void { run(rootDir, "init", "-q"); run(rootDir, "config", "user.name", "Daemon Layout Test"); run(rootDir, "config", "user.email", "daemon-layout@example.invalid"); run(rootDir, "config", "gc.auto", "0"); run(rootDir, "config", "maintenance.auto", "false"); run(rootDir, "commit", "--allow-empty", "-qm", "base"); }
function initFlatLedger(rootDir: string, events: readonly TaskEventV1[]): void {
  initRepo(rootDir);
  const eventsRoot = path.join(rootDir, "harness/events"); mkdirSync(eventsRoot, { recursive: true });
  for (const value of events) writeFileSync(path.join(eventsRoot, `${value.opId}.json`), serializeCanonicalEvent(value));
  writeHead(rootDir, events);
}
function initMixedLedger(rootDir: string, flatEvents: readonly TaskEventV1[], shardedEvent: TaskEventV1): void {
  initRepo(rootDir);
  const eventsRoot = path.join(rootDir, "harness/events"), objectsRoot = path.join(rootDir, "harness/objects/sha256");
  mkdirSync(eventsRoot, { recursive: true }); mkdirSync(objectsRoot, { recursive: true });
  for (const value of flatEvents) writeFileSync(path.join(eventsRoot, `${value.opId}.json`), serializeCanonicalEvent(value));
  const shardedPath = path.join(rootDir, "harness", shardedEventRelativePath(shardedEvent.opId));
  mkdirSync(path.dirname(shardedPath), { recursive: true }); writeFileSync(shardedPath, serializeCanonicalEvent(shardedEvent));
  const twinBody = "mixed drill blob\n", twinHash = sha256Text(twinBody);
  writeFileSync(path.join(objectsRoot, twinHash), twinBody);
  const twinSharded = path.join(objectsRoot, twinHash.slice(0, 2), twinHash.slice(2));
  mkdirSync(path.dirname(twinSharded), { recursive: true }); writeFileSync(twinSharded, twinBody);
  writeHead(rootDir, [...flatEvents, shardedEvent]);
}
function writeHead(rootDir: string, events: readonly TaskEventV1[]): void {
  const last = events.at(-1)!;
  writeFileSync(path.join(rootDir, "harness/events/head.json"), serializeEventHead({ revision: last.workspaceRevision, opId: last.opId, eventDigest: `sha256:${sha256Text(serializeCanonicalEvent(last))}` }));
  run(rootDir, "add", "harness"); run(rootDir, "commit", "-qm", "layout fixture");
}
function shardedEventRelativePath(opId: string): string { return `events/${sha256Text(opId).slice(0, 2)}/${opId}.json`; }
function listTree(rootDir: string, target: string): readonly string[] { return run(rootDir, "ls-tree", "--name-only", `HEAD:${target}`).split("\n").filter(Boolean); }
function show(rootDir: string, target: string): string { return run(rootDir, "show", target); }
function run(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim(); }
