// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { addManagedWorktree, reclaimManagedWorktree } from "../src/schedule-occurrence-workspace.ts";
import { runWorktreeSetup, taskWorktreeDocumentBase, workerLedgerPath } from "../src/worktree-setup.ts";
import { taskWorktreeCandidateInventory } from "../src/task-worktree-candidates.ts";

const taskId = "task-x",
  packageName = `${taskId}-fixture`,
  plan = path.join("harness", "tasks", packageName, "task_plan.md"),
  skill = path.join("harness", "skills", "review", "SKILL.md");

test("a managed worktree holds only its own task package copy, and out-of-package ledger writes cannot reach the canonical checkout", async (t) => {
  const root = repositoryFixture(t),
    worktree = { cwd: path.join(root, ".worktrees", taskId), branch: taskId, baseRef: "origin/main" },
    mirror = path.join(worktree.cwd, "harness");
  await addManagedWorktree(root, worktree);
  assert.equal(existsSync(mirror), false, "git checks out no ledger of its own");
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId, steps: [] });
  // Every later start or dispatch prepares again: it keeps the own-package copy and sweeps what an
  // older layout left behind.
  mkdirSync(path.join(root, "harness", "facts"));
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId, steps: [] });

  // One real directory holding independent copies: only accepted doc-sync writes reach the center. No other ledger directory resolves under the worktree root.
  assert.equal(lstatSync(mirror).isDirectory(), true);
  const workerPackage = path.join(mirror, "tasks", packageName),
    workerPlan = path.join(workerPackage, "task_plan.md"),
    canonicalPlan = path.join(root, plan);
  writeFileSync(workerPlan, "# Updated Plan\n");
  assert.equal(readFileSync(canonicalPlan, "utf8"), "# Plan\n", "worker edits do not mutate canonical files");
  writeFileSync(path.join(workerPackage, "closeout.md"), "# Closeout\n");
  assert.equal(
    readFileSync(path.join(root, "harness", "tasks", packageName, "closeout.md"), "utf8"),
    "# Old Closeout\n",
    "the own package reaches the ledger only through versioned doc-sync",
  );

  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId, steps: [] });
  assert.equal(readFileSync(workerPlan, "utf8"), "# Updated Plan\n", "repeated setup retains worker edits");
  assert.equal(
    readFileSync(taskWorktreeDocumentBase(worktree.cwd, `tasks/${packageName}/task_plan.md`), "utf8"),
    "# Plan\n",
    "repeated setup retains the original version base",
  );

  // A worker deleting or writing an out-of-package private file under its own root fails right
  // there. Runtime consumers instead receive a worker-local copy, so deleting or editing that
  // path cannot change the canonical file (the incident this closes: a deleted skill left every
  // agent referencing it undispatchable).
  const canonicalSkill = path.join(root, skill);
  assert.throws(() => rmSync(path.join(worktree.cwd, skill)), { code: "ENOENT" });
  assert.equal(readFileSync(canonicalSkill, "utf8"), "# Review\n");
  assert.throws(() => writeFileSync(path.join(worktree.cwd, skill), "mutated\n"), { code: "ENOENT" });
  assert.equal(readFileSync(canonicalSkill, "utf8"), "# Review\n");
  assert.deepEqual(readdirSync(mirror).sort(), ["tasks"]);
  assert.equal(lstatSync(path.join(mirror, "tasks")).isSymbolicLink(), false, "tasks holds the link, it is not one");
  assert.deepEqual(readdirSync(path.join(mirror, "tasks")), [packageName]);
  assert.equal(lstatSync(workerPackage).isSymbolicLink(), false, "the package parent stays in the worker checkout");
  assert.equal(existsSync(path.join(mirror, "skills")), false, "out-of-package ledger content does not resolve");
  assert.equal(existsSync(path.join(mirror, "facts")), false);
  const workerSkill = workerLedgerPath(root, worktree.cwd, canonicalSkill);
  assert.notEqual(workerSkill, canonicalSkill);
  assert.equal(readFileSync(workerSkill, "utf8"), "# Review\n");
  writeFileSync(workerSkill, "worker mutation\n");
  assert.equal(readFileSync(canonicalSkill, "utf8"), "# Review\n");
  rmSync(workerSkill);
  assert.equal(readFileSync(canonicalSkill, "utf8"), "# Review\n");
  const workerSkillDirectory = workerLedgerPath(root, worktree.cwd, path.dirname(canonicalSkill));
  assert.equal(readFileSync(path.join(workerSkillDirectory, "SKILL.md"), "utf8"), "# Review\n");
  writeFileSync(path.join(workerSkillDirectory, "SKILL.md"), "directory mutation\n");
  assert.equal(readFileSync(canonicalSkill, "utf8"), "# Review\n");
  // A directory symlink for the own package would resolve `../../skills` from its canonical target and bypass the
  // direct-path check above. The worker package is real, so the same relative write stays inside the worker mirror.
  assert.throws(() =>
    execFileSync(
      process.execPath,
      ["-e", "require('node:fs').rmSync(process.argv[1])", path.join("..", "..", "skills", "review", "SKILL.md")],
      { cwd: workerPackage, stdio: "pipe" },
    ),
  );
  assert.equal(readFileSync(canonicalSkill, "utf8"), "# Review\n");

  assert.equal(git(worktree.cwd, "status", "--porcelain"), "", "the ledger directory is ignored, not untracked");
  git(worktree.cwd, "add", "-A");
  assert.equal(git(worktree.cwd, "diff", "--cached", "--name-only"), "", "git add -A stages nothing of the ledger");
  // The probe tools/check-private-boundary.mjs runs in every checkout: git refuses a path beyond a link.
  git(worktree.cwd, "check-ignore", "--no-index", "-q", "harness/__boundary_probe__");
  assert.equal(git(root, "status", "--porcelain"), "", "the canonical checkout stays clean");

  // Paths under the worker's own package resolve under its own root; anything else in the ledger
  // keeps the canonical path it came from.
  assert.equal(workerLedgerPath(root, worktree.cwd, path.join(root, plan)), path.join(worktree.cwd, plan));
  const isolatedSkill = workerLedgerPath(root, worktree.cwd, path.join(root, skill));
  assert.notEqual(isolatedSkill, path.join(root, skill));
  assert.equal(readFileSync(isolatedSkill, "utf8"), "directory mutation\n");
  // Controls: a reviewer runs in the canonical checkout and keeps its paths; a cwd that holds no ledger, a cwd
  // whose `harness` is some other directory, and a path outside the ledger are left alone.
  assert.equal(workerLedgerPath(root, root, path.join(root, plan)), path.join(root, plan));
  mkdirSync(path.dirname(path.join(root, "packages", "copy", plan)), { recursive: true });
  writeFileSync(path.join(root, "packages", "copy", plan), "# A stale copy\n");
  assert.equal(workerLedgerPath(root, path.join(root, "packages"), path.join(root, plan)), path.join(root, plan));
  assert.equal(
    workerLedgerPath(root, path.join(root, "packages", "copy"), path.join(root, plan)),
    path.join(root, plan),
  );
  assert.equal(workerLedgerPath(root, worktree.cwd, path.join(root, "README.md")), path.join(root, "README.md"));
});

test("an executable ledger entry is copied with the sibling modules it imports", async (t) => {
  const root = repositoryFixture(t),
    worktree = { cwd: path.join(root, ".worktrees", taskId), branch: taskId, baseRef: "origin/main" },
    entryDirectory = path.join(root, "harness", "skills", "scripted"),
    canonicalEntry = path.join(entryDirectory, "run.mjs"),
    sibling = path.join(entryDirectory, "helper.mjs");
  await addManagedWorktree(root, worktree);
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId, steps: [] });
  mkdirSync(entryDirectory, { recursive: true });
  writeFileSync(canonicalEntry, 'import "./helper.mjs";\n');
  writeFileSync(sibling, "export const helper = true;\n");

  // A script is executed from its directory: `./helper.mjs` is part of the entry, so a copy that
  // takes only run.mjs is not a runnable entry. This is the isolated-test dispatcher's failure
  // shape (dispatch-isolated-test.mjs next to test-resources.mjs and the queue/server files).
  const workerEntry = workerLedgerPath(root, worktree.cwd, canonicalEntry);
  assert.notEqual(workerEntry, canonicalEntry);
  assert.equal(readFileSync(workerEntry, "utf8"), 'import "./helper.mjs";\n');
  assert.equal(
    readFileSync(path.join(path.dirname(workerEntry), "helper.mjs"), "utf8"),
    "export const helper = true;\n",
  );
  assert.equal(readFileSync(sibling, "utf8"), "export const helper = true;\n", "the canonical sibling is only read");
});

test("a worktree materialized by the all-links layout is swept to the own-package copy at the next setup", async (t) => {
  const root = repositoryFixture(t),
    worktree = { cwd: path.join(root, ".worktrees", taskId), branch: taskId, baseRef: "origin/main" },
    mirror = path.join(worktree.cwd, "harness");
  await addManagedWorktree(root, worktree);
  mkdirSync(mirror, { recursive: true });
  // The layout before only the own package was linked: every ledger directory as one top-level link,
  // the own package reachable through the tasks link.
  for (const name of ["tasks", "skills", "facts"])
    symlinkDirectory(path.join(root, "harness", name), path.join(mirror, name));

  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId, steps: [] });

  assert.deepEqual(readdirSync(mirror).sort(), ["tasks"]);
  assert.deepEqual(readdirSync(path.join(mirror, "tasks")), [packageName]);
  assert.equal(lstatSync(path.join(mirror, "tasks", packageName)).isSymbolicLink(), false);
  assert.equal(existsSync(path.join(mirror, "skills")), false);
});

test("a missing or replaced worker mirror is recreated without following its replacement symlink", async (t) => {
  const root = repositoryFixture(t),
    worktree = { cwd: path.join(root, ".worktrees", taskId), branch: taskId, baseRef: "origin/main" },
    mirror = path.join(worktree.cwd, "harness"),
    external = path.join(root, "external"),
    sentinel = path.join(external, "keep.txt");
  await addManagedWorktree(root, worktree);
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId, steps: [] });

  rmSync(mirror, { recursive: true, force: true });
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId, steps: [] });
  assert.equal(lstatSync(path.join(mirror, "tasks", packageName)).isDirectory(), true);

  mkdirSync(external);
  writeFileSync(sentinel, "keep\n");
  rmSync(mirror, { recursive: true, force: true });
  symlinkDirectory(external, mirror);
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId, steps: [] });

  assert.equal(lstatSync(mirror).isDirectory(), true);
  assert.equal(lstatSync(path.join(mirror, "tasks", packageName)).isDirectory(), true);
  assert.equal(readFileSync(sentinel, "utf8"), "keep\n");
});

test("an occurrence worktree with no task holds no ledger link", async (t) => {
  const root = repositoryFixture(t),
    worktree = { cwd: path.join(root, ".worktrees", "occ-1"), branch: "occ-1", baseRef: "origin/main" },
    mirror = path.join(worktree.cwd, "harness");
  await addManagedWorktree(root, worktree);
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId: null, steps: [] });
  assert.equal(existsSync(mirror), false);
});

test("reclaiming a managed worktree removes the links and leaves the ledger", async (t) => {
  const root = repositoryFixture(t),
    worktree = { cwd: path.join(root, ".worktrees", taskId), branch: taskId, baseRef: "origin/main" };
  await addManagedWorktree(root, worktree);
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId, steps: [] });

  assert.deepEqual(await reclaimManagedWorktree(root, worktree), {
    outcome: "removed",
    archiveTag: null,
    unmergedCommits: 0,
  });
  assert.equal(existsSync(worktree.cwd), false);
  assert.equal(readFileSync(path.join(root, plan), "utf8"), "# Plan\n", "the ledger itself is untouched");
});

test("a worktree kept for uncommitted work keeps its work and loses only the links", async (t) => {
  const root = repositoryFixture(t),
    worktree = { cwd: path.join(root, ".worktrees", taskId), branch: taskId, baseRef: "origin/main" };
  await addManagedWorktree(root, worktree);
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId, steps: [] });
  writeFileSync(path.join(worktree.cwd, "README.md"), "edited in the worktree\n");

  assert.deepEqual(await reclaimManagedWorktree(root, worktree), {
    outcome: "retained",
    reason: "uncommitted changes",
  });
  assert.equal(readFileSync(path.join(worktree.cwd, "README.md"), "utf8"), "edited in the worktree\n");
  assert.deepEqual(readdirSync(path.join(worktree.cwd, "harness")), []);
  assert.equal(existsSync(taskWorktreeDocumentBase(worktree.cwd, "")), false, "reclamation removes local bases too");
  assert.equal(readFileSync(path.join(root, plan), "utf8"), "# Plan\n");
});

/** One directory junction, the way the ledger links are made on every platform the daemon runs on. */
function symlinkDirectory(target: string, link: string): void {
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(target, link, "junction");
}

/** A project repository as `ha init` leaves it: the ledger directory is ignored, so no worktree checks it out. */
function repositoryFixture(t: TestContext): string {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-worktree-ledger-"))),
    remote = path.join(base, "remote.git"),
    root = path.join(base, "canonical");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  git(base, "init", "--bare", "-q", remote);
  git(base, "init", "-q", "-b", "main", root);
  git(root, "config", "user.name", "Worktree Test");
  git(root, "config", "user.email", "worktree@example.invalid");
  writeFileSync(path.join(root, "README.md"), "base\n");
  writeFileSync(path.join(root, ".gitignore"), "/harness/\n/.harness/\n/.worktrees/\n");
  git(root, "add", "README.md", ".gitignore");
  git(root, "commit", "-qm", "base");
  // origin/main as a worktree base, without a push: the fixture stays hermetic and the worker
  // runtime this test also runs under refuses every push that is not a task branch.
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  for (const [file, body] of [
    [plan, "# Plan\n"],
    [path.join("harness", "tasks", packageName, "closeout.md"), "# Old Closeout\n"],
    [skill, "# Review\n"],
    [path.join("harness", "harness.yaml"), "layout:\n"],
    [path.join("harness", ".git", "HEAD"), "ref: refs/heads/main\n"],
  ] as const) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), body);
  }
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

for (const retired of [false, true]) {
  test(`a pre-base package recovers acknowledged reports and preserves ${retired ? "retired" : "updated"} foreign documents without clocks`, (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-legacy-document-bases-")),
      worker = path.join(root, "worker"),
      packagePath = "tasks/task-legacy-fixture",
      report = `${packagePath}/artifacts/report.md`,
      ruling = `${packagePath}/artifacts/ruling.md`,
      fresh = `${packagePath}/artifacts/new.md`,
      executionIds = ["execution-legacy-old", "execution-legacy-new"],
      oldActor = { principal: { personId: "owner" }, executor: { kind: "agent", id: "old-runtime" } },
      ceo = { principal: { personId: "owner" }, executor: null },
      blobs = new Map([
        ["report-v1", Buffer.from("report v1\n")],
        ["unrelated-report", Buffer.from("unrelated execution report\n")],
        ["ruling-v1", Buffer.from("ruling v1\n")],
        ["ruling-v2", Buffer.from("CEO supplement\n")],
      ]);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, "harness"));
    mkdirSync(path.dirname(path.join(worker, "harness", report)), { recursive: true });
    mkdirSync(path.join(worker, ".git"));
    writeFileSync(path.join(worker, "harness", report), "worker report v2\n");
    writeFileSync(path.join(worker, "harness", ruling), "ruling v1\n");
    writeFileSync(path.join(worker, "harness", fresh), "new worker output\n");
    if (retired) {
      // A crash can leave only part of the legacy package's bases recovered.
      const base = taskWorktreeDocumentBase(worker, report);
      mkdirSync(path.dirname(base), { recursive: true });
      writeFileSync(base, "report v1\n");
    }
    const change = (target: string, sha256: string | null) => ({
        path: target,
        baseBlobSha256: null,
        candidate: sha256 === null ? null : { sha256, size: blobs.get(sha256)!.length, mediaType: "text/markdown" },
      }),
      events = [
        {
          schema: "doc-event/v1",
          type: "documents_written",
          workspaceRevision: 3,
          actor: oldActor,
          source: "local",
          payload: { executionId: "execution-another-task", changes: [change(report, "unrelated-report")] },
        },
        {
          schema: "doc-event/v1",
          type: "documents_written",
          workspaceRevision: 2,
          occurredAt: "1900-01-01T00:00:00.000Z",
          actor: ceo,
          source: "local",
          payload: { executionId: null, changes: [change(ruling, retired ? null : "ruling-v2")] },
        },
        {
          schema: "doc-event/v1",
          type: "documents_written",
          workspaceRevision: 1,
          occurredAt: "2100-01-01T00:00:00.000Z",
          actor: oldActor,
          source: "local",
          payload: {
            executionId: "execution-legacy-old",
            changes: [change(report, "report-v1"), change(ruling, "ruling-v1")],
          },
        },
      ];
    let queries = 0;
    const inventory = taskWorktreeCandidateInventory(
      root,
      worker,
      packagePath,
      { repoId: "legacy", revision: 2, headDigest: `sha256:${"0".repeat(64)}` },
      {
        executionIds,
        store: {
          queryEvents: ({ revisionBound }: { revisionBound?: number }) => {
            queries += 1;
            return events
              .filter((event) => revisionBound === undefined || event.workspaceRevision < revisionBound)
              .slice(0, 1);
          },
          readContentBlob: (sha256: string) => blobs.get(sha256) ?? null,
        } as never,
      },
    );
    assert.deepEqual(inventory!.rows.map((row) => row.path).sort(), [fresh, report].sort());
    assert.equal(Buffer.from(inventory!.rows.find((row) => row.path === report)!.baseBytes!).toString(), "report v1\n");
    assert.equal(inventory!.rows.find((row) => row.path === fresh)!.baseBytes, null);
    assert.equal(queries, 4, "revision pages cross the last page and stop on EOF");
    assert.equal(readFileSync(taskWorktreeDocumentBase(worker, ruling), "utf8"), "ruling v1\n");
    unlinkSync(taskWorktreeDocumentBase(worker, ruling));
    writeFileSync(path.join(worker, "harness", ruling), "unidentifiable foreign edit\n");
    const unknown = taskWorktreeCandidateInventory(
      root,
      worker,
      packagePath,
      { repoId: "legacy", revision: 2, headDigest: `sha256:${"0".repeat(64)}` },
      {
        store: {
          queryEvents: ({ revisionBound }: { revisionBound?: number }) =>
            events.filter((event) => revisionBound === undefined || event.workspaceRevision < revisionBound),
          readContentBlob: (sha256: string) => blobs.get(sha256) ?? null,
        } as never,
      },
    );
    assert.equal(
      unknown!.rows.find((row) => row.path === ruling)!.baseBytes,
      null,
      "unknown edits never adopt the CEO's current version",
    );
  });
}

for (const dirty of [false, true]) {
  test(`tracked ledger bases stay outside Git's visible worktree and are reclaimed with a ${dirty ? "retained" : "removed"} checkout`, async (t) => {
    const root = repositoryFixture(t),
      worktree = { cwd: path.join(root, ".worktrees", taskId), branch: taskId, baseRef: "origin/main" };
    // This repository deliberately does not ignore its localRoot.
    writeFileSync(path.join(root, ".gitignore"), "/.worktrees/\n/harness/.git/\n");
    git(root, "add", ".gitignore", "harness/tasks", "harness/harness.yaml");
    git(root, "commit", "-qm", "tracked authored documents");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    await addManagedWorktree(root, worktree);
    await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId, steps: [], fresh: true });
    const base = taskWorktreeDocumentBase(worktree.cwd, ""),
      original = taskWorktreeDocumentBase(worktree.cwd, `tasks/${packageName}/task_plan.md`);
    assert.equal(path.relative(worktree.cwd, base).startsWith(`..${path.sep}`), true);
    assert.equal(readFileSync(original, "utf8"), "# Plan\n");
    assert.equal(git(worktree.cwd, "status", "--porcelain", "--untracked-files=all"), "");
    if (dirty) writeFileSync(path.join(worktree.cwd, "README.md"), "unfinished work\n");
    const reclaimed = await reclaimManagedWorktree(root, worktree);
    assert.equal(reclaimed.outcome, dirty ? "retained" : "removed");
    assert.equal(existsSync(base), false, "node-local bases leave with worktree reclamation");
    if (dirty) assert.equal(readFileSync(path.join(worktree.cwd, "README.md"), "utf8"), "unfinished work\n");
  });
}
