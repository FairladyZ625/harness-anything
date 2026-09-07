// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { projectedTaskIds } from "../src/repo-cell-receipts.ts";
import { cellCodedError } from "../src/repo-cell-errors.ts";

type StressCell = {
  knownTaskIds: Set<string> | null;
  projection: { list: () => { watermark: number; sourceRevision: number; rows: never[] } };
  store: { readBatch: () => { events: never[]; cursor: null; done: boolean } };
  cellCodedError: typeof cellCodedError;
};

function danglingCell(): StressCell & { scans: { count: number } } {
  const scans = { count: 0 };
  return {
    knownTaskIds: null,
    projection: { list: () => ({ watermark: 7, sourceRevision: 8, rows: [] }) },
    store: {
      readBatch: () => {
        scans.count += 1;
        throw Object.assign(new Error("active execution has no terminal receipt"), { code: "invalid_store" });
      },
    },
    cellCodedError,
    scans,
  };
}

async function commandSweep(cell: StressCell, rounds: number): Promise<void> {
  await Promise.all(
    Array.from({ length: rounds }, async () => {
      // These represent concurrent `task list`, `task show`, and `runtime run`
      // requests from multiple edges observing the same dangling execution.
      projectedTaskIds(cell);
      projectedTaskIds(cell);
      await Promise.resolve(projectedTaskIds(cell));
    }),
  );
}

test("green arm: dangling execution is fail-closed and command reads stay bounded", async () => {
  const cell = danglingCell();
  await commandSweep(cell, 64);
  assert.deepEqual([...projectedTaskIds(cell)], []);
  assert.equal(cell.scans.count, 1, "the latch must prevent a rescan storm");
  assert.ok(cell.knownTaskIds instanceof Set, "fail-closed result must be cached");
});

test("red arm: legacy uncached scan is rejected by the same command oracle", async () => {
  const cell = danglingCell();
  const legacyScan = () => {
    cell.knownTaskIds = null;
    try {
      return projectedTaskIds(cell);
    } finally {
      // Simulates the pre-fix behavior: an errored scan never settles its latch.
      cell.knownTaskIds = null;
    }
  };
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          legacyScan();
        } catch {
          // The command layer observes the settled empty result.
        }
        await Promise.resolve();
      }
    }),
  );
  assert.ok(cell.scans.count > 1, "negative control must demonstrate repeated canonical scans");
  assert.notEqual(cell.scans.count, 1, "uncached legacy behavior must fail the bounded-scan oracle");
});
