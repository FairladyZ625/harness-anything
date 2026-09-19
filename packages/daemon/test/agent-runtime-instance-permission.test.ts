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
      "--settings",
      '{"attribution":{"commit":"","pr":"","sessionUrl":false}}',
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
      }),
      claudeWorkspaceWrite = await store.prepareLaunch("claude-open", {
        cwd: "/workspace/repo",
        prompt: "Scheduled remediate",
        permissionMode: "workspace-write",
        writableRoots: ["/workspace/repo/tmp"],
      });
    assert.deepEqual(dispatched.args, ["exec", "--json", "--sandbox", "read-only", "--model", "gpt-5.6-sol", "-"]);
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
    ]);
    // Scheduled remediate launches must be able to run `ha` (daemon-mediated
    // ledger writes) while every other Bash command keeps acceptEdits behavior:
    // the allow rule rides $permission ahead of $writable-roots and --model.
    assert.deepEqual(claudeWorkspaceWrite.args, [
      "-p",
      "--verbose",
      "--settings",
      '{"attribution":{"commit":"","pr":"","sessionUrl":false}}',
      "--output-format",
      "stream-json",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash(ha *)",
      "--add-dir",
      "/workspace/repo/tmp",
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
      "--print-timeout",
      "30m",
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
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("a kind declaring a single isolation state rejects edits to any other value", () => {
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
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-update",
          instanceId: "agy-isolated",
          isolationState: "enforced",
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_isolation"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

function codedAs(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
