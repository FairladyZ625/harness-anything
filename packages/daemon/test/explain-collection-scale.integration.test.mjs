// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { measureReadScale } from "./fixtures/g38-read-cost.mjs";
import { sqliteWorkProbeUnavailableReason } from "./fixtures/g38-sqlite-work.mjs";

test(
  "explain point reads stay bounded as unrelated task history grows",
  {
    skip: sqliteWorkProbeUnavailableReason() || false,
  },
  async (t) => {
    const samples = [];
    for (const size of [10, 1000]) {
      const sample = (
        await measureReadScale("sqlite", "task-history", size, {
          probeIds: ["explain-actions"],
        })
      )["explain-actions"];
      samples.push(sample);
      t.diagnostic(JSON.stringify(sample));
      assert.equal(sample.resultSize, 1);
      assert.equal(sample.firstResultSize, 1);
    }
    for (const phase of ["firstCall", "counts"]) {
      assert.equal(samples[1][phase].sqlRowsRead, samples[0][phase].sqlRowsRead);
      assert.equal(samples[1][phase].directoryEntries, samples[0][phase].directoryEntries);
    }
  },
);
