import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI init defaults harness project name from the target root basename", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["init"]);
    const config = readFileSync(path.join(rootDir, "harness/harness.yaml"), "utf8");

    assert.equal(result.ok, true);
    assert.equal(result.path, "harness/harness.yaml");
    assert.match(config, new RegExp(`^name: ${path.basename(rootDir)}$`, "m"));
  });
});

test("CLI init accepts an explicit project name", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["init", "--name", "human-kernel"]);

    assert.equal(result.ok, true);
    assert.match(readFileSync(path.join(rootDir, "harness/harness.yaml"), "utf8"), /^name: human-kernel$/m);
  });
});

test("CLI init keeps existing harness config unchanged without explicit name", () => {
  withTempRoot((rootDir) => {
    const configPath = writeExistingHarnessConfig(rootDir, "existing-project");

    const result = runJson(rootDir, ["init"]);

    assert.equal(result.ok, true);
    assert.equal(readFileSync(configPath, "utf8"), existingHarnessConfig("existing-project"));
  });
});

test("CLI init updates only the project name when explicitly requested", () => {
  withTempRoot((rootDir) => {
    const configPath = writeExistingHarnessConfig(rootDir, "old-project");

    const result = runJson(rootDir, ["init", "--name", "new-project"]);

    assert.equal(result.ok, true);
    assert.equal(readFileSync(configPath, "utf8"), existingHarnessConfig("new-project"));
  });
});

function writeExistingHarnessConfig(rootDir: string, name: string): string {
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  const configPath = path.join(rootDir, "harness/harness.yaml");
  writeFileSync(configPath, existingHarnessConfig(name), "utf8");
  return configPath;
}

function existingHarnessConfig(name: string): string {
  return [
    "schema: harness-anything/v1",
    `name: ${name}`,
    "layout:",
    "  authoredRoot: harness",
    "  localRoot: .harness",
    "settings:",
    "  locale: en-US",
    ""
  ].join("\n");
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-init-cli-"));
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
  return JSON.parse(stdout) as Record<string, any>;
}
