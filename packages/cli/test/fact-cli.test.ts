// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const sessionManifest = JSON.parse(readFileSync(path.join(rootDir, "harness", "sessions", `${sessionId}.md`), "utf8")) as { schema: string; sessionId: string };
    assert.equal(sessionManifest.schema, "session-entity/v1");
    assert.equal(sessionManifest.sessionId, sessionId);
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

test("CLI record fact accepts schema-shaped JSON input from file", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["task", "create", "--title", "JSON Fact Owner"]);
    const taskId = String(created.taskId);
    const payloadPath = path.join(rootDir, "fact-input.json");
    writeFileSync(payloadPath, JSON.stringify({
      taskId,
      factId: "F-ABCDEF12",
      statement: "Global --from-file input reaches the fact parser.",
      source: "packages/cli/test/fact-cli.test.ts",
      confidence: "high",
      memoryClass: "procedural",
      memoryTags: ["tool_memory"]
    }), "utf8");

    const result = runJson(rootDir, ["fact", "record", "--from-file", payloadPath]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "record-fact");
    assert.equal(result.factId, "F-ABCDEF12");
    const factsBody = readFileSync(path.join(rootDir, String(created.packagePath), "facts.md"), "utf8");
    assert.match(factsBody, /Global --from-file input reaches the fact parser\./u);
    assert.match(factsBody, /memoryClass: procedural, memoryTags: \[tool_memory\]/u);
  });
});

test("CLI fact record from file never treats an injected flag as the task id", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["task", "create", "--title", "JSON Fact Owner"]);
    const payloadPath = path.join(rootDir, "fact-input-with-unknown-task-key.json");
    writeFileSync(payloadPath, JSON.stringify({
      task: created.taskId,
      statement: "Unknown JSON keys cannot select a write path.",
      source: "packages/cli/test/fact-cli.test.ts"
    }), "utf8");

    const result = runJson(rootDir, ["fact", "record", "--from-file", payloadPath], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "missing_task_id");
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/--statement")), false);
  });
});

test("CLI fact list show and invalidate use the fact write surface", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Fact Commands"]);
    const taskId = String(created.taskId);
    runJson(rootDir, ["fact", "record", "--task", taskId, "--id", "F-DEADBEEF", "--statement", "Old fact.", "--source", "test"]);
    runJson(rootDir, ["fact", "record", "--task", taskId, "--id", "F-FEEDFACE", "--statement", "New fact.", "--source", "test"]);

    const listed = runJson(rootDir, ["fact", "list", "--task", taskId]);
    assert.equal(listed.ok, true);
    assert.equal(listed.command, "fact-list");
    assert.equal(listed.rows, 2);
    assert.equal(listed.report.facts.some((fact: Record<string, unknown>) => fact.factId === "F-DEADBEEF"), true);

    const shown = runJson(rootDir, ["fact", "show", "--task", taskId, "--id", "F-DEADBEEF"]);
    assert.equal(shown.ok, true);
    assert.equal(shown.command, "fact-show");
    assert.equal(shown.factRef, `fact/${taskId}/F-DEADBEEF`);

    const invalidated = runJson(rootDir, [
      "fact",
      "invalidate",
      "--task",
      taskId,
      "--id",
      "F-DEADBEEF",
      "--by",
      "F-FEEDFACE",
      "--rationale",
      "New fact supersedes old fact"
    ]);
    assert.equal(invalidated.ok, true);
    assert.equal(invalidated.command, "fact-invalidate");
    assert.match(String(invalidated.report.relationId), /^rel_[a-f0-9]{16}$/u);
    const factsBody = readFileSync(path.join(rootDir, String(created.packagePath), "facts.md"), "utf8");
    assert.match(factsBody, /relations:/u);
    assert.match(factsBody, /type: supersedes-fact/u);
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-fact-cli-"));
  ensureTestHarnessIdentity(rootDir);
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
        HARNESS_ACTOR: "agent:test",
        ANTIGRAVITY_SESSION_ID: "",
        CLAUDE_CODE_SESSION_ID: "",
        CLAUDE_SESSION_ID: "",
        CODEX_SESSION_ID: "",
        CODEX_THREAD_ID: "",
        ZCODE_SESSION_ID: ""
      }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}
