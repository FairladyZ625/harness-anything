import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git } from "../production-authority-canonical-ingress/fixture.ts";

export function publishSeededTaskFixture(authoredRoot: string, taskRoot: string, taskId: string): void {
  const taskPath = path.relative(authoredRoot, taskRoot).split(path.sep).join("/");
  const files = snapshotTextTree(taskRoot);
  const trunk = git(authoredRoot, "branch", "--show-current");
  const sessionBranch = `sessions/fixture-task-seed-${taskId}`;
  const opId = `op_fixture_task_seed_${taskId}`;
  rmSync(taskRoot, { recursive: true, force: true });
  git(authoredRoot, "add", "-A", taskPath);
  git(authoredRoot, "commit", "-q", "-m", "test: prepare canonical task creation fixture");
  git(authoredRoot, "checkout", "-q", "-b", sessionBranch);
  for (const [relativePath, body] of files) {
    const target = path.join(taskRoot, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  git(authoredRoot, "add", taskPath);
  git(authoredRoot, "commit", "-q", "-m", `harness write fixture task seed [${opId}]`);
  git(authoredRoot, "checkout", "-q", trunk);
  git(authoredRoot, "merge", "-q", "--no-ff", "-m", `materialize fixture task seed [${opId}]`, sessionBranch);
}

export function productionPlan(goal: string): string {
  return [
    "# Plan", "",
    "## Brief", "Brief.",
    "## Goal", goal,
    "## Context", "Context.",
    "## Constraints", "Constraints.",
    "## Checkpoint", "Checkpoint.",
    "## CI/Gate Authority Stop Condition", "Stop.",
    "## Implementation Plan", "Plan.",
    "## Verification", "Verify.",
    ""
  ].join("\n");
}

export function productionCloseout(summary: string): string {
  return [
    "# Closeout", "",
    "## Summary", summary, "",
    "## Verification", "The production daemon completion chain was exercised.", "",
    "## Residual Risk", "No residual risk accepted.", ""
  ].join("\n");
}

function snapshotTextTree(rootDir: string): ReadonlyArray<readonly [string, string]> {
  const rows: Array<readonly [string, string]> = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) rows.push([path.relative(rootDir, absolute), readFileSync(absolute, "utf8")]);
    }
  };
  visit(rootDir);
  return rows.sort(([left], [right]) => left.localeCompare(right));
}
