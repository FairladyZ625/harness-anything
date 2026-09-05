// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, openSqliteEventStore } from "../../kernel/src/index.ts";
import { bundle, eventAt, initRepo } from "../../kernel/test/store/task-event-store.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

test("first RepoCell write does not import an unseeded 1k-event history into the SQLite shadow", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-sqlite-shadow-repo-cell-")),
    rootDir = path.join(parent, "repo"),
    repoId = workspaceId("sqlite-shadow-repo-cell"),
    events = Array.from({ length: 1_000 }, (_, index) => eventAt(index + 1)),
    terminal = bundle(events.at(-1)!);
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined,
    seed: ReturnType<typeof makeTaskEventStore> | undefined;
  mkdirSync(rootDir);
  initRepo(rootDir);
  try {
    seed = makeTaskEventStore({ repoId, rootDir });
    seed.append({ ...terminal, preceding: events.slice(0, -1).map(bundle) });
    await seed.drain();
    const stateRoot = path.join(parent, "writer-epoch"),
      holderId = "sqlite-shadow-writer",
      authority = openPersistentWriterEpoch({ stateRoot, holderId }),
      lease = authority.acquire(repoId),
      binding = {
        actor: { principal: { personId: "sqlite-shadow-owner" }, executor: null },
        source: "local" as const,
        writerEpochFence: {
          schema: "harness-writer-epoch-fence/v1" as const,
          stateRoot,
          repoId,
          epoch: lease.epoch,
          holderId,
        },
      };
    authority.close();

    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: holderId });
    const shadow = openSqliteEventStore({ repoId, rootInput: rootDir });
    try {
      assert.equal(shadow.revision(), 0);
      const first = await cell.run(
        { kind: "task-create", taskId: "task-after-history", title: "After history" },
        binding,
      );
      assert.equal(first.outcome, "applied", JSON.stringify(first));
      assert.equal(first.revision, 1_003, JSON.stringify(first));
      assert.equal(first.cut?.revision, 1_003, JSON.stringify(first));
      assert.equal(shadow.revision(), 0, "the first write must not import pre-existing history");

      const second = await cell.run(
        { kind: "task-create", taskId: "task-after-skip", title: "After skipped shadow" },
        binding,
      );
      assert.equal(second.outcome, "applied", JSON.stringify(second));
      assert.equal(shadow.revision(), 0, "an unseeded shadow stays disabled for later writes in the cell");
    } finally {
      shadow.close();
    }
  } finally {
    await seed?.drain();
    await cell?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
