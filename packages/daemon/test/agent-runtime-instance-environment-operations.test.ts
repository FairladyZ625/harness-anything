// harness-test-tier: contract
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  discoverRuntimeInstallations,
  openRuntimeInstanceStore,
  type RuntimeAuthReadiness,
} from "../src/agent-runtime-instances.ts";
import { codedAs, observed } from "./agent-runtime-instance-environment.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

test("Claude effort defaults and per-launch overrides reach the Claude Code CLI", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-claude-effort-")),
    claude = {
      ...observed,
      installationId: "claude-effort-installation",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude",
    };
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [claude],
      resolveCredential: () => "instance-secret",
    });
    store.create({
      schemaVersion: 2,
      instanceId: "claude-effort",
      name: "Claude Effort",
      kindId: "claude",
      installationId: claude.installationId,
      providerId: "anthropic",
      models: ["claude-fable-5"],
      defaultModel: "claude-fable-5",
      enabled: true,
      isolationState: "enforced",
      claude: { effort: "medium" },
      auth: { mode: "api-key", credentialRef: "credential:v1:claude-effort" },
    });
    const configured = await store.prepareLaunch("claude-effort", { cwd: "/workspace/repo", prompt: "Configured" }),
      overridden = await store.prepareLaunch("claude-effort", {
        cwd: "/workspace/repo",
        prompt: "Override",
        effort: "xhigh",
        providerSessionId: "session-1",
      }),
      minimal = await store.prepareLaunch("claude-effort", {
        cwd: "/workspace/repo",
        prompt: "Minimal",
        effort: "minimal",
      });
    assert.deepEqual(configured.args, [
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
      "--effort",
      "medium",
      "--bare",
    ]);
    assert.deepEqual(overridden.args.slice(-5), ["--effort", "xhigh", "--bare", "--resume", "session-1"]);
    assert.equal(minimal.args[minimal.args.indexOf("--effort") + 1], "low");
    assert.equal(configured.definition.reasoningEffort, "medium");
    assert.equal(overridden.definition.reasoningEffort, "xhigh");
    assert.equal(store.read("claude-effort")?.claude.effort, "medium");
    await assert.rejects(
      store.prepareLaunch("claude-effort", { cwd: "/workspace/repo", prompt: "Bad", effort: "turbo" }),
      (error: unknown) =>
        codedAs(error, "invalid_runtime_effort") && error instanceof Error && error.message.includes("turbo"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("create takes repeated models with an optional explicit default and dispatches any of them", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-create-models-"));
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed],
      resolveCredential: () => "instance-secret",
    });
    const created = store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-multi",
      name: "Codex Multi",
      kindId: "codex",
      providerId: "openai",
      models: ["gpt-5.6-sol", "gpt-5.6-terra"],
      authMode: "api-key",
      credentialRef: "credential:v1:codex-multi",
    }).instance as { readonly models: readonly string[]; readonly defaultModel: string };
    assert.deepEqual(created.models, ["gpt-5.6-sol", "gpt-5.6-terra"]);
    assert.equal(created.defaultModel, "gpt-5.6-sol");
    const explicit = store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-explicit",
      name: "Codex Explicit",
      kindId: "codex",
      providerId: "openai",
      models: ["gpt-5.6-sol", "gpt-5.6-terra"],
      defaultModel: "gpt-5.6-terra",
      authMode: "api-key",
      credentialRef: "credential:v1:codex-explicit",
    }).instance as { readonly defaultModel: string };
    assert.equal(explicit.defaultModel, "gpt-5.6-terra");
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-create",
          instanceId: "codex-bad-default",
          name: "Codex Bad Default",
          kindId: "codex",
          providerId: "openai",
          models: ["gpt-5.6-sol"],
          defaultModel: "gpt-unknown",
          authMode: "api-key",
          credentialRef: "credential:v1:codex-bad-default",
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_model"),
    );
    const second = await store.prepareLaunch("codex-multi", {
      cwd: "/workspace/repo",
      prompt: "Second",
      model: "gpt-5.6-terra",
    });
    assert.equal(second.args[second.args.indexOf("--model") + 1], "gpt-5.6-terra");
    await assert.rejects(
      store.prepareLaunch("codex-multi", { cwd: "/workspace/repo", prompt: "Rejected", model: "gpt-unknown" }),
      (error: unknown) => codedAs(error, "invalid_runtime_model"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("persisted schema v2 records normalize permission and isolation fields once on read", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-field-migration-")),
    claude = {
      ...observed,
      installationId: "claude-field-migration",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude",
    },
    agy = {
      installationId: "agy-field-migration",
      kindId: "agy" as const,
      executablePath: "/opt/runtime-test/agy",
      version: "1.1.22",
      observedAt: "2026-08-29T00:00:00.000Z",
    };
  try {
    writeFileSync(
      path.join(userRoot, "runtime-instances.json"),
      `${JSON.stringify({
        schema: "runtime-instances/v1",
        instances: [
          {
            schemaVersion: 2,
            instanceId: "codex-persisted",
            name: "Codex Persisted",
            kindId: "codex",
            installationId: observed.installationId,
            providerId: "openai",
            models: ["gpt-5.6-sol"],
            defaultModel: "gpt-5.6-sol",
            enabled: true,
            codex: {},
            auth: { mode: "subscription" },
          },
          {
            schemaVersion: 2,
            instanceId: "claude-persisted",
            name: "Claude Persisted",
            kindId: "claude",
            installationId: claude.installationId,
            providerId: "anthropic",
            models: ["claude-fable-5"],
            defaultModel: "claude-fable-5",
            enabled: true,
            claude: {},
            auth: { mode: "subscription" },
          },
          {
            schemaVersion: 2,
            instanceId: "agy-persisted",
            name: "AGY Persisted",
            kindId: "agy",
            installationId: agy.installationId,
            providerId: "google",
            models: ["gemini-3.1-pro-low"],
            defaultModel: "gemini-3.1-pro-low",
            enabled: true,
            agy: {},
            auth: { mode: "subscription" },
          },
        ],
      })}\n`,
    );
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed, claude, agy],
      env: { HOME: "/operator/home", PATH: "/bin" },
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    assert.deepEqual(
      { ...store.read("codex-persisted"), codex: undefined },
      {
        schemaVersion: 2,
        instanceId: "codex-persisted",
        name: "Codex Persisted",
        installationId: observed.installationId,
        installationIdentity: "path-entry/v1",
        providerId: "openai",
        models: ["gpt-5.6-sol"],
        defaultModel: "gpt-5.6-sol",
        enabled: true,
        permissionMode: "bypass",
        isolationState: "enforced",
        kindId: "codex",
        auth: { mode: "subscription" },
        codex: undefined,
      },
    );
    assert.deepEqual(
      { ...store.read("claude-persisted"), claude: undefined },
      {
        schemaVersion: 2,
        instanceId: "claude-persisted",
        name: "Claude Persisted",
        installationId: claude.installationId,
        installationIdentity: "path-entry/v1",
        providerId: "anthropic",
        models: ["claude-fable-5"],
        defaultModel: "claude-fable-5",
        enabled: true,
        permissionMode: "bypass",
        isolationState: "operator-environment",
        kindId: "claude",
        auth: { mode: "subscription" },
        claude: undefined,
      },
    );
    assert.equal(store.read("agy-persisted")?.permissionMode, "bypass");
    const persisted = JSON.parse(readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8"))
      .instances as Array<Record<string, unknown>>;
    assert.deepEqual(
      persisted.map(({ permissionMode, isolationState }) => ({ permissionMode, isolationState })),
      [
        { permissionMode: "bypass", isolationState: "operator-environment" },
        { permissionMode: "bypass", isolationState: "operator-environment" },
        { permissionMode: "bypass", isolationState: "enforced" },
      ],
    );
    const storeAgain = openRuntimeInstanceStore({ userRoot, discover: () => [observed, claude, agy] }),
      mtimeFirst = statSync(path.join(userRoot, "runtime-instances.json")).mtimeMs;
    storeAgain.read("codex-persisted");
    assert.equal(statSync(path.join(userRoot, "runtime-instances.json")).mtimeMs, mtimeFirst);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("runtime auth readiness is explicit, safe, and never falls back across modes", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-auth-readiness-"));
  try {
    let subscriptionReady = false,
      credentialCalls = 0,
      subscriptionCalls = 0;
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed],
      resolveCredential: () => {
        credentialCalls += 1;
        throw new Error("missing");
      },
      subscriptionReady: () => {
        subscriptionCalls += 1;
        return subscriptionReady
          ? { status: "ready", code: null, hint: null }
          : {
              status: "not-ready",
              code: "runtime_subscription_required",
              hint: "Provider subscription authentication is unavailable in this instance state root.",
            };
      },
    });
    store.create({
      schemaVersion: 1,
      instanceId: "codex-sub",
      name: "Codex Subscription",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      model: "gpt-5.6-sol",
      auth: { mode: "subscription" },
    });
    assert.deepEqual(await store.authStatus("codex-sub"), {
      status: "not-ready",
      code: "runtime_subscription_required",
      hint: "Provider subscription authentication is unavailable in this instance state root.",
    });
    assert.equal(credentialCalls, 0);
    assert.equal(subscriptionCalls, 1);
    subscriptionReady = true;
    assert.deepEqual(await store.authStatus("codex-sub"), { status: "ready", code: null, hint: null });
    assert.equal(credentialCalls, 0);
    assert.equal(subscriptionCalls, 2);
    store.create({
      schemaVersion: 1,
      instanceId: "codex-api",
      name: "Codex API",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      model: "gpt-5.6-sol",
      auth: { mode: "api-key", credentialRef: "keychain:harness/missing" },
    });
    assert.deepEqual(await store.authStatus("codex-api"), {
      status: "not-ready",
      code: "runtime_credential_unavailable",
      hint: "The configured runtime API credential is unavailable.",
    });
    assert.equal(subscriptionCalls, 2);
    const receipt = await store.command({ kind: "runtime-instance-show", instanceId: "codex-api", probe: true });
    assert.doesNotMatch(JSON.stringify(receipt), /credentialRef|keychain:|executablePath|\/opt\/runtime-test/u);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("subscription probes distinguish authenticated, unauthenticated, and inconclusive states", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-auth-probe-state-"));
  try {
    let probe: RuntimeAuthReadiness = {
      status: "not-ready",
      code: "runtime_subscription_required",
      hint: "Provider subscription authentication is unavailable in this instance state root.",
    };
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], subscriptionReady: () => probe });
    store.create({
      schemaVersion: 1,
      instanceId: "codex-probe",
      name: "Codex Probe",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      model: "gpt-5.6-sol",
      auth: { mode: "subscription" },
    });
    const unchecked = store.command({ kind: "runtime-instance-show", instanceId: "codex-probe" }).instance as Record<
      string,
      unknown
    >;
    assert.equal(unchecked.authState, "unknown");
    assert.equal((unchecked.authReadiness as Record<string, unknown>).code, "runtime_auth_not_checked");
    const unauthenticated = (
      await store.command({ kind: "runtime-instance-show", instanceId: "codex-probe", probe: true })
    ).instance as Record<string, unknown>;
    assert.equal(unauthenticated.authState, "unauthenticated");
    assert.equal((unauthenticated.authReadiness as Record<string, unknown>).code, "runtime_subscription_required");
    probe = {
      status: "not-ready",
      code: "runtime_auth_probe_failed",
      hint: "Provider authentication probe could not determine readiness.",
    };
    const inconclusive = (
      await store.command({ kind: "runtime-instance-show", instanceId: "codex-probe", probe: true })
    ).instance as Record<string, unknown>;
    assert.equal(inconclusive.authState, "unknown");
    assert.equal((inconclusive.authReadiness as Record<string, unknown>).code, "runtime_auth_probe_failed");
    probe = { status: "ready", code: null, hint: null };
    const authenticated = (
      await store.command({ kind: "runtime-instance-show", instanceId: "codex-probe", probe: true })
    ).instance as Record<string, unknown>;
    assert.equal(authenticated.authState, "authenticated");
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("subscription auth commands use the witnessed executable and instance-only state root", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-auth-command-"));
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed],
      env: {
        PATH: "/runtime/tools",
        HOME: "/host/home",
        TMPDIR: "/host/tmp",
        OPENAI_API_KEY: "host-secret",
        HTTPS_PROXY: "host-proxy",
      },
    });
    store.create({
      schemaVersion: 1,
      instanceId: "codex-sub",
      name: "Codex Subscription",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      model: "gpt-5.6-sol",
      auth: { mode: "subscription" },
    });
    const stateRoot = path.join(userRoot, "runtime-instances", "codex-sub"),
      providerConfigDirectory = path.join(stateRoot, "home", ".codex");
    if (process.platform !== "win32") assert.equal(statSync(providerConfigDirectory).mode & 0o777, 0o700);
    assert.equal(existsSync(path.join(stateRoot, "home", ".claude")), false);
    const command = store.prepareAuthCommand("codex-sub", "login");
    assert.equal(command.executablePath, observed.executablePath);
    assert.deepEqual(command.args, ["login"]);
    assert.equal(command.cwd, stateRoot);
    assert.deepEqual(
      command.env,
      expectedIsolatedEnvironment(stateRoot, "codex", {
        PATH: "/runtime/tools",
        CODEX_HOME: providerConfigDirectory,
      }),
    );
    assert.deepEqual(store.prepareAuthCommand("codex-sub", "logout").args, ["logout"]);
    store.command({ kind: "runtime-instance-update", instanceId: "codex-sub", enabled: false });
    assert.deepEqual(store.prepareAuthCommand("codex-sub", "login").args, ["login"]);
    assert.deepEqual(store.prepareAuthCommand("codex-sub", "logout").args, ["logout"]);
    store.create({
      schemaVersion: 1,
      instanceId: "codex-api",
      name: "Codex API",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      model: "gpt-5.6-sol",
      auth: { mode: "api-key", credentialRef: "keychain:harness/codex-api" },
    });
    assert.throws(
      () => store.prepareAuthCommand("codex-api", "login"),
      (error: unknown) => codedAs(error, "runtime_auth_mode_mismatch"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("credential references accept the backend-agnostic grammar and legacy keychain form", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-credential-grammar-")),
    store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] });
  try {
    const base = {
      schemaVersion: 1 as const,
      kindId: "codex" as const,
      installationId: observed.installationId,
      providerId: "openai",
      model: "gpt-5.6-sol",
      auth: { mode: "api-key" as const, credentialRef: "" },
    };
    for (const reference of [
      "credential:v1:codex-review",
      "credential:v1:openai-main-2",
      "keychain:harness/codex-review",
    ]) {
      const config = {
          ...base,
          instanceId: "codex-grammar",
          name: "Codex Grammar",
          auth: { mode: "api-key" as const, credentialRef: reference },
        },
        created = store.create(config);
      assert.deepEqual(created.models, ["gpt-5.6-sol"]);
      assert.equal(created.defaultModel, "gpt-5.6-sol");
      assert.equal(created.enabled, true);
      store.delete("codex-grammar");
    }
    for (const reference of [
      "credential:v1:-leading",
      "credential:v2:codex",
      "keychain:a/b/c",
      "plaintext-secret",
      "credential:v1:",
    ])
      assert.throws(
        () =>
          store.create({
            ...base,
            instanceId: "codex-grammar",
            name: "Codex Grammar",
            auth: { mode: "api-key", credentialRef: reference },
          }),
        (error: unknown) => codedAs(error, "invalid_credential_reference"),
      );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

// The PATHEXT suffix enumeration is observable from any host: a POSIX host
// witnesses the argv-direct `.exe`-suffixed probe directly, while a real
// Windows host witnesses the same enumeration through the `.cmd` shim the
// shared provider stub fixture produces.
test("win32 installation discovery probes PATHEXT suffixes and witnesses the shim", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-win32-discovery-")),
    bin = path.join(root, "bin");
  try {
    mkdirSync(bin);
    const executablePath = writeProviderExecutable(
      process.platform === "win32" ? path.join(bin, "codex") : path.join(bin, "codex.exe"),
      'console.log("stub-runtime-1.0.0");\n',
    );
    const installations = await discoverRuntimeInstallations({
      env: { PATH: bin },
      platform: "win32",
      now: () => "2026-08-15T01:00:00.000Z",
    });
    assert.equal(installations.length, 1);
    assert.deepEqual(
      {
        kindId: installations[0]!.kindId,
        version: installations[0]!.version,
        observedAt: installations[0]!.observedAt,
      },
      { kindId: "codex", version: "stub-runtime-1.0.0", observedAt: "2026-08-15T01:00:00.000Z" },
    );
    assert.equal(
      installations[0]!.executablePath.endsWith(process.platform === "win32" ? "codex.cmd" : "codex.exe"),
      true,
    );
    assert.equal(installations[0]!.executablePath, realpathSync(executablePath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The shared stub fixture must forward the exact argv through the platform's
// real launch shape: the discovery version probe proves single-argument
// passthrough (`--version`), and the codex subscription probe proves
// multi-argument passthrough (`login status`) — the stub answers ready only
// when it receives that argv verbatim, so a shim that dropped or reordered
// arguments would surface as runtime_subscription_required, not readiness.
test("the shared provider stub fixture launches with the exact argv on every platform", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-stub-fixture-")),
    bin = path.join(root, "bin"),
    witness = path.join(root, "argv-witness.json"),
    userRoot = path.join(root, "user"),
    script = path.join(bin, "codex");
  try {
    requireDirectory(bin);
    const executablePath = writeProviderExecutable(
      script,
      `const fs = require("node:fs");\nconst argv = process.argv.slice(2), serialized = JSON.stringify(argv);\nfs.writeFileSync(${JSON.stringify(witness)}, serialized);\nconsole.log(serialized);\nif (serialized !== JSON.stringify(["--version"]) && serialized !== JSON.stringify(["login", "status"])) process.exit(9);\n`,
    );
    assert.equal(readFileSync(script, "utf8").startsWith(`#!${process.execPath}\n`), true);
    if (process.platform === "win32") assert.equal(executablePath.endsWith(".cmd"), true);
    else assert.equal(statSync(script).mode & 0o777, 0o755);
    const installations = await discoverRuntimeInstallations({ env: { PATH: bin } });
    assert.equal(installations.length, 1, JSON.stringify(installations));
    assert.equal(installations[0]!.executablePath, realpathSync(executablePath));
    assert.equal(installations[0]!.version, JSON.stringify(["--version"]));
    const store = openRuntimeInstanceStore({ userRoot, discover: () => installations });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-stub-argv",
      name: "Codex Stub Argv",
      kindId: "codex",
      installationId: installations[0]!.installationId,
      providerId: "openai",
      models: ["argv-model"],
      defaultModel: "argv-model",
      enabled: true,
      codex: {},
      auth: { mode: "subscription" },
    });
    assert.deepEqual(await store.authStatus("codex-stub-argv"), { status: "ready", code: null, hint: null });
    assert.equal(readFileSync(witness, "utf8"), JSON.stringify(["login", "status"]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime instance update edits the base URL of an existing instance", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-base-url-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-edit",
      name: "Codex Edit",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "codex_local_access",
      models: ["gpt-5.6-sol"],
      codex: { baseUrl: "http://127.0.0.1:1/v1", wireApi: "responses" },
      authMode: "api-key",
      credentialRef: "keychain:harness/codex-edit",
    });
    const replaced = store.command({
      kind: "runtime-instance-update",
      instanceId: "codex-edit",
      baseUrl: "https://api.new-endpoint.example/v1",
    });
    assert.equal(
      (replaced.instance as { readonly configuration: { readonly baseUrl: string | null } }).configuration.baseUrl,
      "https://api.new-endpoint.example/v1",
    );
    // An untouched base URL survives an unrelated update.
    const renamed = store.command({ kind: "runtime-instance-update", instanceId: "codex-edit", name: "Codex Edited" });
    assert.equal(
      (renamed.instance as { readonly configuration: { readonly baseUrl: string | null } }).configuration.baseUrl,
      "https://api.new-endpoint.example/v1",
    );
    // An explicit empty base URL clears back to the official endpoint.
    const cleared = store.command({ kind: "runtime-instance-update", instanceId: "codex-edit", baseUrl: "" });
    assert.equal(
      (
        cleared.instance as {
          readonly configuration: { readonly baseUrl: string | null; readonly baseUrlConfigured: boolean };
        }
      ).configuration.baseUrl,
      null,
    );
    assert.equal(
      (cleared.instance as { readonly configuration: { readonly baseUrlConfigured: boolean } }).configuration
        .baseUrlConfigured,
      false,
    );
    // Same edit path for a claude API-override instance.
    const claudeInstallation = {
      ...observed,
      installationId: "claude-edit",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude",
    };
    const claudeStore = openRuntimeInstanceStore({ userRoot, discover: () => [claudeInstallation] });
    claudeStore.command({
      kind: "runtime-instance-create",
      instanceId: "claude-edit",
      name: "Claude Edit",
      kindId: "claude",
      installationId: claudeInstallation.installationId,
      providerId: "anthropic",
      models: ["claude-fable-5"],
      claude: { effort: "high", baseUrl: "https://old-gateway.example/v1" },
      authMode: "api-key",
      credentialRef: "keychain:harness/claude-edit",
    });
    const claudeReplaced = claudeStore.command({
      kind: "runtime-instance-update",
      instanceId: "claude-edit",
      baseUrl: "https://new-gateway.example/v1",
    });
    assert.equal(
      (claudeReplaced.instance as { readonly configuration: { readonly baseUrl: string | null } }).configuration
        .baseUrl,
      "https://new-gateway.example/v1",
    );
    assert.equal(
      (claudeReplaced.instance as { readonly configuration: { readonly effort: string | null } }).configuration.effort,
      "high",
    );
    // Insecure endpoints are rejected by the same validation create uses.
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-update",
          instanceId: "codex-edit",
          baseUrl: "http://insecure.example/v1",
        }),
      (error: unknown) => codedAs(error, "invalid_base_url"),
    );
    // agy has no API mode and no base URL at all.
    const agyInstallation = {
      ...observed,
      installationId: "agy-edit",
      kindId: "agy" as const,
      executablePath: "/opt/runtime-test/agy",
    };
    const agyStore = openRuntimeInstanceStore({ userRoot, discover: () => [agyInstallation] });
    agyStore.command({
      kind: "runtime-instance-create",
      instanceId: "agy-edit",
      name: "Agy Edit",
      kindId: "agy",
      providerId: "google",
      models: ["gemini"],
      authMode: "subscription",
    });
    assert.throws(
      () =>
        agyStore.command({
          kind: "runtime-instance-update",
          instanceId: "agy-edit",
          baseUrl: "https://api.example/v1",
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_kind_config"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

function requireDirectory(directory: string): void {
  mkdirSync(directory);
}
function expectedIsolatedEnvironment(
  stateRoot: string,
  kindId: "claude" | "codex" | "zcode" | "agy",
  extra: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const home = path.join(stateRoot, "home"),
    tmp = path.join(stateRoot, "tmp"),
    provider =
      kindId === "claude"
        ? { CLAUDE_CONFIG_DIR: path.join(home, ".claude") }
        : kindId === "codex"
          ? { CODEX_HOME: path.join(home, ".codex") }
          : {};
  return platform === "win32"
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
