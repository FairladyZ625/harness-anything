// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { materializePromptFile } from "../src/cli-runtime-prompt-file.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("runtime steer accepts --prompt-file and materializes it into the steer prompt", () => {
  const root = mkdtempSync(path.join(tmpdir(), "steer-prompt-file-"));
  try {
    writeFileSync(path.join(root, "steer.md"), "continue the plan");
    const parsed = parseThinCommand(["runtime", "steer", "runtime_session1", "--prompt-file", "steer.md"], root);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) throw new Error(parsed.nextAction);
    assert.equal(parsed.command.method, "repo.agentRuntime.steer");
    assert.equal(parsed.command.action.runtimeSessionId, "runtime_session1");
    assert.equal(parsed.command.action.promptFile, "steer.md");
    const materialized = materializePromptFile(parsed.command);
    assert.equal(materialized.action.prompt, "continue the plan");
    assert.equal(materialized.action.promptFile, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime steer --prompt-file steers a dispatch target and stays inside the repository", () => {
  const root = mkdtempSync(path.join(tmpdir(), "steer-prompt-file-"));
  try {
    writeFileSync(path.join(root, "steer.md"), "change direction");
    const parsed = parseThinCommand(["runtime", "steer", "dispatch_123", "--prompt-file", "steer.md"], root);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) throw new Error(parsed.nextAction);
    assert.equal(parsed.command.action.dispatchId, "dispatch_123");
    assert.equal(materializePromptFile(parsed.command).action.prompt, "change direction");
    const outside = parseThinCommand(["runtime", "steer", "runtime_session1", "--prompt-file", "../outside.md"], root);
    assert.equal(outside.ok, true, JSON.stringify(outside));
    if (!outside.ok) throw new Error(outside.nextAction);
    assert.throws(
      () => materializePromptFile(outside.command),
      (error: unknown) =>
        (error as { readonly code?: unknown }).code === "invalid_field" &&
        /must stay within the selected repository/u.test(String((error as Error).message)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime steer still takes --prompt directly and rejects ambiguous prompt sources", () => {
  const parsed = parseThinCommand(["runtime", "steer", "runtime_session1", "--prompt", "inline steer"]);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) throw new Error(parsed.nextAction);
  assert.equal(materializePromptFile(parsed.command).action.prompt, "inline steer");
  const neither = parseThinCommand(["runtime", "steer", "runtime_session1"]);
  assert.equal(neither.ok, false);
  if (neither.ok) throw new Error("expected rejection");
  assert.equal(neither.code, "missing_field");
  assert.match(neither.nextAction, /--prompt or --prompt-file/u);
  const both = parseThinCommand([
    "runtime",
    "steer",
    "runtime_session1",
    "--prompt",
    "inline",
    "--prompt-file",
    "steer.md",
  ]);
  assert.equal(both.ok, false);
  if (both.ok) throw new Error("expected rejection");
  assert.equal(both.code, "invalid_field");
  assert.match(both.nextAction, /mutually exclusive/u);
});
