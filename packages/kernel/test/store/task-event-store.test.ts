// harness-test-tier: integration
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { attachReceiptAcceptance } from "../../src/composition/receipt-acceptance.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import { localContentObjectFileSystem } from "../../src/local/local-layout-file-system.ts";
import { localGitObjectRefStore } from "../../src/store/local-version-control-system.ts";
import { openSqliteEventStore, sqliteContentObjectPath } from "../../src/store/sqlite-event-store.ts";
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

test("same canonical event values replay despite a different object key order", async () => {
  const rootDir = fixture("canonical-replay");
  initRepo(rootDir);
  const event = eventAt(1),
    store = makeTaskEventStore({ repoId, rootDir, writerFence });
  try {
    const first = store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] }),
      reordered = {
        payload: event.payload,
        occurredAt: event.occurredAt,
        source: event.source,
        actor: event.actor,
        type: event.type,
        taskId: event.taskId,
        opId: event.opId,
        workspaceRevision: event.workspaceRevision,
        eventId: event.eventId,
        schema: event.schema,
      } as typeof event,
      replay = store.append({ event: reordered, plan: taskLifecycleWritePlan(reordered), blobs: [] });
    assert.deepEqual(replay.cut, first.cut);
    assert.equal(store.currentCut().revision, 1);
    assert.deepEqual(store.readCommandOutcome(event.opId)?.memberOpIds, [event.opId]);
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
    beforeUnrelatedIndex = git(rootDir, "ls-files", "--stage", "--", "notes"),
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
    assert.equal(store.canonicalRef, "sqlite:generation-2");
    assert.equal(store.followerStatus().git.status, "pending");
    assert.equal(git(rootDir, "rev-parse", "HEAD"), beforeHead);
    assert.equal(git(rootDir, "for-each-ref", "--format=%(objectname)", "refs/ha/canonical"), beforeCanonical);
    await store.settlePendingMaterialization?.("contract test");
    assert.equal(store.followerStatus().git.status, "verified");
    assert.equal(git(rootDir, "for-each-ref", "--format=%(objectname)", "refs/ha/canonical"), beforeCanonical);
    assert.equal(git(rootDir, "ls-files", "--stage", "--", "notes"), beforeUnrelatedIndex);
    for (const managed of ["harness/context/contract.md", "harness/events/segments/manifest.json"])
      assert.match(
        git(rootDir, "ls-files", "--stage", "--", managed),
        new RegExp(git(rootDir, "rev-parse", `HEAD:${managed}`), "u"),
      );
    for (const [relative, bytes] of beforeBytes)
      assert.deepEqual(readFileSync(path.join(rootDir, relative)), bytes, `${relative} bytes changed`);
    assert.equal(statSync(path.join(rootDir, "notes/prose.md")).mode & 0o777, beforeMode);
    const sqlite = openSqliteEventStore({ repoId, rootInput: rootDir, generation: 2, readOnly: true });
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

test("each settlement renders and settles only its own events while a concurrent edit keeps its bytes", async (t) => {
  const rootDir = fixture("incremental-follower"),
    edited = path.join(rootDir, "harness/context/edited.md");
  initRepo(rootDir);
  mkdirSync(path.dirname(edited), { recursive: true });
  writeFileSync(edited, "user edit\n");
  let settledFiles = 0;
  const contentReads = t.mock.method(localContentObjectFileSystem, "readBytes"),
    options = {
      repoId,
      rootDir,
      writerFence,
      killpoint: (point: string) => {
        if (point === "before_worktree_rename") settledFiles += 1;
      },
    },
    measure = async (store: ReturnType<typeof makeTaskEventStore>, context: string) => {
      contentReads.mock.resetCalls();
      settledFiles = 0;
      await store.settlePendingMaterialization!(context);
      return { contentReads: contentReads.mock.callCount(), settledFiles };
    };
  const store = makeTaskEventStore(options),
    perCut: Awaited<ReturnType<typeof measure>>[] = [];
  try {
    store.append(docBundle(store, "accepted\n", 1, "incremental-edited", "context/edited.md"));
    await store.settlePendingMaterialization!("cut claiming the edited document");
    for (let revision = 2; revision <= 6; revision += 1) {
      const logical = `context/later-${revision}.md`;
      store.append(docBundle(store, `accepted ${revision}\n`, revision, `incremental-${revision}`, logical));
      perCut.push(await measure(store, `cut ${revision}`));
      assert.equal(readFileSync(path.join(rootDir, "harness", logical), "utf8"), `accepted ${revision}\n`);
    }
    // One content object, and its document plus the manifest, per cut: never the history behind it.
    assert.deepEqual(
      perCut,
      perCut.map(() => ({ contentReads: 1, settledFiles: 2 })),
    );
    assert.equal(readFileSync(edited, "utf8"), "user edit\n");
    const head = store.currentCut(),
      physical = JSON.parse(readFileSync(path.join(rootDir, "harness/events/segments/manifest.json"), "utf8"));
    assert.deepEqual(store.followerStatus().git.cut, head);
    assert.deepEqual(store.followerStatus().worktree.cut, head);
    assert.deepEqual(physical.cut, head);
    assert.equal(store.followerStatus().worktree.status, "pending");
    assert.deepEqual(store.followerStatus().worktree.conflicts, ["harness/context/edited.md"]);
  } finally {
    await store.drain();
  }
  // The worktree's own manifest says where it stands, so a reopen settles nothing and leaves the edit alone.
  const reopened = makeTaskEventStore(options);
  try {
    assert.deepEqual(await measure(reopened, "reopen at the settled cut"), { contentReads: 0, settledFiles: 0 });
    assert.equal(reopened.followerStatus().git.status, "verified");
    assert.equal(readFileSync(edited, "utf8"), "user edit\n");
  } finally {
    await reopened.drain();
  }
});

test("repeated settlement preserves concurrent edits to a claimed document until materialization restores it", async () => {
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
  assert.deepEqual(store.followerStatus().worktree.conflicts, ["harness/context/owned.md"]);
  assert.equal(readFileSync(target, "utf8"), "user edit\n");
  await store.drain();
  assert.equal(readFileSync(target, "utf8"), "user edit\n");
  rmSync(target);
  store = makeTaskEventStore({ repoId, rootDir, writerFence });
  await store.settlePendingMaterialization!("a reported path is not retried on its own");
  assert.equal(existsSync(target), false);
  store.materialize();
  assert.equal(store.followerStatus().worktree.status, "verified");
  assert.equal(readFileSync(target, "utf8"), "accepted content\n");
  await store.drain();
});

test("a caller edit at the rename boundary is preserved as a pending worktree conflict", async () => {
  const rootDir = fixture("rename-boundary-edit"),
    target = path.join(rootDir, "harness/context/boundary.md");
  initRepo(rootDir);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "accepted content\r\n");
  let injectEdit = true;
  const store = makeTaskEventStore({
    repoId,
    rootDir,
    writerFence,
    killpoint: (point) => {
      if (injectEdit && point === "before_worktree_rename") {
        injectEdit = false;
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, "caller edit at settlement boundary\n");
      }
    },
  });
  try {
    store.append(docBundle(store, "accepted content\n", 1, "boundary-edit", "context/boundary.md"));
    await store.settlePendingMaterialization!("inject boundary edit");
    assert.equal(store.followerStatus().git.status, "verified");
    assert.equal(store.followerStatus().worktree.status, "pending");
    assert.deepEqual(store.followerStatus().worktree.conflicts, ["harness/context/boundary.md"]);
    assert.equal(readFileSync(target, "utf8"), "caller edit at settlement boundary\n");
    rmSync(target);
    store.materialize();
    assert.equal(store.followerStatus().worktree.status, "verified");
    assert.equal(readFileSync(target, "utf8"), "accepted content\n");
  } finally {
    await store.drain();
  }
});

test("an authored ref moved after the follower's atomic update is followed, not fought, by the next run", async () => {
  const rootDir = fixture("authored-ref-readback");
  initRepo(rootDir);
  const branch = git(rootDir, "symbolic-ref", "--short", "HEAD"),
    parent = git(rootDir, "rev-parse", "HEAD");
  let resetRef = true;
  const store = makeTaskEventStore({
    repoId,
    rootDir,
    writerFence,
    killpoint: (point) => {
      if (resetRef && point === "after_git_ref_update") {
        resetRef = false;
        git(rootDir, "update-ref", `refs/heads/${branch}`, parent);
      }
    },
  });
  try {
    store.append(docBundle(store, "accepted content\n", 1, "ref-moved", "context/ref-moved.md"));
    await store.settlePendingMaterialization!("move authored ref after update");
    assert.equal(git(rootDir, "rev-parse", "HEAD"), parent);
    await store.settlePendingMaterialization!("publish on top of the moved ref");
    const head = git(rootDir, "rev-parse", "HEAD");
    assert.notEqual(head, parent);
    assert.equal(git(rootDir, "rev-parse", "HEAD^"), parent);
    assert.equal(git(rootDir, "show", "HEAD:harness/context/ref-moved.md"), "accepted content");
    assert.equal(store.followerStatus().git.status, "verified");
    assert.equal(store.followerStatus().git.commitSha, head);
  } finally {
    await store.drain();
  }
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
  const beforeUnrelatedIndex = git(rootDir, "ls-files", "--stage", "--", "harness/.gitattributes"),
    store = makeTaskEventStore({ repoId, rootDir, writerFence });
  try {
    for (let revision = 1; revision <= 3; revision += 1) {
      const body = `accepted revision ${revision}\n`;
      store.append(docBundle(store, body, revision, `successive-${revision}`, "context/managed.md"));
      await store.settlePendingMaterialization!("successive publication");
      assert.equal(store.followerStatus().worktree.status, "verified");
      assert.equal(readFileSync(path.join(rootDir, "harness/context/managed.md"), "utf8"), body);
      assert.equal(git(rootDir, "ls-files", "--stage", "--", "harness/.gitattributes"), beforeUnrelatedIndex);
      for (const managed of ["harness/context/managed.md", "harness/events/segments/manifest.json"])
        assert.match(
          git(rootDir, "ls-files", "--stage", "--", managed),
          new RegExp(git(rootDir, "rev-parse", `HEAD:${managed}`), "u"),
        );
    }
  } finally {
    await store.drain();
  }
});

test("new cuts cannot certify worktree visibility over an older unresolved document conflict", async () => {
  const rootDir = fixture("older-conflict");
  initRepo(rootDir);
  const target = path.join(rootDir, "harness/context/conflicted.md");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "user edit\n");
  const store = makeTaskEventStore({ repoId, rootDir, writerFence });
  try {
    store.append(docBundle(store, "accepted\n", 1, "older-conflict", "context/conflicted.md"));
    await store.settlePendingMaterialization!("first conflict");
    store.append(docBundle(store, "next document\n", 2, "newer-cut", "context/next.md"));
    await store.settlePendingMaterialization!("new cut with prior conflict");
    assert.equal(store.followerStatus().git.status, "verified");
    assert.equal(store.followerStatus().worktree.status, "pending");
    assert.deepEqual(store.followerStatus().worktree.conflicts, ["harness/context/conflicted.md"]);
    assert.equal(readFileSync(target, "utf8"), "user edit\n");
    assert.equal(readFileSync(path.join(rootDir, "harness/context/next.md"), "utf8"), "next document\n");
    // Once the worktree holds the accepted bytes the conflict is gone, so a later cut can certify visibility.
    writeFileSync(target, "accepted\n");
    store.append(docBundle(store, "third document\n", 3, "third-cut", "context/third.md"));
    await store.settlePendingMaterialization!("conflict resolved to the accepted bytes");
    assert.equal(store.followerStatus().worktree.status, "verified");
    assert.deepEqual(store.followerStatus().worktree.conflicts, []);
  } finally {
    await store.drain();
  }
});

test("corrupt accepted content cannot be certified by publishing the same corrupt bytes to Git", async () => {
  const rootDir = fixture("corrupt-content");
  initRepo(rootDir);
  const store = makeTaskEventStore({ repoId, rootDir, writerFence });
  try {
    const bundle = docBundle(store, "accepted\n", 1, "corrupt-content", "context/accepted.md");
    store.append(bundle);
    writeFileSync(
      sqliteContentObjectPath(rootDir, bundle.blobs[0]!.sha256, store.ledgerMetadata().generation),
      "corrupted\n",
    );
    await store.settlePendingMaterialization!("detect corrupt content");
    assert.equal(store.readCommandOutcome("corrupt-content")?.status, "accepted_durable");
    assert.equal(store.followerStatus().git.status, "pending");
    assert.match(store.followerStatus().git.reason!, /corrupt/u);
  } finally {
    await store.drain();
  }
});

function fixture(name: string): string {
  return mkdtempSync(path.join(tmpdir(), `ha-sqlite-${name}-`));
}

test("later acceptance retains the verified prefix without certifying the newer receipt", async () => {
  const rootDir = fixture("verified-prefix");
  initRepo(rootDir);
  const store = makeTaskEventStore({ repoId, rootDir, writerFence });
  const first = eventAt(1),
    second = eventAt(2);
  const projection = { readCut: () => ({ watermark: store.currentCut().revision }) } as never;
  const receipt = (opId: string) => attachReceiptAcceptance({ outcome: "applied", opId }, store, projection);
  try {
    store.append({ event: first, plan: taskLifecycleWritePlan(first), blobs: [] });
    store.materialize();
    assert.equal(receipt(first.opId).git.state, "verified");
    const appended = store.append({ event: second, plan: taskLifecycleWritePlan(second), blobs: [] });
    assert.equal(receipt(first.opId).git.state, "verified", "new acceptance must not erase verified history");
    assert.equal(receipt(first.opId).worktree.state, "verified");
    assert.equal(receipt(second.opId).git.state, "pending");
    assert.equal(receipt(second.opId).worktree.state, "pending");
    assert.equal(receipt(second.opId).git.commitSha, null);
    assert.equal(appended.commitSha, null);
    assert.equal(store.materializationHealth().lastCheckpointRevision, 1);
    assert.equal(store.materializationHealth().pendingWalEvents, 1);
    assert.equal(store.materializationHealth().state, "retrying");
    store.materialize();
    assert.equal(receipt(second.opId).git.state, "verified");
    assert.equal(receipt(second.opId).worktree.state, "verified");
  } finally {
    await store.drain();
  }
});
