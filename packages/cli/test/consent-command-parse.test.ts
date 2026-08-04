// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/cli/parse-args.ts";

test("consent commands never expose an arbitrary session selector", () => {
  for (const argv of [
    ["task", "consent-record", "task_1", "--execution-id", "exe_1", "--utterance", "Approved", "--session", "unrelated-session"],
    ["task", "review-execution", "task_1", "--execution-id", "exe_1", "--verdict", "approved", "--findings", "ship it", "--rationale", "Evidence supports approval", "--consent-utterance", "Approved", "--session", "unrelated-session"]
  ]) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.ok, true, argv.join(" "));
    if (!parsed.ok) continue;
    assert.equal("sessionId" in parsed.value.action, false, argv.join(" "));
  }
});
