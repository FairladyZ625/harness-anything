#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const cli = path.join(root, "packages/cli/src/index.ts");
const retiredEntrypoints = [
  "packages/cli/src/commands/core/migration.ts",
  "packages/cli/src/commands/migration.ts",
  "packages/cli/src/commands/migration-scan.ts",
  "packages/cli/src/commands/migration-collision.ts",
  "packages/cli/src/cli/parse-migration-args.ts",
  "packages/cli/src/cli/parsers/migration-diagnostics.ts"
];
const smokeRoot = mkdtempSync(path.join(tmpdir(), "ha-retired-legacy-intake-"));

try {
  const restored = retiredEntrypoints.filter((relativePath) => existsSync(path.join(root, relativePath)));
  if (restored.length > 0) throw new Error(`retired Legacy Intake entrypoints returned: ${restored.join(", ")}`);

  const receipt = runRetiredCommand();
  if (receipt.schema !== "command-receipt/v2" || receipt.ok !== false || receipt.error?.code !== "unsupported_command") {
    throw new Error(`retired migrate-run must be rejected by the thin parser: ${JSON.stringify(receipt)}`);
  }
  if (readdirSync(smokeRoot).length !== 0) throw new Error("retired migrate-run wrote workspace state");

  console.log("Legacy Intake retirement smoke passed: old entrypoints are absent and migrate-run is unsupported.");
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}

function runRetiredCommand() {
  try {
    execFileSync(process.execPath, [cli, "migrate-run", "--root", smokeRoot, "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    throw new Error("retired migrate-run unexpectedly succeeded");
  } catch (error) {
    if (error instanceof Error && error.message === "retired migrate-run unexpectedly succeeded") throw error;
    const output = String(error?.stdout ?? "").trim();
    if (output.length === 0) throw new Error(`retired migrate-run emitted no JSON receipt: ${String(error?.stderr ?? "")}`);
    return JSON.parse(output);
  }
}
