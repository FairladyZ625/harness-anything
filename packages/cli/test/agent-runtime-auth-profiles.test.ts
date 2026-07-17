// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { probeRuntimeAuthenticationProfiles } from "../src/daemon/agent-runtime-auth-profiles.ts";

test("runtime auth profiles detect account and API-key configuration without projecting credentials", async () => {
  const profiles = await probeRuntimeAuthenticationProfiles({
    env: { ANTHROPIC_API_KEY: "secret-a", OPENAI_API_KEY: "secret-b" },
    runStatus: async (kindId) => kindId === "claude-code"
      ? { exitCode: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","email":"private@example.test"}' }
      : { exitCode: 0, stdout: "", stderr: "Logged in using ChatGPT" }
  });

  assert.deepEqual(profiles.map(({ kindId, profileKind, state }) => ({ kindId, profileKind, state })), [
    { kindId: "claude-code", profileKind: "subscription-account", state: "configured" },
    { kindId: "claude-code", profileKind: "api-key", state: "configured" },
    { kindId: "codex", profileKind: "chatgpt-account", state: "configured" },
    { kindId: "codex", profileKind: "api-key", state: "configured" }
  ]);
  const serialized = JSON.stringify(profiles);
  assert.equal(serialized.includes("secret-a"), false);
  assert.equal(serialized.includes("secret-b"), false);
  assert.equal(serialized.includes("private@example.test"), false);
});
