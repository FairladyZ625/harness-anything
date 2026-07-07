import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveRuntimeConversation } from "../src/runtime-session-logs.ts";
import { runEffect } from "./effect-test-helpers.ts";

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
