// harness-test-tier: integration
import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;

test("CLI exposes Multica snapshot as readonly JSON evidence", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["snapshot", "multica", "FAI-1", "--status", "In Review", "--title", "Review Item"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "snapshot-multica");
    assert.equal(result.report.externalWrites, false);
    assert.equal(result.report.snapshot.canonicalStatus, "in_review");
    assert.equal(existsSync(path.join(rootDir, "harness/tasks")), false);
  });
});

test("CLI adopts Multica tasks locally and rejects duplicate external refs", () => {
  withTempRoot((rootDir) => {
    const adopted = runJson(rootDir, ["adopt", "multica", "FAI-1", "--task", "task-1", "--status", "Active", "--title", "Adopted Multica"]);
    const duplicate = runJson(rootDir, ["adopt", "multica", "FAI-1", "--task", "task-2", "--status", "Active"], false);

    assert.equal(adopted.ok, true);
    assert.equal(adopted.report.externalWrites, false);
    assert.equal(adopted.report.writeBoundary, "local-authored-task-package");
    const index = readFileSync(path.join(rootDir, "harness/tasks/task-1/INDEX.md"), "utf8");
    assert.match(index, /engine: multica/);
    assert.match(index, /ref: FAI-1/);
    assert.equal(/^  status:/mu.test(index), false);
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error.code, "duplicate_external_binding");
  });
});

test("CLI adopt multica honors explicit authored root for receipts and duplicate guards", () => {
  withTempRoot((rootDir) => {
    const adopted = runJson(rootDir, ["--authored-root", ".custom-harness", "adopt", "multica", "FAI-1", "--task", "task-1", "--status", "Active", "--title", "Custom Multica"]);
    const duplicate = runJson(rootDir, ["--authored-root", ".custom-harness", "adopt", "multica", "FAI-1", "--task", "task-2", "--status", "Active"], false);

    assert.equal(adopted.ok, true);
    assert.equal(adopted.path, ".custom-harness/tasks/task-1");
    assert.equal(existsSync(path.join(rootDir, ".custom-harness/tasks/task-1/INDEX.md")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-1/INDEX.md")), false);
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error.code, "duplicate_external_binding");
  });
});

test("CLI legacy scan and intake-plan are readonly intake evidence", () => {
  withTempRoot((rootDir) => {
    writeLegacyTask(rootDir, "old-task", "active");
    writeLegacyDoc(rootDir, "11-REFERENCE/testing-standard.md", "# Testing Standard\n");

    const scan = runJson(rootDir, ["legacy", "scan", "."]);
    const plan = runJson(rootDir, ["legacy", "intake-plan", ".", "--out", "legacy-intake.md"]);

    assert.equal(scan.ok, true);
    assert.equal(scan.command, "legacy-scan");
    assert.equal(scan.report.schema, "legacy-intake-scan/v1");
    assert.equal(scan.report.summary.taskCount, 1);
    assert.equal(scan.report.summary.docCount, 1);
    assert.equal(scan.report.entries.some((entry: Record<string, unknown>) => entry.storedPath === "harness/legacy/tasks/old-task"), true);
    assert.equal(scan.report.entries.some((entry: Record<string, unknown>) => entry.recommendedTreatment === "rebuild-required"), true);
    assert.equal(existsSync(path.join(rootDir, "harness/legacy")), false);
    assert.equal(plan.path, "legacy-intake.md");
    assert.match(readFileSync(path.join(rootDir, "legacy-intake.md"), "utf8"), /Legacy Intake Plan/);
  });
});

test("CLI legacy copy preserves legacy evidence and forwards safe authored docs", () => {
  withTempRoot((rootDir) => {
    writeLegacyTask(rootDir, "done-task", "done");
    writeLegacyModuleTask(rootDir, "auth", "module-task", "active");
    writeLegacyDoc(rootDir, "11-REFERENCE/testing-standard.md", "# Testing Standard\n");

    const dryRun = runJson(rootDir, ["legacy", "copy-safe-docs", "."]);
    assert.equal(dryRun.migrationMode, "plan");
    assert.equal(existsSync(path.join(rootDir, "harness/legacy/tasks/done-task")), false);

    const copied = runJson(rootDir, ["legacy", "copy-safe-docs", ".", "--apply"]);
    const indexed = runJson(rootDir, ["legacy", "index", ".", "--apply"]);
    const verified = runJson(rootDir, ["legacy", "verify"]);

    assert.equal(copied.ok, true);
    assert.equal(indexed.ok, true);
    assert.equal(indexed.path, "harness/legacy/index.json");
    assert.equal(verified.ok, true);
    assert.equal(existsSync(path.join(rootDir, "harness/legacy/tasks/done-task/task_plan.md")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/legacy/tasks/modules/auth/module-task/task_plan.md")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/legacy/docs/11-REFERENCE/testing-standard.md")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/standards/testing-standard.md")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/done-task")), false);
    assert.equal(existsSync(path.join(rootDir, "harness/modules/auth/tasks/module-task")), false);
    const index = JSON.parse(readFileSync(path.join(rootDir, "harness/legacy/index.json"), "utf8"));
    assert.equal(index.schema, "legacy-index/v1");
    assert.equal(index.summary.taskCount, 2);
    assert.equal(index.summary.rebuildRequiredCount, 1);
    assert.match(index.entries[0].sourceDigest, /^sha256:[a-f0-9]{64}$/u);
  });
});

test("CLI legacy copy safe docs preserves authored root override for forwards", () => {
  withTempRoot((rootDir) => {
    writeLegacyDoc(rootDir, "11-REFERENCE/testing-standard.md", "# Testing Standard\n");
    writeFile(rootDir, ".custom-harness/harness.yaml", [
      "schema: harness-anything/v1",
      "settings:",
      "  identity:",
      "    personId: person_test",
      "    displayName: Harness Test",
      ""
    ].join("\n"));

    const dryRun = runJson(rootDir, ["--authored-root", ".custom-harness", "legacy", "copy-safe-docs", "."]);
    const forwardedEntry = dryRun.report.entries.find((entry: Record<string, unknown>) => entry.forwardPath === ".custom-harness/standards/testing-standard.md");

    assert.notEqual(forwardedEntry, undefined);
    runJson(rootDir, ["--authored-root", ".custom-harness", "legacy", "copy-safe-docs", ".", "--apply"]);

    assert.equal(existsSync(path.join(rootDir, ".custom-harness/standards/testing-standard.md")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/standards/testing-standard.md")), false);
  });
});

test("CLI legacy copy applies fixed suffix collisions and writes report", () => {
  withTempRoot((rootDir) => {
    writeLegacyTask(rootDir, "old-task", "active");
    writeLegacyDoc(rootDir, "11-REFERENCE/testing-standard.md", "# Testing Standard\n");
    mkdirSync(path.join(rootDir, "harness/legacy/tasks/old-task"), { recursive: true });
    mkdirSync(path.join(rootDir, "harness/legacy/tasks/old-task-legacy-import-1"), { recursive: true });
    mkdirSync(path.join(rootDir, "harness/legacy/docs/11-REFERENCE"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/legacy/tasks/old-task/sentinel.txt"), "keep", "utf8");
    writeFileSync(path.join(rootDir, "harness/legacy/docs/11-REFERENCE/testing-standard.md"), "keep", "utf8");
    writeFileSync(path.join(rootDir, "harness/legacy/docs/11-REFERENCE/testing-standard.legacy-import-1.md"), "keep-1", "utf8");

    const copied = runJson(rootDir, ["legacy", "copy-safe-docs", ".", "--apply"]);
    const indexed = runJson(rootDir, ["legacy", "index", ".", "--apply"]);
    const verified = runJson(rootDir, ["legacy", "verify"]);
    const collisionReport = JSON.parse(readFileSync(path.join(rootDir, "harness/legacy/collision-report.json"), "utf8"));
    const index = JSON.parse(readFileSync(path.join(rootDir, "harness/legacy/index.json"), "utf8"));

    assert.equal(copied.ok, true);
    assert.equal(indexed.ok, true);
    assert.equal(verified.ok, true);
    assert.equal(verified.report.collisionReport.entryCount, 2);
    assert.equal(verified.report.collisionReport.overwriteAllowed, false);
    assert.equal(readFileSync(path.join(rootDir, "harness/legacy/tasks/old-task/sentinel.txt"), "utf8"), "keep");
    assert.equal(readFileSync(path.join(rootDir, "harness/legacy/docs/11-REFERENCE/testing-standard.md"), "utf8"), "keep");
    assert.equal(existsSync(path.join(rootDir, "harness/legacy/tasks/old-task-legacy-import-2/task_plan.md")), true);
    assert.equal(readFileSync(path.join(rootDir, "harness/legacy/docs/11-REFERENCE/testing-standard.legacy-import-2.md"), "utf8"), "# Testing Standard\n");
    assert.equal(collisionReport.schema, "legacy-collision-report/v1");
    assert.equal(collisionReport.policy.overwriteAllowed, false);
    assert.equal(collisionReport.entries.length, 2);
    assert.equal(collisionReport.entries.some((entry: Record<string, unknown>) => entry.kind === "directory" && entry.chosenPath === "harness/legacy/tasks/old-task-legacy-import-2" && entry.suffixIndex === 2), true);
    assert.equal(collisionReport.entries.some((entry: Record<string, unknown>) => entry.kind === "file" && entry.chosenPath === "harness/legacy/docs/11-REFERENCE/testing-standard.legacy-import-2.md" && entry.suffixIndex === 2), true);
    assert.equal(index.entries.some((entry: Record<string, unknown>) => entry.storedPath === "harness/legacy/tasks/old-task-legacy-import-2"), true);
    assert.equal(index.entries.some((entry: Record<string, unknown>) => entry.storedPath === "harness/legacy/docs/11-REFERENCE/testing-standard.legacy-import-2.md"), true);
  });
});

test("CLI legacy scan discovers V2 layout tasks and forwards private harness context", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "old/.harness-private/coding-agent-harness/harness.yaml", [
      "version: 2",
      "structure:",
      "  harnessRoot: coding-agent-harness",
      "  tasksRoot: coding-agent-harness/tasks",
      ""
    ].join("\n"));
    writeFile(rootDir, "old/.harness-private/coding-agent-harness/tasks/v2-task/INDEX.md", "---\ntitle: V2 Task\nstatus: active\n---\n# V2 Task\n");
    writeFile(rootDir, "old/.harness-private/coding-agent-harness/tasks/v2-task/progress.md", "progress\n");
    writeFile(rootDir, "old/.harness-private/coding-agent-harness/context/architecture/overview.md", "# Architecture\n");
    writeFile(rootDir, "outside-secret.md", "# Secret\n");
    trySymlink(path.join(rootDir, "outside-secret.md"), path.join(rootDir, "old/.harness-private/coding-agent-harness/context/architecture/leak.md"));

    const scan = runJson(rootDir, ["legacy", "scan", "old"]);
    assert.equal(scan.report.summary.taskCount, 1);
    assert.equal(scan.report.summary.docCount, 1);
    assert.equal(scan.report.entries.some((entry: Record<string, unknown>) => entry.sourcePath === ".harness-private/coding-agent-harness/tasks/v2-task"), true);
    assert.equal(scan.report.entries.some((entry: Record<string, unknown>) => entry.sourcePath === ".harness-private/coding-agent-harness/context/architecture/leak.md"), false);
    const contextEntry = scan.report.entries.find((entry: Record<string, unknown>) => entry.sourcePath === ".harness-private/coding-agent-harness/context/architecture/overview.md");
    assert.equal(contextEntry.forwardPath, "harness/context/architecture/overview.md");

    runJson(rootDir, ["legacy", "copy-safe-docs", "old", "--apply"]);
    runJson(rootDir, ["legacy", "index", "old", "--apply"]);

    assert.equal(existsSync(path.join(rootDir, "harness/legacy/tasks/v2-task/INDEX.md")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/context/architecture/overview.md")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/context/architecture/leak.md")), false);
    assert.equal(existsSync(path.join(rootDir, "harness/legacy/docs/.harness-private/coding-agent-harness/context/architecture/overview.md")), true);
  });
});

test("CLI legacy scan skips self-host active harness and generated directories", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "harness/harness.yaml", "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n");
    writeFile(rootDir, "harness/tasks/active-task/INDEX.md", "---\ntitle: Active Task\nstatus: active\n---\n# Active Task\n");
    writeFile(rootDir, "harness/legacy/tasks/old-import/task_plan.md", "# Already Imported\n");
    writeFile(rootDir, "harness/context/architecture/prototype/node_modules/pkg/README.md", "# Package Readme\n");
    writeFile(rootDir, "harness/context/architecture/prototype/node_modules/pkg/package.json", "{\"name\":\"pkg\"}\n");
    writeFile(rootDir, "harness/context/architecture/real-design.md", "# Real Design\n");
    writeLegacyTask(rootDir, "old-task", "done");

    const scan = runJson(rootDir, ["legacy", "scan", "."]);
    const sourcePaths = scan.report.entries.map((entry: Record<string, unknown>) => entry.sourcePath);

    assert.equal(scan.ok, true);
    assert.equal(sourcePaths.includes("docs/09-PLANNING/TASKS/old-task"), true);
    assert.equal(sourcePaths.includes("harness/context/architecture/real-design.md"), false);
    assert.equal(sourcePaths.some((sourcePath: string) => sourcePath.startsWith("harness/tasks/")), false);
    assert.equal(sourcePaths.some((sourcePath: string) => sourcePath.startsWith("harness/legacy/")), false);
    assert.equal(sourcePaths.some((sourcePath: string) => sourcePath.startsWith("harness/context/")), false);
    assert.equal(sourcePaths.some((sourcePath: string) => sourcePath.includes("/node_modules/")), false);
  });
});

test("CLI legacy apply ignores unsafe generated source paths", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "docs/architecture/node_modules/pkg/README.md", "# Package Readme\n");
    writeFile(rootDir, "docs/architecture/overview.md", "# Overview\n");

    const copied = runJson(rootDir, ["legacy", "copy-safe-docs", ".", "--apply"]);

    assert.equal(copied.ok, true);
    assert.equal(copied.report.summary.docCount, 1);
    assert.equal(existsSync(path.join(rootDir, "harness/legacy/docs/architecture/overview.md")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/legacy/docs/architecture/node_modules/pkg/README.md")), false);
  });
});

test("CLI legacy apply refuses the active authored harness root as source", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "harness/harness.yaml", "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n");
    writeFile(rootDir, "harness/docs/architecture/self-host.md", "# Self Host\n");

    const copied = runJson(rootDir, ["legacy", "copy-safe-docs", "harness", "--apply"], false);
    const indexed = runJson(rootDir, ["legacy", "index", "harness", "--apply"], false);

    assert.equal(copied.ok, false);
    assert.equal(copied.error.code, "legacy_unsafe_source");
    assert.equal(indexed.ok, false);
    assert.equal(indexed.error.code, "legacy_unsafe_source");
    assert.equal(existsSync(path.join(rootDir, "harness/legacy/docs/architecture/self-host.md")), false);
    assert.equal(existsSync(path.join(rootDir, "harness/legacy/index.json")), false);
  });
});

test("CLI legacy apply refuses a symlink alias of the active authored harness root", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "harness/harness.yaml", "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n");
    writeFile(rootDir, "harness/docs/architecture/self-host.md", "# Self Host\n");
    if (!trySymlink(path.join(rootDir, "harness"), path.join(rootDir, "link-harness"), "junction")) return;

    const copied = runJson(rootDir, ["legacy", "copy-safe-docs", "link-harness", "--apply"], false);
    const indexed = runJson(rootDir, ["legacy", "index", "link-harness", "--apply"], false);

    assert.equal(copied.ok, false);
    assert.equal(copied.error.code, "legacy_unsafe_source");
    assert.equal(indexed.ok, false);
    assert.equal(indexed.error.code, "legacy_unsafe_source");
    assert.equal(existsSync(path.join(rootDir, "harness/legacy/docs/architecture/self-host.md")), false);
    assert.equal(existsSync(path.join(rootDir, "harness/legacy/index.json")), false);
  });
});

test("CLI legacy copy suffixes planned parent directories before they can overwrite planned children", () => {
  withTempRoot((rootDir) => {
    writeLegacyTask(rootDir, "modules", "active");
    writeLegacyModuleTask(rootDir, "auth", "module-task", "active");
    mkdirSync(path.join(rootDir, "docs/09-PLANNING/TASKS/modules/auth/module-task"), { recursive: true });
    writeFileSync(path.join(rootDir, "docs/09-PLANNING/TASKS/modules/auth/module-task/task_plan.md"), "root nested plan\n", "utf8");

    runJson(rootDir, ["legacy", "copy-safe-docs", ".", "--apply"]);
    runJson(rootDir, ["legacy", "index", ".", "--apply"]);
    const verified = runJson(rootDir, ["legacy", "verify"]);
    const collisionReport = JSON.parse(readFileSync(path.join(rootDir, "harness/legacy/collision-report.json"), "utf8"));
    const index = JSON.parse(readFileSync(path.join(rootDir, "harness/legacy/index.json"), "utf8"));

    assert.equal(verified.ok, true);
    assert.equal(readFileSync(path.join(rootDir, "harness/legacy/tasks/modules/auth/module-task/task_plan.md"), "utf8"), "# module-task\n\nTask Contract: harness-task/v1\n");
    assert.equal(readFileSync(path.join(rootDir, "harness/legacy/tasks/modules-legacy-import-1/auth/module-task/task_plan.md"), "utf8"), "root nested plan\n");
    assert.equal(collisionReport.entries.length, 1);
    assert.equal(collisionReport.entries[0].targetPath, "harness/legacy/tasks/modules");
    assert.equal(collisionReport.entries[0].chosenPath, "harness/legacy/tasks/modules-legacy-import-1");
    assert.equal(collisionReport.entries[0].suffixIndex, 1);
    assert.equal(index.entries.some((entry: Record<string, unknown>) => entry.sourcePath === "docs/09-PLANNING/TASKS/modules" && entry.storedPath === "harness/legacy/tasks/modules-legacy-import-1"), true);
  });
});

test("CLI legacy verify detects missing, invalid, and valid index states", () => {
  withTempRoot((rootDir) => {
    const missing = runJson(rootDir, ["legacy", "verify"], false);
    assert.equal(missing.error.code, "legacy_index_missing");

    mkdirSync(path.join(rootDir, "harness/legacy"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/legacy/index.json"), "{\"schema\":\"wrong\"}\n", "utf8");
    const invalid = runJson(rootDir, ["legacy", "verify"], false);
    assert.equal(invalid.error.code, "legacy_index_invalid");

    rmSync(path.join(rootDir, "harness"), { recursive: true, force: true });
    ensureTestHarnessIdentity(rootDir);
    writeLegacyTask(rootDir, "old-task", "done");
    runJson(rootDir, ["legacy", "copy-safe-docs", ".", "--apply"]);
    runJson(rootDir, ["legacy", "index", ".", "--apply"]);
    const valid = runJson(rootDir, ["legacy", "verify"]);
    assert.equal(valid.ok, true);
    assert.equal(valid.report.summary.taskCount, 1);
  });
});

test("CLI rebuilds a fresh local task from a legacy index entry with provenance", () => {
  withTempRoot((rootDir) => {
    const missingLegacyId = runJson(rootDir, ["new-task", "--from-legacy"], false);
    assert.equal(missingLegacyId.error.code, "missing_legacy_id");

    const manualId = runJson(rootDir, ["new-task", "legacy-old-task", "--from-legacy", "legacy_missing"], false);
    assert.equal(manualId.error.code, "legacy_rebuild_manual_id_forbidden");

    const missing = runJson(rootDir, ["new-task", "--from-legacy", "legacy_missing"], false);
    assert.equal(missing.error.code, "legacy_index_missing");

    mkdirSync(path.join(rootDir, "harness/legacy"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/legacy/index.json"), "{\"schema\":\"wrong\"}\n", "utf8");
    const invalid = runJson(rootDir, ["new-task", "--from-legacy", "legacy_missing"], false);
    assert.equal(invalid.error.code, "legacy_index_invalid");

    rmSync(path.join(rootDir, "harness"), { recursive: true, force: true });
    ensureTestHarnessIdentity(rootDir);
    writeLegacyTask(rootDir, "old-task", "active");
    runJson(rootDir, ["legacy", "copy-safe-docs", ".", "--apply"]);
    runJson(rootDir, ["legacy", "index", ".", "--apply"]);
    const index = JSON.parse(readFileSync(path.join(rootDir, "harness/legacy/index.json"), "utf8"));
    const legacyEntry = index.entries.find((entry: Record<string, unknown>) => entry.category === "task");

    const unknown = runJson(rootDir, ["new-task", "--from-legacy", "legacy_unknown"], false);
    assert.equal(unknown.error.code, "legacy_entry_not_found");

    const rebuilt = runJson(rootDir, ["new-task", "--from-legacy", legacyEntry.id]);
    assert.match(rebuilt.taskId, taskIdPattern);
    assert.notEqual(rebuilt.taskId, legacyEntry.id);
    assert.equal(rebuilt.status, "planned");
    assert.equal(rebuilt.slug, "old-task");
    assert.equal(rebuilt.report.inheritedTaskId, false);
    assert.equal(rebuilt.report.inheritedStatus, false);
    assert.equal(rebuilt.report.source.legacyId, legacyEntry.id);
    assert.equal(rebuilt.report.source.storedPath, legacyEntry.storedPath);

    const taskDir = path.join(rootDir, rebuilt.packagePath);
    const indexBody = readFileSync(path.join(taskDir, "INDEX.md"), "utf8");
    const provenance = JSON.parse(readFileSync(path.join(taskDir, "legacy-provenance.json"), "utf8"));
    assert.match(indexBody, /status: planned/);
    assert.doesNotMatch(indexBody, /status: active/);
    assert.equal(provenance.schema, "legacy-rebuild-provenance/v1");
    assert.equal(provenance.legacyId, legacyEntry.id);
    assert.equal(provenance.storedPath, legacyEntry.storedPath);
    assert.equal(provenance.detectedStatus.raw, "active");
    assert.match(provenance.rebuiltAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.notEqual(provenance.rebuiltAt, "1970-01-01T00:00:00.000Z");
    assert.equal(existsSync(path.join(rootDir, "harness/tasks", legacyEntry.id)), false);
    assert.equal(existsSync(path.join(rootDir, legacyEntry.storedPath)), true);

    writeFileSync(path.join(taskDir, "legacy-provenance.json"), "{\"schema\":\"legacy-rebuild-provenance/v1\",\"legacyId\":\"legacy_bad\"}\n", "utf8");
    const invalidProvenance = runJson(rootDir, ["legacy", "verify"]);
    assert.equal(invalidProvenance.ok, true);
    assert.equal(invalidProvenance.warnings.some((warning: Record<string, unknown>) => warning.code === "legacy_provenance_invalid"), true);

    provenance.storedPath = "harness/legacy/tasks/missing-rebuild-source";
    writeFileSync(path.join(taskDir, "legacy-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
    const verified = runJson(rootDir, ["legacy", "verify"]);
    assert.equal(verified.ok, true);
    assert.equal(verified.warnings.some((warning: Record<string, unknown>) => warning.code === "legacy_provenance_target_missing" && warning.legacyId === legacyEntry.id), true);
  });
});

test("CLI migrate aliases now emit Legacy Intake semantics and retire full cutover", () => {
  withTempRoot((rootDir) => {
    writeLegacyTask(rootDir, "old-task", "active");

    const plan = runJson(rootDir, ["migrate-plan"]);
    const structure = runJson(rootDir, ["migrate-structure", "--apply", "--confirm-plan"]);
    const run = runJson(rootDir, ["migrate-run", "--plan-only"]);
    const retired = runJson(rootDir, ["migrate-verify", run.path, "--full-cutover"], false);

    assert.equal(plan.report.schema, "legacy-intake-scan/v1");
    assert.equal(plan.warnings[0].code, "migration_alias_legacy_intake");
    assert.equal(structure.ok, true);
    assert.equal(JSON.parse(readFileSync(path.join(rootDir, "harness/legacy/collision-report.json"), "utf8")).entries.length, 0);
    assert.equal(existsSync(path.join(rootDir, "harness/legacy/tasks/old-task/task_plan.md")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/old-task")), false);
    assert.equal(run.report.schema, "legacy-intake-session/v1");
    assert.equal(retired.error.code, "full_cutover_retired");
    assert.equal(retired.report.fullCutover, "retired");
  });
});

test("CLI migrate-provenance backfills pre-R2 task indexes through the write journal", () => {
  withTempRoot((rootDir) => {
    const probeEnv = { CLAUDE_SESSION_ID: "claude-review-session-12345" };
    writeCurrentTaskPackage(rootDir, "task-pre-r2", "Pre R2 Task", "planned", { provenance: false });
    writeCurrentTaskPackage(rootDir, "task-with-provenance", "Existing Provenance", "planned", { provenance: true });
    writeSubstantiveTaskPlan(rootDir, "harness/tasks/task-pre-r2");
    const existingBefore = readFileSync(path.join(rootDir, "harness/tasks/task-with-provenance/INDEX.md"), "utf8");

    const locked = runJson(rootDir, ["task", "status", "set", "task-pre-r2", "active"], false);
    assert.equal(locked.ok, false);
    assert.equal(locked.error.code, "malformed_snapshot");
    const watermarkPath = path.join(rootDir, ".harness/write-journal/watermark.json");
    const watermarkBeforeDryRun = existsSync(watermarkPath) ? readFileSync(watermarkPath, "utf8") : null;

    const dryRun = runJson(rootDir, ["migrate-provenance"], true, probeEnv);
    assert.equal(dryRun.command, "migrate-provenance");
    assert.equal(dryRun.migrationMode, "plan");
    assert.equal(dryRun.rows, 1);
    assert.equal(dryRun.report.provenance.runtime, "claude-code");
    assert.match(dryRun.report.provenance.sessionId, /^claude-code-provenance-backfill-\d+-[a-f0-9]{8}$/u);
    assert.equal(dryRun.report.summary.needsBackfill, 1);
    assert.equal(dryRun.report.summary.applied, 0);
    assert.equal(dryRun.report.entries[0].taskId, "task-pre-r2");
    assert.equal(existsSync(watermarkPath), watermarkBeforeDryRun !== null);
    if (watermarkBeforeDryRun !== null) {
      assert.equal(readFileSync(watermarkPath, "utf8"), watermarkBeforeDryRun);
    }

    const applied = runJson(rootDir, ["migrate-provenance", "--apply"], true, probeEnv);
    assert.equal(applied.migrationMode, "apply");
    assert.equal(applied.report.provenance.runtime, "claude-code");
    assert.equal(applied.report.summary.needsBackfill, 1);
    assert.equal(applied.report.summary.applied, 1);

    const backfilled = readFileSync(path.join(rootDir, "harness/tasks/task-pre-r2/INDEX.md"), "utf8");
    assert.match(backfilled, /^provenance:$/m);
    assert.match(backfilled, /runtime: "claude-code"/);
    assert.match(backfilled, /sessionId: "claude-code-provenance-backfill-\d+-[a-f0-9]{8}"/);
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8"), /write-watermark\/v1/);

    const status = runJson(rootDir, ["task", "status", "set", "task-pre-r2", "active"]);
    assert.equal(status.ok, true);
    assert.equal(status.status, "active");
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-with-provenance/INDEX.md"), "utf8"), existingBefore);

    const beforeRepeat = readFileSync(path.join(rootDir, "harness/tasks/task-pre-r2/INDEX.md"), "utf8");
    const repeat = runJson(rootDir, ["migrate-provenance", "--apply"], true, probeEnv);
    assert.equal(repeat.report.summary.needsBackfill, 0);
    assert.equal(repeat.report.summary.applied, 0);
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-pre-r2/INDEX.md"), "utf8"), beforeRepeat);
  });
});

function writeLegacyTask(rootDir: string, id: string, status: string): void {
  const taskDir = path.join(rootDir, "docs/09-PLANNING/TASKS", id);
  writeTaskPackage(taskDir, id, status);
}

function writeLegacyModuleTask(rootDir: string, moduleKey: string, id: string, status: string): void {
  const taskDir = path.join(rootDir, "docs/09-PLANNING/MODULES", moduleKey, "TASKS", id);
  writeTaskPackage(taskDir, id, status);
}

function writeTaskPackage(taskDir: string, id: string, status: string): void {
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(path.join(taskDir, "INDEX.md"), `---\ntitle: ${id}\nstatus: ${status}\n---\n# ${id}\n`, "utf8");
  writeFileSync(path.join(taskDir, "task_plan.md"), `# ${id}\n\nTask Contract: harness-task/v1\n`, "utf8");
  writeFileSync(path.join(taskDir, "progress.md"), `${id} progress\n`, "utf8");
}

function writeLegacyDoc(rootDir: string, relativePath: string, body: string): void {
  const fullPath = path.join(rootDir, "docs", relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, body, "utf8");
}

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const fullPath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, body, "utf8");
}

function trySymlink(target: string, linkPath: string, type?: "file" | "dir" | "junction"): boolean {
  try {
    symlinkSync(target, linkPath, type);
    return true;
  } catch (error) {
    if (isWindowsSymlinkPermissionError(error)) return false;
    throw error;
  }
}

function isWindowsSymlinkPermissionError(error: unknown): boolean {
  return process.platform === "win32" &&
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EPERM";
}

function writeCurrentTaskPackage(
  rootDir: string,
  id: string,
  title: string,
  status: string,
  options: { readonly provenance: boolean }
): void {
  const taskDir = path.join(rootDir, "harness/tasks", id);
  const provenance = options.provenance
    ? [
      "provenance:",
      "  - {runtime: \"human\", sessionId: \"human-fixture\", boundAt: \"2026-07-03T00:00:00.000Z\"}"
    ]
    : [];
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(path.join(taskDir, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${id}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    `  status: ${status}`,
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-07-03T00:00:00.000Z",
    "  bindingFingerprint: sha256:fixture",
    "packageDisposition: active",
    "vertical: software/coding",
    "preset: standard-task",
    ...provenance,
    "profile: baseline",
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"), "utf8");
}

function runJson(
  rootDir: string,
  args: ReadonlyArray<string>,
  expectSuccess = true,
  env: Readonly<Record<string, string | undefined>> = {}
): Record<string, any> {
  const command = [cliEntry, ...args, "--root", rootDir, "--json"];
  try {
    const output = execFileSync(process.execPath, command, {
      encoding: "utf8",
      env: { ...process.env, ...env }
    });
    const parsed = JSON.parse(output);
    if (expectSuccess) assert.equal(parsed.ok, true, output);
    return unwrapCommandReceipt(parsed);
  } catch (error) {
    const failure = error as { readonly stdout?: string; readonly stderr?: string };
    const body = failure.stdout && failure.stdout.trim().length > 0 ? failure.stdout : failure.stderr ?? "";
    const parsed = JSON.parse(body);
    if (expectSuccess) assert.fail(body);
    return unwrapCommandReceipt(parsed);
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-p4-cli-"));
  try {
    ensureTestHarnessIdentity(rootDir);
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
