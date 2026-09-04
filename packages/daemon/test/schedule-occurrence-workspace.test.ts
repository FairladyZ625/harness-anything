// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ScheduleV1 } from "../../kernel/src/index.ts";
import {
  prepareScheduleOccurrenceWorkspace,
  settleScheduleOccurrenceWorkspace,
} from "../src/schedule-occurrence-workspace.ts";

test("detect occurrences use the canonical root without creating a worktree", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-schedule-detect-"));
  try {
    const workspace = prepareScheduleOccurrenceWorkspace(root, schedule("detect", "occurrence-detect"));
    assert.equal(workspace.cwd, root);
    assert.equal(workspace.runtime.worktree, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remediate occurrences start from origin/main and clean empty worktrees", () => {
  const fixture = repositoryFixture();
  try {
    const workspace = prepareScheduleOccurrenceWorkspace(fixture.root, schedule("remediate", "occurrence-clean"));
    assert.equal(git(workspace.cwd, "rev-parse", "HEAD"), git(fixture.root, "rev-parse", "origin/main"));
    assert.equal(settleScheduleOccurrenceWorkspace(fixture.root, workspace.runtime).retainedDetail, null);
    assert.equal(existsSync(workspace.cwd), false);
    assert.throws(() => git(fixture.root, "rev-parse", "occ-occurrence-clean"));
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

for (const change of ["dirty", "commit"] as const)
  test(`remediate occurrences retain a ${change} worktree and name its path`, () => {
    const fixture = repositoryFixture();
    try {
      const workspace = prepareScheduleOccurrenceWorkspace(fixture.root, schedule("remediate", `occurrence-${change}`));
      writeFileSync(path.join(workspace.cwd, "result.txt"), change);
      if (change === "commit") {
        git(workspace.cwd, "add", "result.txt");
        git(workspace.cwd, "commit", "-qm", "occurrence result");
      }
      const detail = settleScheduleOccurrenceWorkspace(fixture.root, workspace.runtime).retainedDetail;
      assert.equal(detail?.includes(workspace.cwd), true);
      assert.equal(existsSync(workspace.cwd), true);
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  });

function schedule(mode: "detect" | "remediate", occurrenceId: string): ScheduleV1 {
  return {
    scheduleId: "workspace-test",
    mode,
    status: { activeRun: { occurrenceId, claimFence: `claim-${occurrenceId}` } },
  } as ScheduleV1;
}

function repositoryFixture(): { readonly base: string; readonly root: string } {
  const base = mkdtempSync(path.join(tmpdir(), "ha-schedule-workspace-")),
    remote = path.join(base, "remote.git"),
    root = path.join(base, "canonical");
  git(base, "init", "--bare", "-q", remote);
  git(base, "init", "-q", "-b", "main", root);
  git(root, "config", "user.name", "Schedule Test");
  git(root, "config", "user.email", "schedule@example.invalid");
  writeFileSync(path.join(root, "README.md"), "base\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "base");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "-u", "origin", "main");
  return { base, root };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
