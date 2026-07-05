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
      "C1:supersedes-fact:fact/task_01REL/F-1234ABCD:Fact F-1234ABCD supersedes claim C1"
    ]);

    assert.equal(result.ok, true);
    const body = readFileSync(path.join(rootDir, "harness/decisions/decision-dec_RELCLI/decision.md"), "utf8");
    assert.match(body, /^relations:$/mu);
    assert.match(body, /  - \{ relation_id: "rel_[a-f0-9]{16}", source: "decision\/dec_RELCLI\/C1", target: "fact\/task_01REL\/F-1234ABCD", type: "supersedes-fact", strength: "strong", direction: "directed", origin: "declared", rationale: "Fact F-1234ABCD supersedes claim C1", state: "active" \}/u);
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
      "C1:supersedes-fact:fact/task_01REL/F-1234ABCD"
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "invalid_decision_evidence_relation");
    assert.equal(existsSync(path.join(rootDir, "harness/decisions")), false);
  });
});

test("CLI decision relate appends typed relation frontmatter through relation write surface", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, [
      "decision",
      "propose",
      "--id",
      "dec_OLDREL",
      "--title",
      "Old relation decision",
      "--question",
      "Should old relation storage stand?",
      "--chosen",
      "Keep old storage",
      "--rejected",
      "Replace it",
      "--why-not",
      "Fixture setup"
    ]);
    runJson(rootDir, [
      "decision",
      "propose",
      "--id",
      "dec_NEWREL",
      "--title",
      "New relation decision",
      "--question",
      "Should new relation storage supersede old?",
      "--chosen",
      "Use typed owner relations",
      "--rejected",
      "Keep old storage",
      "--why-not",
      "Owner-local relations have readers"
    ]);

    const result = runJson(rootDir, [
      "decision",
      "relate",
      "dec_NEWREL",
      "--anchor",
      "CH1",
      "--type",
      "supersedes",
      "--target",
      "decision/dec_OLDREL",
      "--rationale",
      "New relation decision supersedes old storage"
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "decision-relate");
    const body = readFileSync(path.join(rootDir, "harness/decisions/decision-dec_NEWREL/decision.md"), "utf8");
    assert.match(body, /  - \{ relation_id: "rel_[a-f0-9]{16}", source: "decision\/dec_NEWREL\/CH1", target: "decision\/dec_OLDREL", type: "supersedes", strength: "strong", direction: "directed", origin: "declared", rationale: "New relation decision supersedes old storage", state: "active" \}/u);
  });
});

test("CLI decision relation retire and replace rewrite hosted relation frontmatter", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, [
      "decision",
      "propose",
      "--id",
      "dec_RELHOST",
      "--title",
      "Hosted relation decision",
      "--question",
      "Should hosted relation ops rewrite frontmatter?",
      "--chosen",
      "Rewrite hosted relation frontmatter",
      "--rejected",
      "Create relation documents",
      "--why-not",
      "Relations are hosted in source frontmatter"
    ]);
    runJson(rootDir, [
      "decision",
      "propose",
      "--id",
      "dec_TARGET_A",
      "--title",
      "Target A",
      "--question",
      "Target A?",
      "--chosen",
      "A",
      "--rejected",
      "Not A",
      "--why-not",
      "Fixture"
    ]);
    runJson(rootDir, [
      "decision",
      "propose",
      "--id",
      "dec_TARGET_B",
      "--title",
      "Target B",
      "--question",
      "Target B?",
      "--chosen",
      "B",
      "--rejected",
      "Not B",
      "--why-not",
      "Fixture"
    ]);
    runJson(rootDir, [
      "decision",
      "relate",
      "dec_RELHOST",
      "--anchor",
      "CH1",
      "--type",
      "relates",
      "--target",
      "decision/dec_TARGET_A",
      "--rationale",
      "Initial relation"
    ]);
    const decisionPath = path.join(rootDir, "harness/decisions/decision-dec_RELHOST/decision.md");
    const relationId = /relation_id: "(rel_[a-f0-9]{16})"/u.exec(readFileSync(decisionPath, "utf8"))?.[1];
    assert.ok(relationId);

    const replaced = runJson(rootDir, [
      "decision",
      "relation",
      "replace",
      "dec_RELHOST",
      "--relation",
      relationId,
      "--anchor",
      "CH1",
      "--type",
      "relates",
      "--target",
      "decision/dec_TARGET_B",
      "--rationale",
      "Replacement relation"
    ]);
    assert.equal(replaced.ok, true);
    assert.equal(replaced.command, "decision-relation-replace");
    const replacedBody = readFileSync(decisionPath, "utf8");
    assert.match(replacedBody, new RegExp(`relation_id: "${relationId}".*state: "retired"`, "su"));
    assert.match(replacedBody, /target: "decision\/dec_TARGET_B"/u);
    const relationIds = [...replacedBody.matchAll(/relation_id: "(rel_[a-f0-9]{16})"/gu)].map((match) => match[1]);
    const replacementRelationId = relationIds.find((id) => id !== relationId);
    assert.ok(replacementRelationId);

    const retired = runJson(rootDir, ["decision", "relation", "retire", "dec_RELHOST", "--relation", replacementRelationId]);
    assert.equal(retired.ok, true);
    assert.equal(retired.command, "decision-relation-retire");
  });
});

test("CLI decision relate invalid type error enumerates valid relation types", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, [
      "decision",
      "relate",
      "dec_NEWREL",
      "--anchor",
      "CH1",
      "--type",
      "overrides",
      "--target",
      "decision/dec_OLDREL",
      "--rationale",
      "Fixture invalid type"
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "invalid_decision_evidence_relation");
    assert.match(result.error?.hint ?? "", /Valid relation types: supports, supersedes, refines, narrows/u);
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

test("CLI decision list filters projected rows by state and module", () => {
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
      "Manual-only decisions are not queryable",
      "--module",
      "m5-circulation"
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
      "Cold-start reading cost would regress",
      "--module",
      "other-module"
    ]);
    runJson(rootDir, ["decision", "accept", "dec_M5_E72_SELFHOST", "--arbiter", "human:ZeyuLi"]);

    const result = runJson(rootDir, ["decision", "list", "--state", "active", "--module", "m5-circulation"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "decision-list");
    assert.equal(result.rows, 1);
    assert.deepEqual(result.report.filters, { state: "active", module: "m5-circulation" });
    assert.deepEqual(result.report.decisions.map((entry: any) => entry.legacyId), ["E72"]);
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

test("CLI decision amend appends rejected entries through schema-declared amendable fields", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, [
      "decision",
      "propose",
      "--id",
      "dec_M5_E74_DERIVE",
      "--title",
      "E74 derive fields",
      "--question",
      "Should amend fields be derived?",
      "--chosen",
      "Use field contracts",
      "--rejected",
      "Keep title-only amend",
      "--why-not",
      "Schema-declared rejected alternatives must be editable"
    ]);

    const amended = runJson(rootDir, [
      "decision",
      "amend",
      "dec_M5_E74_DERIVE",
      "--append",
      "rejected:{\"id\":\"RJ2\",\"text\":\"Hand-update decision markdown\",\"why_not\":\"WriteCoordinator and schema field coverage must own the edit surface\"}"
    ]);
    assert.equal(amended.ok, true);
    assert.equal(amended.command, "decision-amend");

    const shown = runJson(rootDir, ["decision", "show", "E74"]);
    assert.equal(shown.ok, true);
    assert.deepEqual(shown.report.decision.rejected.map((entry: any) => entry.text), [
      "Keep title-only amend",
      "Hand-update decision markdown"
    ]);
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
