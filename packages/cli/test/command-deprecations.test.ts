// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/cli/parse-args.ts";

test("cutover boundary enters sunset while conditional containment controls remain active", () => {
  const boundary = parseArgs([
    "authority", "cutover", "boundary",
    "--id", "sme-v2",
    "--equality", "equality_1",
    "--expected-v2-tuple-digest", "b".repeat(64)
  ]);
  assert.equal(boundary.ok, true);
  if (boundary.ok) {
    assert.equal(boundary.value.deprecatedInvocation?.kind, "cutover-command");
    assert.equal(boundary.value.deprecatedInvocation?.decisionId, "dec_01KXSN6AVD6PSEB4CFCW8P2RQP");
  }

  for (const argv of [
    ["authority", "cutover", "drain"],
    ["authority", "cutover", "scan"],
    ["authority", "cutover", "confirm", "--first-scan", "scan_1", "--second-scan", "scan_2"]
  ]) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.ok, true, argv.join(" "));
    if (parsed.ok) assert.equal(parsed.value.deprecatedInvocation, undefined, argv.join(" "));
  }
});
