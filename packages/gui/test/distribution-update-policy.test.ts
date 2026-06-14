import assert from "node:assert/strict";
import test from "node:test";
import {
  harnessDistributionPolicy,
  validateDistributionPolicy,
  type DistributionArchitecturePolicy
} from "../src/index.ts";

test("default distribution policy is planned and manually updated", () => {
  const result = validateDistributionPolicy(harnessDistributionPolicy);
  assert.deepEqual(result, { ok: true, errors: [] });
  assert.equal(harnessDistributionPolicy.currentStatus, "source-and-package-smoke-only");
  assert.deepEqual(
    harnessDistributionPolicy.entries
      .filter((entry) => entry.surface === "desktopApp")
      .map((entry) => entry.platform)
      .sort(),
    ["linux", "macos", "windows"]
  );
  assert.deepEqual(
    harnessDistributionPolicy.entries
      .filter((entry) => entry.surface === "localDaemon")
      .map((entry) => entry.platform)
      .sort(),
    ["linux", "macos", "windows"]
  );
  assert.equal(harnessDistributionPolicy.entries.some((entry) => entry.update.mode === "auto" && entry.update.shipped), false);
});

test("distribution policy rejects unsigned production and missing macOS notarization", () => {
  const policy = clonePolicy();
  policy.entries = policy.entries.map((entry) =>
    entry.surface === "desktopApp" && entry.platform === "macos"
      ? {
          ...entry,
          releaseStatus: "shipped",
          signing: { requiredForProduction: false, notarizationRequired: false, unsignedAllowance: "dev-only" }
        }
      : entry
  );

  assert.deepEqual(
    validateDistributionPolicy(policy).errors.map((entry) => entry.code),
    ["unsigned_production", "unsigned_production", "missing_macos_notarization"]
  );
});

test("distribution policy rejects shipped auto update before implementation", () => {
  const policy = clonePolicy();
  policy.entries = policy.entries.map((entry) =>
    entry.surface === "desktopApp" && entry.platform === "windows"
      ? {
          ...entry,
          update: { ...entry.update, mode: "auto", shipped: true, transport: "signed-feed" }
        }
      : entry
  );

  assert.deepEqual(validateDistributionPolicy(policy).errors.map((entry) => entry.code), ["unsupported_auto_update"]);
});

test("distribution policy requires local daemon platform coverage", () => {
  const policy = clonePolicy();
  policy.entries = policy.entries.filter((entry) => !(entry.surface === "localDaemon" && entry.platform !== "macos"));

  assert.deepEqual(validateDistributionPolicy(policy).errors.map((entry) => entry.code), [
    "missing_local_daemon_platform",
    "missing_local_daemon_platform"
  ]);
});

test("manual update planning requires user approval and cannot be marked shipped", () => {
  const policy = clonePolicy();
  policy.entries = policy.entries.map((entry) =>
    entry.surface === "localDaemon" && entry.platform === "linux"
      ? {
          ...entry,
          update: { ...entry.update, requiresUserApproval: false, shipped: true }
        }
      : entry
  );

  assert.deepEqual(validateDistributionPolicy(policy).errors.map((entry) => entry.code), [
    "manual_update_without_user_approval",
    "manual_update_marked_shipped"
  ]);
});

test("remote daemon bootstrap must stay on SSH tunnel and daemon API v1", () => {
  const policy = clonePolicy();
  policy.entries = policy.entries.map((entry) =>
    entry.surface === "remoteDaemon"
      ? {
          ...entry,
          update: { ...entry.update, transport: "signed-feed" },
          remoteBootstrap: { ...entry.remoteBootstrap, protocol: "daemon-api-v2" } as typeof entry.remoteBootstrap
        }
      : entry
  );

  assert.deepEqual(validateDistributionPolicy(policy).errors.map((entry) => entry.code), [
    "remote_daemon_bootstrap_drift",
    "remote_daemon_update_drift"
  ]);
});

function clonePolicy(): DistributionArchitecturePolicy & { entries: DistributionArchitecturePolicy["entries"] } {
  return structuredClone(harnessDistributionPolicy);
}
