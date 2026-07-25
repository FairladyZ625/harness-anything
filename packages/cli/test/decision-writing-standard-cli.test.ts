// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cliTestEnv } from "./helpers/cli-test-env.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI decision propose rejects each overlong chosen entry with corrective guidance", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_CHOSEN_TOO_LONG",
      "--title", "Chosen writing guard",
      "--question", "Should every chosen entry stay independently readable?",
      "--chosen", "Keep the first judgment readable.",
      "--chosen", "x".repeat(121),
      "--rejected", "Allow paragraphs in chosen",
      "--why-not", "The arbiter cannot identify the judgment"
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "decision_chosen_too_long");
    assert.match(result.error.hint, /chosen CH2 is 121 characters/u);
    assert.match(result.error.hint, /split parallel judgments into separate --chosen entries/u);
    assert.match(result.error.hint, /reasoning and tradeoffs to --body or --body-file/u);
    assert.match(result.error.hint, /implementation requirements to a task/u);
    assert.match(result.error.hint, /harness\/standards\/decision-writing\.md/u);
    assert.match(result.error.hint, /run ha init to materialize it/u);
    assert.equal(existsSync(path.join(rootDir, "harness/decisions/decision-dec_CHOSEN_TOO_LONG/decision.md")), false);
  });
});

test("CLI decision propose accepts the rewritten readable chosen example", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_READABLE_CHOSEN",
      "--title", "Readable chosen",
      "--question", "Should the generic-only guard remain?",
      "--chosen", "守卫那条「必须是 generic」是重构没做完的残留,应当去掉;把关交给紧随其后的内容比对检查(它已包含通道适配器)。",
      "--rejected", "Keep the generic-only guard",
      "--why-not", "The body explains why the content comparison is sufficient"
    ]);

    assert.equal(result.ok, true);
  });
});

test("CLI decision propose help teaches the chosen writing standard", () => {
  withTempRoot((rootDir) => {
    const stdout = execFileSync(process.execPath, [
      cliEntry, "--root", rootDir, "decision", "propose", "--help"
    ], {
      encoding: "utf8",
      env: cliTestEnv()
    });

    assert.match(stdout, /maximum 120 characters/u);
    assert.match(stdout, /repeat to split parallel judgments/u);
    assert.match(stdout, /Put reasons in the body and implementation in tasks/u);
    assert.match(stdout, /harness\/standards\/decision-writing\.md/u);
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-writing-"));
  ensureTestHarnessIdentity(rootDir);
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(
  rootDir: string,
  args: ReadonlyArray<string>,
  expectSuccess = true
): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: cliTestEnv({ HARNESS_ACTOR: "agent:test" })
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}
