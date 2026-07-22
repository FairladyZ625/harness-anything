// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverRuntimeSessions, displayRuntimePath, resolveRuntimeConversation, resolveRuntimeLogSearchDepth } from "../src/runtime-session-logs.ts";
import { runEffect } from "./effect-test-helpers.ts";

test("runtime log search depth resolves explicit option then environment and rejects unsafe values", () => {
  assert.equal(resolveRuntimeLogSearchDepth({ env: {} }), 8);
  assert.equal(resolveRuntimeLogSearchDepth({ env: { HARNESS_RUNTIME_LOG_SEARCH_DEPTH: "12" } }), 12);
  assert.equal(resolveRuntimeLogSearchDepth({ maxSearchDepth: 4, env: { HARNESS_RUNTIME_LOG_SEARCH_DEPTH: "12" } }), 4);
  assert.throws(() => resolveRuntimeLogSearchDepth({ env: { HARNESS_RUNTIME_LOG_SEARCH_DEPTH: "0" } }), /HARNESS_RUNTIME_LOG_SEARCH_DEPTH/u);
  assert.throws(() => resolveRuntimeLogSearchDepth({ env: { HARNESS_RUNTIME_LOG_SEARCH_DEPTH: "65" } }), /HARNESS_RUNTIME_LOG_SEARCH_DEPTH/u);
});

test("runtime session discovery uses the operating-system home when HOME is unset", async (context) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-session-home-"));
  const originalHome = process.env.HOME;
  try {
    const sessionRoot = path.join(rootDir, ".codex", "sessions");
    mkdirSync(sessionRoot, { recursive: true });
    writeFileSync(path.join(sessionRoot, "rollout-2026-07-04T00-00-00-windows-home.jsonl"), "\n");
    context.mock.method(os, "homedir", () => rootDir);
    delete process.env.HOME;

    const discovered = await runEffect(discoverRuntimeSessions(
      {},
      { runtime: "codex", limit: 1 },
      "2026-07-04T00:00:00.000Z"
    ));

    assert.deepEqual(discovered.sessions, [{
      runtime: "codex",
      sessionId: "windows-home",
      source: "runtime",
      detectedAt: "2026-07-04T00:00:00.000Z"
    }]);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime path display abbreviates the operating-system home when HOME is unset", (context) => {
  const originalHome = process.env.HOME;
  try {
    context.mock.method(os, "homedir", () => path.join(path.sep, "Users", "windows-user"));
    delete process.env.HOME;

    assert.equal(
      displayRuntimePath(path.join(path.sep, "Users", "windows-user", ".codex", "sessions", "rollout.jsonl")),
      "~/.codex/sessions/rollout.jsonl"
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("runtime session log lookup uses exact or dash-suffix session id matches", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-session-"));
  try {
    const logRoot = path.join(rootDir, "logs");
    mkdirSync(logRoot, { recursive: true });
    writeFileSync(path.join(logRoot, "rollout-2026-07-04T00-00-00-prefix-abc.jsonl"), `${JSON.stringify({
      timestamp: "2026-07-04T00:00:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "suffix match" }
    })}\n`);
    writeFileSync(path.join(logRoot, "rollout-2026-07-04T00-00-00-prefix-abc-extra.jsonl"), `${JSON.stringify({
      timestamp: "2026-07-04T00:00:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "substring false positive" }
    })}\n`);

    const conversation = await runEffect(resolveRuntimeConversation({
      schema: "provenance-session/v1",
      sessionId: "abc",
      runtime: "codex",
      source: "runtime",
      detectedAt: "2026-07-04T00:00:00.000Z",
      exportedAt: "2026-07-04T00:00:00.000Z"
    }, {
      runtimeLogRoots: { codex: [logRoot] }
    }));

    assert.equal(conversation.logPath?.endsWith("prefix-abc.jsonl"), true);
    assert.equal(conversation.messages.some((message) => message.text.includes("suffix match")), true);
    assert.equal(conversation.messages.some((message) => message.text.includes("substring false positive")), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
