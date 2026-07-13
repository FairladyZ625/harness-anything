// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI decision propose and amend load authored markdown from --body-file", () => {
  withTempRoot((rootDir) => {
    const proposedBodyPath = path.join(rootDir, "proposed-body.md");
    const amendedBodyPath = path.join(rootDir, "amended-body.md");
    writeFileSync(proposedBodyPath, "## Background\n\nThe proposal needs prose.", "utf8");
    writeFileSync(amendedBodyPath, "## Conclusion\n\nThe amended decision is clearer.", "utf8");

    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_BODY_FILE",
      "--title", "Body file input",
      "--question", "Can a proposal read markdown from a file?",
      "--chosen", "Read the file",
      "--rejected", "Inline every paragraph",
      "--why-not", "Long prose is difficult to quote safely",
      "--body-file", proposedBodyPath
    ]);

    const proposedPath = path.join(rootDir, "harness/decisions/decision-dec_BODY_FILE/decision.md");
    assert.match(decisionBody(readFileSync(proposedPath, "utf8")), /The proposal needs prose\./u);

    runJson(rootDir, ["decision", "amend", "dec_BODY_FILE", "--body-file", amendedBodyPath]);
    assert.match(decisionBody(readFileSync(proposedPath, "utf8")), /The amended decision is clearer\./u);
  });
});

test("CLI decision body inputs reject --body and --body-file together", () => {
  withTempRoot((rootDir) => {
    const bodyPath = path.join(rootDir, "body.md");
    writeFileSync(bodyPath, "File body", "utf8");

    const result = runJson(rootDir, [
      "decision", "propose",
      "--title", "Conflicting body inputs",
      "--question", "Should body inputs be mutually exclusive?",
      "--chosen", "Reject the conflict",
      "--rejected", "Guess which body wins",
      "--why-not", "Silent precedence loses authored prose",
      "--body", "Inline body",
      "--body-file", bodyPath
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "conflicting_decision_body_input");
    assert.match(result.error?.hint ?? "", /only one of --body or --body-file/u);
  });
});

test("CLI decision body input reports a missing --body-file clearly", () => {
  withTempRoot((rootDir) => {
    const missingPath = path.join(rootDir, "missing-body.md");
    const result = runJson(rootDir, ["decision", "amend", "dec_MISSING_BODY_FILE", "--body-file", missingPath], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "decision_body_file_read_failed");
    assert.match(result.error?.hint ?? "", /Could not read decision body file/u);
    assert.match(result.error?.hint ?? "", /missing-body\.md/u);
  });
});

test("CLI decision propose and accept warn when markdown prose is empty, without blocking transitions", () => {
  withTempRoot((rootDir) => {
    const proposal = runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_EMPTY_BODY",
      "--title", "Empty prose warning",
      "--question", "Should an empty decision body be visible?",
      "--chosen", "Warn without blocking",
      "--rejected", "Reject the write",
      "--why-not", "A hard gate encourages placeholder prose",
      "--evidence-relation", "C1:relates:task/task_01BODY:Evidence supports the claim."
    ]);

    assert.equal(proposal.ok, true);
    assert.equal(proposal.warnings?.some((warning: { code?: string }) => warning.code === "decision_body_empty"), true);

    const accepted = runJson(rootDir, ["decision", "accept", "dec_EMPTY_BODY"]);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.decisionState, "active");
    assert.equal(accepted.warnings?.some((warning: { code?: string }) => warning.code === "decision_body_empty"), true);
  });
});

test("CLI decision proposal and acceptance omit the empty-body warning when prose exists", () => {
  withTempRoot((rootDir) => {
    const proposal = runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_NONEMPTY_BODY",
      "--title", "Written prose",
      "--question", "Does written prose avoid the warning?",
      "--chosen", "Do not warn",
      "--rejected", "Warn anyway",
      "--why-not", "The narrative is already present",
      "--evidence-relation", "C1:relates:task/task_01BODY:Evidence supports the claim.",
      "--body", "## Background\n\nThe reader can see why this choice exists."
    ]);

    assert.equal(proposal.ok, true);
    assert.equal(proposal.warnings?.some((warning: { code?: string }) => warning.code === "decision_body_empty") ?? false, false);

    const accepted = runJson(rootDir, ["decision", "accept", "dec_NONEMPTY_BODY"]);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.warnings?.some((warning: { code?: string }) => warning.code === "decision_body_empty") ?? false, false);
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-body-cli-"));
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

function independentDecisionJudgmentArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  if (args[0] !== "decision" || !["accept", "reject", "defer", "supersede", "retire"].includes(args[1] ?? "")) return args;
  return ["--actor", "human:person_test", ...args];
}

function decisionBody(document: string): string {
  return document.replace(/^---\r?\n[\s\S]*?\r?\n---/u, "");
}
