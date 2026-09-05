// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { serializePersistedCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import {
  migrateEventsToSqlite,
  openSqliteEventStore,
  sqliteLedgerPath,
  type SqliteCommandIntent,
  type SqliteEventStore,
  type SqliteWriterFence,
} from "../../src/store/sqlite-event-store.ts";
import { eventAt } from "./task-event-store.fixtures.ts";

const repoId = "sqlite-generation-test";
const fence: SqliteWriterFence = { repoId, holder: "writer-a", epoch: 1 };

test("single writer serializes revision allocation and rejects a competing revision", () => {
  const databasePath = scratch("concurrent"),
    first = openSqliteEventStore({ repoId, databasePath }),
    second = openSqliteEventStore({ repoId, databasePath });
  try {
    first.claimWriter(fence);
    assert.equal(first.appendCommand(command(first, 1)).lastRevision, 1);
    assert.throws(() => second.appendCommand(command(second, 1, "second-op")), /allocated revision 2/u);
    assert.equal(second.appendCommand(command(second, 2, "second-op")).lastRevision, 2);
    assert.deepEqual(
      second.events().map((event) => event.workspaceRevision),
      [1, 2],
    );
  } finally {
    first.close();
    second.close();
  }
});

test("kill-reopen returns the durable command outcome for the same op_id", () => {
  const databasePath = scratch("reopen");
  let store = openSqliteEventStore({ repoId, databasePath });
  store.claimWriter(fence);
  const accepted = store.appendCommand(command(store, 1));
  store.close();
  store = openSqliteEventStore({ repoId, databasePath });
  try {
    assert.deepEqual(store.appendCommand(command(store, 1)), accepted);
    assert.throws(
      () =>
        store.appendCommand({
          ...command(store, 1),
          intent: { ...intent(1), intentDigest: `sha256:${"f".repeat(64)}` },
        }),
      /another command intent/u,
    );
  } finally {
    store.close();
  }
});

test("event, writer takeover, ledger head, and outcome roll back atomically", () => {
  const databasePath = scratch("rollback"),
    store = openSqliteEventStore({ repoId, databasePath });
  try {
    store.claimWriter(fence);
    assert.throws(
      () =>
        store.appendCommand({
          ...command(store, 1),
          fence: { repoId, holder: "writer-b", epoch: 2 },
          beforeOutcome: () => {
            throw new Error("transaction killpoint");
          },
        }),
      /transaction killpoint/u,
    );
    assert.equal(store.events().length, 0);
    assert.equal(store.outcome(eventAt(1).opId), null);
    assert.equal(store.appendCommand(command(store, 1)).lastRevision, 1);
  } finally {
    store.close();
  }
});

test("one shadow bundle appends preceding events and its terminal event in one command", () => {
  const store = openSqliteEventStore({ repoId, databasePath: scratch("bundle") }),
    events = [eventAt(1), eventAt(2), eventAt(3)],
    eventBytes = events.map(serializePersistedCanonicalEvent),
    outcome = store.appendCommand({
      fence,
      intent: {
        opId: events.at(-1)!.opId,
        intentDigest: `sha256:${sha256Text(JSON.stringify(eventBytes))}`,
        summary: events.at(-1)!.type,
      },
      events,
    });
  try {
    assert.deepEqual(
      { firstRevision: outcome.firstRevision, lastRevision: outcome.lastRevision },
      { firstRevision: 1, lastRevision: 3 },
    );
    assert.deepEqual(store.events(), events);
  } finally {
    store.close();
  }
});

test("SIGKILL recovery discards an uncommitted event and writer takeover", () => {
  const databasePath = scratch("sigkill"),
    store = openSqliteEventStore({ repoId, databasePath });
  store.claimWriter(fence);
  store.close();
  const fixture = fileURLToPath(new URL("./sqlite-event-store-kill.fixture.mjs", import.meta.url)),
    killed = spawnSync(process.execPath, [fixture, databasePath, repoId], { encoding: "utf8" });
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  const reopened = openSqliteEventStore({ repoId, databasePath });
  try {
    assert.equal(reopened.events().length, 0);
    assert.equal(reopened.appendCommand(command(reopened, 1)).lastRevision, 1);
  } finally {
    reopened.close();
  }
});

test("generation migration is byte-exact, idempotent, and reports a bounded throughput sample", (context) => {
  const databasePath = scratch("migration"),
    store = openSqliteEventStore({ repoId, databasePath }),
    events = Array.from({ length: 1_000 }, (_, index) => eventAt(index + 1)),
    started = performance.now();
  try {
    const first = migrateEventsToSqlite({ store, repoId, events, holder: fence.holder, epoch: fence.epoch }),
      elapsedMs = performance.now() - started,
      second = migrateEventsToSqlite({ store, repoId, events, holder: fence.holder, epoch: fence.epoch });
    assert.deepEqual(first, { migrated: 1_000, revision: 1_000 });
    assert.deepEqual(second, { migrated: 0, revision: 1_000 });
    context.diagnostic(
      JSON.stringify({
        events: events.length,
        elapsedMs,
        eventsPerSecond: Math.round(events.length / (elapsedMs / 1_000)),
      }),
    );
  } finally {
    store.close();
  }
});

test("generation paths coexist beneath the local store root", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-path-"));
  assert.equal(sqliteLedgerPath(rootDir, 1), path.join(rootDir, ".harness/store/generations/1/ledger.sqlite"));
  assert.equal(sqliteLedgerPath(rootDir, 2), path.join(rootDir, ".harness/store/generations/2/ledger.sqlite"));
});

test("50k bootstrap is incremental and subsequent shadow bundles stay millisecond-scale", (context) => {
  const store = openSqliteEventStore({ repoId, databasePath: scratch("shadow-cost") }),
    sourceEvents = Array.from({ length: 50_000 }, (_, index) => eventAt(index + 1)),
    bootstrapStarted = performance.now();
  try {
    const bootstrapped = migrateEventsToSqlite({
        store,
        repoId,
        events: sourceEvents,
        holder: fence.holder,
        epoch: fence.epoch,
        verifyExact: false,
      }),
      bootstrapMs = performance.now() - bootstrapStarted,
      incremental = migrateEventsToSqlite({
        store,
        repoId,
        events: sourceEvents,
        holder: fence.holder,
        epoch: fence.epoch,
        verifyExact: false,
      }),
      samplesMs: number[] = [];
    assert.deepEqual(bootstrapped, { migrated: 50_000, revision: 50_000 });
    assert.deepEqual(incremental, { migrated: 0, revision: 50_000 });
    for (let revision = 50_001; revision <= 50_100; revision += 1) {
      const event = eventAt(revision),
        eventBytes = [serializePersistedCanonicalEvent(event)],
        started = performance.now();
      store.appendCommand({
        fence,
        intent: {
          opId: event.opId,
          intentDigest: `sha256:${sha256Text(JSON.stringify(eventBytes))}`,
          summary: event.type,
        },
        events: [event],
      });
      samplesMs.push(performance.now() - started);
    }
    samplesMs.sort((left, right) => left - right);
    const p50Ms = percentile(samplesMs, 0.5),
      p99Ms = percentile(samplesMs, 0.99);
    assert.ok(p99Ms < 100, `expected p99 shadow append below 100ms, received ${p99Ms}ms`);
    context.diagnostic(JSON.stringify({ sourceEvents: sourceEvents.length, bootstrapMs, p50Ms, p99Ms }));
  } finally {
    store.close();
  }
});

function command(_store: SqliteEventStore, revision: number, opId = eventAt(revision).opId) {
  const event = { ...eventAt(revision), opId };
  return { fence, intent: intentFor(event), events: [event] } as const;
}

function intent(revision: number): SqliteCommandIntent {
  return intentFor(eventAt(revision));
}

function intentFor(event: ReturnType<typeof eventAt>): SqliteCommandIntent {
  return {
    opId: event.opId,
    intentDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}`,
    summary: event.type,
  };
}

function scratch(name: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), `ha-sqlite-${name}-`)), "ledger.sqlite");
}

function percentile(sorted: readonly number[], quantile: number): number {
  return sorted[Math.ceil(sorted.length * quantile) - 1]!;
}
