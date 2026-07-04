import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.equal(existsSync(path.join(rootDir, "harness/tasks")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/adr")), true);
    assert.match(readFileSync(path.join(rootDir, "harness/standards/repo-governance.md"), "utf8"), /Repository Governance/u);
    // AGENTS.md is deterministically composed from L1 base + L2 overlay with an
    // empty L3 `## Repository Specifics` anchor reserved (ADR-0021 D2).
    const agents = readFileSync(path.join(rootDir, "AGENTS.md"), "utf8");
    assert.match(agents, /Harness Agent Entry/u);
    assert.match(agents, /## Kernel Workflow \(triadic\)/u);
    assert.match(agents, /## WriteCoordinator discipline/u);
    assert.match(agents, /## Task reading matrix/u);
    assert.match(agents, /## Harness CLI \(software\/coding\)/u);
    assert.match(agents, /## Scaffold folders/u);
    assert.match(agents, /## Governance routing \(near-field hard gates\)/u);
    assert.match(agents, /## Repository Specifics/u);
    // D3: overlay only routes to folder READMEs, it never restates their bodies.
    assert.match(agents, /harness\/adr\/README\.md/u);
    assert.match(readFileSync(path.join(rootDir, "CLAUDE.md"), "utf8"), /Claude Harness Entry/u);
    // Every scaffold folder ships a guide README (ADR-0021 D1). Seeding the
    // decisions/sessions guides also materializes their (otherwise lazy) roots.
    assert.equal(existsSync(path.join(rootDir, "harness/decisions")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/sessions")), true);
    assert.match(readFileSync(path.join(rootDir, "harness/adr/README.md"), "utf8"), /## Usage/u);
    assert.match(readFileSync(path.join(rootDir, "harness/decisions/README.md"), "utf8"), /## 用途/u);
    assert.match(readFileSync(path.join(rootDir, "harness/milestones/README.md"), "utf8"), /## 用途/u);
    assert.match(readFileSync(path.join(rootDir, "harness/sessions/README.md"), "utf8"), /## 用途/u);
    assert.match(readFileSync(path.join(rootDir, "harness/standards/README.md"), "utf8"), /## 用途/u);
    assert.match(readFileSync(path.join(rootDir, "harness/context/README.md"), "utf8"), /## 用途/u);
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

test("CLI init updates the discovered config for a custom authored root project", () => {
  withTempRoot((rootDir) => {
    const configPath = writeExistingHarnessConfig(rootDir, "old-project", ".custom-harness");
    mkdirSync(path.join(rootDir, ".custom-harness"), { recursive: true });

    const result = runJson(rootDir, ["init", "--name", "new-project"]);

    assert.equal(result.ok, true);
    assert.equal(result.path, "harness/harness.yaml");
    assert.equal(readFileSync(configPath, "utf8"), existingHarnessConfig("new-project", ".custom-harness"));
    assert.equal(existsSync(path.join(rootDir, ".custom-harness/harness.yaml")), false);
  });
});

test("CLI readonly version and gui commands do not create a lifecycle engine before dispatch", () => {
  withTempRoot((rootDir) => {
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness", "harness.yaml"), [
      "schema: harness-anything/v1",
      "name: broken-layout",
      "layout:",
      "  authoredRoot: /not/relative",
      ""
    ].join("\n"), "utf8");

    const version = runJson(rootDir, ["version"]);
    const gui = runJson(rootDir, ["gui"], { HARNESS_GUI_DRY_RUN: "1" });

    assert.equal(version.ok, true);
    assert.equal(version.command, "version");
    assert.equal(gui.ok, true);
    assert.equal(gui.command, "gui");
    assert.equal(gui.launchPlan.dryRun, true);
  });
});

function writeExistingHarnessConfig(rootDir: string, name: string, authoredRoot = "harness"): string {
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  const configPath = path.join(rootDir, "harness/harness.yaml");
  writeFileSync(configPath, existingHarnessConfig(name, authoredRoot), "utf8");
  return configPath;
}

function existingHarnessConfig(name: string, authoredRoot = "harness"): string {
  return [
    "schema: harness-anything/v1",
    `name: ${name}`,
    "layout:",
    `  authoredRoot: ${authoredRoot}`,
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

function runJson(rootDir: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv): Record<string, any> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env
  });
  return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
}
