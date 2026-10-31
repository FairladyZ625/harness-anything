// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { runAcpProviderSession } from "../src/runtime-worker-acp.ts";
import { codedAs, observed } from "./agent-runtime-instance-environment.fixture.ts";
import { writeAcpProviderStub } from "./fixtures/acp-stub.ts";
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

test("DeepSeek Harness API-key instances write secret-free profile patches and inject the key only at launch", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-deepseek-api-")),
    operatorDshHome = path.join(userRoot, "operator-home", ".dsh"),
    deepseek = {
      ...observed,
      installationId: "deepseek-api-installation",
      kindId: "deepseek-harness" as const,
      executablePath: "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
    },
    secret = "deepseek-runtime-test-secret";
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      env: {
        PATH: "/runtime/tools",
        HOME: "/operator/home",
        DSH_HOME: operatorDshHome,
        DEEPSEEK_API_KEY: "host-deepseek-key",
      },
      discover: () => [deepseek],
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
      resolveCredential: async (reference) => {
        assert.equal(reference, "credential:v1:deepseek-api");
        return secret;
      },
    });
    const created = store.command({
      kind: "runtime-instance-create",
      instanceId: "deepseek-api",
      name: "DeepSeek API",
      kindId: "deepseek-harness",
      installationId: deepseek.installationId,
      providerId: "deepseek-account",
      models: ["deepseek-flash"],
      "deepseek-harness": { baseUrl: "https://api.deepseek.example/v1", wireApi: "anthropic-messages" },
      authMode: "api-key",
      credentialRef: "credential:v1:deepseek-api",
    });
    const receipt = JSON.stringify(created),
      stateRoot = path.join(userRoot, "runtime-instances", "deepseek-api"),
      configPath = path.join(stateRoot, "home", ".dsh", "profiles", "acp", "cordis.patch.yml");
    assert.doesNotMatch(receipt, new RegExp(secret, "u"));
    assert.doesNotMatch(readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8"), new RegExp(secret, "u"));
    assert.equal((created.instance as { isolationState: string }).isolationState, "enforced");

    const launch = await store.prepareLaunch("deepseek-api", { cwd: "/workspace/repo", prompt: "Inspect" }),
      patch = JSON.parse(readFileSync(configPath, "utf8")) as Array<{
        id: string;
        config: Record<string, unknown>;
      }>;
    assert.equal(launch.env.DSH_HOME, path.join(stateRoot, "home", ".dsh"));
    assert.equal(launch.env.HARNESS_DEEPSEEK_API_KEY, secret);
    assert.equal(launch.env.DEEPSEEK_API_KEY, undefined);
    assert.equal(launch.acpApiKey, undefined);
    assert.deepEqual(launch.args, ["--profile", "acp"]);
    assert.equal(launch.model, '["deepseek-account","deepseek-flash"]');
    assert.deepEqual(patch, [
      { id: "agent-default-model", config: { provider: "deepseek-account", model: "deepseek-flash" } },
      { id: "acp", config: { provider: "deepseek-account", model: "deepseek-flash" } },
      {
        id: "llm-pi-ai",
        config: {
          providers: {
            "deepseek-account": {
              api: "anthropic-messages",
              apiKeyEnv: "HARNESS_DEEPSEEK_API_KEY",
              baseURL: "https://api.deepseek.example/v1",
              displayName: "deepseek-account",
              models: [{ id: "deepseek-flash" }],
            },
          },
        },
      },
    ]);

    const capture = path.join(userRoot, "acp-capture.jsonl"),
      executablePath = writeAcpProviderStub(path.join(userRoot, "dsh-stub"), capture, {
        session: {
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: '["deepseek-official","deepseek-flash"]',
              options: [
                {
                  group: "deepseek-official",
                  name: "DeepSeek",
                  options: [{ value: '["deepseek-official","deepseek-flash"]', name: "deepseek-flash" }],
                },
                {
                  group: "deepseek-account",
                  name: "DeepSeek Account",
                  options: [{ value: '["deepseek-account","deepseek-flash"]', name: "DeepSeek-V4.1-Flash" }],
                },
              ],
            },
          ],
        },
      }),
      acpRecords: Record<string, unknown>[] = [];
    writeFileSync(capture, "");
    const child = spawn(executablePath, ["acp"], {
        cwd: "/tmp",
        env: { ...launch.env, PATH: process.env.PATH },
        stdio: ["pipe", "pipe", "pipe"],
      }),
      closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code))),
      session = runAcpProviderSession(
        child,
        {
          kindId: "deepseek-harness",
          cwd: launch.cwd,
          env: launch.env,
          prompt: launch.prompt,
          model: launch.model,
          acpApiKey: "test-manifest-key",
        },
        (record) => acpRecords.push({ ...record }),
      );
    await session.done;
    assert.equal(await closed, 0);
    const acpEvents = acpRecords
        .filter((record) => record.kind === "provider_event")
        .map((record) => record.event as Record<string, unknown>),
      modelEvent = acpEvents.find((event) => event.type === "acp.model"),
      resultEvent = acpEvents.find((event) => event.type === "acp.result");
    assert.deepEqual(modelEvent, {
      sessionId: "devin-acp-session",
      type: "acp.model",
      requested: '["deepseek-account","deepseek-flash"]',
      applied: '["deepseek-account","deepseek-flash"]',
    });
    assert.equal(resultEvent?.finalText, "devin live content");
    assert.deepEqual(
      readFileSync(capture, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.configOption !== undefined),
      [{ configOption: { configId: "model", value: '["deepseek-account","deepseek-flash"]' } }],
    );

    const tupleModel = '["deepseek-official","Deepseek-V4.1-Flash"]';
    store.command({
      kind: "runtime-instance-create",
      instanceId: "deepseek-tuple-api",
      name: "DeepSeek Tuple API",
      kindId: "deepseek-harness",
      installationId: deepseek.installationId,
      providerId: "deepseek",
      models: [tupleModel],
      authMode: "api-key",
      credentialRef: "credential:v1:deepseek-api",
    });
    const tupleLaunch = await store.prepareLaunch("deepseek-tuple-api", {
        cwd: "/workspace/repo",
        prompt: "Inspect",
        model: tupleModel,
      }),
      tupleConfigPath = path.join(
        userRoot,
        "runtime-instances",
        "deepseek-tuple-api",
        "home",
        ".dsh",
        "profiles",
        "acp",
        "cordis.patch.yml",
      ),
      tuplePatch = JSON.parse(readFileSync(tupleConfigPath, "utf8")) as Array<{
        id: string;
        config: Record<string, unknown>;
      }>;
    assert.equal(tupleLaunch.model, tupleModel);
    assert.deepEqual(tuplePatch.slice(0, 2), [
      {
        id: "agent-default-model",
        config: { provider: "deepseek-official", model: "Deepseek-V4.1-Flash" },
      },
      { id: "acp", config: { provider: "deepseek-official", model: "Deepseek-V4.1-Flash" } },
    ]);
    assert.deepEqual(tuplePatch[2], {
      id: "llm-deepseek",
      config: {
        apiKeyEnv: "HARNESS_DEEPSEEK_API_KEY",
        models: [{ id: "Deepseek-V4.1-Flash" }],
      },
    });

    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-create",
          instanceId: "deepseek-wrong-route-api",
          name: "DeepSeek Wrong Route API",
          kindId: "deepseek-harness",
          installationId: deepseek.installationId,
          providerId: "deepseek-account",
          models: [tupleModel],
          "deepseek-harness": { baseUrl: "https://api.deepseek.example/v1", wireApi: "anthropic-messages" },
          authMode: "api-key",
          credentialRef: "credential:v1:deepseek-api",
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_model"),
    );
    assert.doesNotMatch(readFileSync(configPath, "utf8"), new RegExp(secret, "u"));
    if (process.platform !== "win32") assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.equal(existsSync(path.join(operatorDshHome, "profiles", "acp", "cordis.patch.yml")), false);

    const official = store.command({
      kind: "runtime-instance-create",
      instanceId: "deepseek-official-api",
      name: "DeepSeek Official API",
      kindId: "deepseek-harness",
      installationId: deepseek.installationId,
      providerId: "deepseek",
      models: ["deepseek-v4-flash"],
      "deepseek-harness": { baseUrl: "https://api.deepseek.example/v1" },
      authMode: "api-key",
      credentialRef: "credential:v1:deepseek-api",
    });
    assert.equal((official.instance as { authState: string }).authState, "configured");
    const officialLaunch = await store.prepareLaunch("deepseek-official-api", {
        cwd: "/workspace/repo",
        prompt: "Inspect",
      }),
      officialPatchPath = path.join(
        userRoot,
        "runtime-instances",
        "deepseek-official-api",
        "home",
        ".dsh",
        "profiles",
        "acp",
        "cordis.patch.yml",
      ),
      officialPatch = JSON.parse(readFileSync(officialPatchPath, "utf8")) as Array<{
        id: string;
        config: Record<string, unknown>;
      }>;
    assert.equal(officialLaunch.model, '["deepseek-official","deepseek-v4-flash"]');
    assert.deepEqual(officialPatch[2], {
      id: "llm-deepseek",
      config: {
        apiKeyEnv: "HARNESS_DEEPSEEK_API_KEY",
        baseURL: "https://api.deepseek.example/v1",
        models: [{ id: "deepseek-v4-flash" }],
      },
    });
    assert.deepEqual(officialPatch.slice(0, 2), [
      {
        id: "agent-default-model",
        config: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      },
      { id: "acp", config: { provider: "deepseek-official", model: "deepseek-v4-flash" } },
    ]);
    assert.equal(officialLaunch.env.HARNESS_DEEPSEEK_API_KEY, secret);
    assert.doesNotMatch(JSON.stringify(officialPatch), new RegExp(secret, "u"));

    const subscription = store.command({
      kind: "runtime-instance-create",
      instanceId: "deepseek-subscription",
      name: "DeepSeek Subscription",
      kindId: "deepseek-harness",
      installationId: deepseek.installationId,
      providerId: "deepseek",
      models: ["deepseek-v4-flash"],
      authMode: "subscription",
    });
    assert.equal((subscription.instance as { isolationState: string }).isolationState, "operator-environment");
    const subscriptionLaunch = await store.prepareLaunch("deepseek-subscription", {
      cwd: "/workspace/repo",
      prompt: "Inspect",
    });
    assert.equal(subscriptionLaunch.env.DSH_HOME, operatorDshHome);
    assert.equal(subscriptionLaunch.env.DEEPSEEK_API_KEY, "host-deepseek-key");
    assert.equal(subscriptionLaunch.env.HARNESS_DEEPSEEK_API_KEY, undefined);
    assert.equal(subscriptionLaunch.acpApiKey, undefined);
    assert.equal(existsSync(path.join(userRoot, "runtime-instances", "deepseek-subscription", "home", ".dsh")), false);

    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-create",
          instanceId: "deepseek-bad-wire",
          name: "DeepSeek Bad Wire",
          kindId: "deepseek-harness",
          installationId: deepseek.installationId,
          providerId: "deepseek",
          models: ["deepseek-v4-flash"],
          "deepseek-harness": { wireApi: "responses" },
          authMode: "api-key",
          credentialRef: "credential:v1:deepseek-api",
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_kind_config"),
    );
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-create",
          instanceId: "deepseek-subscription-endpoint",
          name: "DeepSeek Subscription Endpoint",
          kindId: "deepseek-harness",
          installationId: deepseek.installationId,
          providerId: "deepseek",
          models: ["deepseek-v4-flash"],
          "deepseek-harness": { baseUrl: "https://api.deepseek.example/v1" },
          authMode: "subscription",
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_kind_config"),
    );
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-create",
          instanceId: "deepseek-api-operator",
          name: "DeepSeek API Operator",
          kindId: "deepseek-harness",
          installationId: deepseek.installationId,
          providerId: "deepseek",
          models: ["deepseek-v4-flash"],
          authMode: "api-key",
          credentialRef: "credential:v1:deepseek-api",
          isolationState: "operator-environment",
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_isolation"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

// A Claude Code below the kind's declared floor cannot launch a turn: the alias/model it
// reaches is rejected by this build only after the provider is spawned, so the failure
// surfaced as provider_fault after the dispatch had already spent its worker. The probe
// and the launch share one version gate, so both refuse before any spawn and name the
// witnessed version, the floor, and the upgrading command.
test("a Claude installation below the version floor is refused by probe and launch, and the current floor passes", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-claude-version-gate-")),
    oldClaude = {
      ...observed,
      installationId: "claude-below-floor",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude-old",
      version: "2.1.268 (Claude Code)",
    },
    currentClaude = {
      ...observed,
      installationId: "claude-at-floor",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude-current",
      version: "2.1.305 (Claude Code)",
    };
  try {
    let credentialLookups = 0;
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [oldClaude, currentClaude],
      resolveCredential: () => {
        credentialLookups += 1;
        return "instance-secret";
      },
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    for (const [instanceId, installationId] of [
      ["claude-old", oldClaude.installationId],
      ["claude-current", currentClaude.installationId],
    ] as const)
      store.create({
        schemaVersion: 2,
        instanceId,
        name: instanceId,
        kindId: "claude",
        installationId,
        providerId: "anthropic",
        models: ["claude-opus-5-5"],
        defaultModel: "claude-opus-5-5",
        enabled: true,
        claude: {},
        auth: { mode: "api-key", credentialRef: `credential:v1:${instanceId}` },
      });

    const refused = await store.authStatus("claude-old");
    assert.equal(refused.status, "not-ready", JSON.stringify(refused));
    assert.equal(refused.code, "minimum_version_not_met");
    assert.match(refused.hint!, /2\.1\.268/u);
    assert.match(refused.hint!, /2\.1\.280/u);
    assert.match(refused.hint!, /claude update/u);

    // The launch is refused before the credential is even resolved: an unusable CLI must
    // not report authentication readiness or read a secret it can never use.
    credentialLookups = 0;
    await assert.rejects(
      store.prepareLaunch("claude-old", { cwd: "/workspace/repo", prompt: "Inspect" }),
      (error: unknown) =>
        codedAs(error, "minimum_version_not_met") &&
        error instanceof Error &&
        /2\.1\.268/u.test(error.message) &&
        /2\.1\.280/u.test(error.message),
    );
    assert.equal(credentialLookups, 0, "an unusable CLI must be refused before any credential lookup");

    assert.deepEqual(await store.authStatus("claude-current"), { status: "ready", code: null, hint: null });
    const launch = await store.prepareLaunch("claude-current", { cwd: "/workspace/repo", prompt: "Inspect" });
    assert.deepEqual(launch.args.slice(launch.args.indexOf("--model"), launch.args.indexOf("--model") + 2), [
      "--model",
      "claude-opus-5-5",
    ]);
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
      version: "2.1.305 (Claude Code)",
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

// `devin auth status` exits 0 whether or not credentials exist, so the kind's
// subscription probe is file-key: the declared authFile must exist and carry a
// non-empty windsurf_api_key — the same credential the ACP handshake consumes.
test("devin subscription readiness follows the credential file key, not a command exit code", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-devin-filekey-")),
    home = path.join(userRoot, "home"),
    credentials = path.join(home, ".local/share/devin/credentials.toml"),
    devin: RuntimeInstallationWitness = {
      installationId: "devin-installation-test",
      kindId: "devin",
      executablePath: "/opt/runtime-test/devin",
      version: "3000.10.27",
      observedAt: "2026-09-15T00:00:00.000Z",
    };
  try {
    mkdirSync(path.dirname(credentials), { recursive: true });
    const store = openRuntimeInstanceStore({
      userRoot,
      env: { HOME: home, PATH: "/bin" },
      discover: () => [devin],
    });
    store.create({
      schemaVersion: 2,
      instanceId: "devin-subscription",
      name: "Devin Subscription",
      kindId: "devin",
      installationId: devin.installationId,
      providerId: "devin",
      models: ["swe2"],
      defaultModel: "swe2",
      enabled: true,
      isolationState: "operator-environment",
      devin: {},
      auth: { mode: "subscription" },
    });
    const hint = "Provider subscription authentication is unavailable in the operator environment.";
    // No credential file at all → not ready.
    assert.deepEqual(await store.authStatus("devin-subscription"), {
      status: "not-ready",
      code: "runtime_subscription_required",
      hint,
    });
    // The key present but empty is still unauthenticated.
    writeFileSync(credentials, 'windsurf_api_key = ""\napi_server_url = "https://example.invalid"\n');
    assert.deepEqual(await store.authStatus("devin-subscription"), {
      status: "not-ready",
      code: "runtime_subscription_required",
      hint,
    });
    // A non-empty declared key is ready; the secret value never leaves the file.
    writeFileSync(
      credentials,
      'windsurf_api_key = "test-subscription-key"\napi_server_url = "https://example.invalid"\n',
    );
    assert.deepEqual(await store.authStatus("devin-subscription"), {
      status: "ready",
      code: null,
      hint: null,
    });
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

// mcode's `--version` exits 0 signed out and `provider list` prints `managed login` in an
// empty HOME, so readiness comes from the provider's own auth-state document: status plus
// expiry. Three states must stay distinguishable: never signed in / expired / ready.
test("minimax-code readiness follows auth-state status and expiry, and its login argv is native", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-minimax-authstate-")),
    home = path.join(userRoot, "home"),
    state = path.join(home, ".minimax/auth/prod/cn/mcode-public/auth-state.json"),
    mcode: RuntimeInstallationWitness = {
      installationId: "minimax-installation-test",
      kindId: "minimax-code",
      executablePath: "/opt/runtime-test/mcode",
      version: "0.4.6",
      observedAt: "2026-10-29T00:00:00.000Z",
    },
    hint = "Provider subscription authentication is unavailable in the operator environment.";
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      env: { HOME: home, PATH: "/bin" },
      discover: () => [mcode],
    });
    store.create({
      schemaVersion: 2,
      instanceId: "minimax-subscription",
      name: "MiniMax Subscription",
      kindId: "minimax-code",
      installationId: mcode.installationId,
      providerId: "minimax-code",
      models: ["minimax/MiniMax-M3"],
      defaultModel: "minimax/MiniMax-M3",
      enabled: true,
      isolationState: "operator-environment",
      auth: { mode: "subscription" },
    });
    // Defect C: mcode accepts `login`/`logout`, not `auth login` / `auth logout`.
    assert.deepEqual(store.prepareAuthCommand("minimax-subscription", "login").args, ["login"]);
    assert.deepEqual(store.prepareAuthCommand("minimax-subscription", "logout").args, ["logout"]);

    // No credential file at all → not ready, and not the "expired" verdict.
    assert.deepEqual(await store.authStatus("minimax-subscription"), {
      status: "not-ready",
      code: "runtime_subscription_required",
      hint,
    });
    mkdirSync(path.dirname(state), { recursive: true });
    writeFileSync(
      state,
      JSON.stringify({ schemaVersion: 2, status: "authenticated", expiresAtMs: Date.now() - 60_000 }),
    );
    assert.deepEqual(await store.authStatus("minimax-subscription"), {
      status: "not-ready",
      code: "runtime_subscription_expired",
      hint: "Provider subscription sign-in has expired; run the instance login to sign in again.",
    });
    writeFileSync(
      state,
      JSON.stringify({ schemaVersion: 2, status: "authenticated", expiresAtMs: Date.now() + 60_000 }),
    );
    assert.deepEqual(await store.authStatus("minimax-subscription"), { status: "ready", code: null, hint: null });
    // An interrupted sign-in leaves `authorizing`; it is not a credential verdict.
    writeFileSync(state, JSON.stringify({ schemaVersion: 2, status: "authorizing", expiresAtMs: Date.now() + 60_000 }));
    assert.equal((await store.authStatus("minimax-subscription")).code, "runtime_subscription_required");

    // Defect B: enforced isolation resolves ~/.minimax and links the operator's whole auth
    // directory (state + tokens) into the instance, so a refreshed login stays visible.
    writeFileSync(
      state,
      JSON.stringify({ schemaVersion: 2, status: "authenticated", expiresAtMs: Date.now() + 60_000 }),
    );
    store.create({
      schemaVersion: 2,
      instanceId: "minimax-enforced",
      name: "MiniMax Enforced",
      kindId: "minimax-code",
      installationId: mcode.installationId,
      providerId: "minimax-code",
      models: ["minimax/MiniMax-M3"],
      defaultModel: "minimax/MiniMax-M3",
      enabled: true,
      isolationState: "enforced",
      auth: { mode: "subscription" },
    });
    const linked = path.join(userRoot, "runtime-instances/minimax-enforced/home/.minimax/auth"),
      operatorAuth = path.join(home, ".minimax/auth");
    assert.equal(lstatSync(linked).isSymbolicLink(), true);
    assert.equal(readlinkSync(linked), operatorAuth);
    assert.deepEqual(await store.authStatus("minimax-enforced"), { status: "ready", code: null, hint: null });
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

test("an acp launch carries the caller's handshake timeout; other families never see it", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-acp-handshake-")),
    devin = {
      ...observed,
      installationId: "devin-installation-test",
      kindId: "devin" as const,
      executablePath: "/opt/runtime-test/devin",
    };
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [devin],
      resolveCredential: async () => "redacted-test-key",
    });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "devin-acp",
      name: "Devin ACP",
      kindId: "devin",
      providerId: "devin",
      models: ["swe-2"],
      authMode: "api-key",
      credentialRef: "credential:v1:devin-acp",
    });
    const launch = await store.prepareLaunch("devin-acp", {
      cwd: "/workspace/repo",
      prompt: "Probe",
      handshakeTimeoutMs: 45_000,
    });
    assert.equal(launch.protocolFamily, "acp");
    assert.equal(launch.acpApiKey, "redacted-test-key");
    assert.equal(launch.handshakeTimeoutMs, 45_000);
    // A non-acp family ignores the field: the deadline is an ACP handshake concern.
    const claude = {
      ...observed,
      installationId: "claude-installation-test",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude",
      version: "2.1.305 (Claude Code)",
    };
    const claudeStore = openRuntimeInstanceStore({
      userRoot,
      discover: () => [claude],
      resolveCredential: async () => "redacted-test-key",
    });
    claudeStore.command({
      kind: "runtime-instance-create",
      instanceId: "claude-key",
      name: "Claude Key",
      kindId: "claude",
      providerId: "anthropic",
      models: ["claude-opus-4"],
      authMode: "api-key",
      credentialRef: "credential:v1:claude-key",
    });
    const claudeLaunch = await claudeStore.prepareLaunch("claude-key", {
      cwd: "/workspace/repo",
      prompt: "Probe",
      handshakeTimeoutMs: 45_000,
    });
    assert.equal("handshakeTimeoutMs" in claudeLaunch, false);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
