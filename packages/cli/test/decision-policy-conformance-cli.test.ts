// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI decision conformance requires standing-policy fulfillment instead of a task edge", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    writeDecisionConformancePolicy(rootDir);
    propose(rootDir, "dec_POLICY_TARGET", "Policy target");
    propose(rootDir, "dec_POLICY_REFINED", "Refined standing policy", [
      "--evidence-relation",
      "C1:refines:decision/dec_POLICY_TARGET/C1:The standing policy refines an existing policy decision"
    ]);
    runJson(rootDir, ["decision", "accept", "dec_POLICY_REFINED", "--fulfillment", "C1:standing-policy"]);

    propose(rootDir, "dec_POLICY_EMPTY", "Unfulfilled standing policy");
    runJson(rootDir, [
      "decision", "accept", "dec_POLICY_EMPTY",
      "--judgment-only", "Exercise the negative conformance path.",
      "--fulfillment", "C1:standing-policy"
    ]);
    assert.match(readFileSync(path.join(rootDir, "harness/decisions/decision-dec_POLICY_REFINED/decision.md"), "utf8"), /fulfillment: "standing-policy"/u);

    propose(rootDir, "dec_ORDINARY_MISSING", "Ordinary unimplemented decision");
    runJson(rootDir, [
      "decision", "accept", "dec_ORDINARY_MISSING",
      "--judgment-only", "Exercise the ordinary negative path."
    ]);
    const result = runJson(rootDir, ["check", "--profile", "source-package"], false);

    assert.equal(hasFinding(result, "accepted-decision-missing-task-or-defer", "decision/dec_POLICY_REFINED"), false);
    assert.equal(hasFinding(result, "standing-policy-missing-fulfillment", "decision/dec_POLICY_REFINED"), false);
    assert.equal(hasFinding(result, "standing-policy-missing-fulfillment", "decision/dec_POLICY_EMPTY"), true);
    assert.equal(hasFinding(result, "accepted-decision-missing-task-or-defer", "decision/dec_ORDINARY_MISSING"), true);
  });
});

test("CLI decision conformance reaches the deferred decision exemption", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    writeDecisionConformancePolicy(rootDir);
    propose(rootDir, "dec_DEFERRED_EXIT", "Deferred conformance exit");
    runJson(rootDir, ["decision", "amend", "dec_DEFERRED_EXIT", "--standing-policy"]);
    runJson(rootDir, ["decision", "defer", "dec_DEFERRED_EXIT"]);

    const result = runJson(rootDir, ["check", "--profile", "source-package"]);
    assert.equal(hasFinding(result, "accepted-decision-missing-task-or-defer", "decision/dec_DEFERRED_EXIT"), false);
    assert.equal(hasFinding(result, "standing-policy-missing-fulfillment", "decision/dec_DEFERRED_EXIT"), false);
  });
});

function propose(rootDir: string, decisionId: string, title: string, extra: ReadonlyArray<string> = []): void {
  runJson(rootDir, [
    "decision", "propose",
    "--id", decisionId,
    "--title", title,
    "--question", "How should this decision be governed?",
    "--chosen", "Use explicit conformance semantics",
    "--rejected", "Infer conformance from prose",
    "--why-not", "Inference would change default behavior",
    ...extra
  ]);
}

function hasFinding(result: Record<string, any>, type: string, ref: string): boolean {
  const check = result.report.scriptChecks.find((entry: Record<string, any>) => (
    entry.scriptId === "vertical:software-coding:decision-conformance"
  ));
  assert.ok(check);
  return check.report.findings.some((finding: Record<string, any>) => finding.type === type && finding.ref === ref);
}

function writeDecisionConformancePolicy(rootDir: string): void {
  writeFile(rootDir, "harness/policies/presets/decision-conformance.policy.json", JSON.stringify({
    schema: "preset-policy/decision-conformance/v1",
    presetId: "decision-conformance",
    rules: { enforcement: "fail" }
  }));
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-policy-conformance-cli-"));
  ensureTestHarnessIdentity(rootDir);
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  const cliArgs = independentDecisionJudgmentArgs(args);
  try {
    const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...cliArgs], {
      encoding: "utf8",
      env: { ...process.env, HARNESS_ACTOR: "agent:test" }
    });
    const parsed = unwrapCommandReceipt(JSON.parse(output) as Record<string, any>);
    if (expectSuccess) assert.equal(parsed.ok, true, output);
    return parsed;
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function independentDecisionJudgmentArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  if (args[0] !== "decision" || !["accept", "reject", "defer", "supersede", "retire"].includes(args[1] ?? "")) return args;
  return ["--actor", "human:person_test", ...args];
}

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const target = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}
