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
    const sessionId = /sessionId: "(human-cli-\d+)"/u.exec(body)?.[1];
    assert.ok(sessionId);
    assert.equal(existsSync(path.join(rootDir, "harness", "sessions", `${sessionId}.md`)), true);
    assert.match(readFileSync(path.join(rootDir, "harness", "sessions", `${sessionId}.md`), "utf8"), /^runtime: human$/mu);
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8"), /write-watermark\/v1/);
  });
});

test("CLI decision propose writes typed evidence relation frontmatter", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, [
      "decision",
      "propose",
      "--id",
      "dec_RELCLI",
      "--title",
      "Decision CLI relations",
      "--question",
      "Should propose write evidence relations?",
      "--chosen",
      "Write typed relations",
      "--rejected",
      "Leave relations out",
      "--why-not",
      "Coverage requires relation graph edges",
      "--evidence-relation",
      "C1:supports:fact/task_01REL/F-1234ABCD:Fact F-1234ABCD supports claim C1"
    ]);

    assert.equal(result.ok, true);
    const body = readFileSync(path.join(rootDir, "harness/decisions/decision-dec_RELCLI/decision.md"), "utf8");
    assert.match(body, /^relations:$/mu);
    assert.match(body, /  - \{ relation_id: "rel_[a-f0-9]{16}", source: "decision\/dec_RELCLI\/C1", target: "fact\/task_01REL\/F-1234ABCD", type: "supports", strength: "strong", direction: "directed", origin: "declared", rationale: "Fact F-1234ABCD supports claim C1", state: "active" \}/u);
  });
});

test("CLI decision propose rejects strong evidence relation missing rationale", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, [
      "decision",
      "propose",
      "--id",
      "dec_BADREL",
      "--title",
      "Decision CLI relations",
      "--question",
      "Should propose reject weak evidence descriptors?",
      "--chosen",
      "Reject malformed relations",
      "--rejected",
      "Write malformed relations",
      "--why-not",
      "Relations need rationale",
      "--evidence-relation",
      "C1:supports:fact/task_01REL/F-1234ABCD"
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "invalid_decision_evidence_relation");
    assert.equal(existsSync(path.join(rootDir, "harness/decisions")), false);
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

test("CLI decision list returns question chosen rejected summaries", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, [
      "decision",
      "propose",
      "--id",
      "dec_M5_E72_SELFHOST",
      "--title",
      "E72 Self-hosting",
      "--question",
      "Should M5 self-host decisions?",
      "--chosen",
      "Use kernel decisions",
      "--rejected",
      "Keep only the manual ledger",
      "--why-not",
      "Manual-only decisions are not queryable"
    ]);
    runJson(rootDir, [
      "decision",
      "propose",
      "--id",
      "dec_M5_E73_QUERY",
      "--title",
      "E73 Query",
      "--question",
      "Should agents query decisions in one command?",
      "--chosen",
      "Expose decision list",
      "--rejected",
      "Read every decision file manually",
      "--why-not",
      "Cold-start reading cost would regress"
    ]);

    const result = runJson(rootDir, ["decision", "list", "--legacy-range", "E1-E72", "--compact"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "decision-list");
    assert.equal(result.rows, 1);
    assert.deepEqual(result.report.filters.legacyRange, "E1-E72");
    assert.deepEqual(result.report.filters.compact, true);
    assert.deepEqual(result.report.decisions.map((entry: any) => entry.legacyId), ["E72"]);
    assert.deepEqual(result.report.decisions[0].chosen, ["Use kernel decisions"]);
    assert.deepEqual(result.report.decisions[0].rejected, ["Keep only the manual ledger"]);
    assert.equal("path" in result.report.decisions[0], false);
  });
});

test("CLI decision show finds a decision by legacy E number", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, [
      "decision",
      "propose",
      "--id",
      "dec_M5_E72_SELFHOST",
      "--title",
      "E72 Self-hosting",
      "--question",
      "Should M5 self-host decisions?",
      "--chosen",
      "Use kernel decisions",
      "--rejected",
      "Keep only the manual ledger",
      "--why-not",
      "Manual-only decisions are not queryable"
    ]);

    const result = runJson(rootDir, ["decision", "show", "E72"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "decision-show");
    assert.equal(result.decisionId, "dec_M5_E72_SELFHOST");
    assert.equal(result.path, "harness/decisions/decision-dec_M5_E72_SELFHOST/decision.md");
    assert.equal(result.report.decision.question, "Should M5 self-host decisions?");
    assert.deepEqual(result.report.decision.chosen, ["Use kernel decisions"]);
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
