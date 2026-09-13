// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";

const observed: RuntimeInstallationWitness = {
  installationId: "codex-installation-test",
  kindId: "codex",
  executablePath: "/opt/runtime-test/codex",
  version: "0.146.1",
  observedAt: "2026-08-15T00:00:00.000Z",
};

test("claude launches carry attribution-off settings and other kinds stay untouched", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-claude-attribution-")),
    claude = {
      ...observed,
      installationId: "claude-attribution",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude",
    };
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed, claude],
      resolveCredential: () => "instance-secret",
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    store.create({
      schemaVersion: 2,
      instanceId: "claude-attribution",
      name: "Claude Attribution",
      kindId: "claude",
      installationId: claude.installationId,
      providerId: "anthropic",
      models: ["claude-fable-5"],
      defaultModel: "claude-fable-5",
      enabled: true,
      claude: {},
      auth: { mode: "subscription" },
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-attribution",
      name: "Codex Attribution",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: {},
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-attribution" },
    });
    const launch = await store.prepareLaunch("claude-attribution", { cwd: "/workspace/repo", prompt: "Commit" }),
      codexLaunch = await store.prepareLaunch("codex-attribution", { cwd: "/workspace/repo", prompt: "Commit" }),
      settingsJson = '{"attribution":{"commit":"","pr":"","sessionUrl":false}}';
    assert.deepEqual(launch.args.slice(launch.args.indexOf("--settings"), launch.args.indexOf("--settings") + 2), [
      "--settings",
      settingsJson,
    ]);
    assert.equal(codexLaunch.args.includes("--settings"), false);
    assert.equal(codexLaunch.args.includes(settingsJson), false);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
