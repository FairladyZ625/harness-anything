import { serializePersistedCanonicalEvent } from "../../../packages/kernel/src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../../packages/kernel/src/integrity/stable-hash.ts";
import { openSqliteEventStore } from "../../../packages/kernel/src/store/sqlite-event-store.ts";
import { makeTaskEventStore } from "../../../packages/kernel/src/store/task-event-store.ts";
import { openWalEventLog } from "../../../packages/kernel/src/store/wal-event-log.ts";
import { docBundle, eventAt } from "../../../packages/kernel/test/store/task-event-store.fixtures.ts";

const [mode, target, repoId = "stress-s2-boundary", option = "same"] = process.argv.slice(2);
if (!mode || !target) throw new Error("usage: storage-boundary-fixture.mjs <mode> <target> [repo-id] [option]");

if (mode === "sqlite-command") {
  const event = {
    ...eventAt(1),
    eventId: "event-stress-s2-concurrent",
    opId: "op-stress-s2-concurrent",
  };
  const store = openSqliteEventStore({ repoId, databasePath: target });
  let frame;
  try {
    const intentDigest =
      option === "conflict"
        ? `sha256:${"f".repeat(64)}`
        : `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}`;
    const outcome = store.appendCommand({
      fence: { repoId, holder: "stress-s2-writer", epoch: 1 },
      intent: { opId: event.opId, intentDigest, summary: event.type },
      events: [event],
    });
    frame = { pid: process.pid, status: "ok", outcome };
  } catch (error) {
    frame = {
      pid: process.pid,
      status: "error",
      code: errorProperty(error, "code"),
      errcode: errorProperty(error, "errcode"),
      errstr: errorProperty(error, "errstr"),
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    store.close();
  }
  process.stdout.write(`${JSON.stringify(frame)}\n`);
} else if (mode === "git-kill") {
  const store = makeTaskEventStore({
    repoId,
    rootDir: target,
    killpoint: (point) => {
      if (point === option) process.kill(process.pid, "SIGKILL");
    },
  });
  store.append(docBundle(store, "# Stress S2 content\n", 1, "op-stress-s2-git", "context/stress-s2.md"));
  throw new Error(`Git publication did not reach killpoint ${option}`);
} else if (mode === "wal-append") {
  const body = "stress-s2-wal-blob\n";
  const wal = openWalEventLog(target);
  let frame;
  try {
    const record = wal.append({
      event: eventAt(1),
      blobs: [{ sha256: sha256Text(body), size: Buffer.byteLength(body), mediaType: "text/plain", body }],
    });
    frame = { pid: process.pid, status: "ok", revision: record.revision };
  } catch (error) {
    frame = {
      pid: process.pid,
      status: "error",
      code: errorProperty(error, "code"),
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    wal.close();
  }
  process.stdout.write(`${JSON.stringify(frame)}\n`);
} else {
  throw new Error(`unknown mode: ${mode}`);
}

function errorProperty(error, key) {
  return typeof error === "object" && error !== null && key in error ? String(error[key]) : null;
}
