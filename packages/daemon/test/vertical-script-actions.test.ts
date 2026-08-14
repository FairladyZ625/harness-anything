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
    const preview = await cell.run(action, binding); assert.equal(preview.outcome, "applied", JSON.stringify(preview)); const previewResult = parseVerticalScriptResult(JSON.parse(String(preview.evidence))); assert.equal(preview.proof?.worktreeVisible, false); assert.equal(previewResult.documents.length, 2); assert.equal(store().readHead()?.revision ?? 0, before); assert.equal(existsSync(path.join(rootDir, "harness/decisions/adrs/README.md")), false);
    const applied = await cell.run({ ...action, dryRun: false }, binding); assert.equal(applied.outcome, "applied", JSON.stringify(applied)); const appliedResult = parseVerticalScriptResult(JSON.parse(String(applied.evidence))); assert.equal(appliedResult.mode, "apply"); assert.equal(appliedResult.planDigest, previewResult.planDigest); assert.deepEqual(appliedResult.documents, previewResult.documents); assert.equal(readFileSync(path.join(rootDir, "harness/decisions/adrs/README.md"), "utf8").includes("Decision Projection Boundary"), true); assert.equal(store().read().events.at(-1)?.schema, "doc-event/v1");
    const revision = store().readHead()!.revision, unchanged = parseVerticalScriptResult(JSON.parse(String((await cell.run({ ...action, dryRun: false }, binding)).evidence))); assert.equal(unchanged.status, "unchanged"); assert.equal(store().readHead()!.revision, revision);
    const undeclared = await cell.run({ ...action, scriptId: "vertical:software-coding:not-declared" }, binding); assert.deepEqual({ outcome: undeclared.outcome, code: undeclared.code }, { outcome: "rejected", code: "script_not_found" }); assert.equal(store().readHead()!.revision, revision);
    const unknown = await cell.run({ ...action, unknown: true }, binding); assert.deepEqual({ outcome: unknown.outcome, code: unknown.code }, { outcome: "rejected", code: "invalid_script_action" });
    const proposed = await cell.run({ kind: "decision-propose", title: "Script decision", question: "Does conformance inspect canonical decisions?", riskTier: "medium", urgency: "medium", vertical: "software/coding", preset: "decision-conformance", decisionClass: "ordinary", appliesTo: { modules: ["preset"], productLines: [] }, chosen: [{ id: "CH1", text: "Use the typed script" }], rejected: [{ id: "RJ1", text: "Use a raw writer", whyNot: "It bypasses RepoCell" }], claims: [], fulfillments: [], relations: [], body: "\n# Script decision\n" }, binding); assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
    const conformance = await cell.run({ ...action, scriptId: "vertical:software-coding:decision-conformance", inputs: {} }, binding); assert.equal(conformance.outcome, "applied", JSON.stringify(conformance)); const conformanceResult = parseVerticalScriptResult(JSON.parse(String(conformance.evidence))); assert.equal(conformanceResult.status, "attention-required"); assert.equal(conformanceResult.report.decisionCount, 1); assert.deepEqual(conformanceResult.documents, []);
    const beforeUnavailable = store().readHead()!.revision; for (const presetId of ["module", "subtask-expansion"]) { const unavailable = await cell.run({ kind: "task-create", taskId: `task-${presetId}`, title: presetId, presetId }, binding); assert.deepEqual({ outcome: unavailable.outcome, code: unavailable.code }, { outcome: "rejected", code: "missing_provider" }); } assert.equal(store().readHead()!.revision, beforeUnavailable);
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

function initRepo(rootDir: string): void { git(rootDir, "init", "-q"); git(rootDir, "config", "user.name", "Vertical Script Test"); git(rootDir, "config", "user.email", "vertical-script@example.invalid"); mkdirSync(path.join(rootDir, "harness"), { recursive: true }); writeFileSync(path.join(rootDir, "harness/harness.yaml"), "layout:\n  adrRoot: harness/decisions/adrs\n"); git(rootDir, "add", "."); git(rootDir, "commit", "-qm", "base"); }
function git(rootDir: string, ...args: string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim(); }
