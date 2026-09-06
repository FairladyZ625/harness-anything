// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import { localGitObjectRefStore } from "../../src/store/local-version-control-system.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { eventAt, initRepo } from "./task-event-store.fixtures.ts";

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
  const event = eventAt(1),
    store = makeTaskEventStore({ repoId, rootDir, writerFence });
  try {
    const receipt = store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
    assert.equal(receipt.commitSha, null);
    assert.equal(store.canonicalRef, "sqlite:generation-1");
    assert.equal(store.followerStatus().git.status, "pending");
    await store.settlePendingMaterialization?.("contract test");
    assert.equal(store.followerStatus().git.status, "verified");
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
    }
    assert.equal(localGitObjectRefStore.processCount(), before);
  } finally {
    await store.drain();
  }
});

function fixture(name: string): string {
  return mkdtempSync(path.join(tmpdir(), `ha-sqlite-${name}-`));
}
