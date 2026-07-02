import assert from "node:assert/strict";
import test from "node:test";
import { formatFactFlowRecord, isFactId, parseFactFlowRecords, type FactRecord } from "../../src/index.ts";

test("fact records use stable F-id anchors and single-line flow records", () => {
  const record: FactRecord = {
    fact_id: "F-DEADBEEF",
    statement: "Stable fact anchors do not use line numbers.",
    source: "design",
    observedAt: "2026-07-03T00:00:00.000Z",
    confidence: "high"
  };

  assert.equal(isFactId(record.fact_id), true);
  assert.equal(isFactId("F-12"), false);
  assert.equal(formatFactFlowRecord(record), "- {fact_id: F-DEADBEEF, statement: \"Stable fact anchors do not use line numbers.\", source: \"design\", observedAt: \"2026-07-03T00:00:00.000Z\", confidence: high}");
  assert.deepEqual(parseFactFlowRecords(`# Facts\n\n${formatFactFlowRecord(record)}\n`), [record]);
});
