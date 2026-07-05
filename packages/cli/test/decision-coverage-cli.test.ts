import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI decision propose writes multiple claims with derived ids from JSON input", () => {
  withTempRoot((rootDir) => {
    const payload = JSON.stringify({
      decisionId: "dec_MULTICLAIM",
      title: "Multi-claim decision",
      question: "Can a decision be born with multiple claims?",
      chosen: [{ text: "Create all claims at proposal time" }],
      rejected: [{ text: "Append later only", whyNot: "Birth-time claims should be explicit." }],
      claims: [
        { text: "First load-bearing claim." },
        { text: "Second exempt claim.", load_bearing: false }
      ],
      evidenceRelations: [
        { anchor: "C2", type: "relates", target: "task/task_01REL", rationale: "Relation can target an auto-numbered birth claim." }
      ]
    });

    const result = runJson(rootDir, ["decision", "propose", "--json-input", payload]);

    assert.equal(result.ok, true);
    const body = readFileSync(path.join(rootDir, "harness/decisions/decision-dec_MULTICLAIM/decision.md"), "utf8");
    assert.match(body, /claims:\n  - \{ id: "C1", text: "First load-bearing claim\." \}\n  - \{ id: "C2", text: "Second exempt claim\.", load_bearing: false \}/u);
    assert.match(body, /source: "decision\/dec_MULTICLAIM\/C2"/u);
  });
});

test("CLI decision accept blocks zero-evidence decisions without judgment-only", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_NOEVIDENCE",
      "--title", "Decision CLI",
      "--question", "Should CLI accept decisions without evidence?",
      "--chosen", "Accept via CLI",
      "--rejected", "Leave proposed",
      "--why-not", "The acceptance path needs a non-empty floor"
    ]);

    const result = runJson(rootDir, ["decision", "accept", "dec_NOEVIDENCE", "--arbiter", "human:ZeyuLi"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "decision_write_rejected");
    assert.match(result.error?.hint ?? "", /requires at least one evidence relation/u);
  });
});

test("CLI decision accept transitions an existing decision with evidence through the coordinator", () => {
  withTempRoot((rootDir) => {
    const task = runJson(rootDir, ["task", "create", "--title", "Evidence Task"]);
    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_ACCEPTCLI",
      "--title", "Decision CLI",
      "--question", "Should CLI accept decisions?",
      "--chosen", "Accept via CLI",
      "--rejected", "Leave proposed",
      "--why-not", "The acceptance path needs evidence",
      "--evidence-relation", `C1:relates:task/${task.taskId}:Task evidence establishes a non-empty acceptance floor`
    ]);

    const result = runJson(rootDir, ["decision", "accept", "dec_ACCEPTCLI", "--arbiter", "human:ZeyuLi"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "decision-accept");
    assert.equal(result.decisionState, "active");
    assert.match(readFileSync(path.join(rootDir, "harness/decisions/decision-dec_ACCEPTCLI/decision.md"), "utf8"), /^state: active$/mu);
  });
});

test("CLI decision accept records judgment-only rationale", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_JUDGMENTONLY",
      "--title", "Judgment-only Decision",
      "--question", "Can the arbiter accept without evidence?",
      "--chosen", "Accept as judgment-only",
      "--rejected", "Require evidence",
      "--why-not", "The arbiter explicitly records the escape hatch"
    ]);

    const result = runJson(rootDir, [
      "decision", "accept", "dec_JUDGMENTONLY",
      "--arbiter", "human:ZeyuLi",
      "--judgment-only", "Human arbiter accepts this policy bet before facts exist."
    ]);

    assert.equal(result.ok, true);
    const body = readFileSync(path.join(rootDir, "harness/decisions/decision-dec_JUDGMENTONLY/decision.md"), "utf8");
    assert.match(body, /## Judgment-only acceptance/u);
    assert.match(body, /Human arbiter accepts this policy bet before facts exist/u);
  });
});

test("CLI decision reckon fails closed on uncovered load-bearing claims", () => {
  withTempRoot((rootDir) => {
    const task = runJson(rootDir, ["task", "create", "--title", "Reckon Evidence"]);
    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_RECKON_FAIL",
      "--title", "Reckon Failure",
      "--question", "Should uncovered claims pass?",
      "--chosen", "Require coverage at reckon",
      "--rejected", "Let uncovered claims pass",
      "--why-not", "Reckon is the coverage gate",
      "--evidence-relation", `C1:relates:task/${task.taskId}:Task evidence only satisfies accept floor`
    ]);
    runJson(rootDir, ["decision", "accept", "dec_RECKON_FAIL", "--arbiter", "human:ZeyuLi"]);

    const result = runJson(rootDir, ["decision", "reckon", "dec_RECKON_FAIL", "--task", task.taskId], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "decision_reckon_uncovered");
    assert.deepEqual(result.report.uncoveredClaimRefs, ["decision/dec_RECKON_FAIL/C1"]);
  });
});

test("CLI decision reckon passes covered load-bearing claims and records a fact", () => {
  withTempRoot((rootDir) => {
    const task = runJson(rootDir, ["task", "create", "--title", "Reckon Covered"]);
    runJson(rootDir, [
      "fact", "record",
      "--task", task.taskId,
      "--id", "F-C0VERED1",
      "--statement", "The implementation covers the load-bearing claim.",
      "--source", "test",
      "--confidence", "high"
    ]);
    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_RECKON_PASS",
      "--title", "Reckon Pass",
      "--question", "Should covered claims pass?",
      "--chosen", "Pass only after coverage",
      "--rejected", "Ignore coverage",
      "--why-not", "Reckon is mechanical",
      "--evidence-relation", `C1:evidenced-by:fact/${task.taskId}/F-C0VERED1:Fact covers claim C1`
    ]);
    runJson(rootDir, ["decision", "accept", "dec_RECKON_PASS", "--arbiter", "human:ZeyuLi"]);

    const result = runJson(rootDir, ["decision", "reckon", "dec_RECKON_PASS", "--task", task.taskId]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "decision-reckon");
    assert.equal(result.report.status, "passed");
    const taskPackage = readdirSync(path.join(rootDir, "harness/tasks")).find((entry) => entry.startsWith(task.taskId));
    assert.ok(taskPackage);
    const facts = readFileSync(path.join(rootDir, "harness/tasks", taskPackage, "facts.md"), "utf8");
    assert.match(facts, /Decision dec_RECKON_PASS reckon passed/u);
    assert.match(facts, /load-bearing claims all covered/u);
  });
});

test("CLI decision reckon ignores non-load-bearing uncovered claims", () => {
  withTempRoot((rootDir) => {
    const task = runJson(rootDir, ["task", "create", "--title", "Reckon Non Load Bearing"]);
    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_RECKON_IGNORE",
      "--title", "Reckon Ignore",
      "--question", "Should non-load-bearing claims block?",
      "--chosen", "Ignore non-load-bearing claims",
      "--rejected", "Block every claim",
      "--why-not", "Only load-bearing claims are the reckon gate",
      "--non-load-bearing",
      "--evidence-relation", `C1:relates:task/${task.taskId}:Task evidence only satisfies accept floor`
    ]);
    runJson(rootDir, ["decision", "accept", "dec_RECKON_IGNORE", "--arbiter", "human:ZeyuLi"]);

    const result = runJson(rootDir, ["decision", "reckon", "dec_RECKON_IGNORE", "--task", task.taskId]);

    assert.equal(result.ok, true);
    assert.deepEqual(result.report.loadBearingClaimRefs, []);
    assert.deepEqual(result.report.uncoveredClaimRefs, []);
  });
});

test("CLI decision amend auto-numbers appended anchors through schema-declared amendable fields", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_M5_E74_DERIVE",
      "--title", "E74 derive fields",
      "--question", "Should amend fields be derived?",
      "--chosen", "Use field contracts",
      "--rejected", "Keep title-only amend",
      "--why-not", "Schema-declared rejected alternatives must be editable"
    ]);

    const amended = runJson(rootDir, [
      "decision", "amend", "dec_M5_E74_DERIVE",
      "--append", "rejected:{\"text\":\"Hand-update decision markdown\",\"why_not\":\"WriteCoordinator and schema field coverage must own the edit surface\"}"
    ]);

    assert.equal(amended.ok, true);
    assert.equal(amended.command, "decision-amend");
    const shown = runJson(rootDir, ["decision", "show", "E74"]);
    assert.equal(shown.ok, true);
    assert.deepEqual(shown.report.decision.rejected.map((entry: any) => entry.text), [
      "Keep title-only amend",
      "Hand-update decision markdown"
    ]);
    const body = readFileSync(path.join(rootDir, "harness/decisions/decision-dec_M5_E74_DERIVE/decision.md"), "utf8");
    assert.match(body, /id: "RJ2"/u);
  });
});

test("CLI decision amend updates only load_bearing metadata for an existing claim", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_CLAIM_MARKER",
      "--title", "Claim marker",
      "--question", "Can claim marker change?",
      "--chosen", "Allow marker edits",
      "--rejected", "Require content rewrite",
      "--why-not", "Load-bearing status is metadata."
    ]);

    runJson(rootDir, ["decision", "amend", "dec_CLAIM_MARKER", "--append", "claims:{\"text\":\"Optional explanatory claim\"}"]);
    let body = readFileSync(path.join(rootDir, "harness/decisions/decision-dec_CLAIM_MARKER/decision.md"), "utf8");
    assert.match(body, /id: "C2", text: "Optional explanatory claim"/u);

    runJson(rootDir, ["decision", "amend", "dec_CLAIM_MARKER", "--non-load-bearing", "C2"]);
    body = readFileSync(path.join(rootDir, "harness/decisions/decision-dec_CLAIM_MARKER/decision.md"), "utf8");
    assert.match(body, /id: "C2", text: "Optional explanatory claim", load_bearing: false/u);

    runJson(rootDir, ["decision", "amend", "dec_CLAIM_MARKER", "--load-bearing", "C2"]);
    body = readFileSync(path.join(rootDir, "harness/decisions/decision-dec_CLAIM_MARKER/decision.md"), "utf8");
    assert.match(body, /id: "C2", text: "Optional explanatory claim", load_bearing: true/u);
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-coverage-cli-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
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
