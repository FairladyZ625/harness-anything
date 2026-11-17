// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { taskLifecycleWritePlan } from "@harness-anything/kernel/internal/domain/task-lifecycle-publication.ts";
import { activateEmptyCanonicalGeneration, makeSqliteTaskEventStore } from "../../src/sqlite/index.ts";
import { publishPendingSqliteGitOutbox } from "../../src/store/sqlite-git-outbox-publisher.ts";
import { localGitProcessCount } from "../../src/store/local-version-control-system.ts";
import { openPersistentWriterEpoch } from "../../src/writer-epoch.ts";
import { docBundle, eventAt, git, initRepo } from "./task-event-store.fixtures.ts";

// dec_04A9211B073F29F0FC1E1CA573 CH2: authority, restart recovery, and stale-owner negative control.
test("SQLite acceptance spawns no Git and host recovery publishes the durable outbox exactly once", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "host-git-outbox-")),
    repoId = "host-outbox-recovery";
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);
  activateEmptyCanonicalGeneration({ rootInput: rootDir, repoId });
  const options = { repoId, rootDir },
    before = git(rootDir, "rev-parse", "HEAD"),
    event = eventAt(1),
    store = makeSqliteTaskEventStore(options),
    processes = localGitProcessCount();
  const accepted = store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
  assert.equal(accepted.revision, 1);
  assert.equal(accepted.commitSha, null);
  assert.equal(localGitProcessCount(), processes, "canonical acceptance cannot spawn a Git subprocess");
  assert.equal(store.gitOutboxState!().pendingRevision, 1);
  assert.equal(store.gitOutboxState!().publishedRevision, 0);
  assert.equal(git(rootDir, "rev-parse", "HEAD"), before);
  await store.drain();

  // A fresh publisher has no in-memory append callback or remembered baseline.
  const published = await publishPendingSqliteGitOutbox(options),
    head = git(rootDir, "rev-parse", "HEAD");
  assert.equal(published.followerStatus.git.status, "verified");
  assert.notEqual(head, before);
  const repeated = await publishPendingSqliteGitOutbox(options);
  assert.equal(repeated.followerStatus.git.cut?.revision, 1);
  assert.equal(git(rootDir, "rev-parse", "HEAD"), head, "recovery replays no duplicate Git commit");
  const reopened = makeSqliteTaskEventStore(options);
  try {
    assert.equal(reopened.readHead()?.revision, 1, "publication does not append a second canonical event");
    assert.equal(reopened.gitOutboxState!().publishedRevision, 1);
  } finally {
    await reopened.drain();
  }
});

test("an old writer epoch cannot publish or acknowledge a pending Git outbox", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "host-git-outbox-fence-")),
    repoId = "host-outbox-fence";
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);
  activateEmptyCanonicalGeneration({ rootInput: rootDir, repoId });
  const epoch = openPersistentWriterEpoch({ stateRoot: path.join(rootDir, "epochs"), holderId: "first" }),
    first = epoch.acquire(repoId),
    event = eventAt(1),
    withAppendFence = <T>(work: () => T) => epoch.withAppendFence(repoId, first.epoch, first.holderId, work),
    store = makeSqliteTaskEventStore({ repoId, rootDir, writerFence: () => first, withAppendFence });
  t.after(() => epoch.close());
  store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
  await store.drain();
  const head = git(rootDir, "rev-parse", "HEAD");
  epoch.acquire(repoId);
  await assert.rejects(publishPendingSqliteGitOutbox({ repoId, rootDir, withAppendFence }));
  assert.equal(git(rootDir, "rev-parse", "HEAD"), head, "stale publisher cannot advance the Git ref");
  const reopened = makeSqliteTaskEventStore({ repoId, rootDir });
  try {
    assert.equal(reopened.gitOutboxState!().publishedRevision, 0);
  } finally {
    await reopened.drain();
  }
});

test("host publication resumes after the accepting process exits without draining", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "host-outbox-process-restart-")),
    repoId = "host-outbox-process-restart";
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);
  activateEmptyCanonicalGeneration({ rootInput: rootDir, repoId });
  const before = git(rootDir, "rev-parse", "HEAD"),
    accepted = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        fileURLToPath(new URL("./host-outbox-accepted.fixture.mjs", import.meta.url)),
        rootDir,
        repoId,
      ],
      { encoding: "utf8" },
    );
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(git(rootDir, "rev-parse", "HEAD"), before);
  const published = await publishPendingSqliteGitOutbox({ rootDir, repoId }),
    commit = git(rootDir, "rev-parse", "HEAD");
  assert.equal(published.followerStatus.git.cut?.revision, 1);
  assert.notEqual(commit, before);
  await publishPendingSqliteGitOutbox({ rootDir, repoId });
  assert.equal(git(rootDir, "rev-parse", "HEAD"), commit);
});

test("delegated acceptance rejects an unfrozen write plan before sending it to the Writer", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "host-commit-declaration-")),
    repoId = "host-commit-declaration";
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  activateEmptyCanonicalGeneration({ rootInput: rootDir, repoId });
  const event = eventAt(1),
    store = makeSqliteTaskEventStore({
      repoId,
      rootDir,
      canonicalWriter: {
        append: () => assert.fail("invalid declarations cannot cross the commit port"),
        appendRejection: () => assert.fail("invalid declarations cannot mutate command outcomes"),
        pruneReplicationLog: () => assert.fail("invalid declarations cannot prune the ledger"),
      },
    });
  try {
    assert.throws(() => store.append({ event, plan: structuredClone(taskLifecycleWritePlan(event)), blobs: [] }), {
      code: "invalid_write_plan",
    });
    assert.equal(store.readHead(), null);
  } finally {
    await store.drain();
  }
});

test("delegated acceptance validates corrupted content at the authoritative storage boundary", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "host-commit-content-")),
    repoId = "host-commit-content";
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  activateEmptyCanonicalGeneration({ rootInput: rootDir, repoId });
  const writer = makeSqliteTaskEventStore({ repoId, rootDir });
  let transported = 0;
  const host = makeSqliteTaskEventStore({
    repoId,
    rootDir,
    canonicalWriter: {
      ...writer,
      append: (bundle, preparation) => {
        transported++;
        assert.equal(preparation?.authoredRoot, path.join(rootDir, "harness"));
        return writer.append(bundle, preparation);
      },
    },
  });
  try {
    const valid = docBundle(writer, "# Shared\nbody\n", 1, "content-admission", "notes/shared.md");
    assert.throws(
      () => host.append({ ...valid, blobs: valid.blobs.map((blob) => ({ ...blob, body: "# Shared\nevil\n" })) }),
      { code: "invalid_write_plan" },
    );
    assert.equal(transported, 1, "content validation must be proven at the real storage boundary");
    assert.equal(writer.readHead(), null, "rejected bytes cannot produce a canonical event");
    assert.equal(host.append(valid).revision, 1, "the same declaration with correct bytes remains admissible");
  } finally {
    await host.drain();
    await writer.drain();
  }
});
