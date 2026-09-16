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
import { discoverRuntimeModelCatalog, observeRuntimeModels } from "../src/agent-runtime-installation-discovery.ts";
import { codedAs, observed } from "./agent-runtime-instance-environment.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

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

test("runtime installation identity survives an upgrade behind the same PATH entry", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-discovery-")),
    bin = path.join(root, "bin"),
    versions = path.join(root, "versions"),
    entry = path.join(bin, process.platform === "win32" ? "claude.cmd" : "claude"),
    oldScript = path.join(versions, "2.1.237.mjs"),
    newScript = path.join(versions, "2.1.240.mjs");
  try {
    requireDirectory(bin);
    requireDirectory(versions);
    const oldExecutable = writeProviderExecutable(oldScript, 'console.log("2.1.237 (Claude Code)");\n'),
      newExecutable = writeProviderExecutable(newScript, 'console.log("2.1.240 (Claude Code)");\n');
    symlinkSync(oldExecutable, entry, process.platform === "win32" ? "file" : undefined);
    const before = (
      await discoverRuntimeInstallations({ env: { PATH: bin }, now: () => "2026-08-22T00:00:00.000Z" })
    )[0]!;
    rmSync(entry);
    symlinkSync(newExecutable, entry, process.platform === "win32" ? "file" : undefined);
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
    writeProviderExecutable(
      path.join(bin, "devin"),
      // Shape reconstructed from the verified devin 3000.10.27 observation
      // (F-069741D0): {families:[{slug,aliases,variants:[{model_uid}]}]}.
      `const args = process.argv.slice(2); if (args[0] === "--version") console.log("devin-test"); else if (args.join(" ") === "models list --format json") console.log(JSON.stringify({ families: [{ slug: "swe-2", aliases: ["swe2"], variants: [{ model_uid: "swe-2-medium" }] }, { slug: "claude-opus-5", aliases: [], variants: [{ model_uid: "claude-opus-5-high" }] }] }));\n`,
    );
    const rows = await discoverRuntimeInstallations({ env: { PATH: bin }, now: () => "2026-08-22T00:00:00.000Z" });
    assert.deepEqual(
      rows.map(({ kindId, models, defaultModel }) => ({ kindId, models, defaultModel })),
      [
        { kindId: "agy", models: ["gemini-high", "gemini-low"], defaultModel: "gemini-high" },
        { kindId: "claude", models: ["fable", "sonnet", "opus"], defaultModel: "fable" },
        { kindId: "codex", models: ["gpt-sol", "gpt-terra"], defaultModel: "gpt-sol" },
        { kindId: "devin", models: ["swe-2", "claude-opus-5"], defaultModel: "swe-2" },
        // modelProbe: null means catalog unavailable, not a successfully probed empty catalog.
        { kindId: "zcode", models: undefined, defaultModel: undefined },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protocol-observed models merge into the installation catalog without displacing probed entries", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-model-observe-")),
    bin = path.join(root, "bin");
  try {
    mkdirSync(bin);
    writeProviderExecutable(
      path.join(bin, "devin"),
      `const args = process.argv.slice(2); if (args[0] === "--version") console.log("devin-test"); else if (args.join(" ") === "models list --format json") console.log(JSON.stringify({ families: [{ slug: "swe-2" }] }));\n`,
    );
    const devin = (await discoverRuntimeInstallations({ env: { PATH: bin } }))[0]!;
    assert.deepEqual(devin.models, ["swe-2"]);
    observeRuntimeModels({
      kindId: "devin",
      executablePath: devin.executablePath,
      version: devin.version,
      models: ["swe-2-medium", "swe-2"],
      currentModel: "swe-2-medium",
    });
    assert.deepEqual(
      await discoverRuntimeModelCatalog({
        platform: process.platform,
        executablePath: devin.executablePath,
        kindId: "devin",
        env: { PATH: bin },
        version: devin.version,
      }),
      { models: ["swe-2", "swe-2-medium"], defaultModel: "swe-2" },
    );
    // An empty advertisement never clears an installation's catalog.
    observeRuntimeModels({
      kindId: "codex-acp",
      executablePath: "/opt/runtime-test/codex-acp",
      version: "1.11.0",
      models: [],
    });
    assert.equal(
      await discoverRuntimeModelCatalog({
        platform: process.platform,
        executablePath: "/opt/runtime-test/codex-acp",
        kindId: "codex-acp",
        env: {},
        version: "1.11.0",
      }),
      null,
    );
    // A modelProbe: null kind still gains a catalog once the protocol advertises one.
    observeRuntimeModels({
      kindId: "codex-acp",
      executablePath: "/opt/runtime-test/codex-acp",
      version: "1.11.0",
      models: ["gpt-5.6-sol[low]", "gpt-5.6-sol[medium]"],
      currentModel: "gpt-5.6-sol[medium]",
    });
    assert.deepEqual(
      await discoverRuntimeModelCatalog({
        platform: process.platform,
        executablePath: "/opt/runtime-test/codex-acp",
        kindId: "codex-acp",
        env: {},
        version: "1.11.0",
      }),
      { models: ["gpt-5.6-sol[low]", "gpt-5.6-sol[medium]"], defaultModel: "gpt-5.6-sol[medium]" },
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
    const launch = await store.prepareLaunch("codex-api", { cwd: "/workspace/repo", prompt: "Inspect" }),
      writableLaunch = await store.prepareLaunch("codex-api", {
        cwd: "/workspace/repo",
        prompt: "Inspect",
        writableRoots: ["/workspace/repo/tmp/backup", "/workspace/repo/.harness/drills"],
      });
    assert.equal(resolvedReference, "keychain:harness/codex-api");
    assert.deepEqual(launch.installation, observed);
    assert.equal(launch.executablePath, observed.executablePath);
    assert.deepEqual(launch.args, ["exec", "--json", "--sandbox", "danger-full-access", "--model", "gpt-5.6-sol", "-"]);
    assert.deepEqual(writableLaunch.args, [
      "exec",
      "--json",
      "--sandbox",
      "danger-full-access",
      "--add-dir",
      "/workspace/repo/tmp/backup",
      "--add-dir",
      "/workspace/repo/.harness/drills",
      "--model",
      "gpt-5.6-sol",
      "-",
    ]);
    assert.deepEqual(launch.env, expectedIsolatedEnvironment(stateRoot, "codex", { PATH: "/runtime/tools" }));
    const codexConfig = path.join(launch.env.CODEX_HOME!, "config.toml"),
      text = readFileSync(codexConfig, "utf8");
    if (process.platform !== "win32") assert.equal(statSync(codexConfig).mode & 0o777, 0o600);
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
    assertPrivateModes(path.join(userRoot, "runtime-instances.json"), [
      stateRoot,
      ...["home", "tmp", "run"].map((name) => path.join(stateRoot, name)),
    ]);
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
      writableLaunch = await store.prepareLaunch("claude-subscription", {
        cwd: "/workspace/repo",
        prompt: "Inspect",
        writableRoots: ["/workspace/repo/tmp/backup"],
      }),
      stateRoot = path.join(userRoot, "runtime-instances", "claude-subscription");
    assert.deepEqual(launch.args, [
      "-p",
      "--verbose",
      "--settings",
      '{"attribution":{"commit":"","pr":"","sessionUrl":false}}',
      "--output-format",
      "stream-json",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      "claude-fable-5",
    ]);
    assert.deepEqual(writableLaunch.args.slice(6, 10), [
      "--permission-mode",
      "bypassPermissions",
      "--add-dir",
      "/workspace/repo/tmp/backup",
    ]);
    assert.deepEqual(launch.env, expectedIsolatedEnvironment(stateRoot, "claude", { PATH: "/runtime/tools" }));
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
    await assert.rejects(
      store.prepareLaunch("agy-fast", { cwd: "/workspace/repo", prompt: "Reject", writableRoots: ["/tmp/out"] }),
      (error: unknown) => codedAs(error, "runtime_writable_roots_unsupported"),
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
function assertPrivateModes(file: string, directories: readonly string[]): void {
  if (process.platform === "win32") {
    assert.equal(existsSync(file), true);
    for (const directory of directories) assert.equal(statSync(directory).isDirectory(), true, directory);
    return;
  }
  assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const directory of directories) assert.equal(statSync(directory).mode & 0o777, 0o700, directory);
}

function expectedIsolatedEnvironment(
  stateRoot: string,
  kindId: "claude" | "codex",
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const home = path.join(stateRoot, "home"),
    tmp = path.join(stateRoot, "tmp"),
    provider =
      kindId === "claude"
        ? { CLAUDE_CONFIG_DIR: path.join(home, ".claude") }
        : { CODEX_HOME: path.join(home, ".codex") };
  return process.platform === "win32"
    ? {
        USERPROFILE: home,
        TEMP: tmp,
        TMP: tmp,
        APPDATA: path.join(home, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(home, "AppData", "Local"),
        ...provider,
        ...extra,
      }
    : {
        HOME: home,
        TMPDIR: tmp,
        XDG_RUNTIME_DIR: path.join(stateRoot, "run"),
        ...provider,
        ...extra,
      };
}
