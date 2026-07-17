// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { runAgentRuntimeCommand } from "../src/commands/agent-runtime.ts";

test("native agent run and resume commands dispatch through daemon adapter routes", async () => {
  const requests: Array<{ method: string; payload: unknown }> = [];
  const request = async (method: string, payload: unknown) => {
    requests.push({ method, payload });
    return {
      ok: true as const,
      schema: "command-receipt/v2" as const,
      command: method,
      action: "spawn",
      summary: "spawned",
      details: {},
      meta: { generatedAt: "2026-07-17T00:00:00.000Z", compatibility: { legacyReceipt: "CommandReceipt/v1" as const } }
    };
  };

  await runAgentRuntimeCommand([
    "agent", "run", "--runtime", "codex", "--profile", "chatgpt-account",
    "--prompt", "inspect", "--root", "/workspace", "--task", "task_1"
  ], request);
  await runAgentRuntimeCommand([
    "agent", "resume", "--runtime", "claude-code", "--profile", "subscription-account",
    "--provider-session", "provider-old", "--prompt", "continue", "--root", "/workspace"
  ], request);

  assert.equal(requests[0]?.method, "repo.agent-runtimes.spawn");
  assert.deepEqual(requests[0]?.payload, {
    kindId: "codex",
    prompt: "inspect",
    cwd: "/workspace",
    authenticationProfileKind: "chatgpt-account",
    taskId: "task_1"
  });
  assert.equal((requests[1]?.payload as { resumeProviderSessionId?: string }).resumeProviderSessionId, "provider-old");
});
