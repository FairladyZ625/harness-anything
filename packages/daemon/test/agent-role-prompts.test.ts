// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { assembleAgentPrompt } from "../src/runtime-spawn-mission.ts";

test("worker dispatches include the host infrastructure boundary", () => {
  const prompt = assembleAgentPrompt(
    {
      id: "worker",
      name: "Worker",
      instructions: "Do the assigned work.",
      runtime_type: "codex",
      role: "worker",
    },
    "Run the targeted test.",
  );

  assert.match(prompt, /must not operate host virtualization, networking, or system services/u);
  assert.match(prompt, /`prlctl`, `VBoxManage`, `sudo`, `systemctl`, `ip link`, or `networksetup`/u);
  assert.match(prompt, /stop and report the blocker/u);
});
