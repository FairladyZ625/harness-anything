// harness-test-tier: contract
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instance-store.ts";
import { runtimeInstanceConfig } from "../src/agent-runtime-instance-config.ts";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instance-types.ts";
import { codedAs } from "./agent-runtime-instance-environment.fixture.ts";

const agyInstallation: RuntimeInstallationWitness = {
  installationId: "agy-installation",
  kindId: "agy",
  executablePath: "/opt/runtime-test/agy",
  version: "1.1.15",
  observedAt: "2026-11-13T00:00:00.000Z",
};

test("subscription credential sources default to operator and isolate instance credentials", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-credential-source-")),
    operatorHome = path.join(userRoot, "operator-home"),
    sharedGemini = path.join(operatorHome, ".gemini"),
    operatorCredential = path.join(sharedGemini, "antigravity-oauth-token");
  mkdirSync(sharedGemini, { recursive: true, mode: 0o700 });
  writeFileSync(operatorCredential, "test-operator-credential", { mode: 0o600 });
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      platform: "darwin",
      env: { PATH: process.env.PATH, HOME: operatorHome },
      discover: () => [agyInstallation],
    });
    const operator = store.command({
      kind: "runtime-instance-create",
      instanceId: "agy-operator",
      name: "AGY operator",
      kindId: "agy",
      installationId: agyInstallation.installationId,
      providerId: "google",
      models: ["gemini-4-hydrogen-low"],
      authMode: "subscription",
    }).instance as Record<string, unknown>;
    assert.equal(operator.credentialSource, "operator");

    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-create",
          instanceId: "agy-operator-two",
          name: "AGY operator two",
          kindId: "agy",
          installationId: agyInstallation.installationId,
          providerId: "google",
          models: ["gemini-4-hydrogen-low"],
          authMode: "subscription",
        }),
      (error: unknown) => codedAs(error, "runtime_operator_instance_exists"),
    );

    const isolated = store.command({
      kind: "runtime-instance-create",
      instanceId: "agy-pro",
      name: "AGY Pro",
      kindId: "agy",
      installationId: agyInstallation.installationId,
      providerId: "google",
      models: ["gemini-4-hydrogen-low"],
      authMode: "subscription",
      credentialSource: "instance",
    }).instance as Record<string, unknown>;
    assert.equal(isolated.credentialSource, "instance");
    assert.equal(isolated.isolationState, "enforced");
    const instanceCredential = path.join(
      userRoot,
      "runtime-instances",
      "agy-pro",
      "home",
      ".gemini",
      "antigravity-oauth-token",
    );
    assert.throws(() => lstatSync(instanceCredential), { code: "ENOENT" });
    assert.equal(readFileSync(operatorCredential, "utf8"), "test-operator-credential");
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("legacy subscription configs normalize to operator credentials", () => {
  const normalized = runtimeInstanceConfig({
    schemaVersion: 2,
    instanceId: "agy-legacy",
    name: "AGY legacy",
    kindId: "agy",
    installationId: agyInstallation.installationId,
    providerId: "google",
    models: ["gemini-4-hydrogen-low"],
    defaultModel: "gemini-4-hydrogen-low",
    enabled: true,
    isolationState: "operator-environment",
    auth: { mode: "subscription" },
    agy: {},
  });
  assert.equal(normalized.credentialSource, "operator");
});

test("instance credentials fail closed for undeclared kind and platform pairs", () => {
  assert.throws(
    () =>
      runtimeInstanceConfig({
        schemaVersion: 2,
        instanceId: "claude-private",
        name: "Claude private",
        kindId: "claude",
        installationId: "claude-installation",
        providerId: "anthropic",
        models: ["claude-fable-5"],
        defaultModel: "claude-fable-5",
        enabled: true,
        credentialSource: "instance",
        auth: { mode: "subscription" },
        claude: {},
      }),
    (error: unknown) => codedAs(error, "runtime_instance_isolation_unsupported"),
  );

  assert.throws(
    () =>
      runtimeInstanceConfig({
        schemaVersion: 2,
        instanceId: "agy-private-aix",
        name: "AGY private",
        kindId: "agy",
        installationId: agyInstallation.installationId,
        providerId: "google",
        models: ["gemini-4-hydrogen-low"],
        defaultModel: "gemini-4-hydrogen-low",
        enabled: true,
        credentialSource: "instance",
        auth: { mode: "subscription" },
        agy: {},
      }),
    (error: unknown) => codedAs(error, "runtime_instance_isolation_unsupported"),
  );
});
