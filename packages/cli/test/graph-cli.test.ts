import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI graph writes relation graph HTML from projection and embeds F5 cascade focus", () => {
  withTempRoot((rootDir) => {
    writeTask(rootDir, "task-one", "Task One");
    writeTask(rootDir, "task-island", "Task Island");
    writeDecision(rootDir, "dec_OLD", []);
    writeDecision(rootDir, "dec_NEW", [
      "- {relation_id: rel_3c299a8958c5c2c1, source: decision/dec_NEW/CH1, target: decision/dec_OLD, type: supersedes, strength: strong, direction: directed, origin: declared, rationale: \"CLI graph cascade\", state: active}"
    ]);
    runJson(rootDir, ["task", "list"]);

    const result = runJson(rootDir, ["graph", "--focus", "decision/dec_NEW", "--out", ".harness/generated/graph-panorama/w7.html"]);
    const htmlPath = path.join(rootDir, ".harness/generated/graph-panorama/w7.html");
    const html = readFileSync(htmlPath, "utf8");

    assert.equal(result.ok, true);
    assert.equal(result.command, "graph");
    assert.equal(result.rows, 1);
    assert.equal(result.path, ".harness/generated/graph-panorama/w7.html");
    assert.equal(result.projectionPath, ".harness/cache/projections.sqlite");
    assert.equal(result.report.summary.focusOutgoing, 1);
    assert.equal(result.report.summary.islands >= 1, true);
    assert.equal(existsSync(htmlPath), true);
    assert.match(html, /Focused Cascade/u);
    assert.match(html, /Island Audit/u);
    assert.match(html, /task\/task-island/u);
    assert.match(html, /rel_3c299a8958c5c2c1/u);
  });
});

function writeTask(rootDir: string, taskId: string, title: string): void {
  const taskDir = path.join(rootDir, "harness/tasks", `${taskId}-fixture`);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(path.join(taskDir, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: active",
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-07-04T00:00:00.000Z",
    "  bindingFingerprint: sha256:4d1771ef6e83619eb8a82f1593bf118383084665fc58f634072d379178d525d7",
    "packageDisposition: active",
    "vertical: software/coding",
    "preset: standard-task",
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"), "utf8");
}

function writeDecision(rootDir: string, decisionId: string, relations: ReadonlyArray<string>): void {
  const decisionDir = path.join(rootDir, "harness/decisions", `decision-${decisionId}`);
  mkdirSync(decisionDir, { recursive: true });
  writeFileSync(path.join(decisionDir, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    `_coordinatorWatermark: wm-${decisionId}`,
    `title: "${decisionId}"`,
    "state: active",
    "riskTier: low",
    "urgency: low",
    "vertical: \"software/coding\"",
    "preset: \"architecture-decision\"",
    "applies_to:",
    "  modules: []",
    "  productLines: []",
    "proposedBy: { kind: \"agent\", id: \"fixture\" }",
    "proposedAt: \"2026-07-04T00:00:00.000Z\"",
    "arbiter: { kind: \"human\", id: \"fixture\" }",
    "decidedAt: \"2026-07-04T00:00:00.000Z\"",
    "provenance:",
    "  - {runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-07-04T00:00:00.000Z\"}",
    `question: "Should ${decisionId} exist?"`,
    "chosen:",
    "  - { id: \"CH1\", text: \"Yes\" }",
    "rejected:",
    "  - { id: \"RJ1\", text: \"No\", why_not: \"Fixture\" }",
    "claims:",
    "  - { id: \"C1\", text: \"Fixture claim\" }",
    "relations:",
    ...relations.map((relation) => `  ${relation}`),
    "---",
    "",
    `# ${decisionId}`,
    ""
  ].join("\n"), "utf8");
}

function runJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: process.env
  });
  return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-graph-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
