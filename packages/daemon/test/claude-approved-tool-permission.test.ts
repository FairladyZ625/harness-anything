// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { launchArgs } from "../src/agent-runtime-launch-config.ts";
import type { RuntimeInstanceConfig } from "../src/agent-runtime-instance-types.ts";
import { readSettingsFacet } from "@harness-anything/kernel";

const claude = {
  schemaVersion: 2,
  instanceId: "claude-approved-tool",
  name: "Claude approved tool",
  kindId: "claude",
  installationId: "claude-installation",
  providerId: "anthropic",
  models: ["claude-fable-5"],
  defaultModel: "claude-fable-5",
  enabled: true,
  isolationState: "enforced",
  permissionMode: "workspace-write",
  claude: {},
  auth: { mode: "api-key", credentialRef: "credential:v1:test" },
} as const satisfies RuntimeInstanceConfig;

test("Claude admits one reviewed exact bridge command through permissions.allow", () => {
  for (const mode of ["api-key", "subscription"] as const)
    for (const session of [undefined, "fixture-resume"]) {
      const command =
          '/opt/ha/node /opt/ha/bridge.mjs task-create \'{"title":"slice"}\' --instance-snapshot \'{"id":"i1"}\'',
        args = launchArgs(
          { ...claude, auth: mode === "subscription" ? { mode } : claude.auth },
          "claude-fable-5",
          "Run the reviewed bridge.",
          session,
          null,
          "workspace-write",
          false,
          "/tmp/ha-fixture-relay.sock",
          "darwin",
          [{ id: "task-create-bridge", approvedCommand: command }],
        ),
        settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
      assert.deepEqual(settings.permissions, { allow: [`Bash(${command})`] });
      assert.equal(settings.hooks, undefined);
      assert.equal(settings.permissions.allow.includes(`Bash(${command} --extra)`), false);
      assert.equal(args.includes("bypassPermissions"), false);
      assert.equal(args.includes("--bare"), false);
      assert.equal(settings.sandbox.enabled, true);
      assert.equal(settings.sandbox.autoAllowBashIfSandboxed, true);
      assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
      assert.deepEqual(settings.sandbox.network.allowUnixSockets, ["/tmp/ha-fixture-relay.sock"]);
      assert.equal(args.includes("--resume"), session !== undefined);
    }
});

test("reviewed commands cannot widen a different permission mode", () => {
  for (const permissionMode of ["read-only", "bypass", undefined] as const)
    assert.throws(
      () =>
        launchArgs(claude, "claude-fable-5", "Run", undefined, null, permissionMode, false, undefined, "darwin", [
          { id: "bridge", approvedCommand: "/opt/ha/bridge.mjs task-create" },
        ]),
      /runtime_approved_command_permission_mode/u,
    );
});

test("reviewed commands round-trip the settings boundary with their Agent scope", () => {
  const rule = { id: "bridge", approvedCommand: "/opt/ha/bridge.mjs task-create", agent: "sol" };
  assert.deepEqual(
    readSettingsFacet(`settings:\n  runtime:\n    commandInterceptions: ${JSON.stringify([rule])}\n`).runtime
      .commandInterceptions,
    [rule],
  );
});

test("a single quote inside a double-quoted argument stays literal", () => {
  const command = `/opt/ha/bridge.mjs task-create "don't expand"`,
    args = launchArgs(claude, "claude-fable-5", "Run", undefined, null, "workspace-write", false, undefined, "darwin", [
      { id: "bridge", approvedCommand: command },
    ]),
    settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
  assert.deepEqual(settings.permissions, { allow: [`Bash(${command})`] });
});

test("an unbounded or shell-composed reviewed command is rejected before launch", () => {
  for (const approvedCommand of [
    "/opt/ha/bridge.mjs task-create *",
    "/opt/ha/bridge.mjs task-create; rm -rf .",
    "/opt/ha/bridge.mjs task-create && echo done",
    '/opt/ha/bridge.mjs task-create "$(whoami)"',
    `/opt/ha/bridge.mjs task-create "'$(whoami)'" 'safe'`,
    "/opt/ha/bridge.mjs task-create \"'`whoami`'\" 'safe'",
    "/opt/ha/bridge.mjs task-create `whoami`",
    "/opt/ha/bridge.mjs task-create\nother",
    "/opt/ha/bridge.mjs task-create " + "a".repeat(4096),
    "/opt/ha/bridge.mjs task-create '",
    "/opt/ha/bridge.mjs task-create > output",
  ])
    assert.throws(
      () =>
        launchArgs(
          claude,
          "claude-fable-5",
          "Run the reviewed bridge.",
          undefined,
          null,
          "workspace-write",
          false,
          undefined,
          "darwin",
          [{ id: "invalid", approvedCommand }],
        ),
      /runtime_approved_command_invalid/u,
    );
});
