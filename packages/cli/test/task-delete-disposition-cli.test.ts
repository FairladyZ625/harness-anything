import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveRelationId } from "../../kernel/src/index.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;

test("CLI task delete hard path is guarded by F5 disposition semantics", () => {
  withTempRoot((rootDir) => {
    const hard = runJson(rootDir, ["new-task", "--title", "Hard Delete"]);
    const hardTaskId = assertGeneratedTaskId(hard.taskId);
    const hardPackagePath = path.join(rootDir, `harness/tasks/${hardTaskId}-hard-delete`);
    assert.equal(existsSync(hardPackagePath), true);

    const missingConfirm = runJson(rootDir, ["task", "delete", "--hard", hardTaskId, "--reason", "mistaken local package"], false);
    assert.equal(missingConfirm.ok, false);
    assert.equal(missingConfirm.error?.code, "delete_confirm_required");

    const hardResult = runJson(rootDir, ["task", "delete", "--hard", hardTaskId, "--reason", "mistaken local package", "--confirm", hardTaskId]);
    assert.equal(hardResult.ok, true);
    assert.equal(hardResult.mode, "hard");
    assert.equal(existsSync(hardPackagePath), false);
    const journalBody = readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8");
    assert.match(journalBody, /"schema":"delete-audit\/v1"/);
    assert.match(journalBody, /"kind":"package_delete_hard_applied"/);
    const hardDeletePayloads = readdirSync(path.join(rootDir, ".harness/write-journal/payloads"))
      .map((entry) => readFileSync(path.join(rootDir, ".harness/write-journal/payloads", entry), "utf8"));
    assert.equal(hardDeletePayloads.some((body) => body.includes("mistaken local package")), true);

    const archived = runJson(rootDir, ["new-task", "--title", "Archived Delete"]);
    const archivedTaskId = assertGeneratedTaskId(archived.taskId);
    runJson(rootDir, ["task", "archive", archivedTaskId, "--reason", "keep audit"]);
    const archivedFailure = runJson(rootDir, ["task", "delete", "--hard", archivedTaskId, "--reason", "remove", "--confirm", archivedTaskId], false);
    assert.equal(archivedFailure.ok, false);
    assert.equal(archivedFailure.error?.code, "archived_hard_delete_forbidden");

    const terminal = runJson(rootDir, ["new-task", "--title", "Done Delete"]);
    const terminalTaskId = assertGeneratedTaskId(terminal.taskId);
    runJson(rootDir, ["task", "status", "set", terminalTaskId, "active"]);
    runJson(rootDir, ["task", "status", "set", terminalTaskId, "done", "--force", "--reason", "terminal fixture"]);
    const terminalFailure = runJson(rootDir, ["task", "delete", "--hard", terminalTaskId, "--reason", "remove", "--confirm", terminalTaskId], false);
    assert.equal(terminalFailure.ok, false);
    assert.equal(terminalFailure.error?.code, "terminal_hard_delete_forbidden");

    const anchored = runJson(rootDir, ["new-task", "--title", "Anchored Fact Delete"]);
    const anchoredTaskId = assertGeneratedTaskId(anchored.taskId);
    const anchoredPackagePath = path.join(rootDir, `harness/tasks/${anchoredTaskId}-anchored-fact-delete`);
    runJson(rootDir, [
      "fact",
      "record",
      "--task",
      anchoredTaskId,
      "--statement",
      "Anchored fact must survive stage containment.",
      "--source",
      "delete semantics test",
      "--confidence",
      "high"
    ]);
    const anchoredFailure = runJson(rootDir, ["task", "delete", "--hard", anchoredTaskId, "--reason", "remove", "--confirm", anchoredTaskId], false);
    assert.equal(anchoredFailure.ok, false);
    assert.equal(anchoredFailure.error?.code, "related_task_hard_delete_forbidden");
    assert.match(anchoredFailure.error?.hint ?? "", /1 anchored fact\(s\) and 0 active incoming relation\(s\)/u);
    assert.match(anchoredFailure.error?.hint ?? "", /distill evidence into an anchor task/u);
    assert.match(anchoredFailure.error?.hint ?? "", /ha task archive/u);
    assert.equal(existsSync(anchoredPackagePath), true);

    const archivedAnchored = runJson(rootDir, ["task", "archive", anchoredTaskId, "--reason", "stage contained by anchor task"]);
    assert.equal(archivedAnchored.ok, true);
    assert.match(readFileSync(path.join(anchoredPackagePath, "INDEX.md"), "utf8"), /packageDisposition: archived/);

    const related = runJson(rootDir, ["new-task", "--title", "Related Delete"]);
    const relatedTaskId = assertGeneratedTaskId(related.taskId);
    writeDecisionRelation(rootDir, "dec_DELETE_BLOCKER", `task/${relatedTaskId}`, "active");
    const relatedFailure = runJson(rootDir, ["task", "delete", "--hard", relatedTaskId, "--reason", "remove", "--confirm", relatedTaskId], false);
    assert.equal(relatedFailure.ok, false);
    assert.equal(relatedFailure.error?.code, "related_task_hard_delete_forbidden");
    assert.match(relatedFailure.error?.hint ?? "", /0 anchored fact\(s\) and 1 active incoming relation\(s\)/u);
    assert.match(relatedFailure.error?.hint ?? "", /ha task archive/u);

    const retired = runJson(rootDir, ["new-task", "--title", "Retired Relation Delete"]);
    const retiredTaskId = assertGeneratedTaskId(retired.taskId);
    const retiredPackagePath = path.join(rootDir, `harness/tasks/${retiredTaskId}-retired-relation-delete`);
    writeDecisionRelation(rootDir, "dec_DELETE_RETIRED", `task/${retiredTaskId}`, "retired");
    const retiredResult = runJson(rootDir, ["task", "delete", "--hard", retiredTaskId, "--reason", "remove retired relation target", "--confirm", retiredTaskId]);
    assert.equal(retiredResult.ok, true);
    assert.equal(existsSync(retiredPackagePath), false);
  });
});

test("CLI task delete soft path tombstones without invoking hard deletion", () => {
  withTempRoot((rootDir) => {
    const soft = runJson(rootDir, ["new-task", "--title", "Soft Delete"]);
    const softTaskId = assertGeneratedTaskId(soft.taskId);
    const softResult = runJson(rootDir, ["task", "delete", "--soft", softTaskId, "--reason", "not needed"]);

    assert.equal(softResult.ok, true);
    assert.match(readFileSync(path.join(rootDir, `harness/tasks/${softTaskId}-soft-delete/INDEX.md`), "utf8"), /packageDisposition: tombstoned/);
  });
});

function writeDecisionRelation(rootDir: string, decisionId: string, targetRef: string, state: "active" | "retired"): void {
  const source = `decision/${decisionId}/C1`;
  const relation = {
    source,
    target: targetRef,
    type: "derives" as const,
    direction: "directed" as const
  };
  const relationId = deriveRelationId(relation);
  const decisionDir = path.join(rootDir, "harness/decisions", `decision-${decisionId}`);
  mkdirSync(decisionDir, { recursive: true });
  writeFileSync(path.join(decisionDir, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    `_coordinatorWatermark: wm-${decisionId}`,
    `title: ${decisionId}`,
    "state: active",
    "riskTier: medium",
    "urgency: medium",
    "vertical: software/coding",
    "preset: standard-task",
    "applies_to:",
    "  modules: []",
    "  productLines: []",
    "proposedBy: { kind: \"human\", id: \"tester\" }",
    "proposedAt: 2026-07-04T00:00:00.000Z",
    "arbiter: { kind: \"human\", id: \"tester\" }",
    "decidedAt: 2026-07-04T00:00:00.000Z",
    "provenance:",
    "  - { runtime: \"cli\", actor: { kind: \"human\", id: \"tester\" }, capturedAt: \"2026-07-04T00:00:00.000Z\" }",
    `question: ${JSON.stringify(decisionId)}`,
    "chosen:",
    "  - { id: \"CH1\", text: \"Chosen\" }",
    "rejected:",
    "  - { id: \"RJ1\", text: \"Rejected\", why_not: \"Fixture\" }",
    "claims:",
    "  - { id: \"C1\", statement: \"Fixture claim\", required: true }",
    "relations:",
    `  - { relation_id: ${relationId}, source: ${source}, target: ${targetRef}, type: derives, strength: strong, direction: directed, origin: declared, rationale: "Fixture delete guard", state: ${state} }`,
    "---",
    "",
    `# ${decisionId}`,
    ""
  ].join("\n"), "utf8");
}

function assertGeneratedTaskId(value: unknown): string {
  assert.equal(typeof value, "string");
  assert.match(value, taskIdPattern);
  return value;
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-delete-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], { encoding: "utf8" });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}
