// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  serializeTaskEvent,
  type TaskCreatedEvent,
} from "../../src/domain/task-lifecycle.contract.ts";
import { serializeEventHead } from "../../src/domain/write-chain.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import {
  contentObjectRelativePath,
  eventObjectRelativePath,
} from "../../src/layout/ledger-object-layout.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

import {
  bundle,
  docBundle,
  event,
  eventAt,
  flatLedgerFixture,
  git,
  initRepo,
  mixedLedgerFixture,
} from "./task-event-store.fixtures.ts";
test("flat ledger migration renames every event and blob, appends one event, and audits reachability", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const { blobHash, parent } = flatLedgerFixture(rootDir, 2),
      store = makeTaskEventStore({ repoId: "layout-migrate", rootDir }),
      beforeTree = git(rootDir, "rev-parse", `${parent}:harness/events`),
      receipt = store.migrateLayout({
        actor: event.actor,
        source: "local",
        occurredAt: "2026-08-16T00:00:00.000Z",
      });
    assert.equal(receipt.event.schema, "ledger-layout-event/v1");
    if (receipt.event.schema !== "ledger-layout-event/v1") return;
    assert.deepEqual(receipt.event.payload, {
      from: "flat/v1",
      to: "sharded-sha256-2/v1",
      eventCount: 2,
      blobCount: 1,
      preEventsTreeSha: beforeTree,
    });
    assert.equal(receipt.revision, 3);
    assert.equal(
      git(rootDir, "rev-list", "--count", receipt.commitSha.sha),
      String(Number(git(rootDir, "rev-list", "--count", parent)) + 1),
    );
    assert.equal(
      spawnSync("git", [
        "-C",
        rootDir,
        "merge-base",
        "--is-ancestor",
        parent,
        receipt.commitSha.sha,
      ]).status,
      0,
    );
    const rootEntries = git(
      rootDir,
      "ls-tree",
      "--name-only",
      `${receipt.commitSha.sha}:harness/events`,
    ).split("\n");
    assert.deepEqual(
      rootEntries.filter((name) => name.endsWith(".json")),
      ["head.json"],
    );
    for (const oldEvent of [eventAt(1), eventAt(2)]) {
      assert.equal(
        git(
          rootDir,
          "ls-tree",
          "--name-only",
          receipt.commitSha.sha,
          "--",
          `harness/events/${oldEvent.opId}.json`,
        ),
        "",
      );
      assert.equal(
        git(
          rootDir,
          "show",
          `${receipt.commitSha.sha}:harness/${eventObjectRelativePath(oldEvent.opId)}`,
        ),
        serializeTaskEvent(oldEvent).trimEnd(),
      );
    }
    assert.equal(
      git(
        rootDir,
        "show",
        `${receipt.commitSha.sha}:harness/${contentObjectRelativePath(blobHash)}`,
      ),
      "legacy blob",
    );
    assert.equal(store.read().revision, 3);
    const repeated = store.migrateLayout({
      actor: event.actor,
      source: "local",
      occurredAt: "2026-08-16T00:00:00.000Z",
    });
    assert.equal(repeated.commitSha.sha, receipt.commitSha.sha);
    assert.equal(git(rootDir, "rev-parse", "HEAD"), receipt.commitSha.sha);
  });
});

for (const killpoint of [
  "after_head_write",
  "after_worktree_rename",
] as const) {
  test(`flat ledger migration recovers ${killpoint} through the prepared ref`, async () => {
    await withTempStoreAsync(async (rootDir) => {
      flatLedgerFixture(rootDir, 2);
      let settledRenames = 0;
      const interrupted = makeTaskEventStore({
        repoId: "layout-recovery",
        rootDir,
        killpoint: (point) => {
          if (
            point !== killpoint ||
            (point === "after_worktree_rename" && ++settledRenames < 3)
          )
            return;
          throw new Error(`crash:${point}`);
        },
      });
      assert.throws(
        () =>
          interrupted.migrateLayout({
            actor: event.actor,
            source: "local",
            occurredAt: "2026-08-16T00:00:00.000Z",
          }),
        new RegExp(`crash:${killpoint}`, "u"),
      );
      if (killpoint === "after_worktree_rename") {
        const first = eventAt(1);
        assert.equal(
          existsSync(path.join(rootDir, `harness/events/${first.opId}.json`)),
          false,
        );
        assert.equal(
          existsSync(
            path.join(rootDir, "harness", eventObjectRelativePath(first.opId)),
          ),
          true,
        );
      }
      const recoveredStore = makeTaskEventStore({
          repoId: "layout-recovery",
          rootDir,
        }),
        recovered = recoveredStore.recover();
      assert.equal(
        recovered.status,
        killpoint === "after_head_write" ? "committed" : "already_committed",
      );
      assert.equal(recoveredStore.read().revision, 3);
      assert.deepEqual(
        git(rootDir, "ls-tree", "--name-only", "HEAD:harness/events")
          .split("\n")
          .filter((name) => name.endsWith(".json")),
        ["head.json"],
      );
    });
  });
}

test("append follows the ledger's existing flat layout, stays readable, and reuses flat blobs", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const { blobHash } = flatLedgerFixture(rootDir, 2),
      store = makeTaskEventStore({ repoId: "flat-append", rootDir });
    assert.equal(store.layout(), "flat/v1");
    const third = eventAt(3);
    store.append(bundle(third));
    assert.equal(
      existsSync(path.join(rootDir, `harness/events/${third.opId}.json`)),
      true,
    );
    assert.equal(
      git(rootDir, "ls-tree", "-d", "--name-only", "HEAD:harness/events"),
      "",
    );
    assert.equal(store.read().revision, 3);
    assert.deepEqual(store.readEvent(third.opId), third);
    assert.deepEqual(store.append(bundle(third)).metrics.changedPaths, []);
    const doc = store.append(
      docBundle(store, "legacy blob\n", 4, "op-doc-flat", "context/flat.md"),
    );
    assert.equal(
      doc.metrics.changedPaths.includes(`harness/objects/sha256/${blobHash}`),
      false,
    );
    assert.equal(
      git(
        rootDir,
        "ls-tree",
        "--name-only",
        "HEAD:harness/objects/sha256",
      ).trim(),
      blobHash,
    );
    assert.equal(store.read().revision, 4);
  });
});

test("append keeps the sharded layout on sharded ledgers", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "sharded-append", rootDir });
    assert.equal(store.layout(), "sharded-sha256-2/v1");
    store.append(bundle(eventAt(1)));
    assert.equal(
      existsSync(
        path.join(rootDir, "harness", eventObjectRelativePath(eventAt(1).opId)),
      ),
      true,
    );
    assert.equal(
      existsSync(path.join(rootDir, `harness/events/${eventAt(1).opId}.json`)),
      false,
    );
    assert.equal(store.read().revision, 1);
  });
});

test("content blob writes dedupe against both the flat and the sharded spelling", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventsRoot = path.join(rootDir, "harness/events"),
      objectsRoot = path.join(rootDir, "harness/objects/sha256");
    mkdirSync(eventsRoot, { recursive: true });
    mkdirSync(objectsRoot, { recursive: true });
    const first = eventAt(1),
      second = eventAt(2);
    writeFileSync(
      path.join(eventsRoot, `${first.opId}.json`),
      serializeTaskEvent(first),
    );
    writeFileSync(
      path.join(eventsRoot, `${second.opId}.json`),
      serializeTaskEvent(second),
    );
    writeFileSync(
      path.join(eventsRoot, "head.json"),
      serializeEventHead({
        revision: 2,
        opId: second.opId,
        eventDigest: `sha256:${sha256Text(serializeTaskEvent(second))}`,
      }),
    );
    const body = "# Twin body\n",
      hash = sha256Text(body),
      sharded = path.join(objectsRoot, hash.slice(0, 2), hash.slice(2));
    mkdirSync(path.dirname(sharded), { recursive: true });
    writeFileSync(sharded, body);
    git(rootDir, "add", "harness");
    git(rootDir, "commit", "-qm", "flat events with one sharded blob");
    const store = makeTaskEventStore({ repoId: "blob-dual-dedupe", rootDir });
    assert.equal(store.layout(), "flat/v1");
    const receipt = store.append(
      docBundle(store, body, 3, "op-doc-twin", "context/twin.md"),
    );
    assert.equal(
      receipt.metrics.changedPaths.includes(`harness/objects/sha256/${hash}`),
      false,
    );
    assert.equal(
      git(
        rootDir,
        "ls-tree",
        "--name-only",
        "HEAD:harness/objects/sha256",
      ).includes(hash),
      false,
    );
    assert.equal(
      Buffer.from(store.readContentBlob(hash)!).toString("utf8"),
      body,
    );
    assert.equal(store.read().revision, 3);
  });
});

test("mixed ledger migration normalizes shards and twins, then migrates, audits, and replays idempotently", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const fixture = mixedLedgerFixture(rootDir),
      store = makeTaskEventStore({ repoId: "mixed-migrate", rootDir });
    const beforeCommitCount = Number(
      git(rootDir, "rev-list", "--count", fixture.parent),
    );
    const beforeEventBytes = [...fixture.flatEvents, fixture.shardedEvent].map(
      (value) => serializeTaskEvent(value),
    );
    const beforeDistinctBlobs = new Set(
      fixture.blobBodies.map((body) => sha256Text(body)),
    );
    const receipt = store.migrateLayout({
      actor: event.actor,
      source: "local",
      occurredAt: "2026-08-18T00:00:00.000Z",
    });
    assert.equal(receipt.event.schema, "ledger-layout-event/v1");
    if (receipt.event.schema !== "ledger-layout-event/v1") return;
    assert.deepEqual(receipt.event.payload, {
      from: "flat/v1",
      to: "sharded-sha256-2/v1",
      eventCount: 3,
      blobCount: beforeDistinctBlobs.size,
      preEventsTreeSha: git(
        rootDir,
        "rev-parse",
        `${receipt.commitSha.sha}^:harness/events`,
      ),
    });
    assert.equal(receipt.revision, 4);
    assert.deepEqual(
      git(rootDir, "ls-tree", "--name-only", "HEAD:harness/events")
        .split("\n")
        .filter((name) => name.endsWith(".json")),
      ["head.json"],
    );
    assert.equal(
      git(rootDir, "ls-tree", "--name-only", "-d", "HEAD:harness/events")
        .split("\n")
        .filter(Boolean).length > 0,
      true,
    );
    assert.equal(
      git(rootDir, "ls-tree", "--name-only", "HEAD:harness/objects/sha256")
        .split("\n")
        .filter((name) => /^[0-9a-f]{64}$/u.test(name)).length,
      0,
    );
    for (const value of [...fixture.flatEvents, fixture.shardedEvent])
      assert.equal(
        git(
          rootDir,
          "show",
          `HEAD:harness/${eventObjectRelativePath(value.opId)}`,
        ),
        serializeTaskEvent(value).trimEnd(),
      );
    const reachableBlobs = git(
      rootDir,
      "ls-tree",
      "-r",
      "HEAD:harness/objects/sha256",
    )
      .split("\n")
      .map((row) => row.split(/\s/u).at(-1)!.replace("/", ""));
    assert.equal(reachableBlobs.includes(fixture.twinHash), true);
    assert.equal(new Set(reachableBlobs).size, beforeDistinctBlobs.size);
    assert.equal(
      Number(git(rootDir, "rev-list", "--count", "HEAD")),
      beforeCommitCount + 2,
    );
    assert.equal(store.read().revision, 4);
    assert.deepEqual(
      new Set(
        store
          .read()
          .events.filter((value) => value.schema === "task-event/v1")
          .map((value) => (value as TaskCreatedEvent).taskId),
      ),
      new Set(["task-00001", "task-00002", "task-00003"]),
    );
    const beforeBytes = new Set(
      beforeEventBytes.map((bytes) => sha256Text(bytes)),
    );
    assert.equal(
      store
        .read()
        .events.filter((value) => value.schema === "task-event/v1")
        .every((value) =>
          beforeBytes.has(
            sha256Text(serializeTaskEvent(value as TaskCreatedEvent)),
          ),
        ),
      true,
    );
    const repeated = store.migrateLayout({
      actor: event.actor,
      source: "local",
      occurredAt: "2026-08-18T00:00:00.000Z",
    });
    assert.equal(repeated.commitSha.sha, receipt.commitSha.sha);
    assert.equal(store.layout(), "sharded-sha256-2/v1");
  });
});
