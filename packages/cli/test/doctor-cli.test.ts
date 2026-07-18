// harness-test-tier: integration
import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { commandGroups } from "../src/cli/command-spec/command-groups.ts";
import { commandRegistry } from "../src/cli/command-registry.ts";

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

test("CLI global help matches the layered discovery snapshot", () => {
  withTempRoot((rootDir) => {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--help"], {
      encoding: "utf8"
    });

    assert.equal(stdout, readSnapshot("global-help.txt"));
    assert.equal(Buffer.byteLength(stdout) <= 2_000, true, "global help must remain at or below 2 KB");
  });
});

test("CLI global help groups exactly cover every top-level command kind plus daemon", () => {
  const registryKinds = new Set(commandRegistry.flatMap((entry) => entry.commandPath[0] ? [entry.commandPath[0]] : []));
  const expected = [...registryKinds, "daemon"].sort();
  assert.deepEqual(commandGroups.map((group) => group.name).sort(), expected);
});

test("CLI task help lists every task leaf and declares --json only as a global option", () => {
  withTempRoot((rootDir) => {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "task", "--help"], {
      encoding: "utf8"
    });
    const renderedTaskLeaves = stdout.split("\n").filter((line) => line.startsWith("  harness-anything task "));
    const expectedTaskLeaves = commandRegistry
      .filter((entry) => entry.commandPath[0] === "task")
      .map((entry) => `  ${entry.primary.replace(/ \[--json\]/gu, "").replace(/ --json$/u, "")} - ${entry.summary}`);

    assert.deepEqual(renderedTaskLeaves, expectedTaskLeaves);
    assert.equal(stdout.match(/--json(?!-input)/gu)?.length, 1);
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
      "logs",
      "stop",
      "restart",
      "refresh"
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
    assert.doesNotMatch(stdout, /new-task --title <title> \(deprecated/u);
    assert.equal(stdout.match(/--json(?!-input)/gu)?.length, 1);
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

test("migration help marks only the accepted sunset commands deprecated", () => {
  withTempRoot((rootDir) => {
    const migration = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "migrate", "--help"], { encoding: "utf8" });

    assert.match(migration, /migrate plan.*Deprecated — sunset stage 1\/3/u);
    assert.match(migration, /migrate retired-attribution-fields.*Deprecated — sunset stage 1\/3/u);
    assert.doesNotMatch(migration, /migrate fact-execution.*Deprecated/u);
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

function readSnapshot(name: string): string {
  return readFileSync(path.resolve("packages/cli/test/snapshots", name), "utf8");
}
