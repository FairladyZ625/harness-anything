import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.match(result.error?.hint ?? "", /claim anchor/u);
    assert.match(result.error?.hint ?? "", /--anchor C1/u);
    assert.match(result.error?.hint ?? "", /CH1/u);
  });
});

test("CLI decision accept dry-run enforces the same evidence floor as real accept", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_DRYRUN_FLOOR",
      "--title", "Dry-run floor",
      "--question", "Should dry-run enforce accept evidence?",
      "--chosen", "Reject dry-run drift",
      "--rejected", "Let dry-run pass",
      "--why-not", "Dry-run must match real writes"
    ]);

    const result = runJson(rootDir, ["decision", "accept", "dec_DRYRUN_FLOOR", "--dry-run"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "decision_write_rejected");
    assert.match(result.error?.hint ?? "", /--anchor C1/u);
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

test("CLI decision amend appends a chosen anchor that can satisfy accept evidence", () => {
  withTempRoot((rootDir) => {
    const task = runJson(rootDir, ["task", "create", "--title", "Amended Choice Evidence"]);
    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_AMEND_CHOSEN_EVIDENCE",
      "--title", "Amended chosen evidence",
      "--question", "Can appended chosen anchors carry acceptance evidence?",
      "--chosen", "Initial choice",
      "--rejected", "No amendment",
      "--why-not", "Fixture"
    ]);
    const amended = runJson(rootDir, [
      "decision", "amend", "dec_AMEND_CHOSEN_EVIDENCE",
      "--append", "chosen:{\"id\":\"CH2\",\"text\":\"Amended choice\"}"
    ]);
    assert.equal(amended.ok, true);
    runJson(rootDir, [
      "decision", "relate", "dec_AMEND_CHOSEN_EVIDENCE",
      "--anchor", "CH2",
      "--type", "relates",
      "--target", `task/${task.taskId}`,
      "--rationale", "Amended chosen anchor carries the acceptance evidence"
    ]);

    const result = runJson(rootDir, ["decision", "accept", "dec_AMEND_CHOSEN_EVIDENCE", "--arbiter", "human:ZeyuLi"]);

    assert.equal(result.ok, true);
    const body = readFileSync(path.join(rootDir, "harness/decisions/decision-dec_AMEND_CHOSEN_EVIDENCE/decision.md"), "utf8");
    assert.match(body, /claims:[\s\S]*\{ id: "CH2", text: "Amended choice" \}/u);
    assert.match(body, /^state: active$/mu);
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

test("CLI decision judgment-only accept appends without changing existing body bytes", () => {
  withTempRoot((rootDir) => {
    const originalBody = "Original rationale.\n\n## Evidence\n\nLine two.\n";
    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_JUDGMENT_BODY_PRESERVE",
      "--title", "Judgment body preservation",
      "--question", "Does judgment-only acceptance preserve the existing body?",
      "--chosen", "Preserve then append",
      "--rejected", "Replace the body",
      "--why-not", "The existing rationale is an auditable asset",
      "--body", originalBody
    ]);
    const decisionPath = path.join(rootDir, "harness/decisions/decision-dec_JUDGMENT_BODY_PRESERVE/decision.md");
    const before = decisionBody(readFileSync(decisionPath, "utf8"));

    const result = runJson(rootDir, [
      "decision", "accept", "dec_JUDGMENT_BODY_PRESERVE",
      "--arbiter", "human:ZeyuLi",
      "--judgment-only", "The human arbiter accepts this policy choice."
    ]);

    assert.equal(result.ok, true);
    const after = decisionBody(readFileSync(decisionPath, "utf8"));
    assert.equal(after.slice(0, before.length), before);
    assert.match(after.slice(before.length), /## Judgment-only acceptance\n\nThe human arbiter accepts this policy choice\./u);
  });
});

test("CLI decision amend append leaves the existing body byte-for-byte unchanged", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_AMEND_BODY_PRESERVE",
      "--title", "Amend body preservation",
      "--question", "Does structured append preserve the body?",
      "--chosen", "Preserve the body",
      "--rejected", "Rebuild the body",
      "--why-not", "Structured amendments do not own prose",
      "--body", "Original rationale.\n\nSecond paragraph."
    ]);
    const decisionPath = path.join(rootDir, "harness/decisions/decision-dec_AMEND_BODY_PRESERVE/decision.md");
    const before = decisionBody(readFileSync(decisionPath, "utf8"));

    const result = runJson(rootDir, [
      "decision", "amend", "dec_AMEND_BODY_PRESERVE",
      "--append", "claims:{\"text\":\"A newly structured claim\"}"
    ]);

    assert.equal(result.ok, true);
    const after = decisionBody(readFileSync(decisionPath, "utf8"));
    assert.equal(after, before);
  });
});

test("CLI decision amend explicit body still replaces the existing body", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_EXPLICIT_BODY_REPLACE",
      "--title", "Explicit body replacement",
      "--question", "Can an explicit body replace existing prose?",
      "--chosen", "Allow explicit replacement",
      "--rejected", "Forbid all replacement",
      "--why-not", "The body flag is the deliberate replacement surface",
      "--body", "Old body that should be replaced."
    ]);

    const result = runJson(rootDir, [
      "decision", "amend", "dec_EXPLICIT_BODY_REPLACE",
      "--body", "New body supplied explicitly."
    ]);

    assert.equal(result.ok, true);
    const body = decisionBody(readFileSync(path.join(rootDir, "harness/decisions/decision-dec_EXPLICIT_BODY_REPLACE/decision.md"), "utf8"));
    assert.match(body, /New body supplied explicitly\./u);
    assert.doesNotMatch(body, /Old body that should be replaced\./u);
  });
});

test("CLI decision accept rejects a flag-like judgment-only rationale without changing the file", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_FLAG_RATIONALE",
      "--title", "Flag rationale validation",
      "--question", "Should flag-like rationale tokens be rejected?",
      "--chosen", "Reject flag-like rationale",
      "--rejected", "Store the token literally",
      "--why-not", "A mistyped option is not a judgment rationale",
      "--body", "Body must survive a rejected command."
    ]);
    const decisionPath = path.join(rootDir, "harness/decisions/decision-dec_FLAG_RATIONALE/decision.md");
    const before = readFileSync(decisionPath, "utf8");

    const result = runJson(rootDir, [
      "decision", "accept", "dec_FLAG_RATIONALE",
      "--arbiter", "human:ZeyuLi",
      "--judgment-only", "--note"
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "missing_reason");
    assert.equal(readFileSync(decisionPath, "utf8"), before);
  });
});

test("CLI decision accept rejects a whitespace-prefixed flag-like rationale", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_SPACED_FLAG_RATIONALE",
      "--title", "Spaced flag rationale validation",
      "--question", "Should a trimmed flag-like rationale be rejected?",
      "--chosen", "Reject after trimming",
      "--rejected", "Store the trimmed token",
      "--why-not", "Whitespace cannot turn an option into rationale",
      "--body", "Body must survive a rejected command."
    ]);
    const decisionPath = path.join(rootDir, "harness/decisions/decision-dec_SPACED_FLAG_RATIONALE/decision.md");
    const before = readFileSync(decisionPath, "utf8");

    const result = runJson(rootDir, [
      "decision", "accept", "dec_SPACED_FLAG_RATIONALE",
      "--arbiter", "human:ZeyuLi",
      "--judgment-only", "  --note"
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "missing_reason");
    assert.equal(readFileSync(decisionPath, "utf8"), before);
  });
});

test("CLI repeated judgment-only accept keeps a single existing judgment section", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_REPEAT_JUDGMENT",
      "--title", "Repeated judgment acceptance",
      "--question", "Should repeated acceptance duplicate the judgment section?",
      "--chosen", "Keep one section",
      "--rejected", "Append duplicate headings",
      "--why-not", "Repeated lifecycle writes must be body-idempotent",
      "--body", "Original rationale."
    ]);
    const decisionPath = path.join(rootDir, "harness/decisions/decision-dec_REPEAT_JUDGMENT/decision.md");
    runJson(rootDir, [
      "decision", "accept", "dec_REPEAT_JUDGMENT",
      "--arbiter", "human:ZeyuLi",
      "--judgment-only", "Initial judgment rationale."
    ]);
    const afterFirstAccept = decisionBody(readFileSync(decisionPath, "utf8"));

    const repeated = runJson(rootDir, [
      "decision", "accept", "dec_REPEAT_JUDGMENT",
      "--arbiter", "human:ZeyuLi",
      "--judgment-only", "A later accept supplies different words."
    ]);

    assert.equal(repeated.ok, true);
    const afterRepeatedAccept = decisionBody(readFileSync(decisionPath, "utf8"));
    assert.equal(afterRepeatedAccept, afterFirstAccept);
    assert.equal(afterRepeatedAccept.split("## Judgment-only acceptance").length - 1, 1);
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

test("CLI decision conformance exempts pre-rule legacy task and claim findings", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    writeConformanceDecisionFixture(rootDir, "dec_PRE_RULE_CUTOFF", "2026-07-06T23:21:56.223Z");
    writeConformanceDecisionFixture(rootDir, "dec_LEDGER_E123_CUTOFF");

    const result = runJson(rootDir, ["check", "--profile", "source-package"]);
    const findings = decisionConformanceFindings(result);

    assert.equal(findings.length, 0);
  });
});

test("CLI decision conformance still reports post-rule task and claim findings", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    writeConformanceDecisionFixture(rootDir, "dec_POST_RULE_CUTOFF", "2026-07-06T23:21:56.225Z");

    const result = runJson(rootDir, ["check", "--profile", "source-package"], false);

    assert.equal(hasDecisionConformanceFinding(
      result,
      "accepted-decision-missing-task-or-defer",
      "decision/dec_POST_RULE_CUTOFF"
    ), true);
    assert.equal(hasDecisionConformanceFinding(
      result,
      "decision-claim-uncovered",
      "decision/dec_POST_RULE_CUTOFF/C1"
    ), true);
  });
});

test("CLI decision conformance applies task and claim findings at the cutoff boundary", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    writeConformanceDecisionFixture(rootDir, "dec_RULE_BOUNDARY", "2026-07-06T23:21:56.224Z");

    const result = runJson(rootDir, ["check", "--profile", "source-package"], false);

    assert.equal(hasDecisionConformanceFinding(
      result,
      "accepted-decision-missing-task-or-defer",
      "decision/dec_RULE_BOUNDARY"
    ), true);
    assert.equal(hasDecisionConformanceFinding(
      result,
      "decision-claim-uncovered",
      "decision/dec_RULE_BOUNDARY/C1"
    ), true);
  });
});

function decisionConformanceFindings(result: Record<string, any>): ReadonlyArray<Record<string, any>> {
  const entry = result.report.scriptChecks.find((scriptCheck: Record<string, any>) => (
    scriptCheck.scriptId === "vertical:software-coding:decision-conformance"
  ));
  assert.ok(entry);
  return entry.report.findings;
}

function hasDecisionConformanceFinding(result: Record<string, any>, type: string, ref: string): boolean {
  return decisionConformanceFindings(result).some((finding: Record<string, any>) => (
    finding.type === type && finding.ref === ref
  ));
}

function writeConformanceDecisionFixture(rootDir: string, decisionId: string, decidedAt?: string): void {
  writeFile(rootDir, `harness/decisions/decision-${decisionId}/decision.md`, [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    `_coordinatorWatermark: wm-${decisionId}`,
    `title: "${decisionId} conformance fixture"`,
    "state: active",
    "riskTier: medium",
    "urgency: medium",
    "vertical: \"software/coding\"",
    "preset: \"architecture-decision\"",
    "applies_to:",
    "  modules: []",
    "  productLines: []",
    "proposedBy: { kind: \"agent\", id: \"test\" }",
    "proposedAt: \"2026-07-06T23:21:56.000Z\"",
    "arbiter: { kind: \"human\", id: \"zeyuli\" }",
    ...(decidedAt ? [`decidedAt: "${decidedAt}"`] : []),
    "provenance:",
    "  - { runtime: \"test\", sessionId: \"session-fixture\", boundAt: \"2026-07-06T23:21:56.000Z\" }",
    "question: \"Should conformance fixture decisions derive work?\"",
    "chosen:",
    "  - { id: \"CH1\", text: \"Require work derivation\" }",
    "rejected:",
    "  - { id: \"RJ1\", text: \"Leave decision open\", why_not: \"The checker needs a deterministic fixture\" }",
    "claims:",
    "  - { id: \"C1\", text: \"The fixture claim needs live fact coverage\" }",
    "relations: []",
    "---",
    `# ${decisionId} conformance fixture`,
    ""
  ].join("\n"));
}

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

function decisionBody(document: string): string {
  return document.replace(/^---\r?\n[\s\S]*?\r?\n---/u, "");
}

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const target = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}
