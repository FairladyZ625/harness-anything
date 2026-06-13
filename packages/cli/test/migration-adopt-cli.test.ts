import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI exposes Multica snapshot as readonly JSON evidence", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["snapshot", "multica", "FAI-1", "--status", "In Review", "--title", "Review Item"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "snapshot-multica");
    assert.equal(result.report.externalWrites, false);
    assert.equal(result.report.snapshot.canonicalStatus, "in_review");
    assert.equal(existsSync(path.join(rootDir, "harness/planning/tasks")), false);
  });
});

test("CLI adopts Multica tasks locally and rejects duplicate external refs", () => {
  withTempRoot((rootDir) => {
    const adopted = runJson(rootDir, ["adopt", "multica", "FAI-1", "--task", "task-1", "--status", "Active", "--title", "Adopted Multica"]);
    const duplicate = runJson(rootDir, ["adopt", "multica", "FAI-1", "--task", "task-2", "--status", "Active"], false);

    assert.equal(adopted.ok, true);
    assert.equal(adopted.report.externalWrites, false);
    assert.equal(adopted.report.writeBoundary, "local-authored-task-package");
    const index = readFileSync(path.join(rootDir, "harness/planning/tasks/task-1/INDEX.md"), "utf8");
    assert.match(index, /engine: multica/);
    assert.match(index, /ref: FAI-1/);
    assert.equal(/^  status:/mu.test(index), false);
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

test("CLI legacy copy and index write only under harness legacy storage", () => {
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
    assert.equal(existsSync(path.join(rootDir, "harness/planning/tasks/done-task")), false);
    assert.equal(existsSync(path.join(rootDir, "harness/planning/modules/auth/tasks/module-task")), false);
    const index = JSON.parse(readFileSync(path.join(rootDir, "harness/legacy/index.json"), "utf8"));
    assert.equal(index.schema, "legacy-index/v1");
    assert.equal(index.summary.taskCount, 2);
    assert.equal(index.summary.rebuildRequiredCount, 1);
    assert.match(index.entries[0].sourceDigest, /^sha256:[a-f0-9]{64}$/u);
  });
});

test("CLI legacy copy blocks collisions in P04 without overwrite", () => {
  withTempRoot((rootDir) => {
    writeLegacyTask(rootDir, "old-task", "active");
    mkdirSync(path.join(rootDir, "harness/legacy/tasks/old-task"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/legacy/tasks/old-task/sentinel.txt"), "keep", "utf8");

    const conflict = runJson(rootDir, ["legacy", "copy-safe-docs", ".", "--apply"], false);

    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, "legacy_collision_requires_p05");
    assert.equal(readFileSync(path.join(rootDir, "harness/legacy/tasks/old-task/sentinel.txt"), "utf8"), "keep");
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
    writeLegacyTask(rootDir, "old-task", "done");
    runJson(rootDir, ["legacy", "copy-safe-docs", ".", "--apply"]);
    runJson(rootDir, ["legacy", "index", ".", "--apply"]);
    const valid = runJson(rootDir, ["legacy", "verify"]);
    assert.equal(valid.ok, true);
    assert.equal(valid.report.summary.taskCount, 1);
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
    assert.equal(existsSync(path.join(rootDir, "harness/legacy/tasks/old-task/task_plan.md")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/planning/tasks/old-task")), false);
    assert.equal(run.report.schema, "legacy-intake-session/v1");
    assert.equal(retired.error.code, "full_cutover_retired");
    assert.equal(retired.report.fullCutover, "retired");
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

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  const command = [cliEntry, ...args, "--root", rootDir, "--json"];
  try {
    const output = execFileSync(process.execPath, command, { encoding: "utf8" });
    const parsed = JSON.parse(output);
    if (expectSuccess) assert.equal(parsed.ok, true, output);
    return parsed;
  } catch (error) {
    const failure = error as { readonly stdout?: string; readonly stderr?: string };
    const body = failure.stdout && failure.stdout.trim().length > 0 ? failure.stdout : failure.stderr ?? "";
    const parsed = JSON.parse(body);
    if (expectSuccess) assert.fail(body);
    return parsed;
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-p4-cli-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
