// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { findTestWeightDrift, parseJunitTestFileDurations } from "./test-weight-drift.mjs";

test("JUnit file timings are grouped under POSIX repository paths", () => {
  const measured = parseJunitTestFileDurations([
    "<testsuites>",
    '  <testcase name="one" time="4.5" file="/repo/packages/cli/test/heavy.test.ts"/>',
    '  <testcase name="two" time="2" file="/repo/packages/cli/test/heavy.test.ts"/>',
    "</testsuites>"
  ].join("\n"), "/repo");
  assert.deepEqual([...measured], [["packages/cli/test/heavy.test.ts", 6500]]);
});

test("weight drift warns for stale registered and default weights only after a material overage", () => {
  const warnings = findTestWeightDrift(new Map([
    ["packages/registered.test.ts", 21_000],
    ["packages/default.test.ts", 7_000],
    ["packages/noise.test.ts", 5_500]
  ]), {
    integrationWeights: { "packages/registered.test.ts": 10_000 },
    nightlyWeights: {},
    defaultWeightMs: 1000
  });
  assert.deepEqual(warnings, [{
    file: "packages/default.test.ts",
    measuredMs: 7000,
    weightMs: 1000,
    source: "default"
  }, {
    file: "packages/registered.test.ts",
    measuredMs: 21_000,
    weightMs: 10_000,
    source: "registered"
  }]);
});
