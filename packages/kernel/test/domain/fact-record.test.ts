import assert from "node:assert/strict";
import test from "node:test";
import { formatFactFlowRecord, isFactId, parseFactFlowRecords, type FactRecord } from "../../src/index.ts";

test("fact records use stable F-id anchors and single-line flow records", () => {
  const record: FactRecord = {
    fact_id: "F-DEADBEEF",
    statement: "Stable fact anchors do not use line numbers.",
    source: "design",
    observedAt: "2026-07-03T00:00:00.000Z",
    confidence: "high",
    memoryClass: "semantic",
    memoryTags: ["pattern", "abstract_rule"],
    provenance: [{
      runtime: "human",
      sessionId: "human-cli-1783036800000",
      boundAt: "2026-07-03T00:00:00.000Z"
    }]
  };

  assert.equal(isFactId(record.fact_id), true);
  assert.equal(isFactId("F-12"), false);
  assert.equal(formatFactFlowRecord(record), "- {fact_id: F-DEADBEEF, statement: \"Stable fact anchors do not use line numbers.\", source: \"design\", observedAt: \"2026-07-03T00:00:00.000Z\", confidence: high, memoryClass: semantic, memoryTags: [pattern, abstract_rule], provenance: [{runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-07-03T00:00:00.000Z\"}]}");
  assert.deepEqual(parseFactFlowRecords(`# Facts\n\n${formatFactFlowRecord(record)}\n`), [record]);
});

test("fact parser defaults legacy records without memory fields on read", () => {
  const legacyBody = [
    "# Facts",
    "",
    "- {fact_id: F-DEADBEEF, statement: \"Old facts remain visible.\", source: \"historical facts.md\", observedAt: \"2026-06-30T00:00:00.000Z\", confidence: high, provenance: [{runtime: \"human\", sessionId: \"legacy-session-1\", boundAt: \"2026-06-30T00:00:00.000Z\"}]}",
    "- {fact_id: F-FEEDFACE, statement: \"Second old fact also remains visible.\", source: \"historical facts.md\", observedAt: \"2026-06-30T00:01:00.000Z\", confidence: medium, provenance: [{runtime: \"codex\", sessionId: \"legacy-session-2\", boundAt: \"2026-06-30T00:01:00.000Z\"}]}",
    ""
  ].join("\n");

  const records = parseFactFlowRecords(legacyBody);

  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.fact_id), ["F-DEADBEEF", "F-FEEDFACE"]);
  assert.deepEqual(records.map((record) => record.memoryClass), ["episodic", "episodic"]);
  assert.deepEqual(records.map((record) => record.memoryTags), [[], []]);
});

test("fact parser still rejects present but invalid memory fields", () => {
  const invalidMemoryClass = "- {fact_id: F-DEADBEEF, statement: \"Invalid class is not defaulted.\", source: \"test\", observedAt: \"2026-07-03T00:00:00.000Z\", confidence: high, memoryClass: unknown, memoryTags: [], provenance: [{runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-07-03T00:00:00.000Z\"}]}";
  const invalidMemoryTag = "- {fact_id: F-FEEDFACE, statement: \"Invalid tag is not defaulted.\", source: \"test\", observedAt: \"2026-07-03T00:00:00.000Z\", confidence: high, memoryClass: episodic, memoryTags: [unknown], provenance: [{runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-07-03T00:00:00.000Z\"}]}";

  assert.deepEqual(parseFactFlowRecords(`# Facts\n\n${invalidMemoryClass}\n${invalidMemoryTag}\n`), []);
});
