import { parentPort, workerData } from "node:worker_threads";
import { makeTaskProjectionReader } from "../../src/projection/rebuildable-task-projection.ts";
import { closeDatabase, withDatabase } from "../../src/projection/rebuildable-task-projection-database.ts";

interface WorkerInput {
  readonly role: "reader" | "writer";
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
  else runReader();
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

function sqliteFailure(error: unknown): SQLiteFailure {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  return {
    code: typeof record.code === "string" ? record.code : null,
    errcode: typeof record.errcode === "number" ? record.errcode : null,
    errstr: typeof record.errstr === "string" ? record.errstr : null,
    message: error instanceof Error ? error.message : String(error),
  };
}
