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

test("only Codex and Claude declare steer resume and Codex resumes before stdin input", () => {
  const codex = runtimeKinds.find((entry) => entry.kindId === "codex")!,
    claude = runtimeKinds.find((entry) => entry.kindId === "claude")!;
  assert.ok(codex.steer);
  assert.ok(claude.steer);
  const codexResume = codex.steer!.resumeArgs(
    ["exec", "--json", "--sandbox", "workspace-write", "--model", "o4-mini", "-"],
    "thread-123",
  );
  assert.deepEqual(codexResume, [
    "exec",
    "resume",
    "--json",
    "--sandbox",
    "workspace-write",
    "--model",
    "o4-mini",
    "thread-123",
    "-",
  ]);
  assert.deepEqual(
    codex.steer!.resumeArgs(["exec", "resume", "--json", "--model", "o4-mini", "thread-old", "-"], "thread-123"),
    ["exec", "resume", "--json", "--model", "o4-mini", "thread-123", "-"],
  );
  assert.deepEqual(claude.steer!.resumeArgs(["-p", "--output-format", "stream-json"], "session-123"), [
    "-p",
    "--output-format",
    "stream-json",
    "--resume",
    "session-123",
  ]);
  assert.equal(runtimeKinds.filter((entry) => entry.steer).length, 2);
  assert.equal(runtimeKinds.find((entry) => entry.kindId === "copilot")!.steer, undefined);
});

// DeepSeek Harness 0.2.1-rc.2 (2026-10-18): the desktop App's bundled CLI is the only entry
// (nothing on PATH), `dsh --profile acp` takes no flags, and the sandbox/approval policy is
// the DSH_PERMISSION_MODE environment variable (asar acp profile: sandbox-policy.mode and
// user-approval.policy both read it; only danger-full-access turns approval off).
test("the DeepSeek Harness launch contract keeps subscription shared and enables isolated API overrides", () => {
  const kind = runtimeKinds.find((entry) => entry.kindId === "deepseek-harness")!;
  assert.ok(kind);
  assert.equal(kind.protocolFamily, "acp");
  assert.equal(kind.executable.command, "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh");
  assert.equal(kind.executable.configHomeEnvironment, "DSH_HOME");
  assert.equal(kind.executable.authFile, null);
  assert.deepEqual(kind.launch.argumentTemplate, ["--profile", "acp"]);
  assert.deepEqual(kind.launch.permissionEnvironment, {
    bypass: { DSH_PERMISSION_MODE: "danger-full-access" },
    "workspace-write": { DSH_PERMISSION_MODE: "workspace-write" },
    "read-only": { DSH_PERMISSION_MODE: "read-only" },
  });
  assert.deepEqual(kind.isolation, {
    defaultState: "operator-environment",
    states: ["operator-environment", "enforced"],
  });
  assert.deepEqual(kind.auth, {
    shape: "separate",
    modes: ["subscription", "api-key"],
    apiKeyIsolation: "enforced",
    subscriptionIsolation: "operator-environment",
    subscriptionProbe: ["--version"],
    subscriptionProbeTimeoutMs: 10_000,
    endpoints: { baseUrl: "optional" },
  });
  assert.deepEqual(kind.configuration.fields, { baseUrl: "url", wireApi: "identifier" });
  assert.deepEqual(kind.configuration.choices, {
    wireApi: ["openai-completions", "openai-responses", "anthropic-messages"],
  });
  assert.equal(kind.auth.acpAuthMethod, undefined);
  assert.deepEqual(kind.declaredCapabilities, ["structured_witness", "attach", "session_identity"]);
  assert.equal(kind.capabilities.resume, "unsupported");
  // Negative control: no other kind declares an environment-borne permission mapping.
  assert.deepEqual(
    runtimeKinds.filter((entry) => entry.launch.permissionEnvironment !== undefined).map((entry) => entry.kindId),
    ["deepseek-harness"],
  );
});
