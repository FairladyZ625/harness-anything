import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { sha256Text } from "@harness-anything/kernel";
import { readEffectiveDispatchArchiveRetention } from "../../src/repo-cell-settings-state.ts";
import {
  readFactEvidenceSources,
  pruneDispatchStreamArchive,
  scheduleArchivedDispatchStreamCompaction,
} from "../../src/dispatch-stream-archive.ts";

const now = "2026-11-05T00:00:00.000Z";
const archiveRoot = (rootDir) => path.join(rootDir, ".harness/runtime/dispatches/archive");
function resetArchive(rootDir) {
  const archive = archiveRoot(rootDir);
  mkdirSync(archive, { recursive: true });
  for (const file of readdirSync(archive)) unlinkSync(path.join(archive, file));
}
function seedArchive(rootDir, index, records) {
  const dispatchId = `dispatch_${sha256Text(`dispatch-history-${String(index).padStart(8, "0")}`).slice(0, 24)}`,
    delta = "x".repeat(32),
    rows = [{ schema: "runtime-dispatch-stream/v1", kind: "dispatch", dispatchId, startedAt: now }];
  for (let line = 1; line < records; line++)
    rows.push({
      kind: "provider_event",
      event: { type: "model.streaming", turnId: "fixed", payload: { kind: "text_delta", delta } },
    });
  rows.push({
    kind: "provider_event",
    event: { type: "result", turnId: "fixed", response: delta.repeat(records - 1) },
  });
  writeFileSync(
    path.join(archiveRoot(rootDir), `${dispatchId}.jsonl`),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
}

async function runArchiveMaintenance({ rootDir, projection, archiveReadRepeats = 0 }) {
  // Same ordering as repo-cell-open: retention first, then a dynamically enqueued
  // compaction per file. The cursor advances once per job; exhaustion is queue.length.
  const queue = [
    () =>
      pruneDispatchStreamArchive(
        rootDir,
        readEffectiveDispatchArchiveRetention(projection),
        readFactEvidenceSources(projection),
        Date.parse(now),
      ),
  ];
  scheduleArchivedDispatchStreamCompaction(rootDir, (work) =>
    queue.push(async () => {
      await work();
      // Test-only positive control: revisit the complete stream once per 100 input
      // records in the real deferred callback. A 10x input makes these reads quadratic.
      if (archiveReadRepeats) {
        const file = path.join(archiveRoot(rootDir), readdirSync(archiveRoot(rootDir))[0]);
        for (let repeat = 0; repeat < archiveReadRepeats; repeat++) readFileSync(file);
      }
    }),
  );
  for (let next = 0; next < queue.length; next++) await queue[next]();
}

const sourceAudit = (inputCollection) => ({
  inputCollection,
  maxPerInput: {
    sqliteVmSteps: 64,
    sqliteScanPages: 16,
    sqlRowsRead: 16,
    sqlResultBytes: 16384,
    sha256Calls: 2,
    sha256Bytes: 512,
    gitProcesses: 1,
    // Three compaction passes plus retention, each stream <1KiB on the count
    // axis; the volume axis uses fixed 32-byte deltas and charges every record.
    fileReadBytes: 4096,
    directoryEntries: 4,
  },
});

export const ARCHIVE_READ_PROBES = {
  "archive-maintenance": {
    reads: ["background:archive-maintenance"],
    sourceAudit: sourceAudit("archived streams, three provider records per stream"),
    prepare: ({ rootDir }, dimension, size) => {
      resetArchive(rootDir);
      for (let index = 0; index < size; index++) seedArchive(rootDir, index, 3);
    },
    run: runArchiveMaintenance,
    size: () => 0,
  },
  "archive-compaction-volume": {
    reads: ["background:archive-maintenance"],
    sourceAudit: sourceAudit("provider records in one uncompacted archived stream (32-byte deltas)"),
    prepare: ({ rootDir }, dimension, size) => {
      resetArchive(rootDir);
      seedArchive(rootDir, 0, size);
    },
    run: runArchiveMaintenance,
    size: () => 0,
  },
};
