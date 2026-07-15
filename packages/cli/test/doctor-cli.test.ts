// harness-test-tier: integration
import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    assert.equal(result.report.harness.authoredRootGitExists, false);
    assert.equal(result.report.harness.isolation.ok, true);
    assert.equal(result.report.harness.localRootExists, false);
    assert.equal(result.report.recommendedCommands.includes("harness-anything check --post-merge --json"), true);
    assert.equal(JSON.stringify(result).includes(rootDir), false);
    assert.equal(existsSync(path.join(rootDir, ".harness")), false);
  });
});

test("doctor sees initialized authored and generated harness roots without repairing them", () => {
  withTempRoot((rootDir) => {
    const initialized = runJson(rootDir, ["init"]);

    assert.deepEqual(initialized.report.isolation.nextSteps.slice(0, 3), [
      "ha daemon repo register --root .",
      "ha daemon start --service",
      "ha doctor --json"
    ]);

    const result = runJson(rootDir, ["doctor"]);

    assert.equal(result.ok, true);
    assert.equal(result.report.harness.authoredRootExists, true);
    assert.equal(result.report.harness.authoredRootGitExists, true);
    assert.equal(result.report.harness.isolation.ok, true);
    assert.equal(result.report.harness.localRootExists, true);
    assert.equal(result.report.cli.command, "harness-anything doctor");
  });
});

test("doctor reports existing harness that is not isolated from the outer git repository", () => {
  withTempRoot((rootDir) => {
    runGit(rootDir, "init", "--initial-branch=main");
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/harness.yaml"), [
      "schema: harness-anything/v1",
      "name: unisolated",
      "layout:",
      "  authoredRoot: harness",
      "  localRoot: .harness",
      ""
    ].join("\n"), "utf8");

    const result = runJson(rootDir, ["doctor"]);

    assert.equal(result.ok, true);
    assert.equal(result.report.harness.authoredRootExists, true);
    assert.equal(result.report.harness.authoredRootGitExists, false);
    assert.equal(result.report.harness.isolation.ok, false);
    assert.equal(result.report.harness.isolation.findings.some((finding: Record<string, unknown>) => finding.code === "harness_git_missing"), true);
    assert.equal(result.report.harness.isolation.findings.some((finding: Record<string, unknown>) => finding.code === "outer_gitignore_missing"), true);
    assert.equal(result.report.harness.isolation.nextSteps.includes("harness-anything init"), true);
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
    assert.match(stdout, /harness-anything daemon <subcommand> \[options\]/u);
  });
});

test("init text receipt gives the daemon registration and startup path", () => {
  withTempRoot((rootDir) => {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "init"], {
      encoding: "utf8"
    });

    assert.match(stdout, /Next: ha daemon repo register --root \.; then ha daemon start --service; verify with ha doctor --json\./u);
  });
});

test("CLI capabilities exposes daemon onboarding operations", () => {
  withTempRoot((rootDir) => {
    const index = runJson(rootDir, ["capabilities"]);
    const daemon = runJson(rootDir, ["capabilities", "--kind", "daemon"]);

    assert.equal(index.report.items.some((item: Record<string, unknown>) => item.kind === "daemon"), true);
    assert.deepEqual(daemon.report.ops.map((operation: Record<string, unknown>) => operation.action), [
      "register",
      "start",
      "status",
      "stop"
    ]);
    assert.equal(daemon.report.ops[0]?.command, "ha daemon repo register --root .");
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

function runGit(rootDir: string, ...args: string[]): void {
  execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Harness Test",
      GIT_AUTHOR_EMAIL: "harness-test@example.invalid",
      GIT_COMMITTER_NAME: "Harness Test",
      GIT_COMMITTER_EMAIL: "harness-test@example.invalid"
    }
  });
}

function runJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8"
  });
  return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
}
