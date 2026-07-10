import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI milestone-closeout preset script red-blocks task evidence missing milestone criteria and passes after mapped evidence is complete", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "harness/milestones/m2-5/feature-breakdown.md", [
      "# M2.5 Feature Breakdown",
      "",
      "## Exit Criteria",
      "",
      "- [x] Implemented behavior has source evidence.",
      "- [x] Stub criterion still pending.",
      ""
    ].join("\n"));
    writeFile(rootDir, "harness/tasks/task-closeout/INDEX.md", [
      "---",
      "schema: task-package/v2",
      "task_id: task-closeout",
      "title: Closeout fixture",
      "---",
      "# Closeout fixture",
      ""
    ].join("\n"));
    writeFile(rootDir, "harness/tasks/task-closeout/task_plan.md", [
      "# Plan",
      "",
      "## Task Evidence",
      "",
      "- [x] Implemented behavior has source evidence.",
      ""
    ].join("\n"));
    writeFile(rootDir, "harness/decisions/decision-dec_CLOSEOUT/decision.md", decisionDocument([
      "relations:",
      "  - { relation_id: \"rel_closeout_scope\", source: \"decision/dec_CLOSEOUT/CH1\", target: \"task/task-closeout\", type: \"derives\", strength: \"strong\", direction: \"directed\", origin: \"declared\", rationale: \"closeout scope\", state: \"active\" }",
      "---",
      "# Closeout decision",
      ""
    ]));

    const unauthorized = runJson(rootDir, ["preset", "action", "milestone-closeout", "check", "--task", "task-closeout"], false);
    assert.equal(unauthorized.error.code, "preset_script_authorization_required");

    const blocked = runJson(rootDir, ["preset", "action", "milestone-closeout", "check", "--task", "task-closeout", "--allow-scripts"], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, "milestone_closeout_blocked");
    assert.equal(blocked.report.status, "blocked");
    assert.equal(blocked.report.criteriaSource, "milestone-feature-breakdown");
    assert.equal(blocked.report.items.some((item: Record<string, unknown>) => item.status === "red" && item.reason === "milestone_criterion_stub_or_placeholder"), true);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-closeout/artifacts/milestone-closeout-report.json")), true);

    writeFile(rootDir, "harness/milestones/m2-5/feature-breakdown.md", [
      "# M2.5 Feature Breakdown",
      "",
      "## Exit Criteria",
      "",
      "- [x] Implemented behavior has source evidence.",
      "- [x] Former open criterion now has source evidence.",
      ""
    ].join("\n"));
    writeFile(rootDir, "harness/tasks/task-closeout/task_plan.md", [
      "# Plan",
      "",
      "## Task Evidence",
      "",
      "- [x] Implemented behavior has source evidence.",
      "- [x] Former open criterion now has source evidence.",
      ""
    ].join("\n"));

    const passed = runJson(rootDir, ["preset", "action", "milestone-closeout", "check", "--task", "task-closeout", "--allow-scripts"]);

    assert.equal(passed.ok, true);
    assert.equal(passed.report.status, "passed");
    assert.equal(passed.report.summary.red, 0);
    assert.equal(passed.report.summary.green, 2);
    assert.equal(passed.report.summary.weak, 2);
    assert.equal(passed.report.summary.strong, 0);
    assert.equal(passed.report.items.every((item: Record<string, unknown>) => item.evidenceStrength === "weak"), true);
    assert.equal(passed.report.items.some((item: Record<string, unknown>) => String(item.reason).startsWith("load_bearing_decision_claim_")), false);
  });
});

test("CLI milestone-closeout policy rejects checkbox-only evidence and accepts canonical typed refs", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "harness/policies/presets/milestone-closeout.policy.json", JSON.stringify({
      schema: "preset-policy/milestone-closeout/v1",
      presetId: "milestone-closeout",
      rules: {
        requireLoadBearingClaimCoverage: true,
        boundary: { kind: "root-task-subtree", rootTaskInput: "milestoneRootTaskId" },
        evidenceMode: "typed-canonical-projection"
      }
    }));
    writeFile(rootDir, "harness/milestones/m2-5/feature-breakdown.md", [
      "# M2.5 Feature Breakdown",
      "",
      "## Exit Criteria",
      "",
      "- [x] Implemented behavior has source evidence.",
      ""
    ].join("\n"));
    writeFile(rootDir, "harness/tasks/task-closeout/INDEX.md", [
      "---",
      "schema: task-package/v2",
      "task_id: task-closeout",
      "title: Closeout fixture",
      "---",
      "# Closeout fixture",
      ""
    ].join("\n"));
    writeFile(rootDir, "harness/tasks/task-closeout/task_plan.md", [
      "# Plan",
      "",
      "## Task Evidence",
      "",
      "- [x] Implemented behavior has source evidence.",
      ""
    ].join("\n"));
    writeFile(rootDir, "harness/decisions/decision-dec_CLOSEOUT/decision.md", decisionDocument([
      "relations:",
      "  - { relation_id: \"rel_closeout_scope\", source: \"decision/dec_CLOSEOUT/CH1\", target: \"task/task-closeout\", type: \"derives\", strength: \"strong\", direction: \"directed\", origin: \"declared\", rationale: \"closeout scope\", state: \"active\" }",
      "---",
      "# Closeout decision",
      ""
    ]));

    const blocked = runJson(rootDir, [
      "preset", "action", "milestone-closeout", "check", "--task", "task-closeout", "--allow-scripts",
      "--input", "milestoneRootTaskId=task-closeout"
    ], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, "milestone_closeout_blocked");
    assert.equal(blocked.report.status, "blocked");
    assert.equal(blocked.report.items.some((item: Record<string, unknown>) => item.status === "red" && item.reason === "typed_evidence_ref_required" && item.evidenceStrength === "weak"), true);
    assert.equal(blocked.report.items.some((item: Record<string, unknown>) => item.status === "red" && item.reason === "load_bearing_decision_claim_uncovered"), true);

    writeFile(rootDir, "harness/tasks/task-closeout/task_plan.md", [
      "# Plan",
      "",
      "## Task Evidence",
      "",
      "- [x] Implemented behavior has source evidence. Evidence: fact/task-missing/F-NOTREAL",
      ""
    ].join("\n"));
    const unresolved = runJson(rootDir, [
      "preset", "action", "milestone-closeout", "check", "--task", "task-closeout", "--allow-scripts",
      "--input", "milestoneRootTaskId=task-closeout"
    ], false);
    assert.equal(unresolved.report.items.some((item: Record<string, unknown>) => item.status === "red" && item.reason === "typed_evidence_ref_unresolved"), true);

    writeFile(rootDir, "harness/tasks/task-evidence/INDEX.md", [
      "---",
      "schema: task-package/v2",
      "task_id: task-evidence",
      "title: Evidence fixture",
      "parent: task-closeout",
      "---",
      "# Evidence fixture",
      ""
    ].join("\n"));
    writeFile(rootDir, "harness/tasks/task-evidence/facts.md", [
      "---",
      "schema: facts/v1",
      "---",
      "",
      "## F-C0VERED1",
      "fact_id: F-C0VERED1",
      "statement: Covered closeout claim.",
      ""
    ].join("\n"));
    writeFile(rootDir, "harness/tasks/task-closeout/task_plan.md", [
      "# Plan",
      "",
      "## Task Evidence",
      "",
      "- [x] Implemented behavior has source evidence. Evidence: fact/task-evidence/F-C0VERED1",
      ""
    ].join("\n"));
    writeFile(rootDir, "harness/decisions/decision-dec_CLOSEOUT/decision.md", decisionDocument([
      "relations:",
      "  - { relation_id: \"rel_closeout_scope\", source: \"decision/dec_CLOSEOUT/CH1\", target: \"task/task-closeout\", type: \"derives\", strength: \"strong\", direction: \"directed\", origin: \"declared\", rationale: \"closeout scope\", state: \"active\" }",
      "  - { relation_id: \"rel_closeout_coverage\", source: \"decision/dec_CLOSEOUT/C1\", target: \"fact/task-evidence/F-C0VERED1\", type: \"supports\", strength: \"strong\", direction: \"directed\", origin: \"declared\", rationale: \"closeout evidence\", state: \"active\" }",
      "---",
      "# Closeout decision",
      ""
    ]));

    const passed = runJson(rootDir, [
      "preset", "action", "milestone-closeout", "check", "--task", "task-closeout", "--allow-scripts",
      "--input", "milestoneRootTaskId=task-closeout"
    ]);

    assert.equal(passed.ok, true);
    assert.equal(passed.report.status, "passed");
    assert.equal(passed.report.summary.strong, 2);
    assert.equal(passed.report.summary.weak, 0);
    assert.equal(passed.report.items.some((item: Record<string, unknown>) => item.status === "green" && item.reason === "typed_evidence_ref_resolved" && item.evidenceStrength === "strong"), true);
    assert.equal(passed.report.items.some((item: Record<string, unknown>) => item.status === "green" && item.reason === "load_bearing_decision_claim_covered"), true);
  });
});

test("CLI milestone-closeout fails explicitly on an invalid project policy", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "harness/policies/presets/milestone-closeout.policy.json", JSON.stringify({
      schema: "preset-policy/milestone-closeout/v1",
      presetId: "milestone-closeout",
      rules: { evidenceMode: "checkbox-self-report" }
    }));
    writeFile(rootDir, "harness/tasks/task-closeout/INDEX.md", [
      "---",
      "schema: task-package/v2",
      "task_id: task-closeout",
      "title: Closeout fixture",
      "---",
      "# Closeout fixture",
      ""
    ].join("\n"));

    const result = runJson(rootDir, [
      "preset", "action", "milestone-closeout", "check", "--task", "task-closeout", "--allow-scripts"
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "preset_policy_invalid");
  });
});

function decisionDocument(tail: ReadonlyArray<string>): string {
  return [
    "---",
    "schema: decision-package/v1",
    "decision_id: dec_CLOSEOUT",
    "title: Closeout decision",
    "state: active",
    "riskTier: medium",
    "urgency: medium",
    "vertical: software/coding",
    "preset: architecture-decision",
    "applies_to:",
    "  modules: []",
    "  productLines: []",
    "proposedBy: { kind: agent, id: test }",
    "proposedAt: 2026-07-05T00:00:00.000Z",
    "arbiter: { kind: human, id: ZeyuLi }",
    "decidedAt: 2026-07-05T00:01:00.000Z",
    "provenance:",
    "  - { runtime: human, sessionId: human-cli-1, boundAt: 2026-07-05T00:00:00.000Z }",
    "question: Should milestone closeout enforce decision coverage?",
    "chosen:",
    "  - { id: CH1, text: Enforce decision coverage. }",
    "rejected:",
    "  - { id: RJ1, text: Ignore decision coverage., why_not: Milestone exit is the coverage gate. }",
    "claims:",
    "  - { id: C1, text: Uncovered claim blocks milestone exit. }",
    ...tail
  ].join("\n");
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    const parsed = JSON.parse(output) as Record<string, any>;
    if (expectSuccess) assert.equal(parsed.ok, true, output);
    return unwrapCommandReceipt(parsed);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "harness-preset-closeout-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const target = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}
