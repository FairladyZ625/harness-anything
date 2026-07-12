// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI projection read rebuilds relation edges when decision documents change without deleting cache", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["new-task", "--title", "Task One"]);
    writeDecision(rootDir, "dec_OLD", "wm-old", []);
    writeDecision(rootDir, "dec_NEW", "wm-new", []);
    runJson(rootDir, ["task", "list"]);

    assert.equal(readDecisionDecisionEdgeCount(rootDir), 0);

    writeDecision(rootDir, "dec_NEW", "wm-new", [
      "- {relation_id: rel_3c299a8958c5c2c1, source: decision/dec_NEW/CH1, target: decision/dec_OLD, type: supersedes, strength: strong, direction: directed, origin: declared, rationale: \"freshness regression\", state: active}"
    ]);
    const result = runJson(rootDir, ["task", "list"]);

    assert.equal(result.ok, true);
    assert.equal(readDecisionDecisionEdgeCount(rootDir), 1);
  });
});

function writeDecision(rootDir: string, decisionId: string, watermark: string, relations: ReadonlyArray<string>): void {
  const decisionDir = path.join(rootDir, "harness/decisions", `decision-${decisionId}`);
  mkdirSync(decisionDir, { recursive: true });
  writeFileSync(path.join(decisionDir, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    `_coordinatorWatermark: ${watermark}`,
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

function readDecisionDecisionEdgeCount(rootDir: string): number {
  const db = new DatabaseSync(path.join(rootDir, ".harness/cache/projections.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM relation_edges WHERE source_ref LIKE 'decision/%' AND target_ref LIKE 'decision/%'").get() as { readonly count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-"));
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
      env: process.env
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}
