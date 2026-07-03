import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI record fact writes a task-local stable F-id through the coordinator", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Fact Owner"]);
    const taskId = String(created.taskId);
    const result = runJson(rootDir, [
      "record",
      "fact",
      "--task",
      taskId,
      "--id",
      "F-DEADBEEF",
      "--statement",
      "Decision CLI has a human terminal fallback.",
      "--source",
      "manual verification",
      "--confidence",
      "high",
      "--memory-class",
      "semantic",
      "--memory-tag",
      "tool_memory,pattern",
      "--observed-at",
      "2026-07-03T00:00:00.000Z"
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "record-fact");
    assert.equal(result.factId, "F-DEADBEEF");
    assert.equal(result.factRef, `fact/${taskId}/F-DEADBEEF`);
    assert.equal(result.path, "facts.md");
    const factsBody = readFileSync(path.join(rootDir, String(created.packagePath), "facts.md"), "utf8");
    assert.match(factsBody, /^- \{fact_id: F-DEADBEEF, statement: "Decision CLI has a human terminal fallback\.", source: "manual verification", observedAt: "2026-07-03T00:00:00\.000Z", confidence: high, memoryClass: semantic, memoryTags: \[tool_memory, pattern\], provenance: \[\{runtime: "human", sessionId: "human-cli-\d+", boundAt: "2026-07-03T00:00:00\.000Z"\}\]\}$/mu);
    const sessionId = /sessionId: "(human-cli-\d+)"/u.exec(factsBody)?.[1];
    assert.ok(sessionId);
    assert.equal(readFileSync(path.join(rootDir, "harness", "sessions", `${sessionId}.md`), "utf8").includes(`sessionId: ${sessionId}`), true);
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8"), /write-watermark\/v1/);
  });
});

test("CLI check --post-merge fails closed when a referenced F-id is deleted", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Fact Owner"]);
    const taskId = String(created.taskId);
    const packagePath = path.join(rootDir, String(created.packagePath));
    runJson(rootDir, [
      "record",
      "fact",
      "--task",
      taskId,
      "--id",
      "F-DEADBEEF",
      "--statement",
      "Fact anchor remains stable.",
      "--source",
      "test fixture"
    ]);
    writeFileSync(path.join(packagePath, "relations.md"), `target: fact/${taskId}/F-DEADBEEF\n`, "utf8");

    const valid = runJson(rootDir, ["check", "--post-merge"]);
    assert.equal(valid.ok, true);
    assert.equal(valid.warnings.some((warning: Record<string, unknown>) => warning.code === "dangling_entity_ref"), false);

    writeFileSync(path.join(packagePath, "facts.md"), "# Facts\n\n", "utf8");
    const failure = runJson(rootDir, ["check", "--post-merge"], false);

    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "projection_check_failed");
    assert.equal(failure.warnings.some((warning: Record<string, unknown>) =>
      warning.code === "dangling_entity_ref" &&
      warning.severity === "hard-fail" &&
      String(warning.message).includes(`fact/${taskId}/F-DEADBEEF`)
    ), true);
  });
});

test("CLI record fact defaults to episodic memory class and rejects unknown memory tags", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Fact Owner"]);
    const taskId = String(created.taskId);
    const result = runJson(rootDir, [
      "record",
      "fact",
      "--task",
      taskId,
      "--id",
      "F-ABCDEF12",
      "--statement",
      "Default class is episodic.",
      "--source",
      "test fixture"
    ]);
    assert.equal(result.ok, true);
    const factsBody = readFileSync(path.join(rootDir, String(created.packagePath), "facts.md"), "utf8");
    assert.match(factsBody, /memoryClass: episodic, memoryTags: \[\]/u);

    const failure = runJson(rootDir, [
      "record",
      "fact",
      "--task",
      taskId,
      "--statement",
      "Bad tag.",
      "--source",
      "test fixture",
      "--memory-tag",
      "unknown_tag"
    ], false);
    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "invalid_fact_memory_tag");
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-fact-cli-"));
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
