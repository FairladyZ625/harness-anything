// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, parseVerticalScriptResult } from "../../kernel/src/index.ts";
import { actionForDaemonMethod, canonicalRoot, parseDaemonRpcParams, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

const binding = { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" as const }, scriptId = "vertical:software-coding:adr-seed";

test("repo.script.run RPC params are closed and hydrate the kernel-owned action envelope", () => {
  const payload = { scriptId, inputs: { locale: "en-US" }, dryRun: true }, parsed = parseDaemonRpcParams("repo.script.run", { repo: { repoId: "vertical-script" }, payload }); assert.equal(parsed.ok, true); assert.deepEqual(actionForDaemonMethod("repo.script.run", payload), { schema: "vertical-script-action/v1", kind: "script-run", taskId: null, ...payload }); assert.equal(parseDaemonRpcParams("repo.script.run", { repo: { repoId: "vertical-script" }, payload: { ...payload, unknown: true } }).ok, false);
});

test("RepoCell runs only declared vertical scripts and dry-run publishes the same plan without side effects", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-vertical-script-")); initRepo(rootDir); const cell = await openRepoCell({ repoId: workspaceId("vertical-script"), rootDir: canonicalRoot(rootDir), ownerId: "vertical-script-test" });
  try {
    const action = { schema: "vertical-script-action/v1", kind: "script-run", scriptId, taskId: null, inputs: { locale: "en-US" }, dryRun: true } as const, store = () => makeTaskEventStore({ repoId: "vertical-script", rootDir }), before = store().readHead()?.revision ?? 0;
    const preview = await cell.run(action, binding); assert.equal(preview.outcome, "pending", JSON.stringify(preview)); const previewResult = parseVerticalScriptResult(JSON.parse(String(preview.evidence))); assert.equal(preview.proof?.canonicalVisible, false); assert.equal(preview.proof?.worktreeVisible, false); assert.equal(previewResult.documents.length, 2); assert.equal(store().readHead()?.revision ?? 0, before); assert.equal(existsSync(path.join(rootDir, "harness/decisions/adrs/README.md")), false);
    const applied = await cell.run({ ...action, dryRun: false }, binding); assert.equal(applied.outcome, "applied", JSON.stringify(applied)); const appliedResult = parseVerticalScriptResult(JSON.parse(String(applied.evidence))); assert.equal(appliedResult.mode, "apply"); assert.equal(appliedResult.planDigest, previewResult.planDigest); assert.deepEqual(appliedResult.documents, previewResult.documents); assert.equal(readFileSync(path.join(rootDir, "harness/decisions/adrs/README.md"), "utf8").includes("Decision Projection Boundary"), true); assert.equal(store().read().events.at(-1)?.schema, "doc-event/v1");
    const revision = store().readHead()!.revision, unchangedReceipt = await cell.run({ ...action, dryRun: false }, binding), unchanged = parseVerticalScriptResult(JSON.parse(String(unchangedReceipt.evidence))); assert.equal(unchangedReceipt.outcome, "pending"); assert.equal(unchangedReceipt.proof?.canonicalVisible, false); assert.equal(unchanged.status, "unchanged"); assert.equal(store().readHead()!.revision, revision);
    const undeclared = await cell.run({ ...action, scriptId: "vertical:software-coding:not-declared" }, binding); assert.deepEqual({ outcome: undeclared.outcome, code: undeclared.code }, { outcome: "op_rejected", code: "script_not_found" }); assert.equal(store().readHead()!.revision, revision);
    const unknown = await cell.run({ ...action, unknown: true }, binding); assert.deepEqual({ outcome: unknown.outcome, code: unknown.code }, { outcome: "op_rejected", code: "invalid_script_action" });
    const proposed = await cell.run({ kind: "decision-propose", title: "Script decision", question: "Does conformance inspect canonical decisions?", riskTier: "medium", urgency: "medium", vertical: "software/coding", preset: "decision-conformance", decisionClass: "ordinary", appliesTo: { modules: ["preset"], productLines: [] }, chosen: [{ id: "CH1", text: "Use the typed script" }], rejected: [{ id: "RJ1", text: "Use a raw writer", whyNot: "It bypasses RepoCell" }], claims: [], fulfillments: [], relations: [], body: "\n# Script decision\n" }, binding); assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
    const conformance = await cell.run({ ...action, scriptId: "vertical:software-coding:decision-conformance", inputs: {} }, binding); assert.equal(conformance.outcome, "pending", JSON.stringify(conformance)); assert.equal(conformance.proof?.canonicalVisible, false); const conformanceResult = parseVerticalScriptResult(JSON.parse(String(conformance.evidence))); assert.equal(conformanceResult.status, "attention-required"); assert.equal(conformanceResult.report.decisionCount, 1); assert.deepEqual(conformanceResult.documents, []);
    const catalog = JSON.parse(String((await cell.run({ kind: "preset-list" }, binding)).evidence)) as Array<{ id: string; validity: string }>; assert.deepEqual(catalog.filter(({ id }) => ["module", "subtask-expansion"].includes(id)).map(({ id, validity }) => ({ id, validity })), [{ id: "module", validity: "valid" }, { id: "subtask-expansion", validity: "valid" }]);
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("RepoCell snapshot reads overtake a normal write backlog while writes retain FIFO order", async (context) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-vertical-read-backlog-")), blocker = path.join(rootDir, "vertical-script.block"), started = `${blocker}.started`, previousBlocker = process.env.HARNESS_TEST_VERTICAL_SCRIPT_BLOCK_FILE;
  initRepo(rootDir); const cell = await openRepoCell({ repoId: workspaceId("vertical-read-backlog"), rootDir: canonicalRoot(rootDir), ownerId: "vertical-read-backlog-test" }), action = { schema: "vertical-script-action/v1", kind: "script-run", scriptId, taskId: null, inputs: { locale: "en-US" }, dryRun: true } as const;
  const writes: Promise<unknown>[] = [];
  try {
    writeFileSync(blocker, "blocked\n", "utf8"); process.env.HARNESS_TEST_VERTICAL_SCRIPT_BLOCK_FILE = blocker;
    const head = cell.run(action, binding); writes.push(head); await waitForPath(started);
    const first = cell.run({ kind: "task-create", taskId: "task_fifo_first", title: "FIFO First" }, binding), second = cell.run({ kind: "task-create", taskId: "task_fifo_second", title: "FIFO Second" }, binding), backlog = Array.from({ length: 3 }, () => cell.run(action, binding)); writes.push(first, second, ...backlog);

    const beforeRelease = await Promise.race([Promise.all([first, second]).then(() => "settled" as const), delay(100, "pending" as const)]);
    assert.equal(beforeRelease, "pending", "writes must not overtake the head of the RepoCell write tail");
    const snapshotWhileBlocked = await Promise.race([cell.read("repo.tasks.list").then((value) => ({ state: "settled" as const, value })), delay(250, { state: "pending" as const, value: null })]);
    context.diagnostic(`snapshot read while write tail is blocked: ${JSON.stringify({ state: snapshotWhileBlocked.state, queueDepth: cell.status().queueDepth })}`);
    assert.equal(snapshotWhileBlocked.state, "settled", "a committed-snapshot read must not join the write tail");
    assert.deepEqual(snapshotWhileBlocked.value?.rows.map(({ taskId }) => taskId), [], "the snapshot must not expose queued writes");

    rmSync(blocker, { force: true }); await head;
    const backlogRead = cell.read("repo.tasks.list"), winner = await Promise.race([backlogRead.then(() => "read" as const), Promise.all(backlog).then(() => "writes" as const)]);
    context.diagnostic(`snapshot read against released normal write backlog: ${JSON.stringify({ winner, queueDepth: cell.status().queueDepth })}`);
    assert.equal(winner, "read", "a snapshot read must overtake normal queued writes after the staging blocker is released");
    const [firstReceipt, secondReceipt, concurrentRead] = await Promise.all([first, second, backlogRead]);
    assert.deepEqual({ first: firstReceipt.revision, second: secondReceipt.revision }, { first: 1, second: 2 }, "write revisions must retain FIFO order");
    assert.equal([["task_fifo_first"], ["task_fifo_first", "task_fifo_second"]].some((prefix) => JSON.stringify(prefix) === JSON.stringify(concurrentRead.rows.map(({ taskId }) => taskId))), true, "the concurrent snapshot must expose a FIFO prefix, never a partial or reordered write");
    await Promise.all(backlog); assert.deepEqual((await cell.read("repo.tasks.list")).rows.map(({ taskId }) => taskId), ["task_fifo_first", "task_fifo_second"]);
  } finally {
    rmSync(blocker, { force: true }); await Promise.allSettled(writes); if (previousBlocker === undefined) Reflect.deleteProperty(process.env, "HARNESS_TEST_VERTICAL_SCRIPT_BLOCK_FILE"); else process.env.HARNESS_TEST_VERTICAL_SCRIPT_BLOCK_FILE = previousBlocker;
    await cell.close(); rmSync(rootDir, { recursive: true, force: true });
  }
});

function initRepo(rootDir: string): void { git(rootDir, "init", "-q"); git(rootDir, "config", "user.name", "Vertical Script Test"); git(rootDir, "config", "user.email", "vertical-script@example.invalid"); mkdirSync(path.join(rootDir, "harness"), { recursive: true }); writeFileSync(path.join(rootDir, "harness/harness.yaml"), "layout:\n  adrRoot: harness/decisions/adrs\n"); git(rootDir, "add", "."); git(rootDir, "commit", "-qm", "base"); }
function git(rootDir: string, ...args: string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim(); }
async function waitForPath(target: string): Promise<void> { const deadline = Date.now() + 5_000; while (!existsSync(target)) { if (Date.now() >= deadline) throw new Error(`timed out waiting for ${target}`); await delay(10, undefined); } }
function delay<T>(milliseconds: number, value: T): Promise<T> { return new Promise((resolve) => setTimeout(() => resolve(value), milliseconds)); }
