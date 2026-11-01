import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { Pool } from "pg";
import { serializePersistedCanonicalEvent } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import type { PostgresAppendHooks, PostgresEventStoreScope } from "../../src/postgres/pg-event-store.ts";
import type { makePostgresTaskEventStore } from "../../src/postgres/pg-task-event-store.ts";
import type { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { bundle, docBundle, eventAt } from "../store/task-event-store.fixtures.ts";

type PgLedger = ReturnType<typeof makePostgresTaskEventStore>;

/** These assertions require one session; RLS, concurrent locks and transport failures stay in real-PG tests. */
export async function assertSingleSessionLedger(
  t: TestContext,
  input: {
    readonly make: (repoId: string, scope?: PostgresEventStoreScope, hooks?: PostgresAppendHooks) => PgLedger;
    readonly sqlite: ReturnType<typeof makeTaskEventStore>;
    readonly inspect: Pool;
  },
): Promise<void> {
  const { make, sqlite, inspect: admin } = input,
    pg = make("parity-repo"),
    fence = (repoId: string, epoch = 1, holderId = "center-writer") => ({ repoId, holderId, epoch });
  await t.test("sequential append preserves persisted bytes, digest and cut at each revision", async () => {
    const latency: number[] = [];
    for (let revision = 1; revision <= 12; revision++) {
      const input =
          revision === 2
            ? docBundle(sqlite!, "PG ledger content\n", revision, "op-doc-parity", "harness/ledger.md")
            : bundle(eventAt(revision)),
        sqliteReceipt = sqlite!.append(input),
        start = performance.now(),
        pgReceipt = await pg.append(input, revision - 1, fence("parity-repo"));
      latency.push(performance.now() - start);
      assert.deepEqual(pgReceipt.cut, sqliteReceipt.cut);
      assert.equal((await pg.currentCut()).headDigest, sqlite!.currentCut().headDigest);
      const row = (
        await admin!.query(
          "SELECT event_json,event_digest FROM ha_events WHERE repo_id='parity-repo' AND revision=$1",
          [revision],
        )
      ).rows[0];
      assert.equal(row.event_json, serializePersistedCanonicalEvent(input.event));
      assert.equal(row.event_digest, `sha256:${sha256Text(row.event_json)}`);
      if (revision === 2)
        assert.deepEqual(
          Buffer.from((await pg.execute({ operation: "content", sha256: input.blobs[0]!.sha256 })) as Uint8Array),
          Buffer.from("PG ledger content\n"),
        );
      process.stdout.write(`PG_EVENT_LEDGER_PARITY revision=${revision} headDigest=${pgReceipt.cut.headDigest}\n`);
    }
    const positions = (
      await admin!.query(
        "SELECT history,sequence,revision,head_digest FROM ha_replication_positions WHERE repo_id='parity-repo' ORDER BY sequence",
      )
    ).rows;
    assert.equal(positions.length, 12, "every commit has a durable position even if NOTIFY is lost");
    assert.equal(new Set(positions.map((position) => position.history)).size, 1);
    assert.match(positions[0]!.history, /^[0-9a-f-]{36}$/u);
    assert.deepEqual(
      positions.map((position) => Number(position.sequence)),
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    assert.equal(positions.at(-1)!.head_digest, (await pg.currentCut()).headDigest);
    assert.deepEqual(await pg.execute({ operation: "events" }), sqlite!.read().events);
    assert.deepEqual(
      await pg.execute({
        operation: "events",
        query: { limit: 2, type: "task_created", actor: "person-1", revisionBound: 8 },
      }),
      sqlite!.queryEvents!({ limit: 2, type: "task_created", actor: "person-1", revisionBound: 8 }),
    );
    assert.deepEqual(await pg.execute({ operation: "event", key: "event_id", value: eventAt(1).eventId }), eventAt(1));
    latency.sort((a, b) => a - b);
    process.stdout.write(
      `PG_EVENT_LEDGER_LATENCY events_per_bundle=1 samples=${latency.length} blob_bytes=18 p50_ms=${latency[Math.floor(latency.length / 2)]!.toFixed(2)} p95_ms=${latency.at(-1)!.toFixed(2)}\n`,
    );
  });

  await t.test("idempotency returns original cut and conflicts reject another intent", async () => {
    const first = bundle(eventAt(1));
    const replay = await pg.append(first, 0, fence("parity-repo"));
    assert.equal(replay.cut.revision, 1);
    assert.equal((await pg.readHead())!.revision, 12);
    const altered = { ...first.event, payload: { task: { ...eventAt(1).payload.task, title: "another intent" } } };
    await assert.rejects(pg.append(bundle(altered as ReturnType<typeof eventAt>), 12, fence("parity-repo")), {
      code: "op_conflict",
    });
    assert.equal(
      ((await pg.execute({ operation: "outcome", opId: first.event.opId })) as { lastRevision: number }).lastRevision,
      1,
    );
  });

  await t.test("one bundle commits preceding events, outcome and projection callback atomically", async () => {
    const repoId = "bundle-repo",
      store = make(repoId, undefined, {
        project: async (client, value) => {
          assert.equal(value.events.length, 2);
          assert.equal(value.revision, 2);
          assert.equal(
            (await client.query("SELECT count(*) AS n FROM ha_events WHERE repo_id=$1", [repoId])).rows[0]!.n,
            "2",
          );
        },
      });
    const input = { ...bundle(eventAt(2)), preceding: [bundle(eventAt(1))] };
    await store.append(input, 0, fence(repoId));
    const outcome = (await store.execute({ operation: "outcome", opId: eventAt(1).opId })) as {
      memberOpIds: string[];
    };
    assert.deepEqual(outcome.memberOpIds, [eventAt(1).opId, eventAt(2).opId]);
    const broken = make("rollback-repo", undefined, {
      project: async () => {
        throw new Error("projection failed");
      },
    });
    await assert.rejects(broken.append(input, 0, fence("rollback-repo")), /projection failed/u);
    assert.equal(await broken.readHead(), null);
    for (const table of ["ha_events", "ha_command_outcomes", "ha_replication_positions"])
      assert.equal(
        (await admin!.query(`SELECT count(*) AS n FROM ${table} WHERE repo_id='rollback-repo'`)).rows[0]!.n,
        "0",
      );
  });

  await t.test("blob mismatches, missing content and cancellation roll back the whole operation", async () => {
    const repoId = "blob-repo",
      store = make(repoId),
      input = docBundle(sqlite!, "unique blob content\n", 1, "op-blob", "harness/blob.md");
    for (const change of [{ body: "bad" }, { size: 1 }, { sha256: "0".repeat(64) }])
      await assert.rejects(store.append({ ...input, blobs: [{ ...input.blobs[0]!, ...change }] }, 0, fence(repoId)), {
        code: "invalid_write_plan",
      });
    await assert.rejects(store.append({ ...input, blobs: [] }, 0, fence(repoId)), { code: "invalid_write_plan" });
    assert.equal(await store.readHead(), null);
    await store.append(input, 0, fence(repoId));
    const second = docBundle(sqlite!, "unique blob content\n", 2, "op-blob-reuse", "harness/blob-again.md");
    await store.append({ ...second, blobs: [] }, 1, fence(repoId));
    assert.equal(
      (await admin!.query("SELECT count(*) AS n FROM ha_content_blobs WHERE sha256=$1", [input.blobs[0]!.sha256]))
        .rows[0]!.n,
      "1",
    );
    await admin!.query("UPDATE ha_content_blobs SET body=$2 WHERE sha256=$1", [
      input.blobs[0]!.sha256,
      Buffer.from("X".repeat(input.blobs[0]!.size)),
    ]);
    const third = docBundle(sqlite!, "unique blob content\n", 3, "op-blob-corrupt", "harness/blob-third.md");
    await assert.rejects(store.append({ ...third, blobs: [] }, 2, fence(repoId)), { code: "invalid_write_plan" });
    assert.equal((await store.readHead())!.revision, 2);
    const abort = new AbortController(),
      cancelled = make("cancel-repo", undefined, {
        project: async () => abort.abort(new Error("cancelled operation")),
      });
    await assert.rejects(
      cancelled.append(bundle(eventAt(1)), 0, fence("cancel-repo"), abort.signal),
      /cancelled operation/u,
    );
    assert.equal(await cancelled.readHead(), null);
    process.stdout.write(
      "PG_EVENT_LEDGER_CONTENT malformed/missing/corrupt blobs rejected; dedup and cancellation rollback verified\n",
    );
  });
}

/** Start at revision 1 and prove all stale writer identities are rejected without moving the head. */
export async function assertWriterFencing(store: PgLedger, repoId: string): Promise<void> {
  const fence = (targetRepoId: string, epoch = 1, holderId = "center-writer") => ({
    repoId: targetRepoId,
    epoch,
    holderId,
  });
  await store.append(bundle(eventAt(2)), 1, fence(repoId, 2, "new-owner"));
  await assert.rejects(store.append(bundle(eventAt(3)), 2, fence(repoId)), { code: "revision_conflict" });
  await assert.rejects(store.append(bundle(eventAt(3)), 2, fence(repoId, 2, "other-owner")), {
    code: "revision_conflict",
  });
  await assert.rejects(store.append(bundle(eventAt(3)), 1, fence(repoId, 2, "new-owner")), {
    code: "revision_conflict",
  });
  await assert.rejects(store.append(bundle(eventAt(3)), 2, fence("wrong-repo")), { code: "revision_conflict" });
  assert.equal((await store.readHead())!.revision, 2);
}
