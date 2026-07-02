import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI reports actionable journal cause when authored root is ignored without nested Git repo", () => {
  withTempRoot((rootDir) => {
    runGit(rootDir, "init");
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    runGit(rootDir, "add", ".gitignore");
    runGit(rootDir, "commit", "-m", "ignore private harness");
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/harness.yaml"), [
      "schema: harness-anything/v1",
      "name: ignored-authored-root",
      "layout:",
      "  authoredRoot: harness",
      "  localRoot: .harness",
      "tasks:",
      "  root: harness/tasks",
      ""
    ].join("\n"), "utf8");

    const failure = runJson(rootDir, ["new-task", "--title", "Ignored Root"], false);

    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "journal_unavailable");
    assert.match(failure.error?.hint, /authored root is ignored by Git but is not a nested Git repository/);
    assert.equal(JSON.stringify(failure).includes(rootDir), false);
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-boundary-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return JSON.parse(failure.stdout ?? "{}") as Record<string, any>;
  }
}

function runGit(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Harness Test",
      GIT_AUTHOR_EMAIL: "harness-test@example.invalid",
      GIT_COMMITTER_NAME: "Harness Test",
      GIT_COMMITTER_EMAIL: "harness-test@example.invalid"
    }
  }).trim();
}
