// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { validateCommandOptions } from "../src/cli/option-claims.ts";

test("consent commands fail closed on an arbitrary session selector", () => {
  for (const argv of [
    ["task", "consent-record", "task_1", "--execution-id", "exe_1", "--utterance", "Approved", "--session", "unrelated-session"],
    ["task", "review-execution", "task_1", "--execution-id", "exe_1", "--verdict", "approved", "--findings", "ship it", "--rationale", "Evidence supports approval", "--consent-utterance", "Approved", "--session", "unrelated-session"]
  ]) {
    const validation = validateCommandOptions(argv);
    assert.equal(validation.ok, false, argv.join(" "));
    if (validation.ok) continue;
    assert.equal(validation.error.code, "unknown_option", argv.join(" "));
    assert.match(validation.error.hint, /Unknown option '--session'/u, argv.join(" "));
  }
});
