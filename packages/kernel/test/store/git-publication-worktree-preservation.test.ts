// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeLocalVersionControlSystem } from "../../src/persistence/git/local-version-control-system.ts";
import { commitTouchedPaths } from "../../src/write-coordination/journal/publication/git.ts";
import { withTempStore } from "./helpers.ts";

test("session publication preserves worktree content throughout every commit phase (temporal assertion)", () => {
  withTempStore((rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    mkdirSync(harnessRoot, { recursive: true });
    runGit(harnessRoot, "init");
    runGit(harnessRoot, "symbolic-ref", "HEAD", "refs/heads/main");
    writeFileSync(path.join(harnessRoot, "harness.yaml"), "schema: harness-anything/v1\n", "utf8");

    // Seed trunk with a placeholder task plan — the exact "data corruption"
    // scenario from the field: correct content exists only after the write,
    // and trunk holds the old template.
    const planPath = path.join(harnessRoot, "tasks/task-corruption/task_plan.md");
    mkdirSync(path.dirname(planPath), { recursive: true });
    writeFileSync(planPath, "# Placeholder\n\nTEMPLATE\n", "utf8");
    runGit(harnessRoot, "add", "harness.yaml", "tasks/task-corruption/task_plan.md");
    runGit(harnessRoot, "commit", "-m", "seed trunk placeholder");

    // Simulate the user/worker replacing the placeholder with real content.
    const realContent = "# Real Plan\n\nThis is the authoritative task plan.\nLine 2\n";
    writeFileSync(planPath, realContent, "utf8");

    // Temporal assertion: at every commit phase, the worktree file must be
    // byte-identical to the pre-commit content. This assertion runs DURING
    // the commit call — inside the publication window, before the materializer
    // has any chance to merge. If the old checkout-based publisher restored
    // the worktree to trunk at "trunk-checkout-done", the assertion fires on
    // the clobbered placeholder and fails.
    const observations: Array<{ readonly phase: string; readonly content: string }> = [];
    const commitSha = commitTouchedPaths(
      rootDir,
      [planPath],
      ["op-worktree-preservation"],
      rootDir,
      "test worktree preservation",
      "worktree-preservation-session",
      {
        author: { name: "Harness Test", email: "harness-test@example.invalid" },
        onCommitPhase: (phase) => {
          const content = readFileSync(planPath, "utf8");
          observations.push({ phase, content });
        }
      }
    );

    // Every phase observation must see the uncorrupted worktree.
    const corrupted = observations.filter((observation) => observation.content !== realContent);
    assert.equal(
      corrupted.length,
      0,
      `worktree was clobbered at phases: ${corrupted.map((entry) => entry.phase).join(", ")}`
    );
    // Sanity: at least the commit and stage phases fired, proving the
    // assertion was actually inside the publication window.
    const observedPhases = observations.map((entry) => entry.phase);
    assert.ok(observedPhases.includes("commit-call-done"), `expected commit-call-done phase; got ${JSON.stringify(observedPhases)}`);

    // The commit on the session branch must contain the real content.
    assert.equal(
      runGit(harnessRoot, "show", `${commitSha}:tasks/task-corruption/task_plan.md`),
      realContent.trim()
    );

    // HEAD must remain on trunk — the publisher never checked out the session branch.
    assert.equal(runGit(harnessRoot, "rev-parse", "--abbrev-ref", "HEAD"), "main");

    // The worktree file is still the real content post-publish.
    assert.equal(readFileSync(planPath, "utf8"), realContent);
  });
});

test("session publication reuses its already witnessed base commit", () => {
  withTempStore((rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    mkdirSync(harnessRoot, { recursive: true });
    runGit(harnessRoot, "init");
    runGit(harnessRoot, "symbolic-ref", "HEAD", "refs/heads/main");
    writeFileSync(path.join(harnessRoot, "harness.yaml"), "schema: harness-anything/v1\n", "utf8");
    runGit(harnessRoot, "add", "harness.yaml");
    runGit(harnessRoot, "commit", "-m", "seed trunk");

    const witnessedHead = runGit(harnessRoot, "rev-parse", "HEAD");
    const planPath = path.join(harnessRoot, "tasks/task-base/task_plan.md");
    mkdirSync(path.dirname(planPath), { recursive: true });
    writeFileSync(planPath, "# Base witness\n", "utf8");
    const local = makeLocalVersionControlSystem();
    const commitSha = commitTouchedPaths(
      rootDir,
      [planPath],
      ["op-base-witness"],
      rootDir,
      "test witnessed base",
      "base-witness-session",
      {
        author: { name: "Harness Test", email: "harness-test@example.invalid" },
        sessionBaseRef: witnessedHead,
        versionControlSystem: {
          ...local,
          currentBranch: () => {
            throw new Error("current branch must not be queried after the base commit is witnessed");
          }
        }
      }
    );

    assert.equal(runGit(harnessRoot, "rev-parse", `${commitSha}^`), witnessedHead);
  });
});

function runGit(repoRoot: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
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
