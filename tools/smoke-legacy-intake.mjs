#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const cli = path.join(root, "packages/cli/src/index.ts");
const smokeRoot = mkdtempSync(path.join(tmpdir(), "ha-legacy-intake-smoke-root-"));
const outDir = ".harness/generated/legacy-intake-smoke";

function runJson(args) {
  try {
    const output = execFileSync(process.execPath, [cli, ...args, "--root", smokeRoot, "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return unwrapReceipt(JSON.parse(output));
  } catch (error) {
    const failure = error;
    const body = failure.stdout && failure.stdout.toString().trim().length > 0
      ? failure.stdout.toString()
      : failure.stderr?.toString() ?? "";
    return JSON.parse(body);
  }
}

try {
  const legacyTask = path.join(smokeRoot, "docs/09-PLANNING/TASKS/smoke-task");
  mkdirSync(legacyTask, { recursive: true });
  writeFileSync(path.join(legacyTask, "INDEX.md"), "---\ntitle: Smoke Task\nstatus: done\n---\n# Smoke Task\n", "utf8");
  writeFileSync(path.join(legacyTask, "task_plan.md"), "# Smoke Task\n", "utf8");

  const run = runJson(["migrate-run", "--plan-only", "--out-dir", outDir]);
  if (run.ok !== true || run.report?.schema !== "legacy-intake-session/v1") {
    throw new Error("migrate-run did not produce a Legacy Intake session");
  }

  const verify = runJson(["migrate-verify", run.path, "--full-cutover"]);
  if (verify.ok !== false || verify.error?.code !== "full_cutover_retired") {
    throw new Error("migrate-verify --full-cutover must be retired");
  }

  const copy = runJson(["legacy", "copy-safe-docs", ".", "--apply"]);
  if (copy.ok !== true) throw new Error("legacy copy-safe-docs smoke failed");
  const index = runJson(["legacy", "index", ".", "--apply"]);
  if (index.ok !== true) throw new Error("legacy index smoke failed");
  const legacyVerify = runJson(["legacy", "verify"]);
  if (legacyVerify.ok !== true || legacyVerify.report?.summary?.entryCount !== 1) {
    throw new Error("legacy verify did not accept current Legacy Intake index");
  }

  console.log(`Legacy Intake smoke passed with ${legacyVerify.report.summary.entryCount} entries.`);
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}

function unwrapReceipt(value) {
  if (value.ok !== true) return value;
  if (value.receipt !== "CommandReceipt/v1") {
    throw new Error(`unexpected CommandReceipt/v1 output: ${JSON.stringify(value)}`);
  }
  const data = value.data && typeof value.data === "object" ? value.data : {};
  const paths = value.paths && typeof value.paths === "object" ? value.paths : {};
  return {
    ...data,
    ok: value.ok,
    command: value.command,
    receipt: value.receipt,
    path: paths.primary,
    packagePath: paths.package,
    projectionPath: paths.projection,
    warnings: Array.isArray(value.warnings) ? value.warnings : []
  };
}
