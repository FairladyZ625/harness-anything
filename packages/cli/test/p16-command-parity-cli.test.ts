import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("P16 new-task dry-run and inline module registration are explicit and non-destructive", () => {
  withTempRoot((rootDir) => {
    const dryRun = runJson(rootDir, ["new-task", "--title", "Billing Work", "--register-module", "billing", "--module-title", "Billing", "--module-prefix", "BILL", "--module-scope", "packages/billing/**", "--long-running", "--dry-run", "--locale", "en-US"]);

    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.report.dryRun, true);
    assert.equal(dryRun.report.longRunning, true);
    assert.equal(dryRun.generated.includes("long-running-task-contract.md"), true);
    assert.equal(existsSync(path.join(rootDir, "harness/modules.json")), false);
    assert.equal(existsSync(path.join(rootDir, dryRun.packagePath)), false);

    const created = runJson(rootDir, ["new-task", "--title", "Billing Work", "--register-module", "billing", "--module-title", "Billing", "--module-prefix", "BILL", "--module-scope", "packages/billing/**", "--long-running"]);

    assert.equal(created.ok, true);
    assert.equal(created.module.key, "billing");
    assert.equal(existsSync(path.join(rootDir, created.packagePath, "long-running-task-contract.md")), true);
    const modules = JSON.parse(readFileSync(path.join(rootDir, "harness/modules.json"), "utf8"));
    assert.equal(modules.modules[0].key, "billing");
    assert.equal(modules.modules[0].prefix, "BILL");

    const duplicate = runJson(rootDir, ["new-task", "--id", created.taskId, "--migration", "--title", "Duplicate Billing", "--register-module", "failed", "--module-title", "Failed", "--module-scope", "packages/failed/**"], false);
    assert.equal(duplicate.ok, false);
    const unchangedModules = JSON.parse(readFileSync(path.join(rootDir, "harness/modules.json"), "utf8"));
    assert.equal(unchangedModules.modules.some((module: Record<string, unknown>) => module.key === "failed"), false);
  });
});

test("P16 lifecycle provenance flags write auditable task notes", () => {
  withTempRoot((rootDir) => {
    const oldTask = runJson(rootDir, ["new-task", "--title", "Old Task"]);
    const replacement = runJson(rootDir, ["new-task", "--title", "Replacement Task"]);

    const progress = runJson(rootDir, ["task", "progress", "append", oldTask.taskId, "--text", "Ran verification", "--evidence", "log:artifacts/check.log:passed"]);
    assert.equal(progress.report.evidence.path, "artifacts/check.log");
    assert.match(readFileSync(path.join(rootDir, oldTask.packagePath, "progress.md"), "utf8"), /Evidence: log:artifacts\/check.log:passed/);

    const mismatch = runJson(rootDir, ["task", "supersede", oldTask.taskId, "--by", replacement.taskId, "--confirm", "wrong"], false);
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error.code, "supersede_confirm_mismatch");

    const missingConfirm = runJson(rootDir, ["task", "supersede", oldTask.taskId, "--by", replacement.taskId], false);
    assert.equal(missingConfirm.ok, false);
    assert.equal(missingConfirm.error.code, "supersede_confirm_required");

    const missingTarget = runJson(rootDir, ["task", "supersede", oldTask.taskId, "--by", "task_00000000000000000000000000", "--confirm", oldTask.taskId], false);
    assert.equal(missingTarget.ok, false);
    assert.equal(missingTarget.error.code, "supersede_target_not_found");

    const superseded = runJson(rootDir, ["task", "supersede", oldTask.taskId, "--by", replacement.taskId, "--confirm", oldTask.taskId, "--allow-open-findings", "--deleted-by", "alice"]);
    assert.equal(superseded.ok, true);
    assert.equal(superseded.report.relationSemantics, "not-created");
    const oldIndex = readFileSync(path.join(rootDir, oldTask.packagePath, "INDEX.md"), "utf8");
    assert.match(oldIndex, /packageDisposition: archived/);
    assert.match(oldIndex, new RegExp(`supersededBy=${replacement.taskId}`));
    assert.match(oldIndex, /deletedBy=alice/);

    const archivedTask = runJson(rootDir, ["new-task", "--title", "Archive Task"]);
    runJson(rootDir, ["task", "archive", archivedTask.taskId, "--reason", "done elsewhere", "--archived-by", "bob", "--archive-field", "packageDisposition"]);
    const archivedIndex = readFileSync(path.join(rootDir, archivedTask.packagePath, "INDEX.md"), "utf8");
    assert.match(archivedIndex, /archivedBy=bob/);
    assert.match(archivedIndex, /archiveField=packageDisposition/);

    const deleteTask = runJson(rootDir, ["new-task", "--title", "Delete Task"]);
    const deleteMismatch = runJson(rootDir, ["task", "delete", "--soft", deleteTask.taskId, "--reason", "cleanup", "--confirm", "wrong"], false);
    assert.equal(deleteMismatch.error.code, "delete_confirm_mismatch");
    runJson(rootDir, ["task", "delete", "--soft", deleteTask.taskId, "--reason", "cleanup", "--confirm", deleteTask.taskId, "--deleted-by", "carol"]);
    assert.match(readFileSync(path.join(rootDir, deleteTask.packagePath, "INDEX.md"), "utf8"), /deletedBy=carol/);
  });
});

test("P16 init and migrate compatibility flags produce explicit report fields", () => {
  withTempRoot((rootDir) => {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ name: "sample", scripts: { test: "node --test" } }, null, 2), "utf8");
    const init = runJson(rootDir, ["init", "--add-npm-scripts"]);
    assert.equal(init.ok, true);
    assert.deepEqual(init.generated, ["package.json"]);
    const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
    assert.equal(packageJson.scripts.test, "node --test");
    assert.equal(packageJson.scripts.harness, "harness-anything");
    assert.equal(packageJson.scripts["harness:check"], "harness-anything check");

    const migrate = runJson(rootDir, ["migrate-run", "--plan-only", "--session-dir", ".harness/generated/migration-sessions/p16", "--locale", "en-US", "--assume-locale", "zh-CN", "--allow-dirty"]);
    assert.equal(migrate.ok, true);
    assert.equal(migrate.path, ".harness/generated/migration-sessions/p16/session.json");
    assert.deepEqual(migrate.report.compatibility, {
      locale: "en-US",
      assumeLocale: "zh-CN",
      allowDirty: true,
      sessionDir: ".harness/generated/migration-sessions/p16"
    });
  });
});

test("P16 module register stores governance metadata", () => {
  withTempRoot((rootDir) => {
    const registered = runJson(rootDir, ["module", "register", "billing", "--title", "Billing", "--scope", "packages/billing/**", "--prefix", "BILL", "--status", "active", "--branch", "main", "--owner", "team-a", "--current-step", "BILL-01", "--shared", "docs/**", "--depends-on", "kernel"]);

    assert.equal(registered.ok, true);
    assert.equal(registered.module.prefix, "BILL");
    assert.equal(registered.module.owner, "team-a");
    assert.deepEqual(registered.module.shared, ["docs/**"]);
    assert.deepEqual(registered.module.dependsOn, ["kernel"]);

    const inspected = runJson(rootDir, ["module", "inspect", "billing"]);
    assert.equal(inspected.module.currentStep, "BILL-01");
    assert.match(readFileSync(path.join(rootDir, ".harness/generated/Module-Registry.md"), "utf8"), /team-a/);
  });
});

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    return JSON.parse(stdout) as Record<string, any>;
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return JSON.parse(failure.stdout ?? "{}") as Record<string, any>;
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-p16-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
