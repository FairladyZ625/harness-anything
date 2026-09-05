import { renameSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { serializeCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { makeTaskProjection, makeTaskProjectionReader } from "../../src/projection/rebuildable-task-projection.ts";
import { closeDatabase, withDatabase } from "../../src/projection/rebuildable-task-projection-database.ts";
import type { EventStreamPort } from "../../src/projection/rebuildable-task-projection-types.ts";
import { lifecycleFixture } from "./task-lifecycle-fixture.ts";

interface WorkerInput {
  readonly role: "reader" | "rebuilder" | "writer";
  readonly rootDir: string;
  readonly projectionPath: string;
  readonly start: SharedArrayBuffer;
  readonly stop: SharedArrayBuffer;
  readonly rows: number;
  readonly payloadBytes: number;
}

interface SQLiteFailure {
  readonly code: string | null;
  readonly errcode: number | null;
  readonly errstr: string | null;
  readonly message: string;
}

const input = workerData as WorkerInput,
  start = new Int32Array(input.start),
  stop = new Int32Array(input.stop);

try {
  if (input.role === "writer") runWriter();
  else if (input.role === "reader") runReader();
  else runRebuilder();
} catch (error) {
  parentPort!.postMessage({ ok: false, role: input.role, error: sqliteFailure(error) });
}

function runWriter(): void {
  const readHead = () => null;
  parentPort!.postMessage({ ready: true, role: "writer" });
  withDatabase(input.projectionPath, readHead, (db) => {
    db.exec(
      "PRAGMA wal_autocheckpoint = 0; BEGIN; " +
        "CREATE TABLE IF NOT EXISTS close_contention_payload(id INTEGER PRIMARY KEY, body BLOB NOT NULL); " +
        "DELETE FROM close_contention_payload",
    );
    const insert = db.prepare("INSERT INTO close_contention_payload(id, body) VALUES (?, ?)");
    const payload = Buffer.alloc(input.payloadBytes, 1);
    for (let row = 0; row < input.rows; row += 1) insert.run(row, payload);
    db.exec("COMMIT");
    // The controller starts readers from this observed commit boundary. Returning now exercises
    // the production owner's success lifetime, which used to close and clean up the WAL here.
    parentPort!.postMessage({ closing: true, role: "writer" });
  });
  parentPort!.postMessage({ written: true, role: "writer" });
  Atomics.wait(stop, 0, 0);
  closeDatabase(input.projectionPath, readHead);
  parentPort!.postMessage({ ok: true, role: "writer" });
}

function runReader(): void {
  const reader = makeTaskProjectionReader({ rootDir: input.rootDir, projectionPath: input.projectionPath });
  let samples = 0;
  parentPort!.postMessage({ ready: true, role: "reader" });
  try {
    Atomics.wait(start, 0, 0);
    while (Atomics.load(stop, 0) === 0) {
      const cut = reader.withSession((queries) => queries.list({ limit: 1 }));
      if (cut.watermark !== 0 || cut.sourceRevision !== 0)
        throw new Error(`reader left the completed projection cut: ${JSON.stringify(cut)}`);
      samples += 1;
      if (samples === 1) parentPort!.postMessage({ sampled: true, role: "reader" });
      Atomics.wait(stop, 0, 0, 1);
    }
    parentPort!.postMessage({ ok: true, role: "reader", samples });
  } catch (error) {
    parentPort!.postMessage({ ok: false, role: "reader", samples, error: sqliteFailure(error) });
  } finally {
    reader.close();
  }
}

function runRebuilder(): void {
  const ownerAStore = fixtureEventStore(),
    ownerA = makeTaskProjection({
      rootDir: input.rootDir,
      projectionPath: input.projectionPath,
      eventStore: ownerAStore,
    });
  ownerA.catchUp();
  let warmHandle: DatabaseSync | null = null;
  withDatabase(input.projectionPath, ownerAStore.readHead, (db) => {
    warmHandle = db;
    db.exec("CREATE TABLE warm_owner_marker(value TEXT NOT NULL)");
  });

  const ownerB = makeTaskProjection({
      rootDir: input.rootDir,
      projectionPath: input.projectionPath,
      eventStore: fixtureEventStore(),
    }),
    rebuilt = ownerB.rebuild(),
    staleHandleClosed = databaseIsClosed(warmHandle!),
    cold = makeTaskProjection({
      rootDir: input.rootDir,
      projectionPath: path.join(input.rootDir, ".harness/cache/cold-task.sqlite"),
      eventStore: fixtureEventStore(),
    }),
    coldRebuilt = cold.rebuild();
  cold.close();
  ownerB.close();

  let replacedHandle: typeof warmHandle = null;
  withDatabase(input.projectionPath, ownerAStore.readHead, (db) => {
    replacedHandle = db;
    db.exec("CREATE TABLE warm_owner_marker(value TEXT NOT NULL); PRAGMA wal_checkpoint(TRUNCATE)");
  });
  renameSync(cold.path, input.projectionPath);
  const reopened = withDatabase(input.projectionPath, ownerAStore.readHead, (db) => {
    const marker = db
        .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'warm_owner_marker'")
        .get() as { readonly count: number },
      digest = db.prepare("SELECT state_digest FROM projection_meta WHERE singleton = 1").get() as {
        readonly state_digest: string | null;
      };
    return { sameHandle: db === replacedHandle, markerPresent: marker.count > 0, stateDigest: digest.state_digest };
  });
  ownerA.close();
  parentPort!.postMessage({
    ok: true,
    role: "rebuilder",
    staleHandleClosed,
    rebuiltDigest: rebuilt.stateDigest,
    coldDigest: coldRebuilt.stateDigest,
    reopenedSameHandle: reopened.sameHandle,
    markerPresent: reopened.markerPresent,
    reopenedDigest: reopened.stateDigest,
  });
}

function fixtureEventStore(): EventStreamPort {
  const event = lifecycleFixture().events[0]!,
    eventDigest = `sha256:${sha256Text(serializeCanonicalEvent(event))}` as const;
  return {
    readHead: () => ({ revision: event.workspaceRevision, eventDigest }),
    readBatch: () => ({
      sourceRevision: event.workspaceRevision,
      events: [event],
      cursor: null,
      done: true,
      accessedItems: 1,
      prefetchContent: () => new Map(),
    }),
    readContentBlob: () => null,
  };
}

function databaseIsClosed(db: DatabaseSync): boolean {
  try {
    db.exec("SELECT 1");
    return false;
  } catch {
    return true;
  }
}

function sqliteFailure(error: unknown): SQLiteFailure {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  return {
    code: typeof record.code === "string" ? record.code : null,
    errcode: typeof record.errcode === "number" ? record.errcode : null,
    errstr: typeof record.errstr === "string" ? record.errstr : null,
    message: error instanceof Error ? error.message : String(error),
  };
}
