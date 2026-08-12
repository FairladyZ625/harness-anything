// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DOC_CODEC_ID, DOC_POLICY_ID, parseCanonicalEvent, serializeCanonicalEvent, type DocEventV1 } from "../../src/domain/doc-sync.contract.ts";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import { serializeTaskEvent, type TaskCreatedEvent } from "../../src/domain/task-lifecycle.contract.ts";
import { serializeEventHead } from "../../src/domain/write-chain.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { CANONICAL_EVENT_REF, makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

const event: TaskCreatedEvent = { schema: "task-event/v1", eventId: "event-1", workspaceRevision: 1, opId: "op-1", taskId: "task-1", type: "task_created",
  actor: { principal: { personId: "person-1" }, executor: { kind: "agent", id: "codex" } }, source: "local", occurredAt: "2026-08-11T00:00:00.000Z",
  payload: { task: { schema: "task/v1", taskId: "task-1", title: "Replay task", status: "planned", graph: REPLAY_TASK_GRAPH, currentNode: "implementation", iteration: 0,
    createdBy: { principal: { personId: "person-1" }, executor: { kind: "agent", id: "codex" } }, completionGateIds: [] } } };

test("canonical schema registry parses task/doc once and rejects unknown or non-canonical bytes", () => {
  assert.deepEqual(parseCanonicalEvent(serializeTaskEvent(event)), event);
  assert.throws(() => parseCanonicalEvent(`${JSON.stringify({ ...event, schema: "unknown/v1" })}\n`), /unknown/u);
  assert.throws(() => parseCanonicalEvent(`${JSON.stringify(event)}\n`), /not canonical/u);
});

test("object/ref-only publication preserves HEAD, index, prose, and every dirty path byte", async (context) => {
  await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); mkdirSync(path.join(rootDir, "harness/context"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/context/user.md"), "draft\n"); writeFileSync(path.join(rootDir, "dirty.txt"), "dirty\n"); git(rootDir, "add", "harness/context/user.md"); git(rootDir, "commit", "-qm", "user prose"); writeFileSync(path.join(rootDir, "harness/context/user.md"), "draft plus local edit\n");
    const before = snapshot(rootDir), head = git(rootDir, "rev-parse", "HEAD"), store = makeTaskEventStore({ rootDir }), receipt = store.append(event), after = snapshot(rootDir);
    assert.deepEqual(after, before); assert.equal(git(rootDir, "rev-parse", "HEAD"), head); assert.notEqual(store.currentCommit(), head); assert.equal(existsSync(path.join(rootDir, "harness/events")), false);
    assert.equal(git(rootDir, "show", `${CANONICAL_EVENT_REF}:harness/events/op-1.json`), serializeCanonicalEvent(event).trimEnd()); assert.equal(store.readTaskEvent(event.opId)?.opId, event.opId);
    assert.deepEqual(store.append(event).metrics.changedPaths, []); assert.throws(() => store.append({ ...event, payload: { task: { ...event.payload.task, title: "different" } } }), (error: unknown) => { assert.equal((error as { code?: string }).code, "op_conflict"); return /different event/u.test(String(error)); });
    assert.equal(receipt.metrics.nodeSyncs, 0); context.diagnostic(`object-ref-publisher-git-processes=${receipt.metrics.gitProcesses}`);
  });
});

test("doc event, head, and immutable content blob are reachable from one canonical commit", async () => {
  await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const store = makeTaskEventStore({ rootDir }), base = store.currentCommit(), body = "# Notes\n\nMore prose.\n", hash = sha256Text(body);
    const doc: DocEventV1 = { schema: "doc-event/v1", eventId: "doc-event-1", workspaceRevision: 1, opId: "doc-op-1", type: "documents_written", actor: event.actor, source: "local", occurredAt: event.occurredAt,
      payload: { executionId: "execution-1", baseLedgerSha: base, changes: [{ path: "context/notes.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: { sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" }, regionProofs: [{ regionId: "heading/notes", policyId: DOC_POLICY_ID, codecId: DOC_CODEC_ID, baseSha256: sha256Text(""), candidateSha256: hash, insertBytes: Buffer.byteLength(body) }] }] } };
    const receipt = store.append(doc, [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", body }]);
    assert.deepEqual(store.readEvent(doc.opId), doc); assert.equal(Buffer.from(store.readContentBlob(hash)!).toString("utf8"), body); assert.equal(git(rootDir, "show", `${receipt.commitSha}:harness/objects/sha256/${hash}`), body.trimEnd());
    assert.deepEqual(git(rootDir, "diff-tree", "--no-commit-id", "--name-only", "-r", receipt.commitSha).split("\n").sort(), ["harness/events/doc-op-1.json", "harness/events/head.json", `harness/objects/sha256/${hash}`]);
  });
});

for (const killpoint of ["before_event_write", "after_event_write", "after_head_write", "after_git_commit"] as const) {
  test(`object/ref recovery handles ${killpoint} without duplicate publication`, async () => {
    await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const interrupted = makeTaskEventStore({ rootDir, killpoint: (point) => { if (point === killpoint) throw new Error(`crash:${point}`); } });
      assert.throws(() => interrupted.append(event), new RegExp(`crash:${killpoint}`, "u")); const recovery = makeTaskEventStore({ rootDir }).recover();
      if (killpoint === "after_head_write") assert.equal(recovery.status, "committed"); else assert.equal(recovery.status, "none");
      const resumed = makeTaskEventStore({ rootDir }); resumed.append(event); assert.equal(resumed.read().revision, 1); assert.equal(git(rootDir, "rev-list", "--count", CANONICAL_EVENT_REF), "2"); assert.equal(git(rootDir, "for-each-ref", "--format=%(refname)", "refs/ha-event-prepared/"), "");
    });
  });
}

test("startup recovery is under 250ms and independent of 100 versus 10,000-event history", async (context) => {
  const fixture = async (count: number) => withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const eventsRoot = path.join(rootDir, "harness/events"); mkdirSync(eventsRoot, { recursive: true }); let last = event;
    for (let revision = 1; revision <= count; revision += 1) { last = eventAt(revision); writeFileSync(path.join(eventsRoot, `${last.opId}.json`), serializeTaskEvent(last)); }
    const bytes = serializeTaskEvent(last); writeFileSync(path.join(eventsRoot, "head.json"), serializeEventHead({ revision: count, opId: last.opId, eventDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` })); git(rootDir, "add", "harness/events"); git(rootDir, "commit", "-qm", `${count} events`);
    const next = eventAt(count + 1), interrupted = makeTaskEventStore({ rootDir, killpoint: (point) => { if (point === "after_head_write") throw new Error("crash"); } }); assert.throws(() => interrupted.append(next), /crash/u);
    const started = performance.now(), recovered = makeTaskEventStore({ rootDir }).recover(), elapsed = performance.now() - started; assert.equal(recovered.status, "committed"); assert.equal(elapsed < 250, true, `recovery ${elapsed}ms`); return elapsed; });
  const hundred = await fixture(100), tenThousand = await fixture(10_000), ratio = tenThousand / hundred; context.diagnostic(`recovery 100=${hundred.toFixed(3)}ms 10000=${tenThousand.toFixed(3)}ms ratio=${ratio.toFixed(3)}`); assert.equal(ratio < 2, true, `10k/100 ratio ${ratio}`);
});

function initRepo(rootDir: string): void { git(rootDir, "init", "-q"); git(rootDir, "config", "user.name", "Store Test"); git(rootDir, "config", "user.email", "store@example.invalid"); git(rootDir, "config", "gc.auto", "0"); git(rootDir, "config", "maintenance.auto", "false"); git(rootDir, "commit", "--allow-empty", "-qm", "base"); }
function eventAt(revision: number): TaskCreatedEvent { const suffix = String(revision).padStart(5, "0"); return { ...event, eventId: `event-${suffix}`, workspaceRevision: revision, opId: `op-${suffix}`, taskId: `task-${suffix}`, payload: { task: { ...event.payload.task, taskId: `task-${suffix}`, title: `Task ${suffix}` } } }; }
function snapshot(rootDir: string): unknown { const files = ["harness/context/user.md", "dirty.txt"]; return { status: git(rootDir, "status", "--porcelain", "-uall"), index: git(rootDir, "ls-files", "-s"), bytes: files.map((file) => readFileSync(path.join(rootDir, file)).toString("hex")) }; }
function git(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
