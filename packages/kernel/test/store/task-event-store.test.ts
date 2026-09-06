// harness-test-tier: integration
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import { localGitObjectRefStore } from "../../src/store/local-version-control-system.ts";
import { openSqliteEventStore } from "../../src/store/sqlite-event-store.ts";
import { makeTaskEventStore, readCertifiedGitFollower } from "../../src/store/task-event-store.ts";
import { docBundle, eventAt, git, initRepo } from "./task-event-store.fixtures.ts";

const repoId = "sqlite-canonical-contract";
const writerFence = () => ({ repoId, holderId: "contract-writer", epoch: 1 });

test("before_event_write and after_event_write bound one atomic SQLite acceptance", async () => {
  const rootDir = fixture("atomic");
  initRepo(rootDir);
  const observed: string[] = [],
    event = eventAt(1),
    store = makeTaskEventStore({ repoId, rootDir, writerFence, killpoint: (point) => observed.push(point) });
  try {
    store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
    assert.ok(observed.indexOf("before_event_write") < observed.indexOf("after_event_write"));
    assert.ok(observed.indexOf("after_event_write") < observed.indexOf("after_sqlite_commit"));
    assert.equal(store.readCommandOutcome(event.opId)?.status, "accepted_durable");
  } finally {
    await store.drain();
  }
});

test("after_head_write and after_git_commit are absent from the SQLite accept transaction", async () => {
  const rootDir = fixture("retired-killpoints");
  initRepo(rootDir);
  const observed: string[] = [],
    event = eventAt(1),
    store = makeTaskEventStore({ repoId, rootDir, writerFence, killpoint: (point) => observed.push(point) });
  try {
    store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
    assert.equal(observed.includes("after_head_write"), false);
    assert.equal(observed.includes("after_git_commit"), false);
    assert.equal(store.currentCut().revision, 1);
  } finally {
    await store.drain();
  }
});

test("Git follower no longer advances canonical and authored refs to one SHA while preserving index, prose, and every unrelated dirty path byte", async () => {
  const rootDir = fixture("separate-facets");
  initRepo(rootDir);
  mkdirSync(path.join(rootDir, "notes"));
  writeFileSync(path.join(rootDir, "notes/prose.md"), "committed prose\n");
  writeFileSync(path.join(rootDir, "notes/staged.txt"), "committed index\n");
  git(rootDir, "add", "notes");
  git(rootDir, "commit", "-qm", "seed unrelated files");
  writeFileSync(path.join(rootDir, "notes/prose.md"), "dirty prose bytes\n");
  chmodSync(path.join(rootDir, "notes/prose.md"), 0o755);
  writeFileSync(path.join(rootDir, "notes/staged.txt"), "staged bytes\n");
  git(rootDir, "add", "notes/staged.txt");
  writeFileSync(path.join(rootDir, "notes/staged.txt"), "unstaged bytes after staged bytes\n");
  writeFileSync(path.join(rootDir, "notes/untracked.txt"), "untracked bytes\n");
  const beforeHead = git(rootDir, "rev-parse", "HEAD"),
    beforeCanonical = git(rootDir, "for-each-ref", "--format=%(objectname)", "refs/ha/canonical"),
    beforeIndex = git(rootDir, "ls-files", "--stage"),
    beforeBytes = new Map(
      ["notes/prose.md", "notes/staged.txt", "notes/untracked.txt"].map((relative) => [
        relative,
        readFileSync(path.join(rootDir, relative)),
      ]),
    ),
    beforeMode = statSync(path.join(rootDir, "notes/prose.md")).mode & 0o777,
    store = makeTaskEventStore({ repoId, rootDir, writerFence });
  try {
    const receipt = store.append(docBundle(store, "# Git readback\n", 1, "contract-doc", "context/contract.md"));
    assert.equal(receipt.commitSha, null);
    assert.equal(store.canonicalRef, "sqlite:generation-1");
    assert.equal(store.followerStatus().git.status, "pending");
    assert.equal(git(rootDir, "rev-parse", "HEAD"), beforeHead);
    assert.equal(git(rootDir, "for-each-ref", "--format=%(objectname)", "refs/ha/canonical"), beforeCanonical);
    await store.settlePendingMaterialization?.("contract test");
    assert.equal(store.followerStatus().git.status, "verified");
    assert.equal(git(rootDir, "for-each-ref", "--format=%(objectname)", "refs/ha/canonical"), beforeCanonical);
    assert.equal(git(rootDir, "ls-files", "--stage"), beforeIndex);
    for (const [relative, bytes] of beforeBytes)
      assert.deepEqual(readFileSync(path.join(rootDir, relative)), bytes, `${relative} bytes changed`);
    assert.equal(statSync(path.join(rootDir, "notes/prose.md")).mode & 0o777, beforeMode);
    const sqlite = openSqliteEventStore({ repoId, rootInput: rootDir, readOnly: true });
    try {
      const certified = readCertifiedGitFollower({ rootInput: rootDir, repoId, store: sqlite }),
        document = certified.documents.find((candidate) => candidate.path.endsWith("context/contract.md"));
      assert.ok(document);
      assert.equal(git(rootDir, "show", `${certified.commitSha}:harness/${document.path}`), "# Git readback");
      assert.equal(document.mode, "100644");
    } finally {
      sqlite.close();
    }
  } finally {
    await store.drain();
  }
});

test("acceptance subprocess cost is independent of 100 versus 10,000-event history", async () => {
  const rootDir = fixture("history-independent");
  initRepo(rootDir);
  const store = makeTaskEventStore({ repoId, rootDir, writerFence }),
    before = localGitObjectRefStore.processCount();
  try {
    for (let revision = 1; revision <= 10_000; revision += 1) {
      const event = eventAt(revision);
      store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
      if (revision === 100) assert.equal(localGitObjectRefStore.processCount(), before);
    }
    const atTenThousand = localGitObjectRefStore.processCount();
    assert.equal(atTenThousand, before);
  } finally {
    await store.drain();
  }
});

test("repeated settlement preserves concurrent edits to a claimed document and resumes after resolution", async () => {
  const rootDir = fixture("claimed-edit"),
    target = path.join(rootDir, "harness/context/owned.md");
  initRepo(rootDir);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "user edit\n");
  let store = makeTaskEventStore({ repoId, rootDir, writerFence });
  store.append(docBundle(store, "accepted content\n", 1, "claimed-edit", "context/owned.md"));
  await store.settlePendingMaterialization!("first attempt");
  await store.settlePendingMaterialization!("retry must not bless user bytes");
  assert.equal(store.followerStatus().git.status, "verified");
  assert.equal(store.followerStatus().worktree.status, "pending");
  assert.equal(readFileSync(target, "utf8"), "user edit\n");
  await store.drain();
  assert.equal(readFileSync(target, "utf8"), "user edit\n");
  rmSync(target);
  store = makeTaskEventStore({ repoId, rootDir, writerFence });
  await store.settlePendingMaterialization!("user restored pre-publication state");
  assert.equal(store.followerStatus().worktree.status, "verified");
  assert.equal(readFileSync(target, "utf8"), "accepted content\n");
  await store.drain();
});

test("worktree failure preserves an independently verified Git facet", async () => {
  const rootDir = fixture("worktree-failure");
  initRepo(rootDir);
  let fail = true;
  const store = makeTaskEventStore({
    repoId,
    rootDir,
    writerFence,
    killpoint: (point) => {
      if (fail && point === "before_worktree_rename") throw new Error("worktree unavailable");
    },
  });
  try {
    store.append(docBundle(store, "accepted\n", 1, "worktree-failure", "context/accepted.md"));
    await store.settlePendingMaterialization!("injected worktree failure");
    assert.equal(store.readCommandOutcome("worktree-failure")?.status, "accepted_durable");
    assert.equal(store.followerStatus().git.status, "verified");
    assert.equal(store.followerStatus().worktree.status, "pending");
    fail = false;
    await store.settlePendingMaterialization!("worktree recovered");
    assert.equal(store.followerStatus().worktree.status, "verified");
  } finally {
    fail = false;
    await store.drain();
  }
});

test("successive Git cuts settle managed files while leaving the caller index untouched", async () => {
  const rootDir = fixture("successive-cuts");
  initRepo(rootDir);
  const beforeIndex = git(rootDir, "ls-files", "--stage"),
    store = makeTaskEventStore({ repoId, rootDir, writerFence });
  try {
    for (let revision = 1; revision <= 3; revision += 1) {
      const body = `accepted revision ${revision}\n`;
      store.append(docBundle(store, body, revision, `successive-${revision}`, "context/managed.md"));
      await store.settlePendingMaterialization!("successive publication");
      assert.equal(store.followerStatus().worktree.status, "verified");
      assert.equal(readFileSync(path.join(rootDir, "harness/context/managed.md"), "utf8"), body);
      assert.equal(git(rootDir, "ls-files", "--stage"), beforeIndex);
    }
  } finally {
    await store.drain();
  }
});

function fixture(name: string): string {
  return mkdtempSync(path.join(tmpdir(), `ha-sqlite-${name}-`));
}
