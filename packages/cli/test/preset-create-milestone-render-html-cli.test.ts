// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI create-milestone render-html derives a deterministic self-contained dossier from the public machine summary", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    const task = runJson(rootDir, ["task", "create", "--title", "Renderer Coordination"]);
    mkdirSync(path.join(rootDir, "harness/milestones"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/milestones/milestones-summary.md"), [
      "# Milestone Dossier Data",
      "",
      "| Line | Milestone | Status | One-line goal | Root task id | Child count | Dependencies / entry | Batch |",
      "| --- | --- | --- | --- | --- | ---: | --- | --- |",
      "| platform | PLT-Render | active | Derive HTML mechanically. | `task_RENDER_ROOT` | 2 | dec_RENDER | current |",
      "| gui | GUI-Shell | planned | Keep the shell inspectable. | `task_GUI_ROOT` | 0 | task_RENDER_ROOT | next |",
      ""
    ].join("\n"), "utf8");

    const first = runJson(rootDir, ["script", "run", "preset:create-milestone:render-html", "--task", String(task.taskId)]);
    const htmlPath = path.join(rootDir, "harness/milestones/milestones.html");
    const firstHtml = readFileSync(htmlPath, "utf8");
    const second = runJson(rootDir, ["script", "run", "preset:create-milestone:render-html", "--task", String(task.taskId)]);
    const secondHtml = readFileSync(htmlPath, "utf8");

    assert.equal(first.ok, true);
    assert.equal(first.report.html.milestones, 2);
    assert.equal(second.ok, true);
    assert.equal(second.report.html.milestones, 2);
    assert.equal(secondHtml, firstHtml);
    assert.match(firstHtml, /PLT-Render/u);
    assert.match(firstHtml, /GUI-Shell/u);
    assert.match(firstHtml, /--done:#5f7a55/u);
    assert.match(firstHtml, /data-theme/u);
    assert.doesNotMatch(firstHtml, /https?:\/\//u);
    assert.doesNotMatch(firstHtml, /cdn/u);
  });
});

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-create-milestone-render-"));
  ensureTestHarnessIdentity(rootDir);
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
