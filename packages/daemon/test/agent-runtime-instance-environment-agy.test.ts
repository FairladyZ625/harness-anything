// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { codedAs } from "./agent-runtime-instance-environment.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

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
      "--print-timeout",
      "30m",
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
