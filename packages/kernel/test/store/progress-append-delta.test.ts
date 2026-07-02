import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { makeJournaledWriteCoordinator } from "../../src/store/index.ts";
import { progressAppendDelta, progressAppendSnapshot, withTempStore } from "./helpers.ts";

// ADR-0016 D2 / 37-write-coordination-contract §10.2 focused tests.

function progressPath(rootDir: string, taskId: string): string {
  return path.join(rootDir, `harness/planning/tasks/${taskId}/progress.md`);
}

test("progress_append delta accumulates appends with correct separators", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });

    Effect.runSync(coordinator.enqueue(progressAppendDelta("op-1", "task-1", "line one")));
    Effect.runSync(coordinator.flush("explicit"));
    Effect.runSync(coordinator.enqueue(progressAppendDelta("op-2", "task-1", "line two")));
    Effect.runSync(coordinator.flush("explicit"));
    Effect.runSync(coordinator.enqueue(progressAppendDelta("op-3", "task-1", "line three")));
    Effect.runSync(coordinator.flush("explicit"));

    assert.equal(
      readFileSync(progressPath(rootDir, "task-1"), "utf8"),
      "line one\nline two\nline three\n"
    );
  });
});

test("progress_append delta replay preserves hand edits made after enqueue", () => {
  withTempStore((rootDir) => {
    // Seed the file through the coordinator so it exists on disk.
    const seeder = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(seeder.enqueue(progressAppendDelta("op-seed", "task-1", "seed")));
    Effect.runSync(seeder.flush("explicit"));

    // Enqueue a delta op but crash before flushing it (journal has the pending record).
    const crashed = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(crashed.enqueue(progressAppendDelta("op-pending", "task-1", "from journal")));

    // Simulate a direct hand edit of progress.md while the op is unflushed.
    const filePath = progressPath(rootDir, "task-1");
    writeFileSync(filePath, "seed\nMANUAL EDIT", "utf8");

    // Recovery replays the pending delta against the CURRENT on-disk contents.
    const recovered = makeJournaledWriteCoordinator({ rootDir });
    const report = Effect.runSync(recovered.recover);
    assert.equal(report.replayedOps, 1);

    const body = readFileSync(filePath, "utf8");
    assert.equal(body, "seed\nMANUAL EDIT\nfrom journal\n");
    assert.match(body, /MANUAL EDIT/); // hand edit survived; no stale snapshot rollback
  });
});

test("legacy full-snapshot progress_append op still overwrites on replay", () => {
  withTempStore((rootDir) => {
    const seeder = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(seeder.enqueue(progressAppendDelta("op-seed", "task-1", "old seed")));
    Effect.runSync(seeder.flush("explicit"));

    // Enqueue a pre-ADR-0016 snapshot-shaped op (payload carries the full new file body).
    const crashed = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(crashed.enqueue(progressAppendSnapshot("op-legacy", "task-1", "FULL SNAPSHOT REPLACEMENT\n")));

    // A hand edit before replay is intentionally overwritten by the legacy op (old semantics).
    const filePath = progressPath(rootDir, "task-1");
    writeFileSync(filePath, "tampered", "utf8");

    const recovered = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(recovered.recover);

    assert.equal(readFileSync(filePath, "utf8"), "FULL SNAPSHOT REPLACEMENT\n");
  });
});

test("progress_append delta appends text verbatim without formatting or normalization", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    // Markdown-ish content with leading/trailing spaces and blank lines must pass through unchanged.
    const raw = "  * not-a-bullet\n\n#tag   with trailing spaces   ";

    assert.equal(existsSync(progressPath(rootDir, "task-1")), false);
    Effect.runSync(coordinator.enqueue(progressAppendDelta("op-1", "task-1", raw)));
    Effect.runSync(coordinator.flush("explicit"));

    // Only a single trailing newline is added; every other byte is preserved as-is.
    assert.equal(readFileSync(progressPath(rootDir, "task-1"), "utf8"), `${raw}\n`);
  });
});

test("recovery applies multiple pending deltas from separate writers in journal order", () => {
  withTempStore((rootDir) => {
    // Two writers enqueue deltas and both crash before flushing.
    const writerA = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(writerA.enqueue(progressAppendDelta("op-1", "task-1", "first")));
    const writerB = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(writerB.enqueue(progressAppendDelta("op-2", "task-1", "second")));

    // A single recovery batch replays both deltas, accumulating in journal order.
    const recovered = makeJournaledWriteCoordinator({ rootDir });
    const report = Effect.runSync(recovered.recover);

    assert.equal(report.replayedOps, 2);
    assert.equal(readFileSync(progressPath(rootDir, "task-1"), "utf8"), "first\nsecond\n");
  });
});

test("recover after successful flush does not re-append a committed delta", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(coordinator.enqueue(progressAppendDelta("op-1", "task-1", "once only")));
    Effect.runSync(coordinator.flush("explicit"));

    // Watermark covers op-1: recovery must be a no-op for the file.
    const recovered = makeJournaledWriteCoordinator({ rootDir });
    const report = Effect.runSync(recovered.recover);

    assert.equal(report.replayedOps, 0);
    assert.equal(readFileSync(progressPath(rootDir, "task-1"), "utf8"), "once only\n");
  });
});

test("crash between delta apply and watermark does not duplicate the append", () => {
  withTempStore((rootDir) => {
    // Enqueue a delta, then simulate a crash mid-flush: the file write and the
    // durable apply marker landed, but the watermark was never written.
    const crashed = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(crashed.enqueue(progressAppendDelta("op-1", "task-1", "applied once")));

    const filePath = progressPath(rootDir, "task-1");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "applied once\n", "utf8");
    appendFileSync(
      path.join(rootDir, ".harness/write-journal/writes.jsonl"),
      `${JSON.stringify({ schema: "apply-marker/v1", opId: "op-1", entityId: "task/task-1", at: "2026-07-02T00:00:00.000Z" })}\n`,
      "utf8"
    );

    // Replay must skip the file write (marker) yet still watermark the op.
    const recovered = makeJournaledWriteCoordinator({ rootDir });
    const report = Effect.runSync(recovered.recover);

    assert.equal(report.recoveredWatermark, "op-1");
    assert.equal(readFileSync(filePath, "utf8"), "applied once\n");

    // A second recovery is a full no-op.
    Effect.runSync(makeJournaledWriteCoordinator({ rootDir }).recover);
    assert.equal(readFileSync(filePath, "utf8"), "applied once\n");
  });
});
