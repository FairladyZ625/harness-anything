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

test("daemon module lookup rejections use the public module-not-found contract", () => {
  assert.deepEqual(toCliError({
    _tag: "WriteRejected",
    code: "module_not_found",
    reason: "AUTHORITY_PRESET_TASK_CREATE_MODULE_NOT_FOUND:daemon-performance"
  }), {
    code: "module_not_found",
    hint: "Module daemon-performance was not found."
  });
  assert.deepEqual(toCliError({
    _tag: "WriteRejected",
    code: "module_not_found",
    reason: "MODULE_NOT_FOUND"
  }), {
    code: "module_not_found",
    hint: "The selected module was not found."
  });
});

test("daemon WIP-limit rejection preserves its actionable reason and stable code", () => {
  const reason = "TASK_WIP_LIMIT_REACHED: Execution worktable is full (30/30). Return task_OLD to planned, then retry.";
  assert.deepEqual(toCliError({
    _tag: "WriteRejected",
    code: "task_wip_limit_reached",
    reason
  }), {
    code: "task_wip_limit_reached",
    hint: reason
  });
});

test("daemon return-to-idea rejection preserves its actionable reason and stable code", () => {
  const reason = "TASK_RETURN_TO_IDEA_BLOCKED: run `ha task release task_OLD`, then retire Execution exe_OLD.";
  assert.deepEqual(toCliError({
    _tag: "WriteRejected",
    code: "task_return_to_idea_blocked",
    reason
  }), {
    code: "task_return_to_idea_blocked",
    hint: reason
  });
});
