// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;

test("status, dry-run, and submit share the repeatable-path scanner and automatic base", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-scanner-")); initRepo(rootDir); const cell = await openRepoCell({ repoId: workspaceId("scanner"), rootDir: canonicalRoot(rootDir), ownerId: "scanner-daemon" }), binding = { actor, source: "local" as const };
  try { write(rootDir, "context/a.md", "# A\n\nfirst\n"); write(rootDir, "context/b.md", "# B\n\nsecond\n"); write(rootDir, "tasks/task-one/progress.md", "# Progress\n"); write(rootDir, "context/ignored.json", "{}\n"); const before = git(rootDir, "rev-parse", "HEAD"), status = await cell.run({ kind: "doc-status", paths: [] }, binding), statusRows = rows(status.evidence);
    assert.deepEqual(statusRows.map((row) => [row.path, row.state]), [["context/a.md", "eligible"], ["context/b.md", "eligible"], ["tasks/task-one/progress.md", "blocked"]]); assert.equal(git(rootDir, "rev-parse", "HEAD"), before);
    const dry = await cell.run({ kind: "doc-dry-run", paths: ["context/a.md", "context/b.md"] }, binding); assert.deepEqual(rows(dry.evidence), statusRows.slice(0, 2)); assert.equal(git(rootDir, "rev-parse", "HEAD"), before);
    const submitted = await cell.run({ kind: "doc-submit", paths: ["context/a.md"] }, binding); assert.equal(submitted.outcome, "applied", JSON.stringify(submitted)); const event = makeTaskEventStore({ repoId: "scanner", rootDir }).readEvent(submitted.opId); assert.equal(event?.schema, "doc-event/v1"); if (event?.schema === "doc-event/v1") { assert.equal(event.payload.baseLedgerSha.sha, before); assert.equal(event.payload.executionId, null); assert.deepEqual(event.payload.changes.map((change) => change.path), ["context/a.md"]); }
    assert.deepEqual(git(rootDir, "status", "--porcelain", "-uall").split("\n").filter((line) => line.includes(" harness/")).sort(), ["?? harness/context/b.md", "?? harness/context/ignored.json", "?? harness/tasks/task-one/progress.md"]);
    write(rootDir, "context/a.md", "# Renamed\n\nfirst\n"); const acceptedCut = git(rootDir, "rev-parse", "HEAD"), blocked = await cell.run({ kind: "doc-dry-run", paths: ["context/a.md"] }, binding); assert.equal(rows(blocked.evidence)[0]?.state, "blocked"); const rejected = await cell.run({ kind: "doc-submit", paths: ["context/a.md"] }, binding); assert.equal(rejected.outcome, "rejected"); assert.equal(rejected.code, "preview_blocked"); assert.equal(git(rootDir, "rev-parse", "HEAD"), acceptedCut);
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("materialize restores task-bootstrap and doc-event files and is idempotent", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-materialize-")); initRepo(rootDir); const cell = await openRepoCell({ repoId: workspaceId("materialize"), rootDir: canonicalRoot(rootDir), ownerId: "materialize-daemon" }), binding = { actor, source: "local" as const };
  try { assert.equal((await cell.run({ kind: "task-create", taskId: "task-materialize", title: "Materialize" }, binding)).outcome, "applied"); write(rootDir, "context/notes.md", "# Notes\n\ncanonical\n"); assert.equal((await cell.run({ kind: "doc-submit", paths: ["context/notes.md"] }, binding)).outcome, "applied"); const cut = git(rootDir, "rev-parse", "HEAD"), count = git(rootDir, "rev-list", "--count", "HEAD"), taskRoot = path.join(rootDir, "harness/tasks/task-materialize"); rmSync(taskRoot, { recursive: true, force: true }); rmSync(path.join(rootDir, "harness/context/notes.md"));
    const first = await cell.run({ kind: "doc-materialize" }, binding), firstReport = materializeReport(first.evidence); assert.equal(first.outcome, "applied", JSON.stringify(first)); assert.equal(firstReport.changed.includes("context/notes.md"), true); assert.equal(firstReport.changed.some((value) => value.startsWith("tasks/task-materialize/")), true); assert.equal(existsSync(taskRoot), true); assert.equal(git(rootDir, "diff", "--name-only"), "");
    const second = await cell.run({ kind: "doc-materialize" }, binding), secondReport = materializeReport(second.evidence); assert.deepEqual(secondReport.changed, []); assert.deepEqual(secondReport.conflicts, []); assert.equal(git(rootDir, "rev-parse", "HEAD"), cut); assert.equal(git(rootDir, "rev-list", "--count", "HEAD"), count); assert.equal(git(rootDir, "diff", "--name-only"), "");
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("materialize preserves a divergent local edit in one ignored deterministic conflict scratch", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-conflict-")); initRepo(rootDir); const cell = await openRepoCell({ repoId: workspaceId("conflict"), rootDir: canonicalRoot(rootDir), ownerId: "conflict-daemon" }), binding = { actor, source: "local" as const }, canonical = "# Notes\n\ncanonical\n", local = "# Notes\n\nlocal draft\n";
  try { write(rootDir, "context/notes.md", canonical); assert.equal((await cell.run({ kind: "doc-submit", paths: ["context/notes.md"] }, binding)).outcome, "applied"); write(rootDir, "context/notes.md", local); const first = materializeReport((await cell.run({ kind: "doc-materialize" }, binding)).evidence); assert.deepEqual(first.changed, ["context/notes.md"]); assert.equal(first.conflicts.length, 1); assert.equal(readFileSync(path.join(rootDir, first.conflicts[0]!), "utf8"), local); assert.equal(readFileSync(path.join(rootDir, "harness/context/notes.md"), "utf8"), canonical); assert.equal(git(rootDir, "status", "--porcelain", "-uall").includes("conflict-"), false); const second = materializeReport((await cell.run({ kind: "doc-materialize" }, binding)).evidence); assert.deepEqual(second, { changed: [], conflicts: [] });
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("an authored branch advanced outside the daemon returns indeterminate with reconcile guidance", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-diverged-")); initRepo(rootDir); const cell = await openRepoCell({ repoId: workspaceId("diverged"), rootDir: canonicalRoot(rootDir), ownerId: "diverged-daemon" }), binding = { actor, source: "local" as const };
  try { write(rootDir, "context/notes.md", "# Notes\n"); git(rootDir, "add", "harness/context/notes.md"); git(rootDir, "commit", "-qm", "external advance"); const result = await cell.run({ kind: "doc-submit", paths: ["context/notes.md"] }, binding); assert.equal(result.outcome, "indeterminate"); assert.equal(result.code, "publication_indeterminate"); assert.match(result.nextAction ?? "", /reconcile/iu); assert.equal(cell.status().state, "unavailable"); }
  finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

function rows(evidence: string | undefined): readonly { readonly path: string; readonly state: string }[] { assert.match(evidence ?? "", /^doc-scan:/u); return (JSON.parse((evidence ?? "").slice("doc-scan:".length)) as { rows: readonly { path: string; state: string }[] }).rows; }
function materializeReport(evidence: string | undefined): { readonly changed: readonly string[]; readonly conflicts: readonly string[] } { assert.match(evidence ?? "", /^doc-materialize:/u); return JSON.parse((evidence ?? "").slice("doc-materialize:".length)) as { changed: readonly string[]; conflicts: readonly string[] }; }
function write(rootDir: string, target: string, body: string): void { const file = path.join(rootDir, "harness", target); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body); }
function initRepo(rootDir: string): void { git(rootDir, "init", "-q"); git(rootDir, "config", "user.name", "Doc A Test"); git(rootDir, "config", "user.email", "doc-a@example.invalid"); git(rootDir, "commit", "--allow-empty", "-qm", "base"); }
function git(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim(); }
