// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { runtimeKinds } from "../src/runtime-inventory.ts";

/**
 * Launch-config bearing assertions for the 12 ACP providers introduced in PR #2779.
 * Until now catalog coverage only asserted kind membership: the executable command, the
 * argument template an instance actually launches with, and the authenticate method could
 * all drift silently. Each row here is the launch contract of one provider — a change to
 * any cell must be a deliberate contract edit, not an unnoticed catalog refactor.
 */
const acpLaunchContracts = [
  {
    kindId: "copilot",
    command: "copilot",
    argumentTemplate: ["--acp"],
    acpAuthMethod: "copilot-login",
  },
  { kindId: "auggie", command: "auggie", argumentTemplate: ["--acp"] },
  {
    kindId: "droid",
    command: "droid",
    argumentTemplate: ["exec", "--output-format", "acp-daemon"],
    acpAuthMethod: "factory-api-key",
    acpCredentialKey: "factory_api_key",
  },
  { kindId: "grok", command: "grok", argumentTemplate: ["agent", "stdio"], acpAuthMethod: "grok.com" },
  { kindId: "kimi", command: "kimi", argumentTemplate: ["acp"] },
  {
    kindId: "qwen-code",
    command: "qwen",
    argumentTemplate: ["--acp"],
    acpAuthMethod: "openai",
    acpCredentialKey: "openai_api_key",
  },
  { kindId: "minimax-code", command: "mcode", argumentTemplate: ["acp"] },
  { kindId: "mistral-vibe", command: "vibe-acp", argumentTemplate: [], acpAuthMethod: "browser-auth" },
  { kindId: "junie", command: "junie", argumentTemplate: ["--acp=true"] },
  { kindId: "codebuddy", command: "codebuddy", argumentTemplate: ["--acp"] },
  { kindId: "glm-acp", command: "glm-acp-agent", argumentTemplate: [], acpAuthMethod: "z-ai-api-key" },
  { kindId: "agy-acp", command: "agy_acp_server", argumentTemplate: [], acpAuthMethod: "gemini-api-key" },
] as const;

test("the 12 ACP provider launch contracts stay pinned", () => {
  assert.equal(acpLaunchContracts.length, 12);
  assert.equal(new Set(acpLaunchContracts.map(({ kindId }) => kindId)).size, 12);
  for (const expected of acpLaunchContracts) {
    const kind = runtimeKinds.find((entry) => entry.kindId === expected.kindId);
    assert.ok(kind, `runtime kind ${expected.kindId} must stay in the inventory`);
    assert.equal(kind.protocolFamily, "acp", expected.kindId);
    assert.equal(kind.executable.command, expected.command, `${expected.kindId} executable.command`);
    assert.deepEqual(kind.launch.argumentTemplate, expected.argumentTemplate, `${expected.kindId} argumentTemplate`);
    assert.equal(kind.auth.acpAuthMethod, expected.acpAuthMethod, `${expected.kindId} acpAuthMethod`);
    assert.equal(kind.auth.acpCredentialKey, expected.acpCredentialKey, `${expected.kindId} acpCredentialKey`);
  }
});

/**
 * The workspace-write permission contract of the non-ACP CLI kinds. acceptEdits
 * alone leaves a headless Claude session unable to run any Bash command, so the
 * claude mapping must carry exactly the `ha` prefix rule — `ha` writes ride the
 * daemon's authorization and single-writer queue, and Claude Code requires each
 * subcommand of a compound command to match a rule independently. Codex keeps
 * its OS sandbox mapping; its socket reachability gap is handled at Schedule
 * definition time, not by widening these args.
 */
test("claude workspace-write allows exactly the ha command prefix and codex keeps its sandbox mapping", () => {
  const claude = runtimeKinds.find((entry) => entry.kindId === "claude"),
    codex = runtimeKinds.find((entry) => entry.kindId === "codex");
  assert.ok(claude && codex, "claude and codex kinds must stay in the inventory");
  assert.deepEqual(claude.launch.permissionArgs["workspace-write"], [
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash(ha *)",
  ]);
  // The rule must stay prefix-scoped: no bare tool wildcard, no unspaced prefix
  // that would also match unrelated commands (Bash(ha*) matches `hack`).
  const rule = claude.launch.permissionArgs["workspace-write"][3];
  assert.equal(rule, "Bash(ha *)");
  assert.equal(claude.launch.resumePermissionArgs, undefined);
  assert.deepEqual(codex.launch.permissionArgs["workspace-write"], [
    "--sandbox",
    "workspace-write",
    "--config",
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "--config",
    "sandbox_workspace_write.exclude_slash_tmp=true",
  ]);
});
