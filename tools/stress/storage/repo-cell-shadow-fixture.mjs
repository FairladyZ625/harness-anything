import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { serializePersistedCanonicalEvent } from "../../../packages/kernel/src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../../packages/kernel/src/integrity/stable-hash.ts";
import { openSqliteEventStore } from "../../../packages/kernel/src/store/sqlite-event-store.ts";
import { eventAt } from "../../../packages/kernel/test/store/task-event-store.fixtures.ts";

const [mode, rootDir, repoId, taskId] = process.argv.slice(2);
if (!mode || !rootDir) throw new Error("usage: repo-cell-shadow-fixture.mjs <mode> <root> [repo-id] [task-id]");

if (mode === "pwrite-probe") {
  mkdirSync(rootDir, { recursive: true });
  const descriptor = openSync(path.join(rootDir, "pwrite-probe.bin"), "w", 0o600);
  try {
    try {
      const written = writeSync(descriptor, Buffer.from("probe"), 0, 5, 0);
      process.stdout.write(`${JSON.stringify({ pid: process.pid, status: "ok", written })}\n`);
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          pid: process.pid,
          status: "error",
          code: typeof error === "object" && error !== null && "code" in error ? error.code : null,
          message: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
    }
  } finally {
    closeSync(descriptor);
  }
} else if (mode === "command") {
  if (!repoId || !taskId) throw new Error("command mode requires repo-id and task-id");
  const databasePath = path.join(rootDir, ".harness", "store", "generations", "1", "ledger.sqlite"),
    store = openSqliteEventStore({ repoId, databasePath }),
    event = { ...eventAt(1), opId: taskId, eventId: `event-${taskId}` },
    intentDigest = `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}`;
  try {
    const outcome = store.appendCommand({
      fence: { repoId, holder: "stress-s2-center", epoch: 1 },
      intent: { opId: taskId, intentDigest, summary: "stress accepting transaction" },
      events: [event],
    });
    process.stdout.write(`${JSON.stringify({ pid: process.pid, outcome })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        pid: process.pid,
        error: error instanceof Error ? error.message : String(error),
        code: typeof error === "object" && error !== null && "code" in error ? error.code : null,
      })}\n`,
    );
  } finally {
    store.close();
  }
} else {
  throw new Error(`unknown mode: ${mode}`);
}
