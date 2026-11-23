// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "../src/daemon-host/client/local-daemon-target.ts";
import {
  openRuntimeInstanceStore,
  type RuntimeInstallationWitness,
} from "../src/daemon-host/agent-runtime-instances.ts";
import {
  launchArgs,
  maxLinkedWorktreeGitMetadataBytes,
  resolveLinkedWorktreeGitRoots,
  type LinkedWorktreeGitMetadataFs,
} from "../src/daemon-host/agent-runtime-launch-config.ts";
import { makeRuntimeSpawner } from "../src/daemon-host/runtime-spawner.ts";
import type { RuntimeSpawnerInput } from "../src/daemon-host/runtime-spawn-types.ts";
import { emptyDispatchLifecycleRead } from "./dispatch-lifecycle-read.fixtures.ts";
import { dispatchMissionForPermission, explicitPromptMission } from "../src/daemon-host/runtime-spawn-mission.ts";
import { dispatchCallbackRelay } from "../src/daemon-host/runtime-callback-relay.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

const observed: RuntimeInstallationWitness = {
  installationId: "codex-installation-test",
  kindId: "codex",
  executablePath: "/opt/runtime-test/codex",
  version: "0.146.1",
  observedAt: "2026-08-15T00:00:00.000Z",
};

test("Claude workspace-write permits the mission's CLI entries across isolation, auth and resume", async (t) => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-claude-task-permission-")),
    claude: RuntimeInstallationWitness = {
      ...observed,
      kindId: "claude",
      installationId: "claude-task-permission",
      executablePath: "/opt/runtime-test/claude",
      version: "2.1.305 (Claude Code)",
    },
    claudeSubscriptionInstallations = (["enforced", "operator-environment"] as const).map((isolationState) => ({
      ...claude,
      installationId: `${claude.installationId}-${isolationState}`,
    })),
    store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [claude, ...claudeSubscriptionInstallations],
      resolveCredential: () => "test-key",
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
      platform: "darwin",
    });
  t.after(() => removeTempRepository(userRoot));
  const mission = dispatchMissionForPermission(explicitPromptMission("task_own", null, "Deliver."), "workspace-write", {
    kindId: "claude",
    platform: process.platform,
    reviewer: false,
    taskBound: true,
  });
  for (const isolationState of ["enforced", "operator-environment"] as const)
    for (const mode of ["subscription", "api-key"] as const) {
      const instanceId = `claude-${isolationState}-${mode}`;
      const installationId =
        mode === "subscription"
          ? claudeSubscriptionInstallations.find((installation) =>
              installation.installationId.endsWith(isolationState),
            )!.installationId
          : claude.installationId;
      store.create({
        schemaVersion: 2,
        instanceId,
        name: instanceId,
        kindId: "claude",
        installationId,
        providerId: "anthropic",
        models: ["claude-fable-5"],
        defaultModel: "claude-fable-5",
        enabled: true,
        isolationState,
        permissionMode: "workspace-write",
        claude: {},
        auth: mode === "api-key" ? { mode, credentialRef: `credential:v1:${instanceId}` } : { mode },
      });
      for (const providerSessionId of [undefined, "session-existing"]) {
        const launch = await store.prepareLaunch(instanceId, {
            cwd: "/workspace/repo",
            prompt: mission,
            providerSessionId,
          }),
          start = launch.args.indexOf("--allowedTools");
        assert.notEqual(start, -1, `${instanceId}: the task CLI must run without an approval prompt`);
        assert.deepEqual(
          launch.args.slice(start + 1, launch.args.indexOf("--model")),
          ["ha"].flatMap((prefix) =>
            [
              "--help",
              "task submit",
              "task escalate",
              "task read-set",
              "task show",
              "task push",
              "doc show",
              "fact record",
            ].map((command) => `Bash(${prefix} ${command} *)`),
          ),
        );
        assert.equal(launch.args[launch.args.indexOf("--permission-mode") + 1], "acceptEdits");
        assert.equal(launch.args.includes("--add-dir"), false, "canonical reads must not grant canonical edits");
        assert.equal(launch.args.includes("bypassPermissions"), false);
        const settings = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]!);
        assert.deepEqual(settings.sandbox, {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          failIfUnavailable: true,
          filesystem: { disabled: false },
          // Loopback listening is open on macOS only; outbound stays denied by the empty allowlist.
          network: { allowedDomains: [], allowLocalBinding: true },
        });
        assert.equal(settings.attribution.commit, "");
        assert.equal(launch.args[launch.args.indexOf("--setting-sources") + 1], "");
        assert.equal(
          launch.args.some((arg) => /npx harness-anything|node packages\/cli/u.test(arg)),
          false,
        );
        assert.equal(launch.env.HARNESS_EXECUTION_CREDENTIAL, undefined, "binding supplies the dispatch secret later");
        assert.equal(launch.args.includes("--resume"), providerSessionId !== undefined);
      }
    }
  for (const command of ["task submit <task-id>", "task escalate <task-id>", "task read-set task_own"])
    assert.ok(mission.includes(`ha ${command}`), command);
  for (const prefix of ["ha"])
    assert.ok(mission.includes(`\`${prefix}\``), `the mission must name the approved entry ${prefix}`);
  for (const command of [
    "--help",
    "task submit",
    "task escalate",
    "task read-set",
    "task show",
    "task push",
    "doc show",
    "fact record",
  ])
    assert.ok(mission.includes(`\`${command}\``), `the mission must name the approved subcommand ${command}`);
  assert.match(mission, /ha doc show --path <ledger path> --raw/u);
  const config = store.read("claude-enforced-subscription")!;
  assert.throws(
    () => launchArgs(config, "claude-fable-5", mission, undefined, null, "workspace-write", false, undefined, "win32"),
    { code: "claude_workspace_sandbox_unavailable" },
  );
});

test("Claude workspace-write CLI uses only its per-dispatch relay socket", async (t) => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-claude-relay-permission-")),
    claude: RuntimeInstallationWitness = {
      ...observed,
      kindId: "claude",
      installationId: "claude-relay-permission",
      executablePath: "/opt/runtime-test/claude",
      version: "2.1.305 (Claude Code)",
    },
    store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [claude],
      resolveCredential: () => "test-key",
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
      platform: "darwin",
    });
  t.after(() => removeTempRepository(userRoot));
  store.create({
    schemaVersion: 2,
    instanceId: "claude-relay",
    name: "Claude Relay",
    kindId: "claude",
    installationId: claude.installationId,
    providerId: "anthropic",
    models: ["claude-fable-5"],
    defaultModel: "claude-fable-5",
    enabled: true,
    isolationState: "enforced",
    permissionMode: "workspace-write",
    claude: {},
    auth: { mode: "subscription" },
  });
  const callbackRelayPath = "/tmp/ha-dispatch_0123456789abcdef01234567.sock",
    launch = await store.prepareLaunch("claude-relay", {
      cwd: "/workspace/repo",
      prompt: "Run the authorized task submit command.",
      callbackRelayPath,
    }),
    settings = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]!);
  assert.deepEqual(settings.sandbox.network, {
    allowedDomains: [],
    allowLocalBinding: true,
    allowUnixSockets: [callbackRelayPath],
  });
  assert.equal(Object.hasOwn(settings.sandbox, "excludedCommands"), false);
});

test("Claude workspace-write selects a relay only for the workspace-write permission mode", () => {
  const userRoot = path.join(tmpdir(), "ha-claude-relay-route"),
    daemonId = "claude-relay-test",
    route = { userRoot, daemonId, endpoint: localUserDaemonEndpoint(userRoot, daemonId) },
    dispatchId = "dispatch_0123456789abcdef01234567",
    claude = { kindId: "claude", isolationState: "operator-environment", permissionMode: null };
  assert.ok(dispatchCallbackRelay(dispatchId, route, claude, "workspace-write"));
  assert.equal(dispatchCallbackRelay(dispatchId, route, claude, "read-only"), undefined);
  assert.ok(dispatchCallbackRelay(dispatchId, route, { kindId: "codex", isolationState: "enforced" }));
});

test("permission defaults open and tightens through the instance record or a single dispatch", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-permission-")),
    claude = {
      ...observed,
      installationId: "claude-permission",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude",
      version: "2.1.305 (Claude Code)",
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
    assert.equal(store.read("codex-open")?.isolationState, "enforced");
    const codexDefault = await store.prepareLaunch("codex-open", { cwd: "/workspace/repo", prompt: "Default" }),
      claudeDefault = await store.prepareLaunch("claude-open", { cwd: "/workspace/repo", prompt: "Default" });
    assert.deepEqual(codexDefault.args, [
      "exec",
      "--json",
      "--sandbox",
      "danger-full-access",
      "--model",
      "gpt-5.6-sol",
      "--config",
      'web_search="disabled"',
      "--config",
      'shell_environment_policy={inherit="all",ignore_default_excludes=true,exclude=[],include_only=[]}',
      "-",
    ]);
    assert.deepEqual(claudeDefault.args, [
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
      "--bare",
      "--strict-mcp-config",
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
      "--config",
      'web_search="disabled"',
      "--config",
      'shell_environment_policy={inherit="all",ignore_default_excludes=true,exclude=[],include_only=[]}',
      "-",
    ]);
    const relayEnabled = await store.prepareLaunch("codex-open", {
      cwd: "/workspace/repo",
      prompt: "Relay enabled",
      callbackRelayPath: "/tmp/harness-anything-501/r-0123456789abcdef01234567.sock",
    });
    assert.deepEqual(relayEnabled.args, [
      "exec",
      "--json",
      "--config",
      'default_permissions="harness-callback-relay"',
      "--config",
      'permissions.harness-callback-relay.extends=":workspace"',
      "--config",
      'permissions.harness-callback-relay.filesystem={":slash_tmp"="deny",":tmpdir"="deny"}',
      "--config",
      "features.network_proxy=true",
      "--config",
      'permissions.harness-callback-relay.network={enabled=true,domains={},unix_sockets={"/tmp/harness-anything-501/r-0123456789abcdef01234567.sock"="allow"}}',
      "--model",
      "gpt-5.6-sol",
      "--config",
      'web_search="disabled"',
      "--config",
      'shell_environment_policy={inherit="all",ignore_default_excludes=true,exclude=[],include_only=[]}',
      "-",
    ]);
    const resumedRelay = await store.prepareLaunch("codex-open", {
      cwd: "/workspace/repo",
      prompt: "Resume relay",
      providerSessionId: "session-relay",
      callbackRelayPath: "/tmp/harness-anything-501/r-0123456789abcdef01234567.sock",
    });
    assert.deepEqual(resumedRelay.args, [
      "exec",
      "resume",
      "--json",
      "--config",
      'default_permissions="harness-callback-relay"',
      "--config",
      'permissions.harness-callback-relay.extends=":workspace"',
      "--config",
      'permissions.harness-callback-relay.filesystem={":slash_tmp"="deny",":tmpdir"="deny"}',
      "--config",
      "features.network_proxy=true",
      "--config",
      'permissions.harness-callback-relay.network={enabled=true,domains={},unix_sockets={"/tmp/harness-anything-501/r-0123456789abcdef01234567.sock"="allow"}}',
      "--model",
      "gpt-5.6-sol",
      "--config",
      'web_search="disabled"',
      "--config",
      'shell_environment_policy={inherit="all",ignore_default_excludes=true,exclude=[],include_only=[]}',
      "session-relay",
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
    assert.deepEqual(dispatched.args, [
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--model",
      "gpt-5.6-sol",
      "--config",
      'web_search="disabled"',
      "--config",
      'shell_environment_policy={inherit="all",ignore_default_excludes=true,exclude=[],include_only=[]}',
      "-",
    ]);
    assert.deepEqual(claudeDispatched.args, [
      "-p",
      "--verbose",
      "--settings",
      '{"attribution":{"commit":"","pr":"","sessionUrl":false}}',
      "--output-format",
      "stream-json",
      "--permission-mode",
      "plan",
      "--model",
      "claude-fable-5",
      "--bare",
      "--strict-mcp-config",
    ]);
    for (const providerSessionId of [undefined, "session-bypass-relay"]) {
      const bypassRelay = await store.prepareLaunch("codex-open", {
        cwd: "/workspace/repo",
        prompt: "Bypass ignores the sandbox callback profile",
        permissionMode: "bypass",
        ...(providerSessionId ? { providerSessionId } : {}),
        callbackRelayPath: "/tmp/harness-anything-501/r-0123456789abcdef01234567.sock",
      });
      assert.deepEqual(bypassRelay.args, [
        "exec",
        ...(providerSessionId ? ["resume"] : []),
        "--json",
        ...(providerSessionId ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", "danger-full-access"]),
        "--model",
        "gpt-5.6-sol",
        "--config",
        'web_search="disabled"',
        "--config",
        'shell_environment_policy={inherit="all",ignore_default_excludes=true,exclude=[],include_only=[]}',
        ...(providerSessionId ? [providerSessionId] : []),
        "-",
      ]);
    }
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
      "--config",
      'web_search="disabled"',
      "--config",
      'shell_environment_policy={inherit="all",ignore_default_excludes=true,exclude=[],include_only=[]}',
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
      "--config",
      'web_search="disabled"',
      "--config",
      'shell_environment_policy={inherit="all",ignore_default_excludes=true,exclude=[],include_only=[]}',
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
      "--config",
      'web_search="disabled"',
      "--config",
      'shell_environment_policy={inherit="all",ignore_default_excludes=true,exclude=[],include_only=[]}',
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
    removeTempRepository(userRoot);
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
      "--output-format",
      "stream-json",
      "--print-timeout",
      "120m",
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
    removeTempRepository(userRoot);
  }
});

test("codex isolation edits persist and read back through the same projection the GUI reads", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-isolation-"));
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed],
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-isolated",
      isolationState: "enforced",
      name: "Codex Isolated",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: {},
      auth: { mode: "subscription" },
    });
    const readIsolation = () =>
      (
        store.command({ kind: "runtime-instance-show", instanceId: "codex-isolated" }).instance as {
          readonly isolationState: string;
        }
      ).isolationState;
    assert.equal(readIsolation(), "enforced");
    store.command({
      kind: "runtime-instance-update",
      instanceId: "codex-isolated",
      isolationState: "operator-environment",
    });
    assert.equal(readIsolation(), "operator-environment");
    store.command({
      kind: "runtime-instance-update",
      instanceId: "codex-isolated",
      isolationState: "enforced",
    });
    assert.equal(readIsolation(), "enforced");
    assert.equal(store.read("codex-isolated")?.isolationState, "enforced");
  } finally {
    removeTempRepository(userRoot);
  }
});

test("agy accepts each isolation state declared by its provider contract", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-agy-isolation-")),
    agy = {
      installationId: "agy-isolation",
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
      instanceId: "agy-isolated",
      name: "Agy Isolated",
      kindId: "agy",
      providerId: "google",
      models: ["gemini-3.1-pro-low"],
      authMode: "subscription",
    });
    store.command({
      kind: "runtime-instance-update",
      instanceId: "agy-isolated",
      isolationState: "enforced",
    });
    assert.equal(store.read("agy-isolated")?.isolationState, "enforced");
    store.command({
      kind: "runtime-instance-update",
      instanceId: "agy-isolated",
      isolationState: "operator-environment",
    });
    assert.equal(store.read("agy-isolated")?.isolationState, "operator-environment");
  } finally {
    removeTempRepository(userRoot);
  }
});

// DeepSeek Harness reads its sandbox and approval policy from DSH_PERMISSION_MODE, so the
// permission mode lands in the provider environment (catalog launch.permissionEnvironment),
// and the model rides the ACP launch manifest instead of argv.
test("environment-borne permission modes reach the provider environment and ACP launches carry the model", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-permission-env-")),
    dsh: RuntimeInstallationWitness = {
      installationId: "deepseek-harness-permission",
      kindId: "deepseek-harness",
      executablePath: "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
      version: "0.2.1-rc.2",
      observedAt: "2026-10-18T00:00:00.000Z",
    };
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed, dsh],
      env: { HOME: "/Users/operator", PATH: "/usr/bin" },
      resolveGithubToken: async () => "github-token",
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    store.create({
      schemaVersion: 2,
      instanceId: "dsh-default",
      name: "DeepSeek Harness",
      kindId: "deepseek-harness",
      installationId: dsh.installationId,
      providerId: "deepseek",
      models: ['["deepseek-account","deepseek-flash"]', '["deepseek-account","deepseek-v4-pro"]'],
      defaultModel: '["deepseek-account","deepseek-flash"]',
      enabled: true,
      "deepseek-harness": {},
      auth: { mode: "subscription" },
    });
    const bypass = await store.prepareLaunch("dsh-default", { cwd: "/workspace/repo", prompt: "Default" }),
      write = await store.prepareLaunch("dsh-default", {
        cwd: "/workspace/repo",
        prompt: "Write",
        permissionMode: "workspace-write",
      }),
      readOnly = await store.prepareLaunch("dsh-default", {
        cwd: "/workspace/repo",
        prompt: "Read",
        permissionMode: "read-only",
        model: '["deepseek-account","deepseek-v4-pro"]',
      });
    assert.deepEqual(bypass.args, ["--profile", "acp"]);
    assert.equal(bypass.env.DSH_PERMISSION_MODE, "danger-full-access");
    assert.equal(bypass.env.HOME, "/Users/operator", "operator environment keeps the App's $DSH_HOME reachable");
    assert.equal(bypass.env.GH_TOKEN, undefined, "DSH drops credential-shaped names from tool environments");
    assert.equal(bypass.env.GIT_CONFIG_COUNT, undefined, "DSH must not receive partial numbered Git config");
    assert.equal(bypass.githubCredentialNotice, undefined, "daemon-side settlement does not need a worker token");
    assert.equal(bypass.model, '["deepseek-account","deepseek-flash"]');
    assert.equal(write.env.DSH_PERMISSION_MODE, "workspace-write");
    assert.equal(readOnly.env.DSH_PERMISSION_MODE, "read-only");
    assert.equal(readOnly.model, '["deepseek-account","deepseek-v4-pro"]');
    // Negative controls: an argv-driven kind gets neither the variable nor the manifest model,
    // and subscription cannot leave the App's shared login environment.
    store.create({
      schemaVersion: 2,
      instanceId: "codex-env-control",
      name: "Codex",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: {},
      auth: { mode: "subscription" },
    });
    const codex = await store.prepareLaunch("codex-env-control", {
      cwd: "/workspace/repo",
      prompt: "Default",
      permissionMode: "read-only",
    });
    assert.equal(codex.env.DSH_PERMISSION_MODE, undefined);
    assert.equal(codex.model, undefined);
    assert.throws(
      () =>
        store.create({
          schemaVersion: 2,
          instanceId: "dsh-enforced",
          name: "DeepSeek Harness Enforced",
          kindId: "deepseek-harness",
          installationId: dsh.installationId,
          providerId: "deepseek",
          models: ['["deepseek-account","deepseek-flash"]'],
          defaultModel: '["deepseek-account","deepseek-flash"]',
          enabled: true,
          isolationState: "enforced",
          "deepseek-harness": {},
          auth: { mode: "subscription" },
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_isolation"),
    );
  } finally {
    removeTempRepository(userRoot);
  }
});

test("Codex workspace-write grants linked worktree gitdir and commondir across fresh, resume, and relay without opening parent repo", async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "ha-codex-worktree-permission-")),
    userRoot = path.join(base, "user"),
    repoRoot = path.join(base, "repo"),
    otherRepoRoot = path.join(base, "other-repo"),
    wtA = path.join(repoRoot, ".worktrees", "wt-a"),
    wtB = path.join(repoRoot, ".worktrees", "wt-b"),
    wtExternal = path.join(base, "wt-external"),
    nonGit = path.join(base, "non-git"),
    relayPath = "/tmp/harness-anything-501/r-0123456789abcdef01234567.sock";
  t.after(() => removeTempRepository(base));
  mkdirSync(nonGit, { recursive: true });
  for (const repo of [repoRoot, otherRepoRoot]) {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test User"]);
    mkdirSync(path.join(repo, "subdir"), { recursive: true });
    writeFileSync(path.join(repo, "README.md"), "root\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "init"]);
  }
  execFileSync("git", ["-C", repoRoot, "worktree", "add", "-b", "wt-a", wtA]);
  execFileSync("git", ["-C", repoRoot, "worktree", "add", "-b", "wt-b", wtB]);
  execFileSync("git", ["-C", repoRoot, "worktree", "add", "-b", "wt-external", wtExternal]);

  const realRepoRoot = realpathSync.native(repoRoot),
    realCommonDir = path.join(realRepoRoot, ".git"),
    realGitDirA = path.join(realCommonDir, "worktrees", "wt-a"),
    realGitDirB = path.join(realCommonDir, "worktrees", "wt-b"),
    realGitDirExternal = path.join(realCommonDir, "worktrees", "wt-external"),
    expectedLegacyRootsA = `sandbox_workspace_write.writable_roots=[${JSON.stringify(realGitDirA)},${JSON.stringify(realCommonDir)}]`,
    expectedRelayFsA = `permissions.harness-callback-relay.filesystem={":slash_tmp"="deny",":tmpdir"="deny",${JSON.stringify(realGitDirA)}="write",${JSON.stringify(realCommonDir)}="write"}`;

  assert.deepEqual(resolveLinkedWorktreeGitRoots(wtA, repoRoot), [realGitDirA, realCommonDir]);
  assert.deepEqual(resolveLinkedWorktreeGitRoots(wtA), [realGitDirA, realCommonDir]);
  assert.deepEqual(resolveLinkedWorktreeGitRoots(wtB, repoRoot), [realGitDirB, realCommonDir]);
  assert.deepEqual(
    resolveLinkedWorktreeGitRoots(wtExternal, repoRoot),
    [realGitDirExternal, realCommonDir],
    "explicit trusted repoRoot authorizes a worktree registered under repoRoot/.git/worktrees",
  );
  assert.deepEqual(
    resolveLinkedWorktreeGitRoots(wtExternal),
    [],
    "without trusted repoRoot, a checkout outside the commondir owner repository is refused",
  );
  assert.deepEqual(
    resolveLinkedWorktreeGitRoots(wtA, otherRepoRoot),
    [],
    "commondir belonging to a different repository than trusted repoRoot is refused",
  );
  assert.deepEqual(resolveLinkedWorktreeGitRoots(repoRoot, repoRoot), [], "single checkout .git dir is inside cwd");
  assert.deepEqual(resolveLinkedWorktreeGitRoots(repoRoot), [], "single checkout .git dir is already inside cwd");
  assert.deepEqual(resolveLinkedWorktreeGitRoots(path.join(repoRoot, "subdir"), repoRoot), []);
  assert.deepEqual(resolveLinkedWorktreeGitRoots(nonGit, repoRoot), []);
  assert.deepEqual(resolveLinkedWorktreeGitRoots(path.join(base, "missing"), repoRoot), []);

  // Negative control: before the fix / with empty writableRoots, neither external root is emitted.
  const withoutWorktreeRoots = launchArgs(
    {
      schemaVersion: 2,
      instanceId: "codex-wt",
      name: "Codex WT",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      isolationState: "enforced",
      credentialSource: "operator",
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-wt" },
      codex: {},
    },
    "gpt-5.6-sol",
    "Work",
    undefined,
    null,
    "workspace-write",
    false,
    undefined,
  );
  assert.equal(
    withoutWorktreeRoots.some((arg) => arg.includes("writable_roots")),
    false,
  );

  const store = openRuntimeInstanceStore({
    userRoot,
    discover: () => [observed],
    resolveCredential: () => "instance-secret",
  });
  store.create({
    schemaVersion: 2,
    instanceId: "codex-wt",
    name: "Codex WT",
    kindId: "codex",
    installationId: observed.installationId,
    providerId: "openai",
    models: ["gpt-5.6-sol"],
    defaultModel: "gpt-5.6-sol",
    enabled: true,
    permissionMode: "workspace-write",
    codex: {},
    auth: { mode: "api-key", credentialRef: "credential:v1:codex-wt" },
  });

  // 1) Legacy workspace-write: fresh & resume
  const legacyFresh = await store.prepareLaunch("codex-wt", { cwd: wtA, repoRoot, prompt: "Fresh legacy" }),
    legacyResume = await store.prepareLaunch("codex-wt", {
      cwd: wtA,
      repoRoot,
      prompt: "Resume legacy",
      providerSessionId: "thread-1",
    });
  for (const launch of [legacyFresh, legacyResume]) {
    assert.ok(launch.args.includes(expectedLegacyRootsA), JSON.stringify(launch.args));
    assert.equal(
      launch.args.some(
        (arg) => arg === JSON.stringify(realRepoRoot) || arg.includes(`${JSON.stringify(realRepoRoot)}]`),
      ),
      false,
      "must never grant write access to the canonical parent worktree root",
    );
    assert.equal(
      launch.args.some((arg) => arg.includes(realGitDirB)),
      false,
      "must not leak sibling worktree gitdir",
    );
  }
  assert.equal(legacyFresh.args.includes("--sandbox"), true);
  assert.equal(legacyResume.args.includes("--sandbox"), false);
  assert.ok(legacyResume.args.includes('sandbox_mode="workspace-write"'));

  // 2) Callback-relay workspace-write: fresh & resume
  const relayFresh = await store.prepareLaunch("codex-wt", {
      cwd: wtA,
      repoRoot,
      prompt: "Fresh relay",
      callbackRelayPath: relayPath,
    }),
    relayResume = await store.prepareLaunch("codex-wt", {
      cwd: wtA,
      repoRoot,
      prompt: "Resume relay",
      providerSessionId: "thread-2",
      callbackRelayPath: relayPath,
    });
  for (const launch of [relayFresh, relayResume]) {
    assert.ok(launch.args.includes(expectedRelayFsA), JSON.stringify(launch.args));
    assert.equal(
      launch.args.some((arg) => arg.includes(`${JSON.stringify(realRepoRoot)}="write"`)),
      false,
      "must never grant write access to the canonical parent worktree root",
    );
    assert.equal(
      launch.args.some((arg) => arg.includes(realGitDirB)),
      false,
      "must not leak sibling worktree gitdir",
    );
  }

  // Sibling worktree resolves its own gitdir + shared commondir
  const siblingLaunch = await store.prepareLaunch("codex-wt", { cwd: wtB, repoRoot, prompt: "Sibling" });
  assert.ok(
    siblingLaunch.args.includes(
      `sandbox_workspace_write.writable_roots=[${JSON.stringify(realGitDirB)},${JSON.stringify(realCommonDir)}]`,
    ),
  );

  // Single checkout, read-only, and bypass remain unchanged
  const singleCheckout = await store.prepareLaunch("codex-wt", { cwd: repoRoot, repoRoot, prompt: "Single" }),
    readOnlyWt = await store.prepareLaunch("codex-wt", {
      cwd: wtA,
      repoRoot,
      prompt: "Read only",
      permissionMode: "read-only",
      callbackRelayPath: relayPath,
    }),
    bypassWt = await store.prepareLaunch("codex-wt", {
      cwd: wtA,
      repoRoot,
      prompt: "Bypass",
      permissionMode: "bypass",
    });
  for (const launch of [singleCheckout, readOnlyWt, bypassWt]) {
    assert.equal(
      launch.args.some((arg) => arg.includes("writable_roots") || arg.includes(realGitDirA)),
      false,
    );
  }

  // RuntimeSpawner binds prepareLaunch to input.rootDir so cross-repo pointers cannot escape
  const capturedRepoRoots: Array<string | undefined> = [];
  const spawner = makeRuntimeSpawner({
    repoId: "repo-bound",
    rootDir: repoRoot,
    store: () => ({ readEvent: () => null }),
    projection: () =>
      ({
        readDispatchLifecycle: emptyDispatchLifecycleRead,
        readRuntimeSessions: () => [],
        currentLease: () => null,
        getEntity: () => ({ value: { runtime: { allowedInstances: ["codex-wt"] } } }),
        read: () => assert.fail("taskless dispatch"),
      }) as never,
    runtimeInstances: () => [
      {
        instanceId: "codex-wt",
        name: "Codex WT",
        kindId: "codex",
        models: ["gpt-5.6-sol"],
        defaultModel: "gpt-5.6-sol",
        enabled: true,
        authMode: "api-key",
        authReadiness: { status: "ready", code: null, hint: null },
        permissionMode: "workspace-write",
      },
    ],
    prepareLaunch: async (_instanceId, request) => {
      capturedRepoRoots.push(request.repoRoot);
      throw new Error("stop-after-prepareLaunch");
    },
    now: () => "2026-11-19T00:00:00.000Z",
  } as unknown as RuntimeSpawnerInput);
  await assert.rejects(
    spawner.spawn(
      {
        runtimeInstanceId: "codex-wt",
        cwd: { scope: "repo-relative", path: ".worktrees/wt-a" },
        prompt: "Verify spawner repoRoot",
        taskId: null,
        dispatchKey: "verify-repo-root",
      },
      {
        actor: { principal: { personId: "operator" } },
        source: "local",
      } as never,
    ),
    /stop-after-prepareLaunch/u,
  );
  assert.deepEqual(capturedRepoRoots, [repoRoot]);
});

test("Codex workspace-write rejects shape-complete out-of-bounds commondir and source-bearing ancestor directories", async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "ha-codex-worktree-boundary-")),
    userRoot = path.join(base, "user"),
    repoRoot = path.join(base, "repo"),
    externalRepo = path.join(base, "external-repo"),
    externalSourceTree = path.join(base, "external-source-tree"),
    ancestorSourceRoot = path.join(base, "ancestor-with-source"),
    outerRepo = path.join(base, "outer-repo"),
    innerRepo = path.join(outerRepo, "packages", "inner"),
    sneakyDotGitRoot = path.join(base, "sneaky", ".git"),
    relayPath = "/tmp/harness-anything-501/r-0123456789abcdef01234567.sock";
  t.after(() => removeTempRepository(base));

  for (const repo of [repoRoot, externalRepo, outerRepo, innerRepo]) {
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test User"]);
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "app.ts"), "export const secret = 1;\n");
    execFileSync("git", ["-C", repo, "add", "src/app.ts"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "init"]);
  }

  // Helper that materializes a complete Git common-dir + linked-worktree admin dir + matching gitdir backlink.
  const wireCompleteFakeCommonDir = (commonDir: string, worktreeName: string, checkoutDir: string): string => {
    mkdirSync(path.join(commonDir, "objects"), { recursive: true });
    mkdirSync(path.join(commonDir, "refs"), { recursive: true });
    mkdirSync(checkoutDir, { recursive: true });
    if (!lstatSync(path.join(commonDir, "HEAD"), { throwIfNoEntry: false }))
      writeFileSync(path.join(commonDir, "HEAD"), "ref: refs/heads/main\n");
    const adminDir = path.join(commonDir, "worktrees", worktreeName);
    mkdirSync(adminDir, { recursive: true });
    writeFileSync(path.join(adminDir, "HEAD"), "ref: refs/heads/wt\n");
    writeFileSync(path.join(adminDir, "commondir"), "../..\n");
    writeFileSync(path.join(adminDir, "gitdir"), `${path.join(checkoutDir, ".git")}\n`);
    writeFileSync(path.join(checkoutDir, ".git"), `gitdir: ${adminDir}\n`);
    return adminDir;
  };

  // 1) Shape-complete external `.git` belonging to another repository, with matching backlink
  const crossRepoCwd = path.join(repoRoot, ".worktrees", "evil-cross-repo");
  wireCompleteFakeCommonDir(path.join(externalRepo, ".git"), "evil-cross-repo", crossRepoCwd);

  // 2) Shape-complete external source directory (not named `.git`) containing business source + matching backlink
  mkdirSync(path.join(externalSourceTree, "src"), { recursive: true });
  writeFileSync(path.join(externalSourceTree, "src", "sensitive.ts"), "export const key = 'nope';\n");
  const externalSourceCwd = path.join(repoRoot, ".worktrees", "evil-external-src");
  wireCompleteFakeCommonDir(externalSourceTree, "evil-external-src", externalSourceCwd);

  // 3) Shape-complete ancestor directory containing business source code + matching backlink
  mkdirSync(path.join(ancestorSourceRoot, "src"), { recursive: true });
  writeFileSync(path.join(ancestorSourceRoot, "src", "business.ts"), "export const prod = true;\n");
  const ancestorSourceCwd = path.join(ancestorSourceRoot, ".worktrees", "evil-ancestor");
  wireCompleteFakeCommonDir(ancestorSourceRoot, "evil-ancestor", ancestorSourceCwd);

  // 4) Nested inner repo worktree jumping past innerRepo/.git to outerRepo/.git (ancestor with outer source)
  const nestedEscapeCwd = path.join(innerRepo, ".worktrees", "evil-outer-jump");
  wireCompleteFakeCommonDir(path.join(outerRepo, ".git"), "evil-outer-jump", nestedEscapeCwd);

  // 5) Ancestor directory literally named `.git` enclosing `cwd` alongside source files
  mkdirSync(path.join(sneakyDotGitRoot, "src"), { recursive: true });
  writeFileSync(path.join(sneakyDotGitRoot, "src", "hidden.ts"), "export const x = 1;\n");
  const insideDotGitCwd = path.join(sneakyDotGitRoot, "checkout");
  wireCompleteFakeCommonDir(sneakyDotGitRoot, "evil-inside-dotgit", insideDotGitCwd);

  // 6) Classic malformed / hijack / symlink / multiline pointers
  const realCommonDir = path.join(realpathSync.native(repoRoot), ".git"),
    legitWt = path.join(repoRoot, ".worktrees", "legit");
  execFileSync("git", ["-C", repoRoot, "worktree", "add", "-b", "legit", legitWt]);
  const realLegitGitDir = path.join(realCommonDir, "worktrees", "legit"),
    badArbitrary = path.join(repoRoot, ".worktrees", "bad-arbitrary"),
    badMainGit = path.join(repoRoot, ".worktrees", "bad-main-git"),
    badHijack = path.join(repoRoot, ".worktrees", "bad-hijack"),
    badSymlink = path.join(repoRoot, ".worktrees", "bad-symlink"),
    badMultiline = path.join(repoRoot, ".worktrees", "bad-multiline");
  for (const dir of [badArbitrary, badMainGit, badHijack, badSymlink, badMultiline])
    mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(badArbitrary, ".git"), `gitdir: ${repoRoot}\n`);
  writeFileSync(path.join(badMainGit, ".git"), `gitdir: ${realCommonDir}\n`);
  writeFileSync(path.join(badHijack, ".git"), `gitdir: ${realLegitGitDir}\n`);
  symlinkSync(path.join(legitWt, ".git"), path.join(badSymlink, ".git"));
  writeFileSync(path.join(badMultiline, ".git"), `gitdir: ${realLegitGitDir}\nextra: line\n`);

  const store = openRuntimeInstanceStore({
    userRoot,
    discover: () => [observed],
    resolveCredential: () => "instance-secret",
  });
  store.create({
    schemaVersion: 2,
    instanceId: "codex-wt-boundary",
    name: "Codex WT Boundary",
    kindId: "codex",
    installationId: observed.installationId,
    providerId: "openai",
    models: ["gpt-5.6-sol"],
    defaultModel: "gpt-5.6-sol",
    enabled: true,
    permissionMode: "workspace-write",
    codex: {},
    auth: { mode: "api-key", credentialRef: "credential:v1:codex-wt-boundary" },
  });

  const cases: ReadonlyArray<{ readonly label: string; readonly cwd: string; readonly trustedRoot: string }> = [
    { label: "external-repo-dotgit", cwd: crossRepoCwd, trustedRoot: repoRoot },
    { label: "external-source-tree", cwd: externalSourceCwd, trustedRoot: repoRoot },
    { label: "ancestor-with-source", cwd: ancestorSourceCwd, trustedRoot: ancestorSourceRoot },
    { label: "nested-inner-jump-to-outer", cwd: nestedEscapeCwd, trustedRoot: innerRepo },
    { label: "inside-dotgit-ancestor", cwd: insideDotGitCwd, trustedRoot: path.dirname(sneakyDotGitRoot) },
    { label: "arbitrary-dir", cwd: badArbitrary, trustedRoot: repoRoot },
    { label: "main-dotgit", cwd: badMainGit, trustedRoot: repoRoot },
    { label: "backlink-mismatch-hijack", cwd: badHijack, trustedRoot: repoRoot },
    { label: "symlink-dotgit", cwd: badSymlink, trustedRoot: repoRoot },
    { label: "multiline-dotgit", cwd: badMultiline, trustedRoot: repoRoot },
  ];

  for (const { label, cwd, trustedRoot } of cases) {
    assert.deepEqual(resolveLinkedWorktreeGitRoots(cwd, trustedRoot), [], `${label} rejected with trustedRoot`);
    assert.deepEqual(resolveLinkedWorktreeGitRoots(cwd), [], `${label} rejected without trustedRoot`);
    for (const request of [
      { cwd, repoRoot: trustedRoot, prompt: label },
      { cwd, prompt: label },
      { cwd, repoRoot: trustedRoot, prompt: label, callbackRelayPath: relayPath },
      { cwd, prompt: label, callbackRelayPath: relayPath },
    ]) {
      const launch = await store.prepareLaunch("codex-wt-boundary", request);
      assert.equal(
        launch.args.some((arg) => arg.includes("writable_roots")),
        false,
        `${label} must not emit legacy writable_roots`,
      );
      if (request.callbackRelayPath) {
        assert.ok(
          launch.args.includes('permissions.harness-callback-relay.filesystem={":slash_tmp"="deny",":tmpdir"="deny"}'),
          `${label} relay filesystem must keep only default tmp denies: ${JSON.stringify(launch.args)}`,
        );
      }
    }
  }
});

test("Codex workspace-write enforces <= 4096-byte Git metadata cap and degrades to [] on unreadable or racing metadata", async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "ha-codex-worktree-metadata-bounds-")),
    userRoot = path.join(base, "user"),
    repoRoot = path.join(base, "repo"),
    wtValid = path.join(repoRoot, ".worktrees", "wt-valid"),
    wtBigDotGit = path.join(repoRoot, ".worktrees", "wt-big-dotgit"),
    wtBigCommon = path.join(repoRoot, ".worktrees", "wt-big-common"),
    wtBigBacklink = path.join(repoRoot, ".worktrees", "wt-big-backlink"),
    wtCorrupt = path.join(repoRoot, ".worktrees", "wt-corrupt"),
    wtLoop = path.join(repoRoot, ".worktrees", "wt-loop"),
    wtNotDir = path.join(repoRoot, ".worktrees", "wt-notdir"),
    wtUnreadable = path.join(repoRoot, ".worktrees", "wt-unreadable"),
    chmodTargets: string[] = [];
  t.after(() => {
    for (const target of chmodTargets) {
      try {
        chmodSync(target, 0o600);
      } catch {
        // best-effort test teardown before rmSync
      }
    }
    removeTempRepository(base);
  });

  execFileSync("git", ["init", repoRoot]);
  execFileSync("git", ["-C", repoRoot, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repoRoot, "config", "user.name", "Test User"]);
  writeFileSync(path.join(repoRoot, "README.md"), "root\n");
  execFileSync("git", ["-C", repoRoot, "add", "README.md"]);
  execFileSync("git", ["-C", repoRoot, "commit", "-m", "init"]);
  for (const [branch, dir] of [
    ["wt-valid", wtValid],
    ["wt-big-dotgit", wtBigDotGit],
    ["wt-big-common", wtBigCommon],
    ["wt-big-backlink", wtBigBacklink],
    ["wt-corrupt", wtCorrupt],
    ["wt-unreadable", wtUnreadable],
  ] as const) {
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "-b", branch, dir]);
  }

  const realCommonDir = path.join(realpathSync.native(repoRoot), ".git");
  assert.equal(resolveLinkedWorktreeGitRoots(wtValid, repoRoot).length, 2);

  // Oversized (> 4096 bytes) `.git`, `commondir`, and `gitdir` backlink files must be rejected BEFORE readFileSync.
  const oversizedText = `gitdir: ${path.join(realCommonDir, "worktrees", "wt-big-dotgit")}${" ".repeat(maxLinkedWorktreeGitMetadataBytes)}\n`;
  assert.ok(Buffer.byteLength(oversizedText) > maxLinkedWorktreeGitMetadataBytes);
  writeFileSync(path.join(wtBigDotGit, ".git"), oversizedText);
  writeFileSync(
    path.join(realCommonDir, "worktrees", "wt-big-common", "commondir"),
    `../..${" ".repeat(maxLinkedWorktreeGitMetadataBytes)}\n`,
  );
  writeFileSync(
    path.join(realCommonDir, "worktrees", "wt-big-backlink", "gitdir"),
    `${path.join(wtBigBacklink, ".git")}${" ".repeat(maxLinkedWorktreeGitMetadataBytes)}\n`,
  );

  const readCalls: string[] = [],
    countingFs: LinkedWorktreeGitMetadataFs = {
      lstatSync,
      statSync,
      realpathSync: realpathSync.native,
      readFileSync: (filePath) => {
        readCalls.push(filePath);
        return readFileSync(filePath);
      },
    };
  for (const [wt, blockedFile] of [
    [wtBigDotGit, realpathSync.native(path.join(wtBigDotGit, ".git"))],
    [wtBigCommon, path.join(realCommonDir, "worktrees", "wt-big-common", "commondir")],
    [wtBigBacklink, path.join(realCommonDir, "worktrees", "wt-big-backlink", "gitdir")],
  ] as const) {
    readCalls.length = 0;
    assert.deepEqual(resolveLinkedWorktreeGitRoots(wt, repoRoot, countingFs), []);
    assert.equal(
      readCalls.includes(blockedFile),
      false,
      `oversized metadata file ${path.basename(blockedFile)} must not be read into memory`,
    );
  }

  // Invalid UTF-8 / empty / NUL / ENOTDIR / ELOOP / chmod 000 metadata on disk
  writeFileSync(path.join(wtCorrupt, ".git"), Buffer.from([0x67, 0x69, 0x74, 0x64, 0x69, 0x72, 0x3a, 0xff, 0xfe]));
  assert.deepEqual(resolveLinkedWorktreeGitRoots(wtCorrupt, repoRoot), []);
  writeFileSync(path.join(wtCorrupt, ".git"), "");
  assert.deepEqual(resolveLinkedWorktreeGitRoots(wtCorrupt, repoRoot), []);
  writeFileSync(path.join(wtCorrupt, ".git"), "gitdir:   \n");
  assert.deepEqual(resolveLinkedWorktreeGitRoots(wtCorrupt, repoRoot), []);

  mkdirSync(wtLoop, { recursive: true });
  const loopLink = path.join(base, "self-loop");
  symlinkSync(loopLink, loopLink);
  writeFileSync(path.join(wtLoop, ".git"), `gitdir: ${path.join(loopLink, "wt")}\n`);
  assert.deepEqual(resolveLinkedWorktreeGitRoots(wtLoop, repoRoot), []);

  mkdirSync(wtNotDir, { recursive: true });
  const blockerFile = path.join(base, "regular-blocker");
  writeFileSync(blockerFile, "not a dir\n");
  writeFileSync(path.join(wtNotDir, ".git"), `gitdir: ${path.join(blockerFile, "child")}\n`);
  assert.deepEqual(resolveLinkedWorktreeGitRoots(wtNotDir, repoRoot), []);

  const unreadableDotGit = path.join(wtUnreadable, ".git");
  chmodSync(unreadableDotGit, 0o000);
  chmodTargets.push(unreadableDotGit);
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    assert.deepEqual(resolveLinkedWorktreeGitRoots(wtUnreadable, repoRoot), []);
  }

  // Deterministic mid-flight TOCTOU race and post-lstat growth via LinkedWorktreeGitMetadataFs
  for (const code of ["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR", "ELOOP", "EINVAL", "ENAMETOOLONG", "ENXIO"]) {
    const racingFs: LinkedWorktreeGitMetadataFs = {
      lstatSync,
      statSync,
      realpathSync: realpathSync.native,
      readFileSync: () => {
        throw Object.assign(new Error(`simulated ${code}`), { code });
      },
    };
    assert.deepEqual(resolveLinkedWorktreeGitRoots(wtValid, repoRoot, racingFs), [], `graceful [] on ${code}`);
  }
  const grewAfterStatFs: LinkedWorktreeGitMetadataFs = {
    lstatSync,
    statSync,
    realpathSync: realpathSync.native,
    readFileSync: () => Buffer.alloc(maxLinkedWorktreeGitMetadataBytes + 1, 0x61),
  };
  assert.deepEqual(resolveLinkedWorktreeGitRoots(wtValid, repoRoot, grewAfterStatFs), []);

  // Unexpected programmer errors are never swallowed
  const buggyFs: LinkedWorktreeGitMetadataFs = {
    lstatSync,
    statSync,
    realpathSync: realpathSync.native,
    readFileSync: () => {
      throw new TypeError("unexpected programmer bug");
    },
  };
  assert.throws(() => resolveLinkedWorktreeGitRoots(wtValid, repoRoot, buggyFs), TypeError);

  // End-to-end store.prepareLaunch continues with empty writable_roots instead of failing the dispatch
  const store = openRuntimeInstanceStore({
    userRoot,
    discover: () => [observed],
    resolveCredential: () => "instance-secret",
  });
  store.create({
    schemaVersion: 2,
    instanceId: "codex-wt-resilient",
    name: "Codex WT Resilient",
    kindId: "codex",
    installationId: observed.installationId,
    providerId: "openai",
    models: ["gpt-5.6-sol"],
    defaultModel: "gpt-5.6-sol",
    enabled: true,
    permissionMode: "workspace-write",
    codex: {},
    auth: { mode: "api-key", credentialRef: "credential:v1:codex-wt-resilient" },
  });
  for (const badWt of [wtBigDotGit, wtBigCommon, wtBigBacklink, wtCorrupt, wtLoop, wtNotDir]) {
    const launch = await store.prepareLaunch("codex-wt-resilient", {
      cwd: badWt,
      repoRoot,
      prompt: "Continue without extra roots",
    });
    assert.equal(
      launch.args.some((arg) => arg.includes("writable_roots")),
      false,
      `${path.basename(badWt)} must launch cleanly with empty writable_roots`,
    );
  }
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const launch = await store.prepareLaunch("codex-wt-resilient", {
      cwd: wtUnreadable,
      repoRoot,
      prompt: "Continue when .git is unreadable",
    });
    assert.equal(
      launch.args.some((arg) => arg.includes("writable_roots")),
      false,
    );
  }
});

function codedAs(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
