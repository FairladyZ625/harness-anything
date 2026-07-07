import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("doctor reports read-only environment and harness diagnostics without writing local state", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["doctor"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "doctor");
    assert.equal(result.report.schema, "harness-doctor/v1");
    assert.equal(result.report.readOnly, true);
    assert.equal(result.report.node.requiredMajor, 24);
    assert.equal(typeof result.report.node.ok, "boolean");
    assert.equal(result.report.harness.authoredRoot, "harness");
    assert.equal(result.report.harness.authoredRootExists, false);
    assert.equal(result.report.harness.localRootExists, false);
    assert.equal(result.report.recommendedCommands.includes("harness-anything check --post-merge --json"), true);
    assert.equal(JSON.stringify(result).includes(rootDir), false);
    assert.equal(existsSync(path.join(rootDir, ".harness")), false);
  });
});

test("doctor sees initialized authored and generated harness roots without repairing them", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);

    const result = runJson(rootDir, ["doctor"]);

    assert.equal(result.ok, true);
    assert.equal(result.report.harness.authoredRootExists, true);
    assert.equal(result.report.harness.localRootExists, true);
    assert.equal(result.report.cli.command, "harness-anything doctor");
  });
});

test("status command registry includes doctor", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);

    const result = runJson(rootDir, ["status"]);

    assert.equal(result.ok, true);
    const doctor = result.commands.find((entry: Record<string, unknown>) => entry.kind === "doctor");
    assert.equal(doctor?.primary, "harness-anything doctor --json");
    assert.equal(doctor?.aliases.includes("ha doctor --json"), true);
  });
});

test("CLI help prints canonical command and alias", () => {
  withTempRoot((rootDir) => {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--help"], {
      encoding: "utf8"
    });

    assert.match(stdout, /Usage: harness-anything <command> \[options\]/u);
    assert.match(stdout, /Alias: ha <command> \[options\]/u);
    assert.match(stdout, /harness-anything doctor --json/u);
  });
});

test("command-level help exits without creating task state", () => {
  withTempRoot((rootDir) => {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "task", "create", "--help"], {
      encoding: "utf8"
    });

    assert.match(stdout, /Usage: harness-anything task create --title <title>/u);
    assert.match(stdout, /Aliases:/u);
    assert.match(stdout, /new-task --title <title> \(deprecated, use task create; retires at E77\/F6 acceptance\)/u);
    assert.match(stdout, /Options:/u);
    assert.match(stdout, /--title/u);
    assert.match(stdout, /Recommended presets:/u);
    assert.match(stdout, /standard-task\s+General implementation or maintenance task; the default starting point\./u);
    assert.match(stdout, /decision-conformance\s+Work that must prove alignment with recorded decisions\./u);
    assert.match(stdout, /milestone-closeout\s+Milestone wrap-up checks and evidence collection\./u);
    assert.match(stdout, /ha task create --title "\.\.\." --vertical software\/coding --preset <id>/u);
    assert.equal(existsSync(path.join(rootDir, "harness")), false);
    assert.equal(existsSync(path.join(rootDir, ".harness")), false);
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doctor-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8"
  });
  return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
}
