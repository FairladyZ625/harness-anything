// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { decisionPointBindingDigest } from "@harness-anything/kernel";
import { readDefaultVerticalDefinition } from "../src/vertical-declaration-action.ts";
import { readDecisionPointSettings } from "../src/decision-point-settings-read.ts";

test("settings serves each declared point with the executor digest and redacted outgoing projection", () => {
  const vertical = readDefaultVerticalDefinition(),
    rows = readDecisionPointSettings(vertical);
  assert.equal(rows.length, Object.keys(vertical.decisions!.points).length);
  for (const row of rows) {
    const point = vertical.decisions!.points[row.pointId]!,
      question = vertical.decisions!.questions[point.question]!;
    assert.equal(row.bindingDigest, decisionPointBindingDigest(row.pointId, point, question));
    assert.equal(row.bindingKey, `${row.pointId}@${row.bindingDigest.slice(0, 12)}`);
    assert.equal(row.question, question);
    assert.match(row.projectionSample, /reason: .*\nclassification: worker_stop\nreport: .*\[LOCAL_PATH\]/u);
    assert.ok(!row.projectionSample.includes("/Users/example"));
    assert.deepEqual(
      row.input.map(({ field }) => field),
      point.input,
    );
    const changed = {
      ...vertical,
      decisions: {
        ...vertical.decisions!,
        points: { ...vertical.decisions!.points, [row.pointId]: { ...point, revision: `${point.revision}-changed` } },
      },
    };
    assert.notEqual(
      readDecisionPointSettings(changed).find((candidate) => candidate.pointId === row.pointId)!.bindingKey,
      row.bindingKey,
    );
  }
  assert.deepEqual(readDecisionPointSettings(null), []);
  assert.deepEqual(readDecisionPointSettings({ ...vertical, decisions: undefined }), []);
});
