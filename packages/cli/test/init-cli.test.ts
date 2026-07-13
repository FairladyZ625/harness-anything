// harness-test-tier: integration
import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolveHarnessLayout } from "../../kernel/src/index.ts";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;
const noAgentRuntimeEnv = {
  CLAUDE_SESSION_ID: "",
  CLAUDE_CODE_SESSION_ID: "",
  CODEX_SESSION_ID: "",
  CODEX_THREAD_ID: "",
  ZCODE_SESSION_ID: "",
  ANTIGRAVITY_SESSION_ID: ""
};

test("CLI init defaults harness project name from the target root basename", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["init"]);
    const config = readFileSync(path.join(rootDir, "harness/harness.yaml"), "utf8");

    assert.equal(result.ok, true);
    assert.equal(result.path, "harness/harness.yaml");
    assert.equal(result.report.schema, "init-configure-verify-report/v1");
    assert.match(result.report.configureVerify.smokeTaskId, taskIdPattern);
    assert.equal(result.report.configureVerify.smokeTaskFound, true);
    assert.equal(result.report.configureVerify.smokeTaskCleanedUp, true);
    assert.equal(result.report.configureVerify.projectionPath, ".harness/cache/projections.sqlite");
    assert.equal(result.report.isolation.innerRepository.gitDirExists, true);
    assert.equal(result.report.isolation.innerRepository.branch, "master");
    assert.equal(result.report.isolation.innerRepository.commitCount, 1);
    assert.equal(result.report.isolation.outerGitignore.action, "skipped-not-git");
    assert.equal(resolveHarnessLayout(path.join(rootDir, "harness")).rootDir, rootDir);
    assert.match(result.receiptSummary, /Code PRs must not include harness\/ changes/u);
    assert.match(config, new RegExp(`^name: ${path.basename(rootDir)}$`, "m"));
    assert.equal(existsSync(path.join(rootDir, "harness/tasks")), true);
    assert.equal(existsSync(path.join(rootDir, result.report.configureVerify.smokeTaskPackagePath)), false);
    assert.equal(existsSync(path.join(rootDir, "harness/adr")), true);
    assert.match(readFileSync(path.join(rootDir, "harness/standards/repo-governance.md"), "utf8"), /Repository Governance/u);
    // AGENTS.md is deterministically composed from L1 base + L2 overlay with an
    // empty L3 `## Repository Specifics` anchor reserved (ADR-0021 D2).
    const agents = readFileSync(path.join(rootDir, "AGENTS.md"), "utf8");
    assert.match(agents, /Harness Agent Entry/u);
    assert.match(agents, /## Context loading/u);
    assert.match(agents, /## Worktree discipline/u);
    assert.match(agents, /## Kernel Workflow \(triadic\)/u);
    assert.match(agents, /## Relation edge rules/u);
    assert.match(agents, /## WriteCoordinator discipline/u);
    assert.match(agents, /## Harness CLI \(software\/coding\)/u);
    assert.match(agents, /## Scaffold folders/u);
    assert.match(agents, /## Architecture-aware code changes/u);
    assert.match(agents, /architecture-manifest\.json/u);
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
    const architectureGuide = readFileSync(path.join(rootDir, "harness/context/architecture/README.md"), "utf8");
    assert.match(architectureGuide, /## Activation/u);
    assert.match(architectureGuide, /## Agent Query Routing/u);
    assert.match(architectureGuide, /MCP/u);
    assert.equal(existsSync(path.join(rootDir, "harness/context/architecture/architecture-manifest.json")), false);
    assert.equal(existsSync(path.join(rootDir, "harness/context/architecture/model")), false);
  });
});

test("CLI init preserves existing architecture assets without enabling or completing the scaffold", () => {
  withTempRoot((rootDir) => {
    const architectureRoot = path.join(rootDir, "harness/context/architecture");
    const modelRoot = path.join(architectureRoot, "model");
    mkdirSync(modelRoot, { recursive: true });
    writeFileSync(path.join(architectureRoot, "README.md"), "existing architecture guide\n", "utf8");
    writeFileSync(path.join(architectureRoot, "architecture-manifest.json"), "existing manifest\n", "utf8");
    writeFileSync(path.join(modelRoot, "model.c4"), "existing model\n", "utf8");

    const result = runJson(rootDir, ["init"]);

    assert.equal(result.ok, true);
    assert.equal(readFileSync(path.join(architectureRoot, "README.md"), "utf8"), "existing architecture guide\n");
    assert.equal(readFileSync(path.join(architectureRoot, "architecture-manifest.json"), "utf8"), "existing manifest\n");
    assert.equal(readFileSync(path.join(modelRoot, "model.c4"), "utf8"), "existing model\n");
    assert.equal(existsSync(path.join(modelRoot, "specification.c4")), false);
    assert.equal(existsSync(path.join(modelRoot, "views")), false);
  });
});

test("CLI init isolates harness in an outer git repository", () => {
  withTempGitRoot((rootDir) => {
    const result = runJson(rootDir, ["init"]);
    const gitignore = readFileSync(path.join(rootDir, ".gitignore"), "utf8");

    assert.equal(result.ok, true);
    assert.equal(existsSync(path.join(rootDir, "harness/.git")), true);
    assert.equal(runGitText(path.join(rootDir, "harness"), "branch", "--show-current"), "master");
    assert.equal(runGitText(path.join(rootDir, "harness"), "rev-list", "--count", "HEAD"), "1");
    assert.match(runGitText(path.join(rootDir, "harness"), "show", "--name-only", "--format=", "HEAD"), /harness\.yaml/u);
    assert.match(gitignore, /^\.harness\/$/m);
    assert.match(gitignore, /^harness\/$/m);
    assert.equal(result.report.isolation.outerGit.insideWorkTree, true);
    assert.equal(result.report.isolation.outerGitignore.action, "updated");
    assert.equal(result.report.isolation.innerRepository.action, "initialized");
  });
});

test("CLI init skips existing inner harness git repository and keeps gitignore idempotent", () => {
  withTempGitRoot((rootDir) => {
    const first = runJson(rootDir, ["init"]);
    const second = runJson(rootDir, ["init"]);
    const gitignoreLines = readFileSync(path.join(rootDir, ".gitignore"), "utf8").split(/\r?\n/u);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.report.isolation.innerRepository.action, "skipped-existing");
    assert.equal(second.report.isolation.innerRepository.commitCount, 1);
    assert.equal(gitignoreLines.filter((line) => line === "harness/").length, 1);
    assert.equal(gitignoreLines.filter((line) => line === ".harness/").length, 1);
  });
});

test("CLI init creates an inner harness repo without an outer git repository", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["init"]);

    assert.equal(result.ok, true);
    assert.equal(existsSync(path.join(rootDir, "harness/.git")), true);
    assert.equal(existsSync(path.join(rootDir, ".gitignore")), false);
    assert.equal(result.report.isolation.outerGit.insideWorkTree, false);
    assert.equal(result.report.isolation.outerGitignore.action, "skipped-not-git");
  });
});

test("CLI init fails closed when Configure-Verify cannot write the projection", () => {
  withTempRoot((rootDir) => {
    mkdirSync(path.join(rootDir, ".harness/cache/projections.sqlite"), { recursive: true });

    const result = runJson(rootDir, ["init"], undefined, false);

    assert.equal(result.ok, false);
    assert.equal(result.command, "init");
    assert.match(result.error?.hint ?? "", /projection|write|rename|directory|EISDIR|ENOTDIR/u);
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

test("CLI init does not materialize coding scaffold for an unresolved non-coding active vertical", () => {
  withTempRoot((rootDir) => {
    const configPath = path.join(rootDir, "harness/harness.yaml");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, [
      "schema: harness-anything/v1",
      "name: custom-project",
      "settings:",
      "  locale: zh-CN",
      "  defaultVertical: custom/acme",
      "  defaultPreset: standard-task",
      "  identity:",
      "    personId: person_test",
      "    displayName: Harness Test",
      "  customVerticals:",
      "    enabled: false",
      ""
    ].join("\n"));

    const result = runJson(rootDir, ["init"], {
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DIRECT_WRITE_REASON: "test",
      HARNESS_ACTOR: "agent:init-test",
      HARNESS_GIT_AUTHOR_NAME: "Harness Test",
      HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test"
    }, false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "custom_vertical_user_dev_mode_required", JSON.stringify(result));
    assert.equal(existsSync(path.join(rootDir, "AGENTS.md")), false);
    assert.equal(existsSync(path.join(rootDir, "harness/context")), false);
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
    const gui = runJson(rootDir, ["gui"], {
      HARNESS_GUI_DRY_RUN: "1",
      HARNESS_DIRECT_WRITE_REASON: "test"
    });

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

function withTempGitRoot<T>(fn: (rootDir: string) => T): T {
  return withTempRoot((rootDir) => {
    runGit(rootDir, "init", "--initial-branch=main");
    return fn(rootDir);
  });
}

function runGitText(rootDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    env: gitEnv()
  }).trim();
}

function runGit(rootDir: string, ...args: string[]): void {
  execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    env: gitEnv()
  });
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Harness Test",
    GIT_AUTHOR_EMAIL: "harness-test@example.invalid",
    GIT_COMMITTER_NAME: "Harness Test",
    GIT_COMMITTER_EMAIL: "harness-test@example.invalid"
  };
}

function runJson(rootDir: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: { ...process.env, ...noAgentRuntimeEnv, ...(env ?? {}) }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}
