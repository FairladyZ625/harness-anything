// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { codedAs, observed } from "./agent-runtime-instance-environment.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

test("ZCode API-key instances materialize one pinned model in their isolated HOME", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-zcode-config-")),
    zcode = {
      ...observed,
      installationId: "zcode-installation-test",
      kindId: "zcode" as const,
      executablePath: "/opt/runtime-test/zcode",
    };
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [zcode],
      resolveCredential: async () => "redacted-test-key",
    });
    const created = store.command({
      kind: "runtime-instance-create",
      instanceId: "zcode-glm",
      name: "ZCode GLM",
      kindId: "zcode",
      providerId: "bigmodel",
      models: ["GLM-5.3"],
      zcode: { baseUrl: "https://open.bigmodel.cn/api/anthropic" },
      authMode: "api-key",
      credentialRef: "credential:v1:zcode-glm",
    }).instance as { readonly isolationState: string };
    assert.equal(created.isolationState, "enforced");
    const launch = await store.prepareLaunch("zcode-glm", { cwd: "/workspace/repo", prompt: "Probe" }),
      stateRoot = path.join(userRoot, "runtime-instances", "zcode-glm"),
      configPath = path.join(stateRoot, "home", ".zcode", "cli", "config.json");
    assert.equal(launch.env.HOME ?? launch.env.USERPROFILE, path.join(stateRoot, "home"));
    assert.equal(launch.args.includes("--model"), false);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      provider: {
        bigmodel: {
          name: "bigmodel",
          kind: "anthropic",
          options: {
            apiKey: "redacted-test-key",
            baseURL: "https://open.bigmodel.cn/api/anthropic",
          },
          enabled: true,
          models: { "GLM-5.3": {} },
        },
      },
      model: { main: "bigmodel/GLM-5.3" },
    });
    if (process.platform !== "win32") assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-update",
          instanceId: "zcode-glm",
          models: ["GLM-5.3", "GLM-5.3-Flash"],
        }),
      (error: unknown) => codedAs(error, "invalid_command"),
    );
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-create",
          instanceId: "zcode-multi",
          name: "ZCode Multi",
          kindId: "zcode",
          providerId: "bigmodel",
          models: ["GLM-5.3", "GLM-5.3-Flash"],
          authMode: "api-key",
          credentialRef: "credential:v1:zcode-multi",
        }),
      (error: unknown) => codedAs(error, "invalid_command"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

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

test("agy uses the operator environment, OAuth-only auth, and a closed effort enum", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-agy-")),
    agy = {
      installationId: "agy-installation-test",
      kindId: "agy" as const,
      executablePath: "/opt/runtime-test/agy",
      version: "1.1.15",
      observedAt: "2026-08-19T00:00:00.000Z",
    };
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      env: { HOME: "/operator/home", PATH: "/bin" },
      discover: () => [agy],
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    store.create({
      schemaVersion: 2,
      instanceId: "agy-review",
      name: "AGY Review",
      kindId: "agy",
      installationId: agy.installationId,
      providerId: "google",
      models: ["gemini-3.1-pro-low"],
      defaultModel: "gemini-3.1-pro-low",
      enabled: true,
      agy: { effort: "low" },
      auth: { mode: "subscription" },
    });
    const launch = await store.prepareLaunch("agy-review", {
      cwd: "/workspace/repo",
      prompt: "Reply with exactly AGY-OK",
      effort: "medium",
      providerSessionId: "conversation-1",
    });
    assert.deepEqual(launch.args, [
      "-p",
      "Reply with exactly AGY-OK",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "30m",
      "--model",
      "gemini-3.1-pro-low",
      "--dangerously-skip-permissions",
      "--effort",
      "medium",
      "--conversation",
      "conversation-1",
    ]);
    assert.equal(launch.env.HOME, "/operator/home");
    assert.equal(launch.env.CODEX_HOME, undefined);
    assert.equal(launch.env.CLAUDE_CONFIG_DIR, undefined);
    await assert.rejects(
      store.prepareLaunch("agy-review", { cwd: "/workspace/repo", prompt: "reject", effort: "xhigh" }),
      (error: unknown) =>
        codedAs(error, "invalid_runtime_effort") &&
        error instanceof Error &&
        error.message.includes("low, medium, or high"),
    );
    assert.equal(
      store.command({ kind: "runtime-instance-show", instanceId: "agy-review" }).instance &&
        (
          store.command({ kind: "runtime-instance-show", instanceId: "agy-review" }).instance as {
            isolationState: string;
          }
        ).isolationState,
      "operator-environment",
    );
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-create",
          instanceId: "agy-api",
          name: "AGY API",
          kindId: "agy",
          installationId: agy.installationId,
          providerId: "google",
          models: ["gemini"],
          authMode: "api-key",
          credentialRef: "credential:v1:agy-api",
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_auth"),
    );
    assert.throws(
      () => store.prepareAuthCommand("agy-review", "login"),
      (error: unknown) => codedAs(error, "runtime_auth_interactive_only"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("agy subscription probes report an unavailable operator environment", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-agy-subscription-probe-")),
    agy: RuntimeInstallationWitness = {
      installationId: "agy-rejected-status",
      kindId: "agy",
      executablePath: writeProviderExecutable(path.join(userRoot, "agy-models.mjs"), "process.exit(7);\n"),
      version: "1.1.15",
      observedAt: "2026-08-19T00:00:00.000Z",
    };
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [agy] });
    store.create({
      schemaVersion: 1,
      instanceId: "agy-subscription",
      name: "AGY Subscription",
      kindId: "agy",
      installationId: agy.installationId,
      providerId: "google",
      model: "gemini-3.1-pro-low",
      auth: { mode: "subscription" },
    });
    assert.deepEqual(await store.authStatus("agy-subscription"), {
      status: "not-ready",
      code: "runtime_subscription_required",
      hint: "Provider subscription authentication is unavailable in the operator environment.",
    });
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
