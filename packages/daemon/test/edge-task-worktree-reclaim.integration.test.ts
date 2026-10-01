// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { reclaimEdgeTaskWorktrees } from "../src/fleet-edge-worktree-reclaim.ts";
import { pushWorkerBranch } from "../src/runtime-worker-push.ts";
import { addManagedWorktree } from "../src/schedule-occurrence-workspace.ts";
import { checkoutTaskWorktree } from "../src/task-worktree.ts";

// dec_57370FF2021DADF04E3B21724D CH4: an edge reclaims its own checkouts of the tasks its mirrored cut says are
// closed. Two clones of one bare remote stand for two nodes; each has its own replica view of the center's cuts,
// so a node learns of a close only when its own view moves to the cut that carries it.

const repoId = "edge-repo",
  doneId = "task_e0000000000000000000d0ne",
  openId = "task_e00000000000000000000pen",
  harnessYaml = "schema: harness-anything/v1\nname: edge\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n";

test("a node reclaims its clean checkout of a closed task once its own mirror carries the close", async (t) => {
  const fixture = nodesFixture(t),
    onA = await checkout(fixture.nodeA, doneId),
    onB = await checkout(fixture.nodeB, doneId),
    openOnA = await checkout(fixture.nodeA, openId);
  await deliver(fixture.nodeA, onA, doneId);
  // Node B was refused before it worked: an idle checkout at the default branch stays behind (#3193).
  assert.equal(git(onB, "rev-parse", "HEAD"), git(fixture.nodeB.root, "rev-parse", "origin/main"));

  // While the mirror says both tasks are open, a sync touches nothing.
  assert.equal(await sync(fixture.nodeA, { [doneId]: "active", [openId]: "active" }), null);
  assert.equal(existsSync(onA) && existsSync(openOnA), true);

  // Node A mirrors the close; node B is offline and keeps the cut it had.
  assert.deepEqual(await sync(fixture.nodeA, { [doneId]: "done", [openId]: "active" }), {
    removed: [{ taskId: doneId, archiveTag: `archive/wt-${doneId}` }],
    retained: [],
  });
  assert.equal(existsSync(onA), false);
  assert.equal(git(fixture.nodeA.root, "branch", "--list", doneId), "", "the local branch goes with the checkout");
  assert.equal(existsSync(openOnA), true, "an open task's checkout is not this pass's to touch");
  assert.equal(git(fixture.nodeA.root, "branch", "--list", openId).length > 0, true);
  assert.equal(existsSync(onB), true, "one node's reclaim reaches no other node's directory");
  assert.equal(git(fixture.nodeB.root, "branch", "--list", doneId).length > 0, true);
  assert.equal(git(fixture.remote, "rev-parse", "--verify", `refs/heads/${doneId}`).length, 40, "the push stays");

  // Node B comes back: its next sync carries the close and reclaims what B itself holds.
  assert.deepEqual(await sync(fixture.nodeB, { [doneId]: "done", [openId]: "active" }), {
    removed: [{ taskId: doneId, archiveTag: null }],
    retained: [],
  });
  assert.equal(existsSync(onB), false);
  // A node with nothing left for the task says nothing on the next sync.
  assert.equal(await sync(fixture.nodeA, { [doneId]: "done", [openId]: "active" }), null);
});

test("a closed task's checkout holding work no remote has is kept and named until that work is published", async (t) => {
  const fixture = nodesFixture(t),
    cwd = await checkout(fixture.nodeA, doneId),
    head = commit(cwd, "only-here.txt");
  assert.deepEqual(await sync(fixture.nodeA, { [doneId]: "cancelled" }), {
    removed: [],
    retained: [{ taskId: doneId, reason: "1 commit no remote has" }],
  });
  assert.equal(git(cwd, "rev-parse", "HEAD"), head);
  assert.equal(git(fixture.nodeA.root, "tag", "--list"), "", "nothing was archived in place of keeping it");

  // Published but with an edit not committed: the managed-worktree rule keeps it for that reason instead.
  await deliver(fixture.nodeA, cwd, doneId, false);
  writeFileSync(path.join(cwd, "src", "index.txt"), "edited\n");
  assert.deepEqual(await sync(fixture.nodeA, { [doneId]: "cancelled" }), {
    removed: [],
    retained: [{ taskId: doneId, reason: "uncommitted changes" }],
  });
  assert.equal(git(cwd, "rev-parse", "HEAD"), head);

  git(cwd, "checkout", "-q", "--", "src/index.txt");
  assert.deepEqual((await sync(fixture.nodeA, { [doneId]: "cancelled" }))?.retained, []);
  assert.equal(existsSync(cwd), false);
});

test("a tombstoned or archived package closes its task whatever its status says", async (t) => {
  for (const disposition of ["tombstoned", "archived"]) {
    const fixture = nodesFixture(t),
      cwd = await checkout(fixture.nodeA, doneId);
    assert.deepEqual(
      (await sync(fixture.nodeA, { [doneId]: "active" }, { [doneId]: disposition }))?.removed,
      [{ taskId: doneId, archiveTag: null }],
      disposition,
    );
    assert.equal(existsSync(cwd), false, disposition);
  }
});

test("a blocked pull, a directory no mirrored package declares and a checkout on another branch are left alone", async (t) => {
  const fixture = nodesFixture(t),
    node = fixture.nodeA,
    cwd = await checkout(node, doneId);

  // The mirror has not converged with the center, so the close it carries is not acted on yet.
  await sync(node, { [doneId]: "active" });
  writeFileSync(path.join(node.root, "harness", "tasks", doneId, "INDEX.md"), "edited on this node\n");
  setCut(node, { [doneId]: "done" });
  const blocked = applyFleetMirrorCut(node.viewRoot, repoId, node.root, "pull");
  assert.equal(blocked.outcome, "pull_blocked");
  assert.equal(await reclaimEdgeTaskWorktrees(mirrorOf(node), blocked), null);
  assert.equal(existsSync(cwd), true);

  // A schedule occurrence's worktree has the same shape — directory and branch of one name — and no task package.
  const other = fixture.nodeB,
    occurrence = path.join(other.root, ".worktrees", "occ-occurrence_1");
  await addManagedWorktree(other.root, { cwd: occurrence, branch: "occ-occurrence_1", baseRef: "origin/main" });
  // A person switched the closed task's directory to a branch of their own.
  const switched = await checkout(other, doneId);
  git(switched, "switch", "-q", "-c", "mine");
  assert.equal(await sync(other, { [doneId]: "done" }), null);
  assert.equal(existsSync(occurrence) && existsSync(switched), true);
  assert.equal(git(other.root, "branch", "--list", doneId).length > 0, true);
});

test("a Git-less edge has no checkout to reclaim", async (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-edge-reclaim-gitless-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const node = { root: path.join(base, "node"), viewRoot: path.join(base, "view"), revision: 0 };
  mkdirSync(path.join(node.root, ".worktrees", doneId), { recursive: true });
  mkdirSync(path.join(node.root, "harness"));
  writeFileSync(path.join(node.root, "harness", "harness.yaml"), harnessYaml);
  writeFileSync(path.join(node.root, ".worktrees", doneId, "kept.txt"), "kept\n");
  assert.equal(await sync(node, { [doneId]: "done" }), null);
  assert.equal(existsSync(path.join(node.root, ".worktrees", doneId, "kept.txt")), true);
});

interface Node {
  readonly root: string;
  readonly viewRoot: string;
  revision: number;
}

function mirrorOf(node: Node) {
  return { viewRoot: node.viewRoot, repoId, workspaceRoot: node.root };
}

/** One sync round of a node: the center's next cut lands in its view and registered harness, then it reclaims. */
function sync(
  node: Node,
  statuses: Readonly<Record<string, string>>,
  dispositions: Readonly<Record<string, string>> = {},
) {
  setCut(node, statuses, dispositions);
  const applied = applyFleetMirrorCut(node.viewRoot, repoId, node.root, "pull");
  assert.equal(applied.outcome, "applied");
  return reclaimEdgeTaskWorktrees(mirrorOf(node), applied);
}

/** Writes the center's next cut into the node's replica view: one task package per id, the INDEX.md the kernel writes. */
function setCut(
  node: Node,
  statuses: Readonly<Record<string, string>>,
  dispositions: Readonly<Record<string, string>> = {},
): void {
  const revision = (node.revision += 1),
    viewDir = path.join(node.viewRoot, "repos", repoId, "views", "edge-view"),
    cutDir = path.join(viewDir, "cuts", String(revision)),
    files = Object.entries(statuses).map(([taskId, status]) => ({
      path: `tasks/${taskId}/INDEX.md`,
      body:
        `---\nschema: task-package/v2\ntask_id: ${taskId}\ntitle: "status: done"\nlifecycle:\n` +
        `  engine: kernel/task-lifecycle/v1\n  status: ${status}\n` +
        `packageDisposition: ${dispositions[taskId] ?? "active"}\nowner: machine\n---\n# Task\n\nstatus: done\n`,
    }));
  writeJson(path.join(cutDir, "manifest.json"), {
    entries: files.map((file) => ({
      path: file.path,
      blob: { sha256: sha(file.body), size: Buffer.byteLength(file.body), mediaType: "text/markdown" },
    })),
  });
  for (const file of files) {
    mkdirSync(path.dirname(path.join(cutDir, "files", file.path)), { recursive: true });
    writeFileSync(path.join(cutDir, "files", file.path), file.body);
  }
  writeJson(path.join(viewDir, "current.json"), {
    cut: { revision, headDigest: `sha256:${sha(`head-${revision}`)}` },
    manifestDigest: `sha256:${sha(`manifest-${revision}`)}`,
  });
}

async function checkout(node: Node, taskId: string): Promise<string> {
  return (await checkoutTaskWorktree(node.root, taskId, { branch: taskId, path: `.worktrees/${taskId}` }, []))!.cwd;
}

/** What a settlement does: the task branch is pushed, with one more commit on it unless the head is to go as is. */
async function deliver(node: Node, cwd: string, taskId: string, withCommit = true): Promise<void> {
  if (withCommit) commit(cwd, `${path.basename(node.root)}.txt`);
  const pushed = await pushWorkerBranch({ cwd, canonicalRoot: node.root, taskId });
  assert.equal(pushed.attempted && pushed.ok, true, JSON.stringify(pushed));
}

function nodesFixture(t: TestContext): { readonly remote: string; readonly nodeA: Node; readonly nodeB: Node } {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-edge-reclaim-"))),
    remote = path.join(base, "remote.git"),
    seed = path.join(base, "seed");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  git(base, "init", "--bare", "-q", "-b", "main", remote);
  git(base, "init", "-q", "-b", "main", seed);
  identify(seed);
  mkdirSync(path.join(seed, "src"));
  writeFileSync(path.join(seed, "src", "index.txt"), "base\n");
  writeFileSync(path.join(seed, ".gitignore"), "/harness/\n.worktrees\n.harness\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "base");
  git(seed, "push", "-q", remote, "main");
  const node = (name: string): Node => {
    const root = path.join(base, name);
    git(base, "clone", "-q", remote, root);
    identify(root);
    mkdirSync(path.join(root, "harness"));
    writeFileSync(path.join(root, "harness", "harness.yaml"), harnessYaml);
    return { root, viewRoot: path.join(base, `${name}-view`), revision: 0 };
  };
  return { remote, nodeA: node("node-a"), nodeB: node("node-b") };
}

function identify(root: string): void {
  git(root, "config", "user.name", "Edge Reclaim Test");
  git(root, "config", "user.email", "edge-reclaim@example.invalid");
}

function commit(cwd: string, file: string): string {
  writeFileSync(path.join(cwd, file), `${file}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", `feat: ${file}`);
  return git(cwd, "rev-parse", "HEAD");
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(cwd: string, ...args: string[]): string {
  // A task-bound host injects GIT_AUTHOR_*/GIT_COMMITTER_* and its own git config; env beats both repo config
  // and -c flags, so the fixture must not inherit either.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
  for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"])
    delete env[name];
  delete env.HARNESS_TASK_BOUND;
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env }).trim();
}
