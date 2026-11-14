// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instance-store.ts";
import { runtimeInstanceConfig } from "../src/agent-runtime-instance-config.ts";
import { launchEnvironment } from "../src/agent-runtime-launch-config.ts";
import { runtimeKindForId, supportsRuntimeSubscriptionMultiAccountIsolation } from "../src/runtime-inventory.ts";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instance-types.ts";
import { codedAs } from "./agent-runtime-instance-environment.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

// dec_DA1602487428A58E8B446ECE38 CH1: only pairs verified against native credential storage are enabled.
const providers = ["codex", "codex-acp", "claude", "claude-acp", "devin", "opencode", "minimax-code"] as const;
const witness = (kindId: RuntimeInstallationWitness["kindId"]): RuntimeInstallationWitness => ({
  installationId: `${kindId}-installation`,
  kindId,
  executablePath: `/opt/test/${kindId}`,
  version: "9999.1.0",
  observedAt: "2026-11-14T00:00:00.000Z",
});

for (const kindId of providers) {
  test(`${kindId} independent accounts keep login, launch and credentials inside their own HOME`, async () => {
    const userRoot = mkdtempSync(path.join(tmpdir(), "ha-provider-isolation-")),
      operatorHome = path.join(userRoot, "operator-home"),
      declaration = runtimeKindForId(kindId),
      providerDirectory = declaration.executable.configDirectory,
      authFile = declaration.executable.authFile!,
      operatorAuth = path.join(
        operatorHome,
        providerDirectory,
        authFile,
        ...(kindId === "minimax-code" ? ["fixture"] : []),
      ),
      installations = providers.map(witness);
    mkdirSync(path.dirname(operatorAuth), { recursive: true });
    writeFileSync(operatorAuth, "test-operator-account");
    try {
      const store = openRuntimeInstanceStore({
        userRoot,
        platform: "darwin",
        env: {
          PATH: process.env.PATH,
          HOME: operatorHome,
          CODEX_HOME: path.join(operatorHome, ".codex"),
          CLAUDE_CONFIG_DIR: path.join(operatorHome, ".claude"),
          XDG_DATA_HOME: path.join(operatorHome, "shared-data"),
          MINIMAX_DATA_DIR: path.join(operatorHome, ".minimax"),
          ANTHROPIC_AUTH_TOKEN: "test-operator-token",
          OPENAI_API_KEY: "test-operator-key",
        },
        discover: () => installations,
        subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
      });
      const homes: string[] = [];
      for (const suffix of ["one", "two"]) {
        const instanceId = `${kindId}-${suffix}`;
        const created = store.command({
          kind: "runtime-instance-create",
          instanceId,
          name: instanceId,
          kindId,
          installationId: witness(kindId).installationId,
          providerId: declaration.defaultProviderId,
          models: ["test-model"],
          authMode: "subscription",
          credentialSource: "instance",
        }).instance as Record<string, unknown>;
        assert.equal(created.isolationState, "enforced");
        const login = store.prepareAuthCommand(instanceId, "login"),
          home = path.join(userRoot, "runtime-instances", instanceId, "home"),
          directory = path.join(home, providerDirectory),
          localAuth = path.join(directory, authFile),
          credentialFile = kindId === "minimax-code" ? path.join(localAuth, "fixture") : localAuth,
          nativeKind = kindId === "codex-acp" ? "codex" : kindId === "claude-acp" ? "claude" : kindId;
        homes.push(home);
        assert.equal(login.env.HOME, home);
        assert.equal(login.executablePath, witness(nativeKind).executablePath);
        assert.deepEqual(
          login.args,
          kindId.startsWith("codex") || kindId === "minimax-code" ? ["login"] : ["auth", "login"],
        );
        assert.equal(existsSync(localAuth), false, "instance accounts must not link or copy operator credentials");
        mkdirSync(path.dirname(credentialFile), { recursive: true });
        writeFileSync(credentialFile, `test-account-${suffix}`);
        assert.equal(lstatSync(credentialFile).isSymbolicLink(), false);
        const launch = await store.prepareLaunch(instanceId, { cwd: userRoot, prompt: "test isolation" });
        assert.equal(launch.env.HOME, home);
        if (declaration.executable.configHomeEnvironment)
          assert.equal(launch.env[declaration.executable.configHomeEnvironment], directory);
        for (const key of ["ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "XDG_DATA_HOME", "MINIMAX_DATA_DIR"])
          assert.equal(launch.env[key], undefined, `operator ${key} must not escape into the instance`);
        store.prepareAuthCommand(instanceId, "logout");
        assert.equal(readFileSync(credentialFile, "utf8"), `test-account-${suffix}`);
        if (kindId.startsWith("codex")) {
          assert.match(
            readFileSync(path.join(directory, "config.toml"), "utf8"),
            /^cli_auth_credentials_store = "file"$/mu,
          );
          if (kindId === "codex-acp")
            assert.equal(JSON.parse(launch.env.CODEX_CONFIG!).cli_auth_credentials_store, "file");
        }
      }
      assert.notEqual(homes[0], homes[1]);
      assert.equal(readFileSync(operatorAuth, "utf8"), "test-operator-account");
      const cold = openRuntimeInstanceStore({ userRoot, platform: "darwin", discover: () => [] });
      const list = cold.command({ kind: "runtime-instance-list", all: true });
      assert.equal((list.instances as unknown[]).length, 2, "cold list --all must accept enforced subscriptions");
    } finally {
      rmSync(userRoot, { recursive: true, force: true });
    }
  });

  test(`${kindId} rejects undeclared platforms and weakened isolation`, () => {
    const candidate = {
      schemaVersion: 2,
      instanceId: `${kindId}-private`,
      name: "Private",
      kindId,
      installationId: witness(kindId).installationId,
      providerId: runtimeKindForId(kindId).defaultProviderId,
      models: ["test-model"],
      defaultModel: "test-model",
      enabled: true,
      credentialSource: "instance",
      auth: { mode: "subscription" },
      [kindId]: {},
    };
    assert.equal(supportsRuntimeSubscriptionMultiAccountIsolation(kindId, "darwin"), true);
    for (const platform of ["win32", "aix", "linux"] as const)
      assert.throws(
        () => runtimeInstanceConfig(candidate, platform),
        (error: unknown) => codedAs(error, "runtime_instance_isolation_unsupported"),
      );
    assert.throws(
      () => runtimeInstanceConfig({ ...candidate, isolationState: "operator-environment" }, "darwin"),
      (error: unknown) => codedAs(error, "invalid_runtime_isolation"),
    );
  });
}

test("Codex ACP enforces file storage over session config overrides only for isolated launches", () => {
  const config = runtimeInstanceConfig({
    schemaVersion: 2,
    instanceId: "codex-acp-file",
    name: "Codex ACP",
    kindId: "codex-acp",
    installationId: "codex-acp-installation",
    providerId: "openai",
    models: ["test-model"],
    defaultModel: "test-model",
    enabled: true,
    isolationState: "enforced",
    auth: { mode: "subscription" },
    "codex-acp": {},
  });
  const env = { CODEX_CONFIG: JSON.stringify({ cli_auth_credentials_store: "keyring", user_setting: true }) };
  assert.deepEqual(JSON.parse(launchEnvironment(config, env).CODEX_CONFIG!), {
    cli_auth_credentials_store: "file",
    user_setting: true,
    shell_environment_policy: { inherit: "all", ignore_default_excludes: true, exclude: [], include_only: [] },
  });
  assert.equal(
    JSON.parse(launchEnvironment({ ...config, isolationState: "operator-environment" }, env).CODEX_CONFIG!)
      .cli_auth_credentials_store,
    "keyring",
  );
});

test("ACP account probes use native login status and record catalogs from the isolated environment", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-acp-native-probe-")),
    bin = path.join(userRoot, "bin");
  mkdirSync(bin);
  try {
    const installations = ["codex", "codex-acp", "claude", "claude-acp"].map((kindId) => {
      const installation = witness(kindId as RuntimeInstallationWitness["kindId"]),
        target = path.join(bin, process.platform === "win32" ? `${kindId}.cmd` : kindId);
      writeProviderExecutable(
        target,
        `
        const fs = require("node:fs"), path = require("node:path");
        const args = process.argv.slice(2);
        if (args[0] === "--version") { console.log("9999.1.0"); process.exit(0); }
        if (${JSON.stringify(kindId)}.endsWith("-acp")) {
          require("node:readline").createInterface({input:process.stdin}).on("line", line => {
            const m = JSON.parse(line);
            const result = m.method === "initialize" ? {authMethods:[]} : {sessionId:"test-session",models:{availableModels:[{modelId:"test-model"}],currentModelId:"test-model"}};
            if (!["initialize","session/new"].includes(m.method)) process.exit(93);
            console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result}));
          });
          return;
        }
        if (args[0] === "debug") console.log(JSON.stringify({models:[{slug:"test-model"}]}));
        else if (args[0] === "--help") console.log('Use a model alias (e.g. "sonnet" or "opus")');
        else if (!fs.existsSync(path.join(process.env.HOME, "signed-in"))) process.exit(1);
      `,
      );
      return { ...installation, executablePath: target };
    });
    const store = openRuntimeInstanceStore({
      userRoot,
      platform: "darwin",
      env: { PATH: bin },
      discover: () => installations,
    });
    for (const kindId of ["codex-acp", "claude-acp"] as const) {
      store.command({
        kind: "runtime-instance-create",
        instanceId: kindId,
        name: kindId,
        kindId,
        installationId: witness(kindId).installationId,
        providerId: runtimeKindForId(kindId).defaultProviderId,
        models: ["test-model"],
        authMode: "subscription",
        credentialSource: "instance",
      });
      assert.equal(
        (await store.authStatus(kindId)).code,
        "runtime_subscription_required",
        "adapter --version is not authentication",
      );
      writeFileSync(path.join(userRoot, "runtime-instances", kindId, "home", "signed-in"), "test");
      assert.equal((await store.authStatus(kindId)).status, "ready");
      const refreshed = await store.command({ kind: "runtime-instance-show", instanceId: kindId, probe: true });
      assert.equal((refreshed.modelCatalogReadiness as { status: string }).status, "ready");
      assert.deepEqual(store.read(kindId)?.availableModels, ["test-model"]);
    }
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

for (const kindId of ["devin", "minimax-code"] as const) {
  test(`${kindId} file readiness never observes the operator or the other independent account`, async () => {
    const userRoot = mkdtempSync(path.join(tmpdir(), "ha-file-account-readiness-")),
      bin = path.join(userRoot, "bin"),
      operatorHome = path.join(userRoot, "operator"),
      installation = witness(kindId),
      executablePath = path.join(bin, process.platform === "win32" ? `${kindId}.cmd` : kindId);
    mkdirSync(bin);
    writeProviderExecutable(executablePath, 'console.log(JSON.stringify({families:[{slug:"test-model"}]}));');
    const relative =
      kindId === "devin" ? ".local/share/devin/credentials.toml" : ".minimax/auth/prod/cn/mcode-public/auth-state.json";
    const credential =
      kindId === "devin"
        ? 'windsurf_api_key = "test-file-account"\n'
        : JSON.stringify({ status: "authenticated", expiresAtMs: Date.now() + 3600000 });
    const operatorFile = path.join(operatorHome, relative);
    mkdirSync(path.dirname(operatorFile), { recursive: true });
    writeFileSync(operatorFile, credential);
    try {
      const store = openRuntimeInstanceStore({
        userRoot,
        platform: "darwin",
        env: { HOME: operatorHome, PATH: bin },
        discover: () => [{ ...installation, executablePath }],
      });
      for (const suffix of ["one", "two"])
        store.command({
          kind: "runtime-instance-create",
          instanceId: `${kindId}-${suffix}`,
          name: suffix,
          kindId,
          installationId: installation.installationId,
          providerId: kindId,
          models: ["test-model"],
          authMode: "subscription",
          credentialSource: "instance",
        });
      assert.equal((await store.authStatus(`${kindId}-one`)).code, "runtime_subscription_required");
      const localFile = path.join(userRoot, "runtime-instances", `${kindId}-one`, "home", relative);
      mkdirSync(path.dirname(localFile), { recursive: true });
      writeFileSync(localFile, credential);
      assert.equal((await store.authStatus(`${kindId}-one`)).status, "ready");
      assert.equal((await store.authStatus(`${kindId}-two`)).code, "runtime_subscription_required");
      assert.equal(readFileSync(operatorFile, "utf8"), credential);
      if (kindId === "minimax-code") {
        writeFileSync(localFile, JSON.stringify({ status: "authenticated", expiresAtMs: 1 }));
        assert.equal((await store.authStatus(`${kindId}-one`)).code, "runtime_subscription_expired");
      }
    } finally {
      rmSync(userRoot, { recursive: true, force: true });
    }
  });
}

for (const kindId of ["codex-acp", "claude-acp"] as const) {
  test(`${kindId} login rejects missing or ambiguous native credential installations`, () => {
    const userRoot = mkdtempSync(path.join(tmpdir(), "ha-acp-credential-witness-")),
      adapter = witness(kindId),
      native = witness(kindId === "codex-acp" ? "codex" : "claude");
    let installations = [adapter];
    try {
      const store = openRuntimeInstanceStore({
        userRoot,
        platform: "darwin",
        env: { HOME: path.join(userRoot, "operator") },
        discover: () => installations,
      });
      store.command({
        kind: "runtime-instance-create",
        instanceId: kindId,
        name: kindId,
        kindId,
        installationId: adapter.installationId,
        providerId: runtimeKindForId(kindId).defaultProviderId,
        models: ["test-model"],
        authMode: "subscription",
        credentialSource: "instance",
      });
      assert.throws(
        () => store.prepareAuthCommand(kindId, "login"),
        (error: unknown) => codedAs(error, "runtime_credential_command_not_found"),
      );
      installations = [adapter, native, { ...native, installationId: `${native.installationId}-other` }];
      assert.throws(
        () => store.prepareAuthCommand(kindId, "login"),
        (error: unknown) => codedAs(error, "runtime_installation_ambiguous"),
      );
    } finally {
      rmSync(userRoot, { recursive: true, force: true });
    }
  });
}
