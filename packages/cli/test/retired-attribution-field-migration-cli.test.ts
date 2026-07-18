// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupRetiredAttributionFields } from "../../kernel/src/index.ts";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("retired attribution migration dry-runs byte-exact deletions and applies with migration attribution", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "AGENTS.md", "# Agent Context\n");
    writeFile(rootDir, "CLAUDE.md", "# Claude Context\n");
    runJson(rootDir, ["init"]);
    const created = runJson(rootDir, ["new-task", "--title", "Historical task body"]);
    const taskRelative = String(created.packagePath);
    const taskPath = path.join(rootDir, taskRelative, "INDEX.md");
    const taskBefore = injectTaskRetiredField(readFileSync(taskPath, "utf8"));
    writeFileSync(taskPath, taskBefore, "utf8");

    const decisionId = "dec_TEST_RETIRED_ATTRIBUTION";
    const decisionRelative = `harness/decisions/decision-${decisionId}/decision.md`;
    const decisionPath = path.join(rootDir, decisionRelative);
    const decisionBefore = decisionFixture(decisionId);
    writeFile(rootDir, decisionRelative, decisionBefore);
    commitHarness(rootDir, "seed retired attribution fixtures");
    const baseline = harnessGit(rootDir, "rev-parse", "HEAD").trim();

    const dryRun = runJson(rootDir, ["migrate", "retired-attribution-fields", "--dry-run", "--batch-size", "2"]);
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.migrationMode, "plan");
    assert.equal(dryRun.report.summary.taskCandidates, 1);
    assert.equal(dryRun.report.summary.decisionCandidates, 1);
    assert.equal(dryRun.report.summary.candidateDocuments, 2);
    assert.equal(dryRun.report.summary.contentPinArbitersBefore, 1);
    assert.equal(dryRun.report.summary.expectedContentPinArbitersAfter, 1);
    assert.equal(dryRun.report.summary.targetContentPinArbitersBefore, 1);
    assert.equal(dryRun.report.summary.targetContentPinArbitersAfter, 1);
    assert.deepEqual(dryRun.report.invariants, {
      addedBytes: 0,
      allAuthoredBodiesByteIdentical: true,
      allContentPinArbitersPreserved: true,
      allTransformsAreStrictDeletions: true
    });
    assert.equal(harnessGit(rootDir, "rev-parse", "HEAD").trim(), baseline);

    const unconfirmed = runJson(rootDir, [
      "migrate", "retired-attribution-fields", "--apply", "--evidence-ref", "task/task_TEST/artifacts/report.md#sha256:test"
    ], false);
    assert.equal(unconfirmed.ok, false);
    assert.equal(unconfirmed.error.code, "plan_confirmation_required");

    const applied = runJson(rootDir, [
      "migrate", "retired-attribution-fields", "--apply",
      "--confirm-plan", String(dryRun.report.planId),
      "--evidence-ref", "task/task_TEST/artifacts/report.md#sha256:test",
      "--batch-size", "2"
    ]);
    assert.equal(applied.ok, true);
    assert.equal(applied.report.summary.appliedDocuments, 2);
    assert.equal(readFileSync(taskPath, "utf8"), cleanupRetiredAttributionFields(taskBefore, "task-index").body);
    assert.equal(readFileSync(decisionPath, "utf8"), cleanupRetiredAttributionFields(decisionBefore, "decision").body);
    assert.match(readFileSync(taskPath, "utf8"), /## Lifecycle Note\n\nPreserve this body byte-for-byte\./u);
    assert.match(readFileSync(decisionPath, "utf8"), /^  - .*arbiter:/mu);

    const events = readMigrationEvents(rootDir);
    assert.equal(events.length, 2);
    assert.equal(events.every((event) => event.kind === "migration_retired_attribution_fields"), true);
    assert.equal(events.every((event) => event.principalSource?.kind === "migration"), true);
    assert.equal(events.every((event) => event.principalSource?.evidenceRef === "task/task_TEST/artifacts/report.md#sha256:test"), true);

    const repeated = runJson(rootDir, ["migrate", "retired-attribution-fields", "--dry-run"]);
    assert.equal(repeated.report.summary.candidateDocuments, 0);
    assert.equal(repeated.report.summary.contentPinArbitersBefore, 1);
    assert.equal(repeated.report.summary.targetContentPinArbitersBefore, 0);
  });
});

function injectTaskRetiredField(body: string): string {
  return body.replace("\n---\n\n# ", [
    "\ncreatedBy:",
    "  name: Historical Author",
    "  email: historical@example.test",
    "---",
    "",
    "# "
  ].join("\n")).trimEnd() + "\n\n## Lifecycle Note\n\nPreserve this body byte-for-byte.\n";
}

function decisionFixture(decisionId: string): string {
  return [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    "_coordinatorWatermark: historical-watermark",
    "proposedBy: { kind: \"agent\", id: \"legacy-agent\" }",
    "arbiter: { kind: \"human\", id: \"legacy-human\" }",
    "contentPins:",
    "  - { action: \"accept\", arbiter: { kind: \"human\", id: \"person_test\" }, digest: \"sha256:test\" }",
    "---",
    "",
    "# Historical decision",
    "",
    "Preserve this decision body byte-for-byte.",
    ""
  ].join("\n");
}

function readMigrationEvents(rootDir: string): ReadonlyArray<Record<string, any>> {
  const eventsRoot = path.join(rootDir, "harness", "attribution-events");
  if (!existsSync(eventsRoot)) return [];
  return readdirSync(eventsRoot).flatMap((name) => readFileSync(path.join(eventsRoot, name), "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>)
    .filter((event) => event.kind === "migration_retired_attribution_fields"));
}

function commitHarness(rootDir: string, message: string): void {
  harnessGit(rootDir, "add", ".");
  harnessGit(rootDir, "commit", "-m", message);
}

function harnessGit(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", [
    "-c", "user.email=harness@example.test",
    "-c", "user.name=Harness Test",
    "-C", path.join(rootDir, "harness"),
    ...args
  ], { encoding: "utf8" });
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--actor", "agent:fixture", "--json", ...args], {
      encoding: "utf8",
      env: { ...process.env, HARNESS_DAEMON_MODE: "fixture", HARNESS_DAEMON_USER_ROOT: path.join(rootDir, ".daemon-user") }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-retired-attribution-migration-"));
  ensureTestHarnessIdentity(rootDir);
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
