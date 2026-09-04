// harness-test-tier: contract
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  discoverRuntimeInstallations,
  openRuntimeInstanceStore,
  type RuntimeAuthReadiness,
  type RuntimeInstallationWitness,
} from "../src/agent-runtime-instances.ts";
import { ensureSharedAuthFile } from "../src/agent-runtime-instance-storage.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

const observed: RuntimeInstallationWitness = {
  installationId: "codex-installation-test",
  kindId: "codex",
  executablePath: "/opt/runtime-test/codex",
  version: "0.146.1",
  observedAt: "2026-08-15T00:00:00.000Z",
};

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

test("permission defaults open and tightens through the instance record or a single dispatch", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-permission-")),
    claude = {
      ...observed,
      installationId: "claude-permission",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude",
    };
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed, claude],
      resolveCredential: () => "instance-secret",
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-open",
      name: "Codex Open",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: {},
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-open" },
    });
    store.create({
      schemaVersion: 2,
      instanceId: "claude-open",
      name: "Claude Open",
      kindId: "claude",
      installationId: claude.installationId,
      providerId: "anthropic",
      models: ["claude-fable-5"],
      defaultModel: "claude-fable-5",
      enabled: true,
      isolationState: "enforced",
      claude: {},
      auth: { mode: "api-key", credentialRef: "credential:v1:claude-open" },
    });
    const codexDefault = await store.prepareLaunch("codex-open", { cwd: "/workspace/repo", prompt: "Default" }),
      claudeDefault = await store.prepareLaunch("claude-open", { cwd: "/workspace/repo", prompt: "Default" });
    assert.deepEqual(codexDefault.args, [
      "exec",
      "--json",
      "--sandbox",
      "danger-full-access",
      "--model",
      "gpt-5.6-sol",
      "-",
    ]);
    assert.deepEqual(claudeDefault.args, [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      "claude-fable-5",
      "--bare",
    ]);
    store.command({ kind: "runtime-instance-update", instanceId: "codex-open", permissionMode: "workspace-write" });
    const tightened = await store.prepareLaunch("codex-open", { cwd: "/workspace/repo", prompt: "Tightened" });
    assert.deepEqual(tightened.args, [
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--config",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "--config",
      "sandbox_workspace_write.exclude_slash_tmp=true",
      "--model",
      "gpt-5.6-sol",
      "-",
    ]);
    assert.equal(store.read("codex-open")?.permissionMode, "workspace-write");
    const dispatched = await store.prepareLaunch("codex-open", {
        cwd: "/workspace/repo",
        prompt: "Dispatch",
        permissionMode: "read-only",
      }),
      claudeDispatched = await store.prepareLaunch("claude-open", {
        cwd: "/workspace/repo",
        prompt: "Dispatch",
        permissionMode: "read-only",
      });
    assert.deepEqual(dispatched.args, ["exec", "--json", "--sandbox", "read-only", "--model", "gpt-5.6-sol", "-"]);
    assert.deepEqual(claudeDispatched.args, [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "plan",
      "--model",
      "claude-fable-5",
      "--bare",
    ]);
    const resumedBypass = await store.prepareLaunch("codex-open", {
        cwd: "/workspace/repo",
        prompt: "Resume open",
        providerSessionId: "session-bypass",
        permissionMode: "bypass",
      }),
      resumedWorkspace = await store.prepareLaunch("codex-open", {
        cwd: "/workspace/repo",
        prompt: "Resume workspace",
        providerSessionId: "session-workspace",
      }),
      resumedReadOnly = await store.prepareLaunch("codex-open", {
        cwd: "/workspace/repo",
        prompt: "Resume read-only",
        providerSessionId: "session-read-only",
        permissionMode: "read-only",
      });
    assert.deepEqual(resumedBypass.args, [
      "exec",
      "resume",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5.6-sol",
      "session-bypass",
      "-",
    ]);
    assert.deepEqual(resumedWorkspace.args, [
      "exec",
      "resume",
      "--json",
      "--config",
      'sandbox_mode="workspace-write"',
      "--config",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "--config",
      "sandbox_workspace_write.exclude_slash_tmp=true",
      "--model",
      "gpt-5.6-sol",
      "session-workspace",
      "-",
    ]);
    assert.deepEqual(resumedReadOnly.args, [
      "exec",
      "resume",
      "--json",
      "--config",
      'sandbox_mode="read-only"',
      "--model",
      "gpt-5.6-sol",
      "session-read-only",
      "-",
    ]);
    for (const resumed of [resumedBypass, resumedWorkspace, resumedReadOnly])
      assert.equal(resumed.args.includes("--sandbox"), false);
    assert.equal(store.read("codex-open")?.permissionMode, "workspace-write");
    await assert.rejects(
      store.prepareLaunch("codex-open", { cwd: "/workspace/repo", prompt: "Bad", permissionMode: "turbo" }),
      (error: unknown) => codedAs(error, "invalid_runtime_permission"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("agy defaults to bypass and distinguishes persisted restrictions from a dispatch override", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-agy-permission-")),
    agy = {
      installationId: "agy-permission",
      kindId: "agy" as const,
      executablePath: "/opt/runtime-test/agy",
      version: "1.1.22",
      observedAt: "2026-08-29T00:00:00.000Z",
    };
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [agy],
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "agy-open",
      name: "AGY Open",
      kindId: "agy",
      providerId: "google",
      models: ["gemini-3.1-pro-low"],
      authMode: "subscription",
    });
    assert.equal(
      (
        store.command({ kind: "runtime-instance-show", instanceId: "agy-open" }).instance as {
          readonly permissionMode: string | null;
        }
      ).permissionMode,
      "bypass",
    );
    const defaultLaunch = await store.prepareLaunch("agy-open", { cwd: "/workspace/repo", prompt: "Default" });
    assert.deepEqual(defaultLaunch.args, [
      "-p",
      "Default",
      "--output-format",
      "stream-json",
      "--model",
      "gemini-3.1-pro-low",
      "--dangerously-skip-permissions",
    ]);
    store.command({ kind: "runtime-instance-update", instanceId: "agy-open", permissionMode: "read-only" });
    const restricted = await store.prepareLaunch("agy-open", { cwd: "/workspace/repo", prompt: "Restricted" }),
      overridden = await store.prepareLaunch("agy-open", {
        cwd: "/workspace/repo",
        prompt: "Override",
        permissionMode: "bypass",
      });
    assert.equal(restricted.args.includes("--dangerously-skip-permissions"), false);
    assert.equal(overridden.args.includes("--dangerously-skip-permissions"), true);
    assert.equal(store.read("agy-open")?.permissionMode, "read-only");
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

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
    assert.deepEqual(isolated.env, {
      PATH: "/runtime/tools",
      HOME: path.join(stateRoot, "home"),
      TMPDIR: path.join(stateRoot, "tmp"),
      XDG_RUNTIME_DIR: path.join(stateRoot, "run"),
      CLAUDE_CONFIG_DIR: path.join(stateRoot, "home", ".claude"),
      ANTHROPIC_API_KEY: "instance-secret",
    });
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
    assert.equal(statSync(providerConfigDirectory).mode & 0o777, 0o700);
    assert.equal(existsSync(path.join(stateRoot, "home", ".claude")), false);
    const command = store.prepareAuthCommand("codex-sub", "login");
    assert.equal(command.executablePath, observed.executablePath);
    assert.deepEqual(command.args, ["login"]);
    assert.equal(command.cwd, stateRoot);
    assert.deepEqual(command.env, {
      PATH: "/runtime/tools",
      HOME: path.join(stateRoot, "home"),
      TMPDIR: path.join(stateRoot, "tmp"),
      XDG_RUNTIME_DIR: path.join(stateRoot, "run"),
      CODEX_HOME: providerConfigDirectory,
    });
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
    assert.notEqual(launchA.env.HOME, launchB.env.HOME);
    assert.notEqual(launchA.env.TMPDIR, launchB.env.TMPDIR);
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
function codedAs(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
