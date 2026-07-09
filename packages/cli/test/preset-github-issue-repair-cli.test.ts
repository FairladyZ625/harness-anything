import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI github issue repair preset pulls an issue fixture and writes a repair plan", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "harness/tasks/task-github-issue/artifacts/issues.json", JSON.stringify({
      issues: [
        {
          number: 42,
          title: "CLI check fails when preset scripts emit repair evidence",
          state: "open",
          html_url: "https://github.com/FairladyZ625/harness-anything/issues/42",
          user: { login: "agent-reporter" },
          labels: [{ name: "bug" }, { name: "agent-ready" }],
          updated_at: "2026-07-08T12:00:00.000Z",
          body: "Reproduction: run `npm run check` after a preset script writes repair evidence."
        },
        {
          number: 41,
          title: "Blocked design question",
          state: "open",
          html_url: "https://github.com/FairladyZ625/harness-anything/issues/41",
          labels: [{ name: "blocked" }],
          updated_at: "2026-07-09T12:00:00.000Z",
          body: "Needs maintainer decision before implementation."
        }
      ]
    }, null, 2));

    const inspected = runJson(rootDir, ["preset", "inspect", "github-issue-repair"]);
    assert.equal(inspected.preset.kind, "process-action");
    assert.deepEqual(inspected.preset.entrypoints, ["plan"]);

    const listed = runJson(rootDir, ["script", "list", "--source", "preset", "--purpose", "generate"]);
    assert.equal(listed.scripts.some((script: Record<string, unknown>) => script.id === "preset:github-issue-repair:plan"), true);

    const unauthorized = runJson(rootDir, ["preset", "action", "github-issue-repair", "plan", "--task", "task-github-issue"], false);
    assert.equal(unauthorized.error.code, "preset_script_authorization_required");

    const result = runJson(rootDir, [
      "preset", "action", "github-issue-repair", "plan",
      "--task", "task-github-issue",
      "--allow-scripts",
      "--input", "fixtureFile=artifacts/issues.json",
      "--input", "repo=FairladyZ625/harness-anything",
      "--input", "labels=bug"
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.rows, 1);
    assert.equal(result.report.schema, "github-issue-repair-plan/v1");
    assert.equal(result.report.status, "ready");
    assert.equal(result.report.selectedIssue.number, 42);
    assert.match(result.report.prompt, /Repair GitHub issue FairladyZ625\/harness-anything#42/u);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-github-issue/artifacts/github-issue-repair-plan.json")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-github-issue/artifacts/github-issue-repair-plan.md")), true);
    const markdown = readFileSync(path.join(rootDir, "harness/tasks/task-github-issue/artifacts/github-issue-repair-plan.md"), "utf8");
    assert.match(markdown, /Open or update a PR that references FairladyZ625\/harness-anything#42/u);
  });
});

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    const parsed = JSON.parse(output) as Record<string, any>;
    if (expectSuccess) assert.equal(parsed.ok, true, output);
    return unwrapCommandReceipt(parsed);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "harness-preset-github-issue-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const target = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}
