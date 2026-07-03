import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI distill candidate writes a generated candidate without recording a fact", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Distill Owner"]);
    const taskId = String(created.taskId);
    writeFileSync(path.join(rootDir, "source-note.md"), "Distilled behavior should remain candidate by default.\n\nEvidence body.\n", "utf8");

    const candidate = runJson(rootDir, ["distill", "candidate", "--task", taskId, "--input", "source-note.md"]);

    assert.equal(candidate.ok, true);
    assert.equal(candidate.command, "distill-candidate");
    assert.equal(candidate.taskId, taskId);
    assert.equal(candidate.report.factWrite, false);
    assert.equal(candidate.report.factState, "candidate");
    assert.match(candidate.path, new RegExp(`^\\.harness/generated/distill/${taskId}/distill_[^/]+\\.json$`, "u"));
    assert.equal(existsSync(path.join(rootDir, String(created.packagePath), "facts.md")), false);

    const artifact = JSON.parse(readFileSync(path.join(rootDir, String(candidate.path)), "utf8")) as Record<string, unknown>;
    assert.equal(artifact.schema, "distill-candidate/v1");
    assert.equal(artifact.factState, "candidate");
    assert.equal(artifact.taskId, taskId);
    assert.equal(artifact.inputPath, "source-note.md");
    assert.equal(typeof artifact.inputSha256, "string");
  });
});

test("CLI distill commit records the explicit claim through the fact write path", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Distill Owner"]);
    const taskId = String(created.taskId);
    writeFileSync(path.join(rootDir, "source-note.md"), "Candidate claim body.\n", "utf8");
    const candidate = runJson(rootDir, ["distill", "candidate", "--task", taskId, "--input", "source-note.md"]);

    const committed = runJson(rootDir, [
      "distill",
      "commit",
      "--task",
      taskId,
      "--candidate",
      String(candidate.path),
      "--claim",
      "Distill commit records only after explicit command.",
      "--id",
      "F-ABCD1234",
      "--memory-class",
      "semantic",
      "--memory-tag",
      "pattern",
      "--observed-at",
      "2026-07-03T00:00:00.000Z"
    ]);

    assert.equal(committed.ok, true);
    assert.equal(committed.command, "distill-commit");
    assert.equal(committed.factRef, `fact/${taskId}/F-ABCD1234`);
    assert.equal(committed.report.factWrite, true);
    const factsBody = readFileSync(path.join(rootDir, String(created.packagePath), "facts.md"), "utf8");
    assert.match(factsBody, /fact_id: F-ABCD1234/u);
    assert.match(factsBody, /statement: "Distill commit records only after explicit command\."/u);
    assert.match(factsBody, /source: "ha distill commit; candidate=\.harness\/generated\/distill\//u);
    assert.match(factsBody, /input=source-note\.md; inputSha256=[a-f0-9]{64}/u);
    assert.match(factsBody, /memoryClass: semantic, memoryTags: \[pattern\]/u);
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8"), /write-watermark\/v1/u);
  });
});

test("CLI distill commit fails closed for missing or mismatched candidates", () => {
  withTempRoot((rootDir) => {
    const first = runJson(rootDir, ["new-task", "--title", "First"]);
    const second = runJson(rootDir, ["new-task", "--title", "Second"]);
    writeFileSync(path.join(rootDir, "source-note.md"), "Candidate claim body.\n", "utf8");
    const candidate = runJson(rootDir, ["distill", "candidate", "--task", String(first.taskId), "--input", "source-note.md"]);

    const missing = runJson(rootDir, [
      "distill",
      "commit",
      "--task",
      String(first.taskId),
      "--candidate",
      ".harness/generated/distill/missing.json",
      "--claim",
      "Missing candidate should not write."
    ], false);
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, "artifact_read_failed");

    const mismatch = runJson(rootDir, [
      "distill",
      "commit",
      "--task",
      String(second.taskId),
      "--candidate",
      String(candidate.path),
      "--claim",
      "Mismatched candidate should not write."
    ], false);
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error?.code, "artifact_read_failed");
    assert.equal(existsSync(path.join(rootDir, String(second.packagePath), "facts.md")), false);
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-distill-cli-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        ANTIGRAVITY_SESSION_ID: "",
        CLAUDE_CODE_SESSION_ID: "",
        CLAUDE_SESSION_ID: "",
        CODEX_SESSION_ID: "",
        ZCODE_SESSION_ID: ""
      }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return JSON.parse(failure.stdout ?? "{}") as Record<string, any>;
  }
}
