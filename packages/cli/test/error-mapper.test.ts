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

test("global write conflicts explain that direct recovery cannot race a live daemon", () => {
  assert.deepEqual(toCliError({ _tag: "GlobalWriteConflict", owner: ".harness/locks/global.lock" }), {
    code: "write_conflict",
    hint: "Global write lock is held: .harness/locks/global.lock Direct recovery remains mutually exclusive with a live daemon; stop or drain the current writer and verify with 'ha daemon status' before retrying."
  });
});

test("daemon generation rejection preserves its stable code and structured context", () => {
  const context = {
    schema: "daemon-generation-write-rejection/v1",
    machineId: "machine-a",
    attemptedDaemonGeneration: 7,
    currentDaemonGeneration: 8,
    workspaceId: "workspace-a",
    opId: "op-a",
    stage: "before-terminal-journal"
  };
  assert.deepEqual(toCliError({
    _tag: "WriteRejected",
    code: "DAEMON_GENERATION_FENCED",
    reason: "The daemon generation is stale.",
    retryable: true,
    context
  }), {
    code: "DAEMON_GENERATION_FENCED",
    hint: "The daemon generation is stale.",
    context
  });
});
