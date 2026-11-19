// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  clampPermissionMode,
  resolveScheduledPermissionMode,
  validRuntimeLaunchPermissionMode,
} from "../../src/index.ts";
import { runtimeLaunchPermissionModes } from "../../src/domain/agent-runtime.ts";

test("clampPermissionMode honors declared Agent ceilings across all permission modes", () => {
  assert.deepEqual([...runtimeLaunchPermissionModes], ["read-only", "workspace-write", "bypass"]);
  assert.equal(clampPermissionMode("read-only", "bypass"), "read-only");
  assert.equal(clampPermissionMode("read-only", "workspace-write"), "read-only");
  assert.equal(clampPermissionMode("read-only", "read-only"), "read-only");
  assert.equal(clampPermissionMode("read-only", undefined), "read-only");

  assert.equal(clampPermissionMode("workspace-write", "bypass"), "workspace-write");
  assert.equal(clampPermissionMode("workspace-write", "workspace-write"), "workspace-write");
  assert.equal(clampPermissionMode("workspace-write", "read-only"), "read-only");
  assert.equal(clampPermissionMode("workspace-write", undefined), "workspace-write");

  assert.equal(clampPermissionMode("bypass", "bypass"), "bypass");
  assert.equal(clampPermissionMode("bypass", "workspace-write"), "workspace-write");
  assert.equal(clampPermissionMode("bypass", "read-only"), "read-only");
  assert.equal(clampPermissionMode("bypass", undefined), "bypass");

  assert.equal(clampPermissionMode(undefined, "bypass"), "bypass");
  assert.equal(clampPermissionMode(undefined, "workspace-write"), "workspace-write");
  assert.equal(clampPermissionMode(undefined, "read-only"), "read-only");
  assert.equal(clampPermissionMode(undefined, undefined), undefined);
});

test("resolveScheduledPermissionMode never exceeds declared Agent permissionMode and falls back for undeclared Agents", () => {
  assert.equal(
    resolveScheduledPermissionMode({ agentPermissionMode: "read-only", scheduleDefault: "bypass" }),
    "read-only",
  );
  assert.equal(
    resolveScheduledPermissionMode({ agentPermissionMode: "workspace-write", scheduleDefault: "bypass" }),
    "workspace-write",
  );
  assert.equal(resolveScheduledPermissionMode({ agentPermissionMode: "bypass", scheduleDefault: "bypass" }), "bypass");
  assert.equal(resolveScheduledPermissionMode({ agentPermissionMode: undefined, scheduleDefault: "bypass" }), "bypass");

  assert.equal(
    resolveScheduledPermissionMode({ agentPermissionMode: "bypass", scheduleDefault: "read-only" }),
    "read-only",
  );
  assert.equal(
    resolveScheduledPermissionMode({ agentPermissionMode: undefined, scheduleDefault: "read-only" }),
    "read-only",
  );
});

test("validRuntimeLaunchPermissionMode accepts canonical modes and rejects invalid inputs", () => {
  for (const mode of runtimeLaunchPermissionModes) assert.equal(validRuntimeLaunchPermissionMode(mode), true);
  assert.equal(validRuntimeLaunchPermissionMode("unknown"), false);
  assert.equal(validRuntimeLaunchPermissionMode(undefined), false);
});
