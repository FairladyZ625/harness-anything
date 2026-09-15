// harness-test-tier: contract
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { ensureSharedAuthFile } from "../src/agent-runtime-instance-storage.ts";
import { codedAs, observed } from "./agent-runtime-instance-environment.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

test("claude isolation defaults to the operator environment and stays enforced on request", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-claude-isolation-")),
    claude = {
      ...observed,
      installationId: "claude-isolation",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude",
    },
    agy = {
      installationId: "agy-isolation",
      kindId: "agy" as const,
      executablePath: "/opt/runtime-test/agy",
      version: "1.1.15",
      observedAt: "2026-08-20T00:00:00.000Z",
    },
    operatorEnv = {
      PATH: "/runtime/tools",
      HOME: "/operator/home",
      TMPDIR: "/operator/tmp",
      ANTHROPIC_AUTH_TOKEN: "operator-oauth",
    };
  try {
    const claudeOperatorEnv =
      process.platform === "darwin" ? { ...operatorEnv, USER: userInfo().username } : operatorEnv;
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [claude, observed, agy],
      env: operatorEnv,
      resolveCredential: () => "instance-secret",
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    store.create({
      schemaVersion: 2,
      instanceId: "claude-operator",
      name: "Claude Operator",
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
      instanceId: "claude-operator-key",
      name: "Claude Operator Key",
      kindId: "claude",
      installationId: claude.installationId,
      providerId: "anthropic",
      models: ["claude-fable-5"],
      defaultModel: "claude-fable-5",
      enabled: true,
      claude: {},
      auth: { mode: "api-key", credentialRef: "credential:v1:claude-operator-key" },
    });
    const launch = await store.prepareLaunch("claude-operator", {
        cwd: "/workspace/repo",
        prompt: "Reuse the operator login",
      }),
      login = store.prepareAuthCommand("claude-operator", "login"),
      keyLaunch = await store.prepareLaunch("claude-operator-key", {
        cwd: "/workspace/repo",
        prompt: "Key in operator env",
      });
    assert.equal(
      (
        store.command({ kind: "runtime-instance-show", instanceId: "claude-operator" }).instance as {
          readonly isolationState: string;
        }
      ).isolationState,
      "operator-environment",
    );
    assert.deepEqual(launch.env, claudeOperatorEnv);
    assert.deepEqual(keyLaunch.env, { ...claudeOperatorEnv, ANTHROPIC_API_KEY: "instance-secret" });
    assert.deepEqual(login.env, claudeOperatorEnv);
    assert.deepEqual(login.args, ["auth", "login"]);
    assert.equal(statSync(login.cwd).isDirectory(), true);
    assert.equal(existsSync(path.join(userRoot, "runtime-instances", "claude-operator", "home")), false);
    store.create({
      schemaVersion: 2,
      instanceId: "claude-enforced",
      name: "Claude Enforced",
      kindId: "claude",
      installationId: claude.installationId,
      providerId: "anthropic",
      models: ["claude-fable-5"],
      defaultModel: "claude-fable-5",
      enabled: true,
      isolationState: "enforced",
      claude: {},
      auth: { mode: "api-key", credentialRef: "credential:v1:claude-enforced" },
    });
    const isolated = await store.prepareLaunch("claude-enforced", { cwd: "/workspace/repo", prompt: "Isolate" }),
      stateRoot = path.join(userRoot, "runtime-instances", "claude-enforced");
    assert.deepEqual(
      isolated.env,
      expectedIsolatedEnvironment(stateRoot, "claude", {
        PATH: "/runtime/tools",
        ANTHROPIC_API_KEY: "instance-secret",
      }),
    );
    const codexOperator = store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-operator",
      name: "Codex Operator",
      kindId: "codex",
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      isolationState: "operator-environment",
      authMode: "subscription",
    }).instance as { readonly isolationState: string };
    assert.equal(codexOperator.isolationState, "operator-environment");
    assert.deepEqual(
      (
        await store.prepareLaunch("codex-operator", {
          cwd: "/workspace/repo",
          prompt: "Reuse the operator ChatGPT login",
        })
      ).env,
      operatorEnv,
    );
    assert.equal(existsSync(path.join(userRoot, "runtime-instances", "codex-operator", "home")), false);
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-create",
          instanceId: "codex-operator-key",
          name: "Codex Operator Key",
          kindId: "codex",
          providerId: "openai",
          models: ["gpt-5.6-sol"],
          isolationState: "operator-environment",
          authMode: "api-key",
          credentialRef: "credential:v1:codex-operator-key",
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_isolation"),
    );
    store.create({
      schemaVersion: 2,
      instanceId: "codex-keyed-enforced",
      name: "Codex Keyed Enforced",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: {},
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-keyed-enforced" },
    });
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-update",
          instanceId: "codex-keyed-enforced",
          isolationState: "operator-environment",
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_isolation"),
    );
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-create",
          instanceId: "agy-enforced",
          name: "AGY Enforced",
          kindId: "agy",
          providerId: "google",
          models: ["gemini-3.1-pro-low"],
          isolationState: "enforced",
          authMode: "subscription",
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_isolation"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("macOS Claude operator probes use the OS username and report the probed environment", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-claude-operator-probe-")),
    userRoot = path.join(root, "user"),
    bin = path.join(root, "bin"),
    readyPath = path.join(bin, "claude-ready"),
    rejectedPath = path.join(bin, "claude-rejected"),
    username = userInfo().username;
  try {
    mkdirSync(bin);
    const ready = writeProviderExecutable(
        readyPath,
        `if (process.env.USER !== ${JSON.stringify(username)}) process.exit(7);\n`,
      ),
      rejected = writeProviderExecutable(rejectedPath, "process.exit(7);\n"),
      readyInstallation: RuntimeInstallationWitness = {
        installationId: "claude-operator-ready",
        kindId: "claude",
        executablePath: ready,
        version: "2.1.240",
        observedAt: "2026-08-23T00:00:00.000Z",
      },
      rejectedInstallation: RuntimeInstallationWitness = {
        installationId: "claude-operator-rejected",
        kindId: "claude",
        executablePath: rejected,
        version: "2.1.240",
        observedAt: "2026-08-23T00:00:00.000Z",
      },
      env = { PATH: bin, HOME: "/operator/home", LANG: "C" };
    const store = openRuntimeInstanceStore({
      userRoot,
      platform: "darwin",
      env,
      discover: () => [readyInstallation, rejectedInstallation],
    });
    store.create({
      schemaVersion: 2,
      instanceId: "claude-operator-ready",
      name: "Claude Operator Ready",
      kindId: "claude",
      installationId: readyInstallation.installationId,
      providerId: "anthropic",
      models: ["sonnet"],
      defaultModel: "sonnet",
      enabled: true,
      isolationState: "operator-environment",
      claude: {},
      auth: { mode: "subscription" },
    });
    assert.deepEqual(await store.authStatus("claude-operator-ready"), { status: "ready", code: null, hint: null });
    store.create({
      schemaVersion: 2,
      instanceId: "claude-operator-rejected",
      name: "Claude Operator Rejected",
      kindId: "claude",
      installationId: rejectedInstallation.installationId,
      providerId: "anthropic",
      models: ["sonnet"],
      defaultModel: "sonnet",
      enabled: true,
      isolationState: "operator-environment",
      claude: {},
      auth: { mode: "subscription" },
    });
    assert.deepEqual(await store.authStatus("claude-operator-rejected"), {
      status: "not-ready",
      code: "runtime_subscription_required",
      hint: "Provider subscription authentication is unavailable in the operator environment.",
    });
    store.create({
      schemaVersion: 2,
      instanceId: "claude-enforced-rejected",
      name: "Claude Enforced Rejected",
      kindId: "claude",
      installationId: rejectedInstallation.installationId,
      providerId: "anthropic",
      models: ["sonnet"],
      defaultModel: "sonnet",
      enabled: true,
      isolationState: "enforced",
      claude: {},
      auth: { mode: "subscription" },
    });
    assert.deepEqual(await store.authStatus("claude-enforced-rejected"), {
      status: "not-ready",
      code: "runtime_subscription_required",
      hint: "Provider subscription authentication is unavailable in this instance state root.",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "enforced instances link the operator's shared provider auth while generated config stays in the state root",
  { skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-shared-auth-")),
      operatorHome = path.join(parent, "operator"),
      userRoot = path.join(parent, "user"),
      claude = {
        ...observed,
        installationId: "claude-shared-auth",
        kindId: "claude" as const,
        executablePath: "/opt/runtime-test/claude",
      };
    try {
      mkdirSync(path.join(operatorHome, ".codex"), { recursive: true });
      writeFileSync(path.join(operatorHome, ".codex", "auth.json"), `{"tokens":"operator-login"}`, { mode: 0o600 });
      mkdirSync(path.join(operatorHome, ".claude"), { recursive: true });
      writeFileSync(path.join(operatorHome, ".claude", ".credentials.json"), `{"oauth":"operator-login"}`, {
        mode: 0o600,
      });
      const store = openRuntimeInstanceStore({
        userRoot,
        discover: () => [observed, claude],
        env: { HOME: operatorHome, PATH: "/runtime/tools" },
        subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
      });
      store.create({
        schemaVersion: 2,
        instanceId: "codex-shared-auth",
        name: "Codex Shared Auth",
        kindId: "codex",
        installationId: observed.installationId,
        providerId: "openai",
        models: ["gpt-5.6-sol"],
        defaultModel: "gpt-5.6-sol",
        enabled: true,
        codex: {},
        auth: { mode: "subscription" },
      });
      const launch = await store.prepareLaunch("codex-shared-auth", {
          cwd: "/workspace/repo",
          prompt: "Reuse the operator login",
        }),
        stateRoot = path.join(userRoot, "runtime-instances", "codex-shared-auth"),
        linkedAuth = path.join(stateRoot, "home", ".codex", "auth.json");
      assert.equal(lstatSync(linkedAuth).isSymbolicLink(), true);
      assert.equal(readlinkSync(linkedAuth), path.join(operatorHome, ".codex", "auth.json"));
      assert.equal(existsSync(path.join(stateRoot, "home", ".codex", "config.toml")), true);
      assert.equal(existsSync(path.join(operatorHome, ".codex", "config.toml")), false);
      assert.equal(existsSync(path.join(operatorHome, ".codex", "skills")), false);
      writeFileSync(linkedAuth, `{"tokens":"refreshed-through-the-instance"}`, { mode: 0o600 });
      assert.equal(
        readFileSync(path.join(operatorHome, ".codex", "auth.json"), "utf8"),
        `{"tokens":"refreshed-through-the-instance"}`,
      );
      store.create({
        schemaVersion: 2,
        instanceId: "claude-shared-auth",
        name: "Claude Shared Auth",
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
      const login = store.prepareAuthCommand("claude-shared-auth", "login"),
        claudeCredentials = path.join(
          userRoot,
          "runtime-instances",
          "claude-shared-auth",
          "home",
          ".claude",
          ".credentials.json",
        );
      assert.equal(lstatSync(claudeCredentials).isSymbolicLink(), true);
      assert.equal(readlinkSync(claudeCredentials), path.join(operatorHome, ".claude", ".credentials.json"));
      for (const receipt of [launch, login]) assert.doesNotMatch(JSON.stringify(receipt), /operator-login/u);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test("auth sharing rejects a source that is also its destination without replacing the credential", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-auth-self-reference-")),
    authFile = path.join(parent, "home", ".codex", "auth.json"),
    contents = `{"tokens":"operator-login"}`;
  try {
    mkdirSync(path.dirname(authFile), { recursive: true });
    writeFileSync(authFile, contents, { mode: 0o600 });
    assert.throws(
      () => ensureSharedAuthFile(authFile, path.join(parent, "home", ".codex", ".", "auth.json")),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { readonly code?: string }).code === "runtime_auth_share_self_reference" &&
        /same path/u.test(error.message),
    );
    assert.equal(lstatSync(authFile).isSymbolicLink(), false, "the credential must remain a regular file");
    assert.equal(readFileSync(authFile, "utf8"), contents, "the rejected link must not mutate the credential");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("api-key instances never receive the operator's shared provider credentials", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-api-key-no-shared-auth-")),
    operatorHome = path.join(parent, "operator"),
    userRoot = path.join(parent, "user"),
    claude = {
      ...observed,
      installationId: "claude-api-key-no-shared-auth",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude",
    };
  try {
    mkdirSync(path.join(operatorHome, ".codex"), { recursive: true });
    writeFileSync(path.join(operatorHome, ".codex", "auth.json"), `{"tokens":"operator-login"}`, { mode: 0o600 });
    mkdirSync(path.join(operatorHome, ".claude"), { recursive: true });
    writeFileSync(path.join(operatorHome, ".claude", ".credentials.json"), `{"oauth":"operator-login"}`, {
      mode: 0o600,
    });
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed, claude],
      env: { HOME: operatorHome, PATH: "/runtime/tools" },
      resolveCredential: () => "instance-secret",
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-api-key-isolated",
      name: "Codex API Key Isolated",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "codex_local_access",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: { baseUrl: "http://127.0.0.1:1/v1" },
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-api-key-isolated" },
    });
    const codexLaunch = await store.prepareLaunch("codex-api-key-isolated", {
      cwd: "/workspace/repo",
      prompt: "Route through the broker key only",
    });
    assert.equal(
      existsSync(path.join(userRoot, "runtime-instances", "codex-api-key-isolated", "home", ".codex", "auth.json")),
      false,
    );
    assert.match(
      readFileSync(path.join(codexLaunch.env.CODEX_HOME!, "config.toml"), "utf8"),
      /experimental_bearer_token = "instance-secret"/u,
    );
    assert.equal(existsSync(path.join(operatorHome, ".codex", "config.toml")), false);
    store.create({
      schemaVersion: 2,
      instanceId: "claude-api-key-isolated",
      name: "Claude API Key Isolated",
      kindId: "claude",
      installationId: claude.installationId,
      providerId: "anthropic",
      models: ["claude-fable-5"],
      defaultModel: "claude-fable-5",
      enabled: true,
      isolationState: "enforced",
      claude: {},
      auth: { mode: "api-key", credentialRef: "credential:v1:claude-api-key-isolated" },
    });
    const claudeLaunch = await store.prepareLaunch("claude-api-key-isolated", {
      cwd: "/workspace/repo",
      prompt: "Route through the broker key only",
    });
    assert.equal(
      existsSync(
        path.join(userRoot, "runtime-instances", "claude-api-key-isolated", "home", ".claude", ".credentials.json"),
      ),
      false,
    );
    assert.equal(claudeLaunch.env.ANTHROPIC_API_KEY, "instance-secret");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test(
  "a stale auth copy or wrong-target link is dropped and re-linked on the next ensure",
  { skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-auth-refresh-")),
      operatorHome = path.join(parent, "operator"),
      userRoot = path.join(parent, "user");
    try {
      const operatorAuth = path.join(operatorHome, ".codex", "auth.json");
      mkdirSync(path.dirname(operatorAuth), { recursive: true });
      writeFileSync(operatorAuth, `{"tokens":"v1"}`, { mode: 0o600 });
      const store = openRuntimeInstanceStore({
        userRoot,
        discover: () => [observed],
        env: { HOME: operatorHome, PATH: "/runtime/tools" },
        subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
      });
      store.create({
        schemaVersion: 2,
        instanceId: "codex-auth-refresh",
        name: "Codex Auth Refresh",
        kindId: "codex",
        installationId: observed.installationId,
        providerId: "openai",
        models: ["gpt-5.6-sol"],
        defaultModel: "gpt-5.6-sol",
        enabled: true,
        codex: {},
        auth: { mode: "subscription" },
      });
      const instanceAuth = path.join(
        userRoot,
        "runtime-instances",
        "codex-auth-refresh",
        "home",
        ".codex",
        "auth.json",
      );
      rmSync(instanceAuth);
      writeFileSync(instanceAuth, `{"tokens":"stale-copy"}`, { mode: 0o600 });
      writeFileSync(operatorAuth, `{"tokens":"v2"}`, { mode: 0o600 });
      await store.authStatus("codex-auth-refresh");
      assert.equal(lstatSync(instanceAuth).isSymbolicLink(), true);
      assert.equal(readFileSync(instanceAuth, "utf8"), `{"tokens":"v2"}`);
      rmSync(instanceAuth);
      symlinkSync(`${operatorAuth}.bak`, instanceAuth);
      await store.authStatus("codex-auth-refresh");
      assert.equal(readlinkSync(instanceAuth), operatorAuth);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test("a missing operator auth file links nothing and leaves an instance-local login in place", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-auth-absent-")),
    operatorHome = path.join(parent, "operator"),
    userRoot = path.join(parent, "user");
  try {
    mkdirSync(operatorHome, { recursive: true });
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed],
      env: { HOME: operatorHome, PATH: "/runtime/tools" },
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-auth-absent",
      name: "Codex Auth Absent",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: {},
      auth: { mode: "subscription" },
    });
    const instanceAuth = path.join(userRoot, "runtime-instances", "codex-auth-absent", "home", ".codex", "auth.json");
    assert.equal(existsSync(instanceAuth), false);
    writeFileSync(instanceAuth, `{"tokens":"instance-local-login"}`, { mode: 0o600 });
    await store.authStatus("codex-auth-absent");
    assert.equal(lstatSync(instanceAuth).isSymbolicLink(), false);
    assert.equal(readFileSync(instanceAuth, "utf8"), `{"tokens":"instance-local-login"}`);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("operator-environment codex accepts prompt-injected skills without writing operator home", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-codex-operator-skills-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    operatorEnv = { HOME: path.join(parent, "operator"), PATH: "/runtime/tools" };
  try {
    const prompt = `Skilled dispatch\n\n# Required Skills\n\n- probe: ${path.join(parent, "shared", "probe", "SKILL.md")}`;
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed],
      env: operatorEnv,
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-operator-skills",
      name: "Codex Operator Skills",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      isolationState: "operator-environment",
      codex: {},
      auth: { mode: "subscription" },
    });
    const launch = await store.prepareLaunch("codex-operator-skills", { cwd: rootDir, prompt });
    assert.deepEqual(launch.env, operatorEnv);
    assert.equal(launch.env.CODEX_HOME, undefined);
    assert.equal(existsSync(path.join(userRoot, "runtime-instances", "codex-operator-skills", "home")), false);
    assert.equal(launch.prompt, prompt);
    assert.equal(launch.args.includes("--plugin-dir"), false);
    assert.equal(launch.args.includes("--add-dir"), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("win32 instances derive USERPROFILE/TEMP/APPDATA isolation without POSIX variables", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-win32-isolation-"));
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed],
      platform: "win32",
      env: {
        PATH: "C:\\runtime\\tools",
        HOME: "C:\\host\\home",
        TMPDIR: "C:\\host\\tmp",
        SYSTEMROOT: "C:\\Windows",
        SYSTEMDRIVE: "C:",
        COMSPEC: "C:\\Windows\\system32\\cmd.exe",
        PATHEXT: ".COM;.EXE;.CMD",
        OPENAI_API_KEY: "host-secret",
      },
      resolveCredential: () => "instance-secret",
    });
    store.create({
      schemaVersion: 1,
      instanceId: "codex-win",
      name: "Codex Windows",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      model: "gpt-5.6-sol",
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-win" },
    });
    const launch = await store.prepareLaunch("codex-win", { cwd: "/workspace/repo", prompt: "Inspect" }),
      stateRoot = path.join(userRoot, "runtime-instances", "codex-win");
    assert.deepEqual(launch.env, {
      PATH: "C:\\runtime\\tools",
      PATHEXT: ".COM;.EXE;.CMD",
      SYSTEMROOT: "C:\\Windows",
      SYSTEMDRIVE: "C:",
      COMSPEC: "C:\\Windows\\system32\\cmd.exe",
      USERPROFILE: path.join(stateRoot, "home"),
      TEMP: path.join(stateRoot, "tmp"),
      TMP: path.join(stateRoot, "tmp"),
      APPDATA: path.join(stateRoot, "home", "AppData", "Roaming"),
      LOCALAPPDATA: path.join(stateRoot, "home", "AppData", "Local"),
      CODEX_HOME: path.join(stateRoot, "home", ".codex"),
    });
    assert.match(
      readFileSync(path.join(launch.env.CODEX_HOME!, "config.toml"), "utf8"),
      /experimental_bearer_token = "instance-secret"/u,
    );
    assert.equal("HOME" in launch.env, false);
    assert.equal("TMPDIR" in launch.env, false);
    assert.equal("XDG_RUNTIME_DIR" in launch.env, false);
    assert.equal(Object.values(launch.env).includes("host-secret"), false);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("linux instances keep the POSIX isolation shape distinct from the host", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-linux-isolation-"));
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [
        {
          ...observed,
          kindId: "claude",
          installationId: "claude-installation-test",
          executablePath: "/opt/runtime-test/claude",
        },
      ],
      platform: "linux",
      env: {
        PATH: "/runtime/tools",
        HOME: "/host/home",
        USERPROFILE: "C:\\host\\home",
        XDG_RUNTIME_DIR: "/host/run/xdg",
        ANTHROPIC_API_KEY: "host-secret",
      },
    });
    store.create({
      schemaVersion: 2,
      instanceId: "claude-linux",
      name: "Claude Linux",
      kindId: "claude",
      installationId: "claude-installation-test",
      providerId: "anthropic",
      models: ["claude-fable-5"],
      defaultModel: "claude-fable-5",
      enabled: true,
      isolationState: "enforced",
      claude: {},
      auth: { mode: "subscription" },
    });
    const command = store.prepareAuthCommand("claude-linux", "login"),
      stateRoot = path.join(userRoot, "runtime-instances", "claude-linux");
    assert.deepEqual(command.env, {
      PATH: "/runtime/tools",
      HOME: path.join(stateRoot, "home"),
      TMPDIR: path.join(stateRoot, "tmp"),
      XDG_RUNTIME_DIR: path.join(stateRoot, "run"),
      CLAUDE_CONFIG_DIR: path.join(stateRoot, "home", ".claude"),
    });
    assert.equal("USERPROFILE" in command.env, false);
    assert.equal(Object.values(command.env).includes("host-secret"), false);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("two same-binary same-model instances never share state roots or credentials", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-pair-isolation-"));
  try {
    const vault = new Map<string, string>([
        ["credential:v1:codex-a", "secret-a"],
        ["credential:v1:codex-b", "secret-b"],
      ]),
      secrets: string[] = [];
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed],
      resolveCredential: (reference) => {
        if (!vault.has(reference)) throw new Error(`missing ${reference}`);
        const secret = vault.get(reference)!;
        secrets.push(secret);
        return secret;
      },
    });
    for (const [suffix, reference] of [
      ["a", "credential:v1:codex-a"],
      ["b", "credential:v1:codex-b"],
    ] as const)
      store.create({
        schemaVersion: 1,
        instanceId: `codex-pair-${suffix}`,
        name: `Codex Pair ${suffix}`,
        kindId: "codex",
        installationId: observed.installationId,
        providerId: "openai",
        model: "gpt-5.6-sol",
        auth: { mode: "api-key", credentialRef: reference },
      });
    const launchA = await store.prepareLaunch("codex-pair-a", { cwd: "/workspace/repo", prompt: "A" }),
      launchB = await store.prepareLaunch("codex-pair-b", { cwd: "/workspace/repo", prompt: "B" }),
      rootA = path.join(userRoot, "runtime-instances", "codex-pair-a"),
      rootB = path.join(userRoot, "runtime-instances", "codex-pair-b");
    assert.notEqual(rootA, rootB);
    const homeA = launchA.env.HOME ?? launchA.env.USERPROFILE,
      homeB = launchB.env.HOME ?? launchB.env.USERPROFILE,
      tmpA = launchA.env.TMPDIR ?? launchA.env.TEMP,
      tmpB = launchB.env.TMPDIR ?? launchB.env.TEMP;
    assert.notEqual(homeA, homeB);
    assert.notEqual(tmpA, tmpB);
    assert.match(
      readFileSync(path.join(launchA.env.CODEX_HOME!, "config.toml"), "utf8"),
      /experimental_bearer_token = "secret-a"/u,
    );
    assert.match(
      readFileSync(path.join(launchB.env.CODEX_HOME!, "config.toml"), "utf8"),
      /experimental_bearer_token = "secret-b"/u,
    );
    assert.equal(Object.values(launchA.env).includes("secret-b"), false);
    assert.equal(Object.values(launchB.env).includes("secret-a"), false);
    assert.equal(JSON.stringify(launchA).includes("secret-b"), false);
    assert.equal(JSON.stringify(launchB).includes("secret-a"), false);
    store.create({
      schemaVersion: 1,
      instanceId: "codex-pair-c",
      name: "Codex Pair C",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      model: "gpt-5.6-sol",
      auth: { mode: "api-key", credentialRef: "credential:v1:not-in-vault" },
    });
    await assert.rejects(
      store.prepareLaunch("codex-pair-c", { cwd: "/workspace/repo", prompt: "C" }),
      (error: unknown) => codedAs(error, "runtime_credential_unavailable"),
    );
    assert.equal(secrets.includes("secret-a"), true);
    assert.equal(secrets.includes("secret-b"), true);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

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
