// harness-test-tier: contract
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseThinCommand } from "../../cli/src/cli/thin-command.ts";
import { credentialPort, runCredentialCommand } from "../src/agent-runtime-credential-port.ts";
import {
  discoverRuntimeInstallations,
  openRuntimeInstanceStore,
  type RuntimeInstallationWitness,
} from "../src/agent-runtime-instances.ts";
import {
  daemonProtocolCommands,
  runtimeInstanceMethods,
  validateDaemonRpcCall,
} from "../src/protocol/daemon-protocol.contract.ts";
import { runtimeKindIds, runtimeKinds, type RuntimeProviderDeclaration } from "../src/runtime-inventory.ts";
import { parseProviderFrame, providerFrameParsers } from "../src/runtime-spawn-provider-frames.ts";
import { runtimeProviderPlane } from "../../gui/src/renderer/runtime-provider-planes.ts";
import { validateAgentRuntimeOverview } from "../src/agent-runtime-contract.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

const observed: RuntimeInstallationWitness = {
  installationId: "codex-installation-test",
  kindId: "codex",
  executablePath: "/opt/runtime-test/codex",
  version: "0.146.1",
  observedAt: "2026-08-15T00:00:00.000Z",
};

test("ZCode inventory declares API-key configuration isolation", () => {
  const zcode = runtimeKinds.find(({ kindId }) => kindId === "zcode");
  assert.ok(zcode);
  assert.equal(zcode.auth.shape, "separate");
  assert.deepEqual(zcode.auth.modes, ["subscription", "api-key"]);
  assert.equal(zcode.isolation.defaultState, "enforced");
  assert.deepEqual(zcode.isolation.states, ["enforced", "operator-environment"]);
  assert.equal(zcode.capabilities.configurationIsolation, "supported");
  assert.equal(zcode.configuration.fields.baseUrl, "url");
});

test("runtime instance create RPC leaves provider configuration wrappers open to the inventory", () => {
  const create = runtimeInstanceMethods.find((method) => method.method === "daemon.runtimeInstance.create"),
    payload = create?.params.fields.payload;
  assert.ok(payload && typeof payload === "object" && "fields" in payload);
  assert.equal(payload.open, true);
});

test("a synthetic declaration and frame parser traverse the shared provider surfaces", () => {
  const declaration = {
      ...runtimeKinds[0],
      kindId: "fixture",
      protocolFamily: "fixture",
      displayName: "Fixture Runtime",
      defaultProviderId: "fixture-provider",
      executable: { ...runtimeKinds[0].executable, command: "fixture", configDirectory: ".fixture" },
      configuration: { fields: {}, publicFields: {}, publicDefaults: {} },
    } as unknown as RuntimeProviderDeclaration,
    declarations = runtimeKinds as unknown as RuntimeProviderDeclaration[],
    ids = runtimeKindIds as unknown as string[];
  declarations.push(declaration);
  ids.push(declaration.kindId);
  providerFrameParsers.fixture = (_value, sessionId) => ({
    finalText: "fixture-ok",
    outcome: "succeeded",
    ...(sessionId ? {} : {}),
  });
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-declaration-fixture-"));
  try {
    const parsed = parseThinCommand([
      "runtime",
      "instance",
      "create",
      "--id",
      "fixture-one",
      "--name",
      "Fixture One",
      "--kind",
      "fixture",
      "--installation",
      "fixture-installation",
      "--provider",
      "fixture-provider",
      "--model",
      "fixture-model",
      "--auth",
      "subscription",
    ]);
    assert.equal(parsed.ok && parsed.command.action.kindId, "fixture");
    const store = openRuntimeInstanceStore({
        userRoot,
        discover: () => [
          {
            installationId: "fixture-installation",
            kindId: "fixture",
            executablePath: "/opt/runtime-test/fixture",
            version: "1.0.0",
            observedAt: "2026-09-04T00:00:00.000Z",
          } as never,
        ],
      }),
      receipt = store.command(parsed.ok ? parsed.command.action : {}),
      instance = receipt.instance as { readonly kindId: string; readonly configuration: object };
    assert.equal(instance.kindId, "fixture");
    assert.deepEqual(instance.configuration, {});
    assert.match(readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8"), /"kindId": "fixture"/u);
    assert.equal(runtimeProviderPlane(instance.kindId).defaultProviderId, "fixture-provider");
    assert.deepEqual(
      validateAgentRuntimeOverview({
        ok: true,
        status: "ready",
        installations: [
          {
            installationId: "fixture-installation",
            kindId: "fixture",
            protocolFamily: "fixture",
            version: "1.0.0",
            attachCapability: "supported",
            lastObservedAt: "2026-09-04T00:00:00.000Z",
          },
        ],
        instances: [instance],
        sessions: [],
        watermark: 0,
        sourceRevision: 0,
      }),
      [],
    );
    assert.deepEqual(parseProviderFrame("fixture" as never, { type: "result", session_id: "fixture-session" }), {
      finalText: "fixture-ok",
      outcome: "succeeded",
      sessionIdentity: {
        runtime: "fixture",
        sessionId: "fixture-session",
        transcriptReachability: "by_session_id",
      },
    });
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
    delete providerFrameParsers.fixture;
    ids.pop();
    declarations.pop();
  }
});

test("a blocked credential backend keeps the daemon runtime-instance caller responsive", async (context) => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-credential-block-"));
  try {
    const port = credentialPort("darwin", () =>
      runCredentialCommand({
        file: process.execPath,
        args: ["-e", "setTimeout(() => process.stdout.write('resolved-secret'), 200)"],
      }),
    );
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], resolveCredential: port.resolve });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-blocked",
      name: "Codex blocked",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: {},
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-blocked" },
    });
    let heartbeats = 0;
    const heartbeat = setInterval(() => {
      heartbeats += 1;
    }, 5);
    try {
      assert.deepEqual(await store.authStatus("codex-blocked"), { status: "ready", code: null, hint: null });
    } finally {
      clearInterval(heartbeat);
    }
    context.diagnostic(`daemon-runtime-heartbeats-during-credential-command=${heartbeats}`);
    assert.ok(heartbeats > 0, `expected a responsive daemon caller, observed ${heartbeats} heartbeats`);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("machine runtime instance CRUD binds a witnessed installation and enforces private storage", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-store-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] }),
      config = {
        schemaVersion: 1 as const,
        instanceId: "codex-review",
        name: "Codex Review",
        kindId: "codex" as const,
        installationId: observed.installationId,
        providerId: "openai",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        baseUrl: "https://api.openai.com/v1",
        auth: { mode: "api-key" as const, credentialRef: "keychain:harness/codex-review" },
      };
    const normalized = {
      schemaVersion: 2 as const,
      instanceId: config.instanceId,
      name: config.name,
      installationId: config.installationId,
      installationIdentity: "path-entry/v1" as const,
      providerId: config.providerId,
      models: [config.model],
      defaultModel: config.model,
      enabled: true,
      permissionMode: "bypass" as const,
      isolationState: "enforced" as const,
      auth: config.auth,
      kindId: config.kindId,
      codex: { reasoningEffort: config.reasoningEffort, baseUrl: config.baseUrl },
    };
    assert.deepEqual(store.create(config), normalized);
    assert.deepEqual(store.list(), [normalized]);
    assert.deepEqual(store.read(config.instanceId), normalized);
    const target = path.join(userRoot, "runtime-instances.json"),
      stateRoot = path.join(userRoot, "runtime-instances", config.instanceId);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    for (const directory of [stateRoot, ...["home", "tmp", "run"].map((name) => path.join(stateRoot, name))])
      assert.equal(statSync(directory).mode & 0o777, 0o700, directory);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), {
      schema: "runtime-instances/v1",
      instances: [normalized],
    });
    assert.deepEqual(store.delete(config.instanceId), normalized);
    assert.equal(store.read(config.instanceId), null);
    assert.equal(existsSync(stateRoot), false);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("runtime installation identity survives an upgrade behind the same PATH entry", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-discovery-")),
    bin = path.join(root, "bin"),
    versions = path.join(root, "versions"),
    entry = path.join(bin, "claude"),
    oldExecutable = path.join(versions, "2.1.237"),
    newExecutable = path.join(versions, "2.1.240");
  try {
    requireDirectory(bin);
    requireDirectory(versions);
    writeProviderExecutable(oldExecutable, 'console.log("2.1.237 (Claude Code)");\n');
    writeProviderExecutable(newExecutable, 'console.log("2.1.240 (Claude Code)");\n');
    symlinkSync(oldExecutable, entry);
    const before = (
      await discoverRuntimeInstallations({ env: { PATH: bin }, now: () => "2026-08-22T00:00:00.000Z" })
    )[0]!;
    rmSync(entry);
    symlinkSync(newExecutable, entry);
    const after = (
      await discoverRuntimeInstallations({ env: { PATH: bin }, now: () => "2026-08-23T00:00:00.000Z" })
    )[0]!;
    assert.deepEqual([before.version, after.version], ["2.1.237 (Claude Code)", "2.1.240 (Claude Code)"]);
    assert.deepEqual(
      [before.executablePath, after.executablePath],
      [realpathSync(oldExecutable), realpathSync(newExecutable)],
    );
    assert.equal(before.executableEntryPath, path.resolve(entry));
    assert.equal(after.executableEntryPath, before.executableEntryPath);
    assert.notEqual(after.executablePath, before.executablePath);
    assert.notEqual(after.version, before.version);
    assert.equal(after.installationId, before.installationId);
    assert.match(after.installationId, /^claude_[0-9a-f]{24}$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime installation discovery projects each provider's detected model catalog", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-model-discovery-")),
    bin = path.join(root, "bin");
  try {
    mkdirSync(bin);
    writeProviderExecutable(
      path.join(bin, "codex"),
      `const args = process.argv.slice(2); if (args[0] === "--version") console.log("codex-test"); else if (args.join(" ") === "debug models --bundled") console.log(JSON.stringify({ models: [{ slug: "gpt-sol" }, { slug: "gpt-terra" }] }));\n`,
    );
    writeProviderExecutable(
      path.join(bin, "agy"),
      `const args = process.argv.slice(2); if (args[0] === "--version") console.log("agy-test"); else if (args[0] === "models") console.log("gemini-high\\tGemini High\\ngemini-low\\tGemini Low");\n`,
    );
    writeProviderExecutable(
      path.join(bin, "claude"),
      `const args = process.argv.slice(2); if (args[0] === "--version") console.log("claude-test"); else if (args[0] === "--help") console.log("aliases 'fable', 'sonnet', and 'opus'");\n`,
    );
    writeProviderExecutable(
      path.join(bin, "zcode"),
      `const args = process.argv.slice(2); if (args[0] === "--version") console.log("zcode-test"); else process.exitCode = 1;\n`,
    );
    const rows = await discoverRuntimeInstallations({ env: { PATH: bin }, now: () => "2026-08-22T00:00:00.000Z" });
    assert.deepEqual(
      rows.map(({ kindId, models, defaultModel }) => ({ kindId, models, defaultModel })),
      [
        { kindId: "agy", models: ["gemini-high", "gemini-low"], defaultModel: "gemini-high" },
        { kindId: "claude", models: ["fable", "sonnet", "opus"], defaultModel: "fable" },
        { kindId: "codex", models: ["gpt-sol", "gpt-terra"], defaultModel: "gpt-sol" },
        // modelProbe: null means catalog unavailable, not a successfully probed empty catalog.
        { kindId: "zcode", models: undefined, defaultModel: undefined },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime installation probes are asynchronous and parallel across providers", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-async-discovery-")),
    bin = path.join(root, "bin");
  try {
    mkdirSync(bin);
    for (const kindId of ["codex", "claude", "agy"] as const)
      writeProviderExecutable(
        path.join(bin, kindId),
        `const args = process.argv.slice(2); setTimeout(() => { if (args[0] === "--version") console.log("${kindId}-async"); else if ("${kindId}" === "codex") console.log(JSON.stringify({ models: [{ slug: "gpt-async" }] })); else if ("${kindId}" === "agy") console.log("gemini-async\\tGemini Async"); else console.log("aliases 'fable'"); }, 100);\n`,
      );
    let heartbeats = 0;
    const heartbeat = setInterval(() => {
        heartbeats += 1;
      }, 5),
      startedAt = Date.now();
    try {
      const rows = await discoverRuntimeInstallations({ env: { PATH: bin } });
      assert.deepEqual(
        rows.map(({ kindId }) => kindId),
        ["agy", "claude", "codex"],
      );
    } finally {
      clearInterval(heartbeat);
    }
    const durationMs = Date.now() - startedAt;
    context.diagnostic(`runtime-discovery-duration-ms=${durationMs};heartbeats=${heartbeats}`);
    assert.ok(heartbeats >= 10, `expected event-loop progress during discovery, observed ${heartbeats} heartbeats`);
    assert.ok(durationMs < 1_600, `expected parallel provider probes, discovery took ${durationMs}ms`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex sidecar launch materializes the complete non-secret provider config in isolated CODEX_HOME", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-api-isolation-"));
  try {
    let resolvedReference: string | undefined;
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed],
      env: {
        PATH: "/runtime/tools",
        HOME: "/host/home",
        TMPDIR: "/host/tmp",
        OPENAI_API_KEY: "host-secret",
        ANTHROPIC_AUTH_TOKEN: "host-token",
        HTTPS_PROXY: "http://host-proxy",
      },
      resolveCredential: (reference) => {
        resolvedReference = reference;
        return "instance-secret";
      },
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-api",
      name: "Codex API",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "codex_local_access",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: {
        reasoningEffort: "xhigh",
        baseUrl: "http://127.0.0.1:1/v1",
        wireApi: "responses",
        requiresOpenAiAuth: true,
        httpHeaders: { "X-Harness-Probe": "present", "X-Static-Route": "sidecar" },
      },
      auth: { mode: "api-key", credentialRef: "keychain:harness/codex-api" },
    });
    const stateRoot = path.join(userRoot, "runtime-instances", "codex-api");
    chmodSync(path.join(userRoot, "runtime-instances.json"), 0o644);
    for (const directory of [stateRoot, ...["home", "tmp", "run"].map((name) => path.join(stateRoot, name))])
      chmodSync(directory, 0o755);
    const launch = await store.prepareLaunch("codex-api", { cwd: "/workspace/repo", prompt: "Inspect" });
    assert.equal(resolvedReference, "keychain:harness/codex-api");
    assert.deepEqual(launch.installation, observed);
    assert.equal(launch.executablePath, observed.executablePath);
    assert.deepEqual(launch.args, ["exec", "--json", "--sandbox", "danger-full-access", "--model", "gpt-5.6-sol", "-"]);
    assert.deepEqual(launch.env, {
      PATH: "/runtime/tools",
      HOME: path.join(stateRoot, "home"),
      TMPDIR: path.join(stateRoot, "tmp"),
      XDG_RUNTIME_DIR: path.join(stateRoot, "run"),
      CODEX_HOME: path.join(stateRoot, "home", ".codex"),
    });
    const codexConfig = path.join(launch.env.CODEX_HOME!, "config.toml"),
      text = readFileSync(codexConfig, "utf8");
    assert.equal(statSync(codexConfig).mode & 0o777, 0o600);
    assert.equal(
      text,
      `model_provider = "codex_local_access"\nmodel_reasoning_effort = "xhigh"\n\n[model_providers."codex_local_access"]\nname = "codex_local_access"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = true\nhttp_headers = { "X-Harness-Probe" = "present", "X-Static-Route" = "sidecar" }\nexperimental_bearer_token = "instance-secret"\n`,
    );
    assert.match(text, /experimental_bearer_token = "instance-secret"/u);
    assert.doesNotMatch(JSON.stringify(launch), /instance-secret/u);
    assert.equal(Object.values(launch.env).includes("host-secret"), false);
    assert.equal(Object.values(launch.env).includes("host-token"), false);
    assert.equal(Object.values(launch.env).includes("http://host-proxy"), false);
    assert.equal(launch.prompt, "Inspect");
    assert.equal(launch.cwd, "/workspace/repo");
    assert.equal(statSync(path.join(userRoot, "runtime-instances.json")).mode & 0o777, 0o600);
    for (const directory of [stateRoot, ...["home", "tmp", "run"].map((name) => path.join(stateRoot, name))])
      assert.equal(statSync(directory).mode & 0o777, 0o700, directory);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("same-instance API-key launches keep the previous bearer during the next credential lookup", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-api-key-fanout-"));
  let credentialLookups = 0;
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed],
      resolveCredential: async () => {
        credentialLookups += 1;
        if (credentialLookups === 2) await new Promise((resolve) => setTimeout(resolve, 50));
        return credentialLookups === 1 ? "instance-secret" : "worker-secret";
      },
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-api-fanout",
      name: "Codex API Fanout",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "codex_local_access",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: { baseUrl: "https://example.invalid/v1" },
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-api-fanout" },
    });
    const configPath = path.join(userRoot, "runtime-instances", "codex-api-fanout", "home", ".codex", "config.toml");
    assert.equal(existsSync(configPath), true);
    assert.doesNotMatch(readFileSync(configPath, "utf8"), /experimental_bearer_token\s*=/u);

    await store.prepareLaunch("codex-api-fanout", {
      cwd: "/workspace/repo",
      prompt: "leader",
    });
    const workerLaunch = store.prepareLaunch("codex-api-fanout", {
      cwd: "/workspace/repo",
      prompt: "worker",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.match(readFileSync(configPath, "utf8"), /experimental_bearer_token = "instance-secret"/u);
    await workerLaunch;
    assert.match(readFileSync(configPath, "utf8"), /experimental_bearer_token = "instance-secret"/u);
    assert.doesNotMatch(readFileSync(configPath, "utf8"), /experimental_bearer_token = "worker-secret"/u);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("runtime kinds receive prompt-injected skills without native discovery mounts", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-skill-prompt-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    installations = (["codex", "claude", "agy"] as const).map((kindId) => ({
      installationId: `${kindId}-skills`,
      kindId,
      executablePath: `/opt/runtime-test/${kindId}`,
      version: "1.0.0",
      observedAt: "2026-08-20T00:00:00.000Z",
    }));
  try {
    const prompt = `Use probe\n\n# Required Skills\n\nRead and follow every selected skill before doing the mission:\n\n- probe: ${path.join(parent, "shared", "probe", "SKILL.md")}`;
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => installations,
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    for (const installation of installations)
      store.create({
        schemaVersion: 2,
        instanceId: `${installation.kindId}-skills`,
        name: `${installation.kindId} skills`,
        kindId: installation.kindId,
        installationId: installation.installationId,
        providerId: installation.kindId,
        models: ["skill-model"],
        defaultModel: "skill-model",
        enabled: true,
        ...(installation.kindId === "codex"
          ? { codex: {} }
          : installation.kindId === "claude"
            ? { claude: {} }
            : { agy: {} }),
        auth: { mode: "subscription" },
      });
    const launches = await Promise.all(
      installations.map(async (installation) => ({
        kindId: installation.kindId,
        launch: await store.prepareLaunch(`${installation.kindId}-skills`, { cwd: rootDir, prompt }),
      })),
    );
    for (const { launch } of launches) {
      assert.equal(launch.prompt, prompt);
      assert.equal(launch.args.includes("--plugin-dir"), false);
      assert.equal(launch.args.includes("--add-dir"), false);
    }
    const codex = launches.find(({ kindId }) => kindId === "codex")!.launch;
    assert.equal(existsSync(path.join(codex.env.CODEX_HOME!, "skills")), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("API-key launch fails closed on a missing key or installation without checking subscription auth", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-api-fail-closed-"));
  try {
    let installationPresent = true,
      subscriptionChecks = 0;
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => (installationPresent ? [observed] : []),
      resolveCredential: () => {
        throw new Error("missing key");
      },
      subscriptionReady: () => {
        subscriptionChecks += 1;
        return { status: "ready", code: null, hint: null };
      },
    });
    store.create({
      schemaVersion: 1,
      instanceId: "codex-closed",
      name: "Codex Closed",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      model: "gpt-5.6-sol",
      auth: { mode: "api-key", credentialRef: "keychain:harness/missing" },
    });
    await assert.rejects(
      store.prepareLaunch("codex-closed", { cwd: "/workspace/repo", prompt: "Inspect" }),
      (error: unknown) => codedAs(error, "runtime_credential_unavailable"),
    );
    assert.equal(subscriptionChecks, 0);
    installationPresent = false;
    await assert.rejects(
      store.prepareLaunch("codex-closed", { cwd: "/workspace/repo", prompt: "Inspect" }),
      (error: unknown) => codedAs(error, "runtime_installation_not_found"),
    );
    assert.equal(subscriptionChecks, 0);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("subscription launch fails closed without provider-native readiness and never falls back to an API key", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-subscription-isolation-")),
    claude: RuntimeInstallationWitness = {
      ...observed,
      installationId: "claude-installation-test",
      kindId: "claude",
      executablePath: "/opt/runtime-test/claude",
    };
  try {
    let ready = false,
      credentialCalls = 0,
      readinessEnvironment: NodeJS.ProcessEnv | undefined;
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [claude],
      env: {
        PATH: "/runtime/tools",
        HOME: "/host/home",
        ANTHROPIC_API_KEY: "host-secret",
        ANTHROPIC_AUTH_TOKEN: "host-oauth",
      },
      resolveCredential: () => {
        credentialCalls += 1;
        return "fallback-secret";
      },
      subscriptionReady: ({ env }) => {
        readinessEnvironment = env;
        return ready
          ? { status: "ready", code: null, hint: null }
          : {
              status: "not-ready",
              code: "runtime_subscription_required",
              hint: "Provider subscription authentication is unavailable in this instance state root.",
            };
      },
    });
    store.create({
      schemaVersion: 2,
      instanceId: "claude-subscription",
      name: "Claude Subscription",
      kindId: "claude",
      installationId: claude.installationId,
      providerId: "anthropic",
      models: ["claude-fable-5"],
      defaultModel: "claude-fable-5",
      enabled: true,
      isolationState: "enforced",
      claude: {},
      auth: { mode: "subscription" },
    });
    await assert.rejects(
      store.prepareLaunch("claude-subscription", { cwd: "/workspace/repo", prompt: "Inspect" }),
      (error: unknown) => codedAs(error, "runtime_subscription_required"),
    );
    assert.equal(credentialCalls, 0);
    ready = true;
    const launch = await store.prepareLaunch("claude-subscription", { cwd: "/workspace/repo", prompt: "Inspect" }),
      stateRoot = path.join(userRoot, "runtime-instances", "claude-subscription");
    assert.deepEqual(launch.args, [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      "claude-fable-5",
    ]);
    assert.deepEqual(launch.env, {
      PATH: "/runtime/tools",
      HOME: path.join(stateRoot, "home"),
      TMPDIR: path.join(stateRoot, "tmp"),
      XDG_RUNTIME_DIR: path.join(stateRoot, "run"),
      CLAUDE_CONFIG_DIR: path.join(stateRoot, "home", ".claude"),
    });
    assert.deepEqual(readinessEnvironment, launch.env);
    assert.equal(credentialCalls, 0);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("subscription probes distinguish a rejected status command from an unspawnable executable", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-subscription-probe-")),
    rejectedPath = path.join(userRoot, "rejected-status.mjs"),
    rejected = {
      ...observed,
      installationId: "codex-rejected-status",
      executablePath: writeProviderExecutable(rejectedPath, "process.exit(7);\n"),
    },
    unspawnable = {
      ...observed,
      installationId: "codex-unspawnable-status",
      executablePath: path.join(userRoot, "missing-status"),
    };
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [rejected, unspawnable] });
    for (const installation of [rejected, unspawnable])
      store.create({
        schemaVersion: 1,
        instanceId: installation.installationId,
        name: installation.installationId,
        kindId: "codex",
        installationId: installation.installationId,
        providerId: "openai",
        model: "gpt-5.6-sol",
        auth: { mode: "subscription" },
      });
    assert.equal((await store.authStatus(rejected.installationId)).code, "runtime_subscription_required");
    assert.equal((await store.authStatus(unspawnable.installationId)).code, "runtime_auth_probe_failed");
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("runtime instance CRUD is a closed defineCliCommand surface", async () => {
  const ids = [
    "runtime-instance-create",
    "runtime-instance-list",
    "runtime-instance-show",
    "runtime-instance-update",
    "runtime-instance-delete",
  ];
  for (const id of ids) {
    const command = daemonProtocolCommands.find((entry) => entry.id === id);
    assert.ok(command, id);
    assert.deepEqual(command.inputs, command.flags, id);
  }
  assert.equal(
    daemonProtocolCommands
      .find((entry) => entry.id === "runtime-instance-update")
      ?.inputs.some(({ name }) => name === "--installation"),
    true,
  );
  const created = parseThinCommand([
    "runtime",
    "instance",
    "create",
    "--id",
    "codex-review",
    "--name",
    "Codex Review",
    "--kind",
    "codex",
    "--installation",
    observed.installationId,
    "--provider",
    "codex_local_access",
    "--model",
    "gpt-5.6-sol",
    "--model",
    "gpt-5.6-terra",
    "--default-model",
    "gpt-5.6-terra",
    "--permission-mode",
    "workspace-write",
    "--effort",
    "xhigh",
    "--base-url",
    "http://127.0.0.1:1/v1",
    "--wire-api",
    "responses",
    "--requires-openai-auth",
    "--http-header",
    "X-Harness-Probe=present",
    "--auth",
    "api-key",
    "--credential-ref",
    "keychain:harness/codex-review",
  ]);
  assert.equal(created.ok, true);
  if (created.ok)
    assert.deepEqual(
      { method: created.command.method, action: created.command.action },
      {
        method: "daemon.runtimeInstance.create",
        action: {
          kind: "runtime-instance-create",
          instanceId: "codex-review",
          name: "Codex Review",
          kindId: "codex",
          installationId: observed.installationId,
          providerId: "codex_local_access",
          models: ["gpt-5.6-sol", "gpt-5.6-terra"],
          defaultModel: "gpt-5.6-terra",
          permissionMode: "workspace-write",
          codex: {
            reasoningEffort: "xhigh",
            baseUrl: "http://127.0.0.1:1/v1",
            wireApi: "responses",
            requiresOpenAiAuth: true,
            httpHeaders: { "X-Harness-Probe": "present" },
          },
          authMode: "api-key",
          credentialRef: "keychain:harness/codex-review",
        },
      },
    );
  const claudeCreated = parseThinCommand([
    "runtime",
    "instance",
    "create",
    "--id",
    "claude-review",
    "--name",
    "Claude Review",
    "--kind",
    "claude",
    "--installation",
    "claude-installation",
    "--provider",
    "anthropic",
    "--model",
    "claude-fable-5",
    "--effort",
    "high",
    "--auth",
    "subscription",
  ]);
  assert.equal(claudeCreated.ok, true);
  if (claudeCreated.ok) assert.deepEqual(claudeCreated.command.action.claude, { effort: "high" });
  for (const [argv, method, instanceId] of [
    ["list", "daemon.runtimeInstance.list", undefined],
    ["show", "daemon.runtimeInstance.show", "codex-review"],
    ["update", "daemon.runtimeInstance.update", "codex-review"],
    ["delete", "daemon.runtimeInstance.delete", "codex-review"],
  ] as const) {
    const parsed = parseThinCommand(["runtime", "instance", argv, ...(instanceId ? [instanceId] : [])]);
    assert.equal(parsed.ok, argv === "update" ? false : true, JSON.stringify(parsed));
    if (parsed.ok)
      assert.deepEqual(
        { method: parsed.command.method, action: parsed.command.action },
        { method, action: { kind: `runtime-instance-${argv}`, ...(instanceId ? { instanceId } : {}) } },
      );
  }
  const update = parseThinCommand([
    "runtime",
    "instance",
    "update",
    "codex-review",
    "--name",
    "Updated",
    "--installation",
    "codex-new",
    "--model",
    "gpt-5.6-sol",
    "--model",
    "gpt-5.6-terra",
    "--default-model",
    "gpt-5.6-terra",
    "--permission-mode",
    "read-only",
    "--disable",
  ]);
  assert.equal(update.ok, true);
  if (update.ok)
    assert.deepEqual(update.command.action, {
      kind: "runtime-instance-update",
      instanceId: "codex-review",
      name: "Updated",
      installationId: "codex-new",
      models: ["gpt-5.6-sol", "gpt-5.6-terra"],
      defaultModel: "gpt-5.6-terra",
      permissionMode: "read-only",
      enabled: false,
    });
  assert.deepEqual(
    validateDaemonRpcCall({
      method: "daemon.runtimeInstance.update",
      params: { payload: { instanceId: "codex-review", installationId: "codex-new" } },
    }),
    [],
  );
  const run = parseThinCommand([
    "runtime",
    "run",
    "codex-review",
    "--model",
    "gpt-5.6-terra",
    "--effort",
    "xhigh",
    "--permission-mode",
    "workspace-write",
    "--prompt",
    "Inspect",
  ]);
  assert.equal(run.ok, true);
  if (run.ok) {
    assert.equal(run.command.action.model, "gpt-5.6-terra");
    assert.equal(run.command.action.effort, "xhigh");
    assert.equal(run.command.action.permissionMode, "workspace-write");
  }
  assert.deepEqual(parseThinCommand(["runtime", "run", "codex-review", "--effort", "turbo", "--prompt", "Inspect"]), {
    ok: false,
    code: "invalid_runtime_effort",
    nextAction:
      "Use minimal, low, medium, high, xhigh, or max with Claude or Codex; agy supports low, medium, or high.",
    json: false,
  });
  const probed = parseThinCommand(["runtime", "instance", "show", "codex-review", "--probe"]);
  assert.equal(probed.ok, true);
  if (probed.ok)
    assert.deepEqual(
      { method: probed.command.method, action: probed.command.action },
      {
        method: "daemon.runtimeInstance.show",
        action: { kind: "runtime-instance-show", instanceId: "codex-review", probe: true },
      },
    );
  assert.deepEqual(
    parseThinCommand([
      "runtime",
      "instance",
      "create",
      "--id",
      "bad",
      "--name",
      "Bad",
      "--kind",
      "codex",
      "--installation",
      observed.installationId,
      "--provider",
      "openai",
      "--model",
      "gpt",
      "--auth",
      "api-key",
    ]),
    {
      ok: false,
      code: "missing_field",
      nextAction: "API-key instances require --credential-ref <opaque-ref>.",
      json: false,
    },
  );
  assert.deepEqual(
    parseThinCommand([
      "runtime",
      "instance",
      "create",
      "--id",
      "bad",
      "--name",
      "Bad",
      "--kind",
      "codex",
      "--installation",
      observed.installationId,
      "--provider",
      "openai",
      "--model",
      "gpt",
      "--auth",
      "subscription",
      "--credential-ref",
      "keychain:harness/bad",
    ]),
    {
      ok: false,
      code: "invalid_field",
      nextAction: "Subscription instances cannot accept a credential reference.",
      json: false,
    },
  );
  assert.deepEqual(
    parseThinCommand([
      "runtime",
      "instance",
      "create",
      "--id",
      "bad",
      "--name",
      "Bad",
      "--kind",
      "claude",
      "--installation",
      observed.installationId,
      "--provider",
      "anthropic",
      "--model",
      "claude",
      "--wire-api",
      "responses",
      "--auth",
      "subscription",
    ]),
    {
      ok: false,
      code: "invalid_field",
      nextAction: "This runtime kind does not accept options for another adapter.",
      json: false,
    },
  );
  for (const flag of ["--env", "--argv", "--isolation-profile"]) {
    const parsed = parseThinCommand([
      "runtime",
      "instance",
      "create",
      "--id",
      "bad",
      "--name",
      "Bad",
      "--kind",
      "codex",
      "--installation",
      observed.installationId,
      "--provider",
      "openai",
      "--model",
      "gpt",
      "--auth",
      "subscription",
      flag,
      "open",
    ]);
    assert.equal(parsed.ok ? "ok" : parsed.code, "unknown_field", flag);
  }
});

test("runtime instance command receipts expose readiness metadata without credential refs or host paths", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-command-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] });
    const created = store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-safe",
      name: "Codex Safe",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "api-key",
      credentialRef: "keychain:harness/codex-safe",
    });
    assert.deepEqual(created.instance, {
      schemaVersion: 2,
      instanceId: "codex-safe",
      name: "Codex Safe",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      permissionMode: "bypass",
      configuration: {
        reasoningEffort: null,
        fast: false,
        baseUrl: null,
        baseUrlConfigured: false,
        wire_api: null,
        requires_openai_auth: null,
        http_headers: null,
      },
      authMode: "api-key",
      authState: "configured",
      authReadiness: {
        status: "not-ready",
        code: "runtime_auth_not_checked",
        hint: "Authentication has not been verified in this daemon generation.",
      },
      isolationState: "enforced",
    });
    const listed = store.command({ kind: "runtime-instance-list" }),
      shown = store.command({ kind: "runtime-instance-show", instanceId: "codex-safe" });
    assert.deepEqual(listed.installations, [
      {
        installationId: observed.installationId,
        kindId: "codex",
        version: observed.version,
        observedAt: observed.observedAt,
      },
    ]);
    assert.equal(
      listed.summary,
      `ID\tNAME\tKIND\tMODEL\tENABLED\tAUTH MODE\tLOGIN STATUS\ncodex-safe\tCodex Safe\tcodex\tgpt-5.6-sol\tenabled\tapi-key\tnot-checked\n\nINSTALLATION\tKIND\tVERSION\tOBSERVED AT\n${observed.installationId}\tcodex\t${observed.version}\t${observed.observedAt}`,
    );
    assert.deepEqual(shown.instance, created.instance);
    for (const receipt of [created, listed, shown]) {
      assert.doesNotMatch(
        JSON.stringify(receipt),
        /credentialRef|keychain:|instance-secret|executablePath|\/opt\/runtime-test/u,
      );
      assert.equal(receipt.schema, "command-receipt/v2");
      assert.equal(receipt.ok, true);
    }
    assert.equal(
      store.command({ kind: "runtime-instance-delete", instanceId: "codex-safe" }).deletedInstanceId,
      "codex-safe",
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("runtime catalog reads and auth probes reuse one installation discovery snapshot per command", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-discovery-snapshot-"));
  let discoveries = 0;
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => {
        discoveries += 1;
        return [observed];
      },
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-discovery-snapshot",
      name: "Codex discovery snapshot",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription",
    });

    discoveries = 0;
    store.command({ kind: "runtime-instance-list", all: true });
    assert.equal(discoveries, 1);

    discoveries = 0;
    const probed = await store.command({ kind: "runtime-instance-list", probe: true });
    assert.equal(discoveries, 1);
    assert.equal(probed.instances[0]?.authReadiness.status, "ready");

    discoveries = 0;
    await store.command({ kind: "runtime-instance-show", instanceId: "codex-discovery-snapshot", probe: true });
    assert.equal(discoveries, 1);

    discoveries = 0;
    store.command({ kind: "runtime-instance-update", instanceId: "codex-discovery-snapshot", enabled: false });
    assert.equal(discoveries, 0);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("runtime instance create filters auto-resolution by kind and rejects same-kind ambiguity", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-installation-resolution-")),
    ambiguousRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-installation-ambiguous-")),
    claude = {
      ...observed,
      installationId: "claude-first",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude",
      version: "claude 1.0.0",
    },
    codex = { ...observed, installationId: "codex-first", version: "codex 1.0.0" },
    secondClaude = { ...claude, installationId: "claude-second", version: "claude 2.0.0" };
  try {
    const automatic = openRuntimeInstanceStore({ userRoot, discover: () => [claude, codex] }),
      created = automatic.command({
        kind: "runtime-instance-create",
        instanceId: "claude-auto",
        name: "Claude Auto",
        kindId: "claude",
        providerId: "anthropic",
        models: ["claude-fable-5"],
        authMode: "subscription",
      });
    assert.equal((created.instance as Record<string, unknown>).installationId, claude.installationId);
    const ambiguous = openRuntimeInstanceStore({
      userRoot: ambiguousRoot,
      discover: () => [claude, codex, secondClaude],
    });
    assert.throws(
      () =>
        ambiguous.command({
          kind: "runtime-instance-create",
          instanceId: "claude-ambiguous",
          name: "Claude Ambiguous",
          kindId: "claude",
          providerId: "anthropic",
          models: ["claude-fable-5"],
          authMode: "subscription",
        }),
      (error: unknown) =>
        codedAs(error, "runtime_installation_ambiguous") &&
        error instanceof Error &&
        error.message.includes(claude.installationId) &&
        error.message.includes(secondClaude.installationId),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
    rmSync(ambiguousRoot, { recursive: true, force: true });
  }
});

test("runtime instance command adapter rejects ambiguous or unknown auth modes", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-auth-command-")),
    store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] }),
    base = {
      kind: "runtime-instance-create",
      instanceId: "codex-auth",
      name: "Codex Auth",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
    };
  try {
    assert.throws(
      () => store.command({ ...base, authMode: "oauth", credentialRef: "keychain:harness/codex-auth" }),
      (error: unknown) => codedAs(error, "invalid_runtime_auth"),
    );
    assert.throws(
      () => store.command({ ...base, authMode: "subscription", credentialRef: "keychain:harness/codex-auth" }),
      (error: unknown) => codedAs(error, "invalid_runtime_auth"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("public instance projections expose one generic provider configuration", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-public-projection-")),
    claude = {
      ...observed,
      installationId: "claude-projection",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude",
    },
    store = openRuntimeInstanceStore({ userRoot, discover: () => [observed, claude] });
  try {
    store.create({
      schemaVersion: 2,
      instanceId: "codex-projection",
      name: "Codex Projection",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "sidecar",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: {
        reasoningEffort: "high",
        baseUrl: "http://127.0.0.1:1/v1",
        wireApi: "responses",
        requiresOpenAiAuth: true,
        httpHeaders: { "X-Probe": "present" },
      },
      auth: { mode: "subscription" },
    });
    store.create({
      schemaVersion: 2,
      instanceId: "claude-projection",
      name: "Claude Projection",
      kindId: "claude",
      installationId: claude.installationId,
      providerId: "anthropic",
      models: ["claude"],
      defaultModel: "claude",
      enabled: true,
      claude: { effort: "medium", baseUrl: "https://gateway.example.test/v1" },
      auth: { mode: "subscription" },
    });
    const codex = store.command({ kind: "runtime-instance-show", instanceId: "codex-projection" }).instance as Record<
        string,
        unknown
      >,
      claudeDto = store.command({ kind: "runtime-instance-show", instanceId: "claude-projection" }).instance as Record<
        string,
        unknown
      >,
      listed = store.command({ kind: "runtime-instance-list" }).instances as Array<Record<string, unknown>>;
    assert.deepEqual(codex.configuration, {
      reasoningEffort: "high",
      fast: false,
      baseUrl: "http://127.0.0.1:1/v1",
      baseUrlConfigured: true,
      wire_api: "responses",
      requires_openai_auth: true,
      http_headers: { "X-Probe": "present" },
    });
    assert.equal("reasoningEffort" in codex, false);
    assert.equal("baseUrl" in codex, false);
    assert.deepEqual(claudeDto.configuration, {
      effort: "medium",
      baseUrl: "https://gateway.example.test/v1",
      baseUrlConfigured: true,
    });
    assert.equal(
      listed.every((item) => "configuration" in item),
      true,
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("kind-specific runtime config fails closed across adapters and rejects secret-like persisted headers", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-kind-config-")),
    claude = {
      ...observed,
      installationId: "claude-installation-test",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude",
    },
    store = openRuntimeInstanceStore({ userRoot, discover: () => [observed, claude] });
  try {
    const common = {
      schemaVersion: 2 as const,
      instanceId: "claude-closed",
      name: "Claude Closed",
      kindId: "claude" as const,
      installationId: claude.installationId,
      providerId: "anthropic",
      models: ["claude-fable-5"],
      defaultModel: "claude-fable-5",
      enabled: true,
      auth: { mode: "subscription" as const },
    };
    assert.throws(
      () => store.create({ ...common, claude: {}, codex: { wireApi: "responses" } } as never),
      (error: unknown) =>
        codedAs(error, "invalid_runtime_kind_config") &&
        error.message.includes("claude runtime instance cannot include codex"),
    );
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-create",
          instanceId: "claude-command",
          name: "Claude Command",
          kindId: "claude",
          installationId: claude.installationId,
          providerId: "anthropic",
          models: ["claude-fable-5"],
          claude: {},
          codex: { wireApi: "responses" },
          authMode: "subscription",
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_kind_config"),
    );
    assert.throws(
      () =>
        store.create({
          schemaVersion: 2,
          instanceId: "codex-secret-header",
          name: "Codex Secret Header",
          kindId: "codex",
          installationId: observed.installationId,
          providerId: "sidecar",
          models: ["gpt-5.6-sol"],
          defaultModel: "gpt-5.6-sol",
          enabled: true,
          codex: { baseUrl: "http://127.0.0.1:1/v1", httpHeaders: { Authorization: "Bearer forbidden" } },
          auth: { mode: "subscription" },
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_http_headers"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("runtime instance update changes metadata and models without touching credentials or state root", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-update-")),
    replacement = {
      ...observed,
      installationId: "codex-installation-replacement",
      executablePath: "/opt/runtime-test/codex-replacement",
      version: "0.147.0",
    },
    wrongKind = {
      ...observed,
      installationId: "claude-installation-replacement",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude-replacement",
      version: "2.1.240",
    };
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed, replacement, wrongKind],
      resolveCredential: () => "instance-secret",
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-update",
      name: "Before",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-update" },
    });
    const stateRoot = path.join(userRoot, "runtime-instances", "codex-update"),
      stateMarker = path.join(stateRoot, "state-marker"),
      auth = store.read("codex-update")!.auth;
    writeFileSync(stateMarker, "preserved");
    const updated = store.command({
      kind: "runtime-instance-update",
      instanceId: "codex-update",
      name: "After",
      installationId: replacement.installationId,
      models: ["gpt-5.6-sol", "gpt-5.6-terra"],
      defaultModel: "gpt-5.6-terra",
      enabled: false,
    });
    assert.equal((updated.instance as { readonly name: string }).name, "After");
    assert.deepEqual((updated.instance as { readonly models: readonly string[] }).models, [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    assert.equal((updated.instance as { readonly defaultModel: string }).defaultModel, "gpt-5.6-terra");
    assert.equal((updated.instance as { readonly enabled: boolean }).enabled, false);
    assert.equal(store.read("codex-update")!.installationId, replacement.installationId);
    assert.equal(store.read("codex-update")!.installationIdentity, "path-entry/v1");
    assert.deepEqual(store.read("codex-update")!.auth, auth);
    assert.equal(readFileSync(stateMarker, "utf8"), "preserved");
    assert.deepEqual(store.command({ kind: "runtime-instance-list" }).instances, []);
    assert.equal(
      (
        store.command({ kind: "runtime-instance-list", all: true }).instances as Array<{ readonly enabled: boolean }>
      )[0]!.enabled,
      false,
    );
    await assert.rejects(
      store.prepareLaunch("codex-update", { cwd: "/workspace/repo", prompt: "Inspect", model: "gpt-5.6-sol" }),
      (error: unknown) => codedAs(error, "runtime_instance_disabled"),
    );
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-update",
          instanceId: "codex-update",
          models: ["gpt-5.6-sol"],
          defaultModel: "gpt-5.6-terra",
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_model"),
    );
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-update",
          instanceId: "codex-update",
          installationId: wrongKind.installationId,
        }),
      (error: unknown) => codedAs(error, "runtime_installation_not_found"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("legacy runtime instance records migrate once to schema v2 on read", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-migration-"));
  try {
    writeFileSync(
      path.join(userRoot, "runtime-instances.json"),
      `${JSON.stringify({ schema: "runtime-instances/v1", instances: [{ schemaVersion: 1, instanceId: "codex-legacy", name: "Legacy", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "subscription" } }] })}\n`,
    );
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] });
    assert.deepEqual(store.read("codex-legacy"), {
      schemaVersion: 2,
      instanceId: "codex-legacy",
      name: "Legacy",
      installationId: observed.installationId,
      installationIdentity: "path-entry/v1",
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      permissionMode: "bypass",
      isolationState: "enforced",
      auth: { mode: "subscription" },
      kindId: "codex",
      codex: {},
    });
    assert.equal(
      JSON.parse(readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8")).instances[0].schemaVersion,
      2,
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("one same-kind witness automatically migrates a legacy installation binding once without moving instance state", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-installation-migration-")),
    target = path.join(userRoot, "runtime-instances.json"),
    stateRoot = path.join(userRoot, "runtime-instances", "claude-upgrade"),
    stateMarker = path.join(stateRoot, "state-marker"),
    current = {
      installationId: "claude_stable_entry",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/versions/2.1.240",
      version: "2.1.240 (Claude Code)",
      observedAt: "2026-08-23T00:00:00.000Z",
    };
  try {
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(stateMarker, "preserved");
    writeFileSync(
      target,
      `${JSON.stringify({ schema: "runtime-instances/v1", instances: [{ schemaVersion: 2, instanceId: "claude-upgrade", name: "Claude Upgrade", kindId: "claude", installationId: "claude_version_2_1_237", providerId: "anthropic", models: ["sonnet"], defaultModel: "sonnet", enabled: true, permissionMode: "bypass", isolationState: "operator-environment", claude: {}, auth: { mode: "subscription" } }] })}\n`,
    );
    const store = openRuntimeInstanceStore({
        userRoot,
        discover: () => [current],
        subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
      }),
      migrated = store.read("claude-upgrade")!;
    assert.equal(migrated.installationId, current.installationId);
    assert.equal(migrated.installationIdentity, "path-entry/v1");
    assert.deepEqual(migrated.auth, { mode: "subscription" });
    assert.equal(readFileSync(stateMarker, "utf8"), "preserved");
    assert.equal(
      (await store.prepareLaunch("claude-upgrade", { cwd: "/workspace/repo", prompt: "Continue" })).installation
        .installationId,
      current.installationId,
    );
    const firstMtime = statSync(target).mtimeMs,
      firstContents = readFileSync(target, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 20));
    store.read("claude-upgrade");
    assert.equal(readFileSync(target, "utf8"), firstContents);
    assert.equal(statSync(target).mtimeMs, firstMtime);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("legacy installation migration refuses zero or multiple same-kind witnesses and gives executable repair commands", async () => {
  const candidates = [
    {
      installationId: "claude_candidate_one",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude-one",
      version: "2.1.240",
      observedAt: "2026-08-23T00:00:00.000Z",
    },
    {
      installationId: "claude_candidate_two",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude-two",
      version: "2.1.240",
      observedAt: "2026-08-23T00:00:00.000Z",
    },
  ];
  for (const [name, witnessed] of [
    ["zero", []],
    ["multiple", candidates],
  ] as const) {
    const userRoot = mkdtempSync(path.join(tmpdir(), `ha-runtime-installation-${name}-`)),
      target = path.join(userRoot, "runtime-instances.json");
    try {
      writeFileSync(
        target,
        `${JSON.stringify({ schema: "runtime-instances/v1", instances: [{ schemaVersion: 2, instanceId: `claude-${name}`, name: `Claude ${name}`, kindId: "claude", installationId: "claude_old_version", providerId: "anthropic", models: ["sonnet"], defaultModel: "sonnet", enabled: true, permissionMode: "bypass", isolationState: "operator-environment", claude: {}, auth: { mode: "subscription" } }] })}\n`,
      );
      const store = openRuntimeInstanceStore({
          userRoot,
          discover: () => witnessed,
          subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
        }),
        config = store.read(`claude-${name}`)!;
      assert.equal(config.installationId, "claude_old_version");
      assert.equal(config.installationIdentity, undefined);
      const readiness = await store.authStatus(`claude-${name}`);
      assert.equal(readiness.code, "runtime_installation_not_found");
      await assert.rejects(
        store.prepareLaunch(`claude-${name}`, { cwd: "/workspace/repo", prompt: "Continue" }),
        (error: unknown) =>
          codedAs(error, "runtime_installation_not_found") &&
          error instanceof Error &&
          error.message === readiness.hint,
      );
      if (name === "zero")
        assert.match(
          readiness.hint!,
          /ha runtime instance list.*ha runtime instance update claude-zero --installation <installation-id>/u,
        );
      else {
        for (const candidate of candidates) {
          assert.match(readiness.hint!, new RegExp(`${candidate.installationId} \\(${candidate.version}\\)`, "u"));
          assert.ok(
            readiness.hint!.includes(
              `ha runtime instance update claude-multiple --installation ${candidate.installationId}`,
            ),
          );
        }
        store.command({
          kind: "runtime-instance-update",
          instanceId: "claude-multiple",
          installationId: candidates[0]!.installationId,
        });
        assert.equal(store.read("claude-multiple")!.installationIdentity, "path-entry/v1");
        assert.equal(
          (await store.prepareLaunch("claude-multiple", { cwd: "/workspace/repo", prompt: "Continue" })).installation
            .installationId,
          candidates[0]!.installationId,
        );
      }
    } finally {
      rmSync(userRoot, { recursive: true, force: true });
    }
  }
});

test("flat schema v2 runtime config normalizes into its kind section on read", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-v2-migration-"));
  try {
    writeFileSync(
      path.join(userRoot, "runtime-instances.json"),
      `${JSON.stringify({ schema: "runtime-instances/v1", instances: [{ schemaVersion: 2, instanceId: "codex-flat", name: "Flat", kindId: "codex", installationId: observed.installationId, providerId: "sidecar", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, reasoningEffort: "high", baseUrl: "http://127.0.0.1:1/v1", auth: { mode: "subscription" } }] })}\n`,
    );
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] }),
      config = store.read("codex-flat");
    assert.deepEqual(config?.codex, { reasoningEffort: "high", baseUrl: "http://127.0.0.1:1/v1" });
    const persisted = JSON.parse(readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8")).instances[0];
    assert.deepEqual(persisted.codex, config?.codex);
    assert.equal("reasoningEffort" in persisted, false);
    assert.equal("baseUrl" in persisted, false);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("flat Claude effort from schema v2 migrates into Claude configuration", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-claude-v2-migration-")),
    claude = {
      ...observed,
      installationId: "claude-installation-test",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude",
    };
  try {
    writeFileSync(
      path.join(userRoot, "runtime-instances.json"),
      `${JSON.stringify({ schema: "runtime-instances/v1", instances: [{ schemaVersion: 2, instanceId: "claude-flat", name: "Claude Flat", kindId: "claude", installationId: claude.installationId, providerId: "anthropic", models: ["claude-fable-5"], defaultModel: "claude-fable-5", enabled: true, reasoningEffort: "high", baseUrl: "https://gateway.example.test/v1", auth: { mode: "subscription" } }] })}\n`,
    );
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [claude] });
    assert.deepEqual(store.read("claude-flat")?.claude, { effort: "high", baseUrl: "https://gateway.example.test/v1" });
    const persisted = JSON.parse(readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8")).instances[0];
    assert.deepEqual(persisted.claude, { effort: "high", baseUrl: "https://gateway.example.test/v1" });
    assert.equal("reasoningEffort" in persisted, false);
    assert.equal("codex" in persisted, false);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("one enabled instance dispatches two supported models without reauth", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-model-choice-"));
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed],
      resolveCredential: () => "instance-secret",
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-models",
      name: "Models",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol", "gpt-5.6-terra"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-models" },
    });
    const first = await store.prepareLaunch("codex-models", {
        cwd: "/workspace/repo",
        prompt: "First",
        model: "gpt-5.6-sol",
      }),
      second = await store.prepareLaunch("codex-models", {
        cwd: "/workspace/repo",
        prompt: "Second",
        model: "gpt-5.6-terra",
      });
    assert.equal(first.args[first.args.indexOf("--model") + 1], "gpt-5.6-sol");
    assert.equal(second.args[second.args.indexOf("--model") + 1], "gpt-5.6-terra");
    assert.deepEqual(first.definition.model, "gpt-5.6-sol");
    assert.deepEqual(second.definition.model, "gpt-5.6-terra");
    await assert.rejects(
      store.prepareLaunch("codex-models", { cwd: "/workspace/repo", prompt: "Rejected", model: "gpt-unknown" }),
      (error: unknown) =>
        codedAs(error, "invalid_runtime_model") && error.message.includes("gpt-5.6-sol, gpt-5.6-terra"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("Codex effort is a per-launch override and never mutates the instance", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-effort-"));
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed],
      resolveCredential: () => "instance-secret",
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-effort",
      name: "Effort",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: { reasoningEffort: "medium" },
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-effort" },
    });
    const low = await store.prepareLaunch("codex-effort", { cwd: "/workspace/repo", prompt: "Low", effort: "low" }),
      xhigh = await store.prepareLaunch("codex-effort", { cwd: "/workspace/repo", prompt: "Hard", effort: "xhigh" });
    assert.notEqual(low.args.join("\0"), xhigh.args.join("\0"));
    assert.match(low.args.join(" "), /model_reasoning_effort="low"/u);
    assert.match(xhigh.args.join(" "), /model_reasoning_effort="xhigh"/u);
    assert.equal(store.read("codex-effort")?.kindId, "codex");
    assert.equal(store.read("codex-effort")?.codex.reasoningEffort, "medium");
    await assert.rejects(
      store.prepareLaunch("codex-effort", { cwd: "/workspace/repo", prompt: "Bad", effort: "turbo" }),
      (error: unknown) =>
        codedAs(error, "invalid_runtime_effort") && error instanceof Error && error.message.includes("turbo"),
    );
    await assert.rejects(
      store.prepareLaunch("codex-effort", { cwd: "/workspace/repo", prompt: "Bad", effort: "" }),
      (error: unknown) => codedAs(error, "invalid_runtime_effort"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("Codex fast reaches its CLI, per-run false overrides its default, and unsupported kinds reject", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-fast-")),
    agy = {
      installationId: "agy-fast-installation",
      kindId: "agy" as const,
      executablePath: "/opt/runtime-test/agy",
      version: "1.1.22",
      observedAt: "2026-08-29T00:00:00.000Z",
    };
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed, agy],
      resolveCredential: () => "instance-secret",
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-fast",
      name: "Fast",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: { fast: true },
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-fast" },
    });
    const configured = await store.prepareLaunch("codex-fast", { cwd: "/workspace/repo", prompt: "Configured" }),
      overridden = await store.prepareLaunch("codex-fast", { cwd: "/workspace/repo", prompt: "Override", fast: false });
    assert.deepEqual(
      configured.args.slice(configured.args.indexOf("--config"), configured.args.indexOf("--config") + 2),
      ["--config", 'service_tier="fast"'],
    );
    assert.equal(overridden.args.includes('service_tier="fast"'), false);
    assert.equal(configured.definition.fast, true);
    assert.equal(overridden.definition.fast, false);
    assert.equal(store.read("codex-fast")?.kindId === "codex" && store.read("codex-fast")?.codex.fast, true);
    const created = parseThinCommand([
        "runtime",
        "instance",
        "create",
        "--id",
        "codex-fast",
        "--name",
        "Fast",
        "--kind",
        "codex",
        "--installation",
        observed.installationId,
        "--provider",
        "openai",
        "--model",
        "gpt-5.6-sol",
        "--fast",
        "--auth",
        "subscription",
      ]),
      updated = parseThinCommand(["runtime", "instance", "update", "codex-fast", "--fast"]),
      run = parseThinCommand(["runtime", "run", "codex-fast", "--fast", "--prompt", "Inspect"]);
    assert.equal(created.ok && (created.command.action.codex as { fast?: boolean }).fast, true);
    assert.equal(updated.ok && updated.command.action.fast, true);
    assert.equal(run.ok && run.command.action.fast, true);
    assert.deepEqual(
      parseThinCommand([
        "runtime",
        "instance",
        "create",
        "--id",
        "agy-fast",
        "--name",
        "AGY Fast",
        "--kind",
        "agy",
        "--installation",
        agy.installationId,
        "--provider",
        "google",
        "--model",
        "gemini",
        "--fast",
        "--auth",
        "subscription",
      ]),
      {
        ok: false,
        code: "invalid_runtime_fast",
        nextAction: "Fast mode is not supported by agy runtime instances.",
        json: false,
      },
    );
    store.command({
      kind: "runtime-instance-create",
      instanceId: "agy-fast",
      name: "AGY Fast",
      kindId: "agy",
      installationId: agy.installationId,
      providerId: "google",
      models: ["gemini-3.1-pro-low"],
      authMode: "subscription",
    });
    await assert.rejects(
      store.prepareLaunch("agy-fast", { cwd: "/workspace/repo", prompt: "Reject", fast: true }),
      (error: unknown) => codedAs(error, "invalid_runtime_fast"),
    );
    assert.throws(
      () => store.command({ kind: "runtime-instance-update", instanceId: "agy-fast", fast: true }),
      (error: unknown) => codedAs(error, "invalid_runtime_fast"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

function requireDirectory(directory: string): void {
  mkdirSync(directory);
}
function codedAs(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
