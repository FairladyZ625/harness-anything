// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";

import { toCliError } from "../src/cli/error-mapper.ts";

test("timeout errors preserve the deadline and teach a concrete diagnostic step", () => {
  assert.deepEqual(toCliError({ _tag: "Timeout", ms: 2_500 }), {
    code: "Timeout",
    hint: "Operation timed out after 2500ms. Retry the command; if it repeats, run 'ha doctor --json' and inspect engine or daemon connectivity."
  });
});

test("journal failures always retain their cause and teach a concrete diagnostic step", () => {
  assert.deepEqual(toCliError({
    _tag: "JournalUnavailable",
    cause: new Error("journal denied access.\ninternal detail")
  }), {
    code: "journal_unavailable",
    hint: "Journal is unavailable: journal denied access. Run 'ha doctor --json' to inspect journal and daemon health, then retry the command."
  });
  assert.deepEqual(toCliError({ _tag: "JournalUnavailable" }), {
    code: "journal_unavailable",
    hint: "Journal is unavailable. Run 'ha doctor --json' to inspect journal and daemon health, then retry the command."
  });
  assert.deepEqual(toCliError({
    _tag: "JournalUnavailable",
    cause: { name: "Error", message: "publisher observation mismatched", code: "EIO" }
  }), {
    code: "journal_unavailable",
    hint: "Journal is unavailable: publisher observation mismatched. Run 'ha doctor --json' to inspect journal and daemon health, then retry the command."
  });
});
