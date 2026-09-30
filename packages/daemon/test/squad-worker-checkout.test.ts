// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareWorkerWorktree } from "../src/squad-worker-checkout.ts";

test("the same squad worker receives a distinct checkout for each attempt", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-worker-checkout-"));
  try {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: rootDir });
    writeFileSync(path.join(rootDir, "baseline.txt"), "baseline\n");
    execFileSync("git", ["add", "baseline.txt"], { cwd: rootDir });
    execFileSync(
      "git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "baseline"],
      {
        cwd: rootDir,
      },
    );
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: rootDir });
    execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: rootDir });
    execFileSync("git", ["branch", "-m", "task_0123456789abcdef0123456789"], { cwd: rootDir });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim(),
      state = { squadRunId: "squad_0123456789abcdef01234567", cwd: rootDir },
      first = await prepareWorkerWorktree(state, baseSha, "worker-3", "worker-1", noSetup(rootDir)),
      second = await prepareWorkerWorktree(state, baseSha, "worker-3", "worker-2", noSetup(rootDir));

    assert.notEqual(first?.cwd, second?.cwd);
    assert.notEqual(first?.branch, second?.branch);
    assert.match(first?.branch ?? "", /^task_0123456789abcdef0123456789--squad-/u);
    assert.equal(first?.baseSha, baseSha);
    assert.equal(second?.baseSha, baseSha);
    assert.deepEqual(await prepareWorkerWorktree(state, baseSha, "worker-3", "worker-1", noSetup(rootDir)), first);

    writeFileSync(path.join(first!.cwd, "worker.txt"), "worker\n");
    execFileSync("git", ["add", "worker.txt"], { cwd: first!.cwd });
    execFileSync("git", ["commit", "-m", "worker change"], {
      cwd: first!.cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    });
    const childSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: first!.cwd, encoding: "utf8" }).trim();

    execFileSync("git", ["switch", "-c", "comparison/cherry-pick", baseSha], { cwd: rootDir });
    execFileSync("git", ["cherry-pick", childSha], {
      cwd: rootDir,
      env: { ...process.env, GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z" },
    });
    const cherryPickedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim();
    assert.notEqual(cherryPickedSha, childSha, "cherry-pick recreates the child commit");

    execFileSync("git", ["switch", "task_0123456789abcdef0123456789"], { cwd: rootDir });
    execFileSync("git", ["merge", "--no-ff", "--no-edit", first!.branch], { cwd: rootDir });
    execFileSync("git", ["merge-base", "--is-ancestor", childSha, "HEAD"], { cwd: rootDir });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("workers branch off the Commander's checked-out branch whatever it is named, and a detached HEAD is refused", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "squad-checkout-branch-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", rootDir]);
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: rootDir });
  execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: rootDir });
  writeFileSync(path.join(rootDir, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "seed.txt"], { cwd: rootDir });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: rootDir });
  execFileSync("git", ["branch", "-m", "delivery/mission"], { cwd: rootDir });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim(),
    state = { squadRunId: "squad_89abcdef0123456789abcdef", cwd: rootDir },
    named = await prepareWorkerWorktree(state, baseSha, "worker-1", "attempt-1", noSetup(rootDir));
  assert.match(named?.branch ?? "", /^delivery\/mission--squad-/u);

  execFileSync("git", ["checkout", "-q", "--detach"], { cwd: rootDir });
  await assert.rejects(
    prepareWorkerWorktree(
      { ...state, squadRunId: "squad_fedcba9876543210fedcba98" },
      baseSha,
      "worker-2",
      "attempt-1",
      noSetup(rootDir),
    ),
    /checked-out branch/u,
  );
});

test("a worker checkout runs the repository's setup steps with the child task id", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "squad-checkout-setup-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "task_0123456789abcdef0123456789", rootDir]);
  execFileSync(
    "git",
    ["-c", "user.name=F", "-c", "user.email=f@example.com", "commit", "-q", "--allow-empty", "-m", "seed"],
    {
      cwd: rootDir,
    },
  );
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim(),
    worker = await prepareWorkerWorktree(
      { squadRunId: "squad_0123456789abcdef01234567", cwd: rootDir },
      baseSha,
      "w",
      "a",
      {
        rootDir,
        taskId: "task_child",
        steps: ['run: echo "$HARNESS_TASK_ID" > setup.out'],
      },
    );
  assert.equal(readFileSync(path.join(worker!.cwd, "setup.out"), "utf8"), "task_child\n");
});

function noSetup(rootDir: string) {
  return { rootDir, taskId: "task_child", steps: [] };
}
