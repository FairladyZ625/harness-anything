import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI decision propose writes a decision package through the coordinator", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, [
      "decision",
      "propose",
      "--id",
      "dec_TESTCLI",
      "--title",
      "Decision CLI",
      "--question",
      "Should CLI write decisions?",
      "--chosen",
      "Use decision CLI",
      "--rejected",
      "Write markdown by hand",
      "--why-not",
      "Coordinator watermark is required",
      "--module",
      "cli"
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "decision-propose");
    assert.equal(result.decisionId, "dec_TESTCLI");
    assert.equal(result.decisionState, "proposed");
    const body = readFileSync(path.join(rootDir, "harness/decisions/decision-dec_TESTCLI/decision.md"), "utf8");
    assert.match(body, /schema: decision-package\/v1/);
    assert.match(body, /decision_id: dec_TESTCLI/);
    assert.match(body, /_coordinatorWatermark: /);
    assert.match(body, /runtime: "human"/);
    assert.match(body, /sessionId: "human-cli-\d+"/);
    assert.match(body, /boundAt: "/);
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8"), /write-watermark\/v1/);
  });
});

test("CLI decision propose rejects missing rejected alternative", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, [
      "decision",
      "propose",
      "--title",
      "Decision CLI",
      "--question",
      "Question",
      "--chosen",
      "Chosen"
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "missing_decision_rejected");
    assert.equal(existsSync(path.join(rootDir, "harness/decisions")), false);
  });
});

test("CLI decision accept transitions an existing decision through the coordinator", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, [
      "decision",
      "propose",
      "--id",
      "dec_ACCEPTCLI",
      "--title",
      "Decision CLI",
      "--question",
      "Should CLI accept decisions?",
      "--chosen",
      "Accept via CLI",
      "--rejected",
      "Leave proposed",
      "--why-not",
      "The acceptance path needs coverage"
    ]);

    const result = runJson(rootDir, ["decision", "accept", "dec_ACCEPTCLI", "--arbiter", "human:ZeyuLi"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "decision-accept");
    assert.equal(result.decisionState, "active");
    assert.match(readFileSync(path.join(rootDir, "harness/decisions/decision-dec_ACCEPTCLI/decision.md"), "utf8"), /^state: active$/mu);
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-cli-"));
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
