// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { cliTestEnv } from "./helpers/cli-test-env.ts";
import { productionAuthorityHostServices } from "../src/composition/production-authority-host-services.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const bodyRemovalDecisionId = "dec_01KXVFNKCS75CB3YDM0QNMYZ00";
const longRunningDecisionIds = [
  "dec_01KXDS6G36ED47NZE410GEFY0V",
  "dec_01KXF661DNF187S0WZEE04KHF8"
] as const;

test("decision propose surfaces find body-only and union candidates without blocking dry-run or write", () => {
  withAdmissionFixture((rootDir) => {
    const dryRun = propose(rootDir, ["--surface=--body", "--surface", "long-running-task", "--dry-run"]);
    const admission = dryRun.report.decisionAdmission;

    assert.equal(dryRun.ok, true);
    assert.deepEqual(
      admission.candidates.map((candidate: Record<string, unknown>) => candidate.decisionId),
      [bodyRemovalDecisionId, ...longRunningDecisionIds]
    );
    assert.equal(
      admission.matches.find((match: Record<string, unknown>) => match.surface === "--body").candidates[0].decisionId,
      bodyRemovalDecisionId
    );
    assert.deepEqual(
      admission.matches
        .find((match: Record<string, unknown>) => match.surface === "long-running-task")
        .candidates.map((candidate: Record<string, unknown>) => candidate.decisionId),
      [...longRunningDecisionIds]
    );

    const written = propose(rootDir, ["--surface=--body"]);
    assert.equal(written.ok, true);
    assert.equal(
      written.warnings.some((warning: Record<string, unknown>) => warning.code === "decision_surface_candidates"),
      true
    );
  });
});

test("preset is reported as non-discriminative without dumping candidate details", () => {
  withAdmissionFixture((rootDir) => {
    const result = propose(rootDir, ["--surface", "preset", "--dry-run"]);
    const match = result.report.decisionAdmission.matches[0];
    const warning = result.warnings.find((entry: Record<string, unknown>) =>
      entry.code === "decision_surface_not_discriminative");

    assert.equal(result.ok, true);
    assert.equal(match.discriminative, false);
    assert.equal(match.matchCount > 20, true);
    assert.deepEqual(match.candidates, []);
    assert.deepEqual(result.report.decisionAdmission.candidates, []);
    assert.equal(warning.matchCount, match.matchCount);
    assert.deepEqual(warning.candidates, []);
  });
});

test("decision propose evaluates candidates before writing and excludes its own id", () => {
  withAdmissionFixture((rootDir) => {
    for (let index = 0; index < 20; index += 1) {
      writeDecision(rootDir, `dec_SELF_${String(index).padStart(2, "0")}`, `Self match ${index}`, "self-match-anchor");
    }
    const args = ["--id", "dec_SELF_NEW", "--surface", "self-match-anchor", "--body", "self-match-anchor"];
    const dryRun = propose(rootDir, [...args, "--dry-run"]);
    const written = propose(rootDir, args);

    assert.equal(dryRun.report.decisionAdmission.matches[0].matchCount, 20);
    assert.equal(written.report.decisionAdmission.matches[0].matchCount, 20);
    assert.equal(written.report.decisionAdmission.matches[0].discriminative, true);
    assert.equal(
      written.report.decisionAdmission.candidates.some((candidate: Record<string, unknown>) =>
        candidate.decisionId === "dec_SELF_NEW"),
      false
    );
  });
});

test("task create injects the same candidates into read_set without editing task-contract", () => {
  withAdmissionFixture((rootDir) => {
    const preview = runJson(rootDir, [
      "task", "create",
      "--title", "Retire long running surface",
      "--surface", "long-running-task",
      "--dry-run"
    ]);
    assert.deepEqual(preview.report.preview.summary.surfaces, {
      count: 1,
      items: ["long-running-task"]
    });
    assert.equal(preview.report.preview.summary.decisionAdmissionReadSet, "planned");
    assert.equal(
      preview.report.preview.paths.some((entry: Record<string, unknown>) => entry.path === "read_set.md"),
      true
    );

    const result = productionAuthorityHostServices.buildTaskCreateWrites({
      rootInput: rootDir,
      action: {
        kind: "new-task",
        taskId: "task_ADMISSION",
        title: "Retire long running surface",
        slug: "retire-long-running-surface",
        allowManualId: false,
        titleProvided: true,
        slugProvided: false,
        surfaces: ["long-running-task"],
        longRunning: false,
        dryRun: false
      },
      createdAt: "2026-07-29T00:00:00.000Z",
      provenance: {
        runtime: "codex",
        sessionId: "session-admission",
        boundAt: "2026-07-29T00:00:00.000Z"
      }
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const readSet = result.writes.find((write) => write.path === "read_set.md")?.body ?? "";
    const contractWrite = result.writes.find((write) => write.path === "task-contract.json");
    assert.ok(contractWrite);
    const contract = JSON.parse(contractWrite.body) as {
      readonly documents: ReadonlyArray<{ readonly materializeAs: string }>;
    };

    for (const decisionId of longRunningDecisionIds) assert.match(readSet, new RegExp(decisionId, "u"));
    assert.match(readSet, /search candidates, not machine judgments/u);
    assert.equal(contract.documents.some((document) => document.materializeAs === "read_set.md"), false);
  });
});

function propose(rootDir: string, tail: ReadonlyArray<string>): Record<string, any> {
  return runJson(rootDir, [
    "decision", "propose",
    "--title", "Admission probe",
    "--question", "Should the declared surface be checked?",
    "--chosen", "Show historical candidates",
    "--rejected", "Skip historical candidates",
    "--why-not", "The proposer needs prior context",
    ...tail
  ]);
}

function withAdmissionFixture<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-admission-"));
  ensureTestHarnessIdentity(rootDir);
  writeDecision(rootDir, bodyRemovalDecisionId, "Remove decision body flags", "The retired surface is `--body`.");
  writeDecision(rootDir, longRunningDecisionIds[0], "Retire long-running preset", "Remove `long-running-task`.");
  writeDecision(rootDir, longRunningDecisionIds[1], "Consolidate long-running preset", "The `long-running-task` surface overlaps.");
  for (let index = 0; index < 21; index += 1) {
    writeDecision(rootDir, `dec_NOISE_${String(index).padStart(2, "0")}`, `Preset noise ${index}`, "Broad topic fixture.");
  }
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeDecision(rootDir: string, decisionId: string, title: string, body: string): void {
  const decisionRoot = path.join(rootDir, "harness", "decisions", `decision-${decisionId}`);
  mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(path.join(decisionRoot, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    `_coordinatorWatermark: wm-${decisionId}`,
    `title: "${title}"`,
    "state: active",
    "riskTier: medium",
    "urgency: medium",
    "vertical: \"software/coding\"",
    "preset: \"architecture-decision\"",
    "applies_to:",
    "  modules: []",
    "  productLines: []",
    "proposedAt: \"2026-07-01T00:00:00.000Z\"",
    "provenance:",
    "  - { runtime: \"test\", sessionId: \"session-fixture\", boundAt: \"2026-07-01T00:00:00.000Z\" }",
    "question: \"Should this fixture exist?\"",
    "chosen:",
    "  - { id: \"CH1\", text: \"Keep the fixture deterministic\" }",
    "rejected:",
    "  - { id: \"RJ1\", text: \"Remove the fixture\", why_not: \"The admission test needs it\" }",
    "claims:",
    "  - { id: \"C1\", text: \"The fixture is searchable\" }",
    "relations:",
    "---",
    "",
    body,
    ""
  ].join("\n"), "utf8");
}

function runJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: cliTestEnv({
      HARNESS_ACTOR: "agent:decision-surface-admission-test",
      HARNESS_DAEMON_MODE: "fixture"
    })
  });
  return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
}
