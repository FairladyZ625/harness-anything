import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import type { RepoCell } from "../src/repo-cell.ts";

export const git = (rootDir: string, ...args: readonly string[]): string =>
  execFileSync("git", args, { cwd: rootDir, encoding: "utf8", windowsHide: true }).trim();

export function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "RepoCell Test");
  git(rootDir, "config", "user.email", "repo-cell@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "config", "maintenance.auto", "false");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
  writeFileSync(path.join(rootDir, "README.md"), "# Review fixture delivery\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "--quiet", "-m", "fixture delivery");
}

export function submissionOutcome<T extends { outcome: string }>(receipt: T): string {
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  return receipt.outcome;
}

export function writeCloseout(rootDir: string, packagePath: unknown): void {
  writeFileSync(
    path.join(rootDir, "harness", String(packagePath), "closeout.md"),
    `# Closeout\n\n## Summary\n\nReview fixture delivered at ${git(rootDir, "rev-parse", "HEAD")}.\n\n` +
      "## Verification\n\nReview independence integration assertions.\n\n" +
      "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nShared review authorization.\n",
  );
}

export function writeSettingsFixture(rootDir: string): void {
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    [
      "schema: harness-anything/v1",
      "layout:",
      "  authoredRoot: harness",
      "  localRoot: .harness",
      "settings:",
      "  defaultVertical: software/coding",
      "  defaultPreset: standard-task",
      "  defaultProfile: baseline",
      "  scaffolds:",
      "    task: governance/task-scaffold.json",
      "    repository: governance/repository-scaffold.json",
      "",
    ].join("\n"),
  );
  git(rootDir, "add", "harness/harness.yaml");
  git(rootDir, "commit", "--quiet", "-m", "settings fixture");
}

// runtime_session_* publications chain onto the cell write queue when the fixture hands the daemon
// the provider line, and commit only when that queue turn runs — after spawnRuntime has already
// returned its dispatch receipt. A fixed poll window races that queue under load, so wait for the
// delivery itself, drain the write queue past the publication, then read the store exactly once:
// an event still missing after both signals is a real defect, not a lost race.
export async function runtimeEvent(
  cell: RepoCell,
  delivery: Promise<void>,
  rootDir: string,
  repoId: string,
  matches: (event: ReturnType<ReturnType<typeof makeTaskEventReader>["read"]>["events"][number]) => boolean,
): Promise<void> {
  await delivery;
  await cell.settlePendingMaterialization("runtime event assertion");
  assert.ok(makeTaskEventReader({ repoId, rootDir }).read().events.some(matches), "runtime event did not arrive");
}
