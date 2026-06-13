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

test("CLI migration plan is readonly and structure apply requires confirmation", () => {
  withTempRoot((rootDir) => {
    writeLegacyTask(rootDir, "old-task");

    const plan = runJson(rootDir, ["migrate-plan"]);
    const structurePlan = runJson(rootDir, ["migrate-structure", "--plan"]);
    const refusedApply = runJson(rootDir, ["migrate-structure", "--apply"], false);

    assert.equal(plan.ok, true);
    assert.equal(plan.report.schema, "harness-migration-plan/v1");
    assert.equal(plan.report.summary.taskCount, 1);
    assert.equal(structurePlan.migrationMode, "plan");
    assert.equal(existsSync(path.join(rootDir, "harness/planning/tasks/old-task")), false);
    assert.equal(refusedApply.error.code, "plan_confirmation_required");
  });
});

test("CLI migration apply copies legacy tasks and refuses target collisions before writing", () => {
  withTempRoot((rootDir) => {
    writeLegacyTask(rootDir, "old-task");
    mkdirSync(path.join(rootDir, "harness/planning/tasks/old-task"), { recursive: true });

    const conflict = runJson(rootDir, ["migrate-structure", "--apply", "--confirm-plan"], false);
    assert.equal(conflict.error.code, "migration_preflight_failed");
    assert.equal(existsSync(path.join(rootDir, "harness/planning/tasks/old-task/task_plan.md")), false);
  });

  withTempRoot((rootDir) => {
    writeLegacyTask(rootDir, "old-task");
    writeLegacyModuleTask(rootDir, "auth", "auth-old");

    const applied = runJson(rootDir, ["migrate-structure", "--apply", "--confirm-plan"]);

    assert.equal(applied.ok, true);
    assert.equal(applied.migrationMode, "apply");
    assert.equal(existsSync(path.join(rootDir, "harness/planning/tasks/old-task/task_plan.md")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/planning/tasks/old-task/walkthrough.md")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/planning/modules/auth/tasks/auth-old/task_plan.md")), true);
  });
});

test("CLI migration run writes source-pack session evidence and normal verify", () => {
  withTempRoot((rootDir) => {
    writeLegacyTask(rootDir, "old-task");

    const run = runJson(rootDir, ["migrate-run"]);
    const verify = runJson(rootDir, ["migrate-verify", run.path]);
    const fullCutover = runJson(rootDir, ["migrate-verify", run.path, "--full-cutover"], false);

    assert.equal(run.ok, true);
    assert.equal(run.report.schema, "harness-migration-session/v1");
    assert.match(run.report.sourcePack.digest, /^sha256:/);
    assert.equal(verify.ok, true);
    assert.equal(verify.report.fullCutover, false);
    assert.equal(fullCutover.error.code, "full_cutover_verify_failed");
    assert.equal(fullCutover.report.fullCutover, true);
    assert.equal(fullCutover.report.fullCutoverEvidence.ok, false);
  });
});

test("CLI full cutover verify requires package and behavior corpus evidence", () => {
  withTempRoot((rootDir) => {
    writeLegacyTask(rootDir, "old-task");
    writeCutoverReadySurface(rootDir);

    const run = runJson(rootDir, ["migrate-run"]);
    const fullCutover = runJson(rootDir, ["migrate-verify", run.path, "--full-cutover"]);

    assert.equal(fullCutover.ok, true);
    assert.equal(fullCutover.report.fullCutover, true);
    assert.equal(fullCutover.report.fullCutoverEvidence.ok, true);
    assert.equal(fullCutover.report.fullCutoverEvidence.packageReleaseDecision.publishState, "not-published");
    assert.equal(fullCutover.report.fullCutoverEvidence.behaviorCorpus.needsDecision, 0);
  });
});

function writeLegacyTask(rootDir: string, id: string): void {
  const taskDir = path.join(rootDir, "docs/09-PLANNING/TASKS", id);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(path.join(taskDir, "task_plan.md"), `# ${id}\n\nTask Contract: harness-task/v1\n`, "utf8");
}

function writeLegacyModuleTask(rootDir: string, moduleKey: string, id: string): void {
  const taskDir = path.join(rootDir, "docs/09-PLANNING/MODULES", moduleKey, "TASKS", id);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(path.join(taskDir, "task_plan.md"), `# ${id}\n`, "utf8");
}

function writeCutoverReadySurface(rootDir: string): void {
  writePackage(rootDir, "package.json", { name: "harness-anything", private: true });
  writePackage(rootDir, "packages/kernel/package.json", { name: "@harness-anything/kernel", version: "0.0.0", private: true });
  writePackage(rootDir, "packages/application/package.json", { name: "@harness-anything/application", version: "0.0.0", private: true });
  writePackage(rootDir, "packages/gui/package.json", { name: "@harness-anything/gui", version: "0.0.0", private: true });
  writePackage(rootDir, "packages/adapters/local/package.json", { name: "@harness-anything/adapter-local", version: "0.0.0", private: true });
  writePackage(rootDir, "packages/adapters/multica/package.json", { name: "@harness-anything/adapter-multica", version: "0.0.0", private: true });
  writePackage(rootDir, "packages/adapters/github-issues/package.json", { name: "@harness-anything/adapter-github-issues", version: "0.0.0", private: true });
  writePackage(rootDir, "packages/adapters/linear/package.json", { name: "@harness-anything/adapter-linear", version: "0.0.0", private: true });
  writePackage(rootDir, "packages/cli/package.json", {
    name: "@harness-anything/cli",
    version: "0.0.0",
    private: true,
    bin: { "harness-anything": "./dist/cli/src/index.js" },
    exports: { ".": "./dist/cli/src/index.js" }
  });

  const cutoverDir = path.join(rootDir, "tools/cutover");
  mkdirSync(cutoverDir, { recursive: true });
  writeFileSync(path.join(cutoverDir, "behavior-corpus-classification.json"), JSON.stringify({
    schema: "harness-anything-behavior-corpus-classification/v1",
    scope: "M2 final cutover",
    publishState: "not-published",
    categories: {
      preserve: 7,
      "intentional-change": 5,
      "old-bug": 1,
      "unsupported-input": 2,
      "needs-decision": 0
    },
    items: [
      ...Array.from({ length: 7 }, (_, index) => ({ classification: "preserve", summary: `preserve ${index}` })),
      ...Array.from({ length: 5 }, (_, index) => ({ classification: "intentional-change", summary: `intentional ${index}` })),
      { classification: "old-bug", summary: "old compatibility promise" },
      { classification: "unsupported-input", summary: "conflicting legacy tree" },
      { classification: "unsupported-input", summary: "npm publishing deferred" }
    ]
  }), "utf8");
  writeFileSync(path.join(cutoverDir, "behavior-corpus-classification.md"), "# Behavior Corpus Classification\n", "utf8");
}

function writePackage(rootDir: string, relativePath: string, packageJson: Record<string, any>): void {
  const fullPath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, JSON.stringify(packageJson), "utf8");
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
