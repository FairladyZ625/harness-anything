// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveRelationId, formatRelationFlowRecord, parseFactFlowRecords, type EntityRelationRecord } from "../../kernel/src/index.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("fact-execution migration classifies three signals, requires plan confirmation, and archives without deleting Facts", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "AGENTS.md", "# Agent Context\n");
    writeFile(rootDir, "CLAUDE.md", "# Claude Context\n");
    runJson(rootDir, ["init"]);
    const created = runJson(rootDir, ["new-task", "--title", "Historical Delivery"]);
    const taskPath = String(created.packagePath);
    const indexPath = path.join(rootDir, taskPath, "INDEX.md");
    const taskId = readFileSync(indexPath, "utf8").match(/^task_id:\s*(\S+)/mu)?.[1];
    assert.ok(taskId);
    writeFileSync(indexPath, readFileSync(indexPath, "utf8").replace(/^  status:\s*planned$/mu, "  status: done"), "utf8");

    writeFile(rootDir, `${taskPath}/facts.md`, factsBody());
    writeDecisionEvidence(rootDir, taskId);

    const dryRun = runJson(rootDir, ["migrate", "fact-execution", "--dry-run", "--batch-size", "10"]);
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.migrationMode, "plan");
    assert.deepEqual(dryRun.report.summary, {
      scannedFacts: 5,
      referencedFacts: 1,
      orphanFacts: 4,
      episodicOrphans: 2,
      deliveryWordingOrphans: 2,
      automaticIntersection: 1,
      automaticReady: 1,
      automaticSkipped: 0,
      manualDifference: 2,
      bearingObservations: 1,
      alreadyMigrated: 0,
      selectedInBatch: 1,
      readyInBatch: 1,
      skippedInBatch: 0,
      appliedFacts: 0,
      appliedTasks: 0
    });
    assert.deepEqual(dryRun.report.manualConfirmation.map((row: Record<string, string>) => row.factRef), [
      `fact/${taskId}/F-EP1S0D1C`,
      `fact/${taskId}/F-W0RD1NG0`
    ]);
    assert.equal(dryRun.report.samples.bearingObservations[0].factRef, `fact/${taskId}/F-BEAR1NG0`);

    const unconfirmed = runJson(rootDir, ["migrate", "fact-execution", "--apply"], false);
    assert.equal(unconfirmed.ok, false);
    assert.equal(unconfirmed.error.code, "plan_confirmation_required");
    assert.equal(parseFactFlowRecords(readFileSync(path.join(rootDir, taskPath, "facts.md"), "utf8")).some((fact) => fact.migration), false);

    const applied = runJson(rootDir, [
      "migrate", "fact-execution", "--apply", "--confirm-plan", String(dryRun.report.planId), "--batch-size", "10"
    ]);
    assert.equal(applied.report.summary.appliedFacts, 1);
    assert.equal(applied.report.summary.appliedTasks, 1);
    const facts = parseFactFlowRecords(readFileSync(path.join(rootDir, taskPath, "facts.md"), "utf8"));
    const migrated = facts.find((fact) => fact.fact_id === "F-A0T0MAT1");
    assert.equal(migrated?.migration?.state, "migrated");
    assert.equal(facts.length, 5);
    const executionPath = path.join(rootDir, taskPath, "executions", `${migrated?.migration?.execution_ref.split("/").at(-1)}.md`);
    const execution = JSON.parse(readFileSync(executionPath, "utf8")) as Record<string, any>;
    assert.equal(execution.state, "accepted");
    assert.equal(execution.outputs.length, 1);
    assert.equal(execution.outputs[0].locator.text, "PR #123 merged; CI and npm run check passed.");

    const repeated = runJson(rootDir, [
      "migrate", "fact-execution", "--apply", "--confirm-plan", String(dryRun.report.planId), "--batch-size", "10"
    ]);
    assert.equal(repeated.report.summary.appliedFacts, 0);
    assert.equal((JSON.parse(readFileSync(executionPath, "utf8")) as Record<string, any>).outputs.length, 1);
  });
});

test("fact-execution manual list migrates an explicitly confirmed Fact through the shared archival path", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "AGENTS.md", "# Agent Context\n");
    writeFile(rootDir, "CLAUDE.md", "# Claude Context\n");
    runJson(rootDir, ["init"]);
    const created = runJson(rootDir, ["new-task", "--title", "Manual Historical Delivery"]);
    const taskPath = String(created.packagePath);
    const indexPath = path.join(rootDir, taskPath, "INDEX.md");
    const taskId = readFileSync(indexPath, "utf8").match(/^task_id:\s*(\S+)/mu)?.[1];
    assert.ok(taskId);
    writeFileSync(indexPath, readFileSync(indexPath, "utf8").replace(/^  status:\s*planned$/mu, "  status: done"), "utf8");
    writeFile(rootDir, `${taskPath}/facts.md`, [
      "# Facts",
      "",
      fact("F-MAN0A1YX", "The operator completed the historical handoff.", "semantic"),
      ""
    ].join("\n"));
    writeFile(rootDir, "artifacts/manual-facts.txt", `# CEO-confirmed delivery facts\nfact/${taskId}/F-MAN0A1YX\n`);

    const dryRun = runJson(rootDir, [
      "migrate", "fact-execution", "--dry-run", "--apply-manual", "artifacts/manual-facts.txt"
    ]);
    assert.equal(dryRun.report.selectionMode, "manual-list");
    assert.equal(dryRun.report.summary.manualRequested, 1);
    assert.equal(dryRun.report.summary.manualReady, 1, JSON.stringify(dryRun.report));
    assert.equal(dryRun.report.summary.manualSkipped, 0);

    const applied = runJson(rootDir, [
      "migrate", "fact-execution", "--apply", "--apply-manual", "artifacts/manual-facts.txt",
      "--confirm-plan", String(dryRun.report.planId)
    ]);
    assert.equal(applied.report.summary.appliedFacts, 1);
    const migrated = parseFactFlowRecords(readFileSync(path.join(rootDir, taskPath, "facts.md"), "utf8"))[0];
    assert.equal(migrated?.migration?.schema, "fact-migration/v1");
    assert.equal(migrated?.migration?.state, "migrated");
    const executionId = migrated?.migration?.execution_ref.split("/").at(-1);
    assert.ok(executionId);
    const execution = JSON.parse(readFileSync(path.join(rootDir, taskPath, "executions", `${executionId}.md`), "utf8")) as Record<string, any>;
    assert.equal(execution.outputs[0].locator.text, "The operator completed the historical handoff.");
    assert.equal(execution.outputs[0].evidence_id, migrated?.migration?.evidence_id);
  });
});

function factsBody(): string {
  return [
    "# Facts",
    "",
    fact("F-A0T0MAT1", "PR #123 merged; CI and npm run check passed.", "episodic"),
    fact("F-EP1S0D1C", "The operator discussed the migration boundary.", "episodic"),
    fact("F-W0RD1NG0", "A screenshot report exists for the architecture observation.", "semantic"),
    fact("F-BEAR1NG0", "The accepted boundary excludes destructive data changes.", "semantic"),
    fact("F-REF3R3NC", "PR #999 merged and tests passed.", "episodic"),
    ""
  ].join("\n");
}

function fact(id: string, statement: string, memoryClass: "episodic" | "semantic"): string {
  return `- {fact_id: ${id}, statement: ${JSON.stringify(statement)}, source: "fixture", observedAt: "2026-07-12T00:00:00.000Z", confidence: high, memoryClass: ${memoryClass}, memoryTags: [], provenance: [{runtime: "human", sessionId: "fixture", boundAt: "2026-07-12T00:00:00.000Z"}]}`;
}

function writeDecisionEvidence(rootDir: string, taskId: string): void {
  const relation = {
    source: "decision/dec_FIXTURE/CH1",
    target: `fact/${taskId}/F-REF3R3NC`,
    type: "evidenced-by",
    strength: "strong",
    direction: "directed",
    origin: "declared",
    rationale: "Referenced negative control.",
    state: "active"
  } satisfies Omit<EntityRelationRecord, "relation_id">;
  const record = { ...relation, relation_id: deriveRelationId(relation) };
  writeFile(rootDir, "harness/decisions/decision-dec_FIXTURE/decision.md", [
    "---",
    "schema: decision-package/v1",
    "decision_id: dec_FIXTURE",
    "_coordinatorWatermark: fixture-watermark",
    "title: Fixture decision",
    "state: accepted",
    "chosen:",
    "  - {id: CH1, text: Fixture choice}",
    "claims:",
    "  - {id: C1, text: Fixture claim}",
    "relations:",
    `  ${formatRelationFlowRecord(record)}`,
    "---",
    "",
    "# Fixture decision",
    ""
  ].join("\n"));
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--actor", "human:fixture", "--json", ...args], {
      encoding: "utf8",
      env: { ...process.env, HARNESS_DAEMON_MODE: "direct", HARNESS_DAEMON_USER_ROOT: path.join(rootDir, ".daemon-user") }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-fact-execution-migration-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
}
