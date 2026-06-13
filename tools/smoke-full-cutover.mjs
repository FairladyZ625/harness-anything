#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const cli = path.join(root, "packages/cli/src/index.ts");
const outDir = ".harness/generated/full-cutover-smoke";

function runJson(args) {
  const output = execFileSync(process.execPath, [cli, ...args, "--root", root, "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return JSON.parse(output);
}

try {
  rmSync(path.join(root, outDir), { recursive: true, force: true });
  const run = runJson(["migrate-run", "--plan-only", "--out-dir", outDir]);
  if (run.ok !== true || run.report?.schema !== "harness-migration-session/v1") {
    throw new Error("migrate-run did not produce a migration session");
  }

  const verify = runJson(["migrate-verify", run.path, "--full-cutover"]);
  if (verify.ok !== true || verify.report?.fullCutoverEvidence?.ok !== true) {
    throw new Error("full-cutover verify did not accept real repository evidence");
  }

  const itemCount = verify.report.fullCutoverEvidence.behaviorCorpus.itemCount;
  if (itemCount < 15) throw new Error(`behavior corpus too small: ${itemCount}`);

  console.log(`Full cutover smoke passed with ${itemCount} behavior corpus items.`);
} finally {
  rmSync(path.join(root, outDir), { recursive: true, force: true });
}
