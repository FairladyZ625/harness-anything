// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { installHandoffRollout, validateHandoffRollout } from "../src/runtime-handoff-native.ts";
const sessionId = "019abcdef-1234-5678-9999-abcdef123456";
function rollout(extra: object[] = [], version = "0.159.1") {
  return Buffer.from(
    [
      { type: "session_meta", payload: { id: sessionId, cli_version: version, timestamp: "2026-10-04T00:00:00.000Z" } },
      ...extra,
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
}
test("accepts inline image, shell result and compaction records in the verified native format", () => {
  assert.equal(
    validateHandoffRollout(
      rollout([
        {
          type: "response_item",
          payload: { type: "message", content: [{ type: "input_image", image_url: "data:image/png;base64,eA==" }] },
        },
        {
          type: "response_item",
          payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"cat token.txt"}' },
        },
        { type: "response_item", payload: { type: "function_call_output", output: "known-token" } },
        { type: "compacted", payload: { message: "known-token" } },
        { type: "world_state", payload: { full: true, state: {} } },
        { type: "token_usage_record", payload: { thread_id: sessionId, usage: { input_tokens: 5 } } },
      ]),
      sessionId,
    ),
    "0.159.1",
  );
});
test("refuses unknown version, other session, external image/file and child conversation closure", () => {
  assert.throws(() => validateHandoffRollout(rollout([], "0.160.0"), sessionId), {
    code: "runtime_handoff_version_unsupported",
  });
  assert.throws(() => validateHandoffRollout(rollout(), "other"), { code: "runtime_handoff_version_unsupported" });
  for (const payload of [
    { image_url: "file:///tmp/a.png" },
    { image_url: "https://example.test/a.png" },
    { file_id: "file-1" },
    { type: "function_call", name: "spawn_agent" },
    { type: "function_call", name: "mcp__tool" },
    { type: "custom_tool_call", name: "unknown_tool" },
  ])
    assert.throws(() => validateHandoffRollout(rollout([{ type: "response_item", payload }]), sessionId), {
      code: "runtime_handoff_closure_unsupported",
    });
  assert.throws(() => validateHandoffRollout(rollout([{ type: "future_record", payload: {} }]), sessionId), {
    code: "runtime_handoff_closure_unsupported",
  });
});

// The target install writes only into the provider home the prepared target
// launch resolved — never a userRoot/instance layout — and stays idempotent
// for identical bytes while refusing a conflicting native session state.
test("installHandoffRollout installs into the resolved provider home and rejects conflicts", () => {
  const providerHome = mkdtempSync(path.join(tmpdir(), "ha-handoff-install-"));
  try {
    const body = rollout([{ type: "response_item", payload: { type: "message", role: "user", content: [] } }]);
    installHandoffRollout(providerHome, sessionId, body);
    const installed = path.join(providerHome, "sessions", "2026", "10", "04");
    const written = path.join(installed, `rollout-2026-10-04T00-00-00-${sessionId}.jsonl`);
    assert.equal(readFileSync(written).equals(body), true);
    // Reinstalling the identical bytes is the claim-retry no-op.
    installHandoffRollout(providerHome, sessionId, body);
    assert.equal(readFileSync(written).equals(body), true);
    // A different native state under the same selected identity is refused.
    writeFileSync(
      written,
      Buffer.from(
        `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cli_version: "0.159.1", timestamp: "2026-10-04T00:00:00.000Z" } })}\n`,
      ),
    );
    assert.throws(() => installHandoffRollout(providerHome, sessionId, body), {
      code: "runtime_handoff_target_exists",
    });
  } finally {
    rmSync(providerHome, { recursive: true, force: true });
  }
});
