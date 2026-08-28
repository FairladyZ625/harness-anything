// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseAgyFrame } from "../src/runtime-spawn-provider-frames.ts";

const conversation = { conversation_id: "agy-conversation", step_index: 2 };

test("agy tool steps become tool activity so a read-only run is visible before its final answer", () => {
  const active = parseAgyFrame(
    {
      event: "step_update",
      step_update: {
        ...conversation,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "view_file",
        tool_info: { name: "view_file", parameters: { AbsolutePath: "/repo/README.md" } },
      },
    },
    "agy-conversation",
  );
  assert.equal(active.signals?.length, 1);
  assert.equal(active.signals?.[0]?.activity, "tool");
  const content = JSON.parse(active.signals?.[0]?.content ?? "{}") as Record<string, unknown>;
  assert.equal(content.tool_name, "view_file");
  assert.equal(content.state, "ACTIVE");
  assert.equal(Object.hasOwn(content, "conversation_id"), false);
});

test("agy text deltas stay message activity and other text-less steps stay silent", () => {
  const message = parseAgyFrame(
    {
      event: "step_update",
      step_update: { ...conversation, state: "ACTIVE", step_type: "agent_response", text_delta: "hi" },
    },
    "agy-conversation",
  );
  assert.deepEqual(message.signals, [{ type: "activity", activity: "message", content: "hi" }]);
  const silent = parseAgyFrame(
    { event: "step_update", step_update: { ...conversation, state: "DONE", step_type: "user_input" } },
    "agy-conversation",
  );
  assert.equal(silent.signals, undefined);
});
