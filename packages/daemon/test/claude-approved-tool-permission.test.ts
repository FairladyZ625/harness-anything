// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { launchArgs } from "../src/agent-runtime-launch-config.ts";
import type { RuntimeInstanceConfig } from "../src/agent-runtime-instance-types.ts";

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
  const command =
      '/opt/ha/node /opt/ha/bridge.mjs task-create \'{"title":"slice"}\' --instance-snapshot \'{"id":"i1"}\'',
    args = launchArgs(
      claude,
      "claude-fable-5",
      "Run the reviewed bridge.",
      undefined,
      null,
      "workspace-write",
      false,
      undefined,
      "darwin",
      [{ id: "task-create-bridge", approvedCommand: command }],
    ),
    settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
  assert.deepEqual(settings.permissions, { allow: [`Bash(${command})`] });
  assert.equal(settings.hooks, undefined);
  assert.equal(settings.permissions.allow.includes(`Bash(${command} --extra)`), false);
  assert.equal(args.includes("bypassPermissions"), false);
  assert.equal(args.includes("--bare"), false);
});

test("an unbounded or shell-composed reviewed command is rejected before launch", () => {
  for (const approvedCommand of [
    "/opt/ha/bridge.mjs task-create *",
    "/opt/ha/bridge.mjs task-create; rm -rf .",
    "/opt/ha/bridge.mjs task-create && echo done",
    '/opt/ha/bridge.mjs task-create "$(whoami)"',
    "/opt/ha/bridge.mjs task-create `whoami`",
    "/opt/ha/bridge.mjs task-create\nother",
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
