// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instances.ts";
import { codedAs, observed } from "./agent-runtime-instance-environment.fixture.ts";

const sessionA = "runtime_0123456789abcdef01234567",
  sessionB = "runtime_89abcdef0123456789abcdef";

function sessionTemp(userRoot: string, instanceId: string, runtimeSessionId: string): string {
  return path.join(userRoot, "runtime-instances", instanceId, "tmp", runtimeSessionId);
}

test("a launch scoped to a runtime session gets its own temp directory under the instance tmp root", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-launch-temp-"));
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed],
      resolveCredential: () => "instance-secret",
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-run-temp",
      name: "Codex Run Temp",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: {},
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-run-temp" },
    });
    const launch = await store.prepareLaunch("codex-run-temp", {
      cwd: "/workspace/repo",
      prompt: "Scoped run",
      runtimeSessionId: sessionA,
    });
    assert.equal(launch.env.TMPDIR, sessionTemp(userRoot, "codex-run-temp", sessionA));
    const stat = statSync(sessionTemp(userRoot, "codex-run-temp", sessionA));
    assert.equal(stat.isDirectory(), true);
    // The instance-wide home, config, and tmp root survive every per-run scope.
    assert.equal(existsSync(path.join(userRoot, "runtime-instances", "codex-run-temp", "home")), true);
    assert.equal(existsSync(path.join(launch.env.CODEX_HOME!, "config.toml")), true);
    const sharedRootLaunch = await store.prepareLaunch("codex-run-temp", {
      cwd: "/workspace/repo",
      prompt: "Shared root",
    });
    assert.equal(sharedRootLaunch.env.TMPDIR, path.join(userRoot, "runtime-instances", "codex-run-temp", "tmp"));
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("reclaim removes exactly one session's temp tree and leaves siblings plus instance state", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-reclaim-temp-"));
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed],
      resolveCredential: () => "instance-secret",
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-reclaim",
      name: "Codex Reclaim",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: {},
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-reclaim" },
    });
    for (const session of [sessionA, sessionB]) {
      await store.prepareLaunch("codex-reclaim", {
        cwd: "/workspace/repo",
        prompt: session,
        runtimeSessionId: session,
      });
      const scratch = path.join(sessionTemp(userRoot, "codex-reclaim", session), "fixture-copy");
      mkdirSync(scratch, { recursive: true });
      writeFileSync(path.join(scratch, "payload.txt"), "one-off test fixture");
    }
    store.reclaimRuntimeTempDirectory("codex-reclaim", sessionA);
    assert.equal(existsSync(sessionTemp(userRoot, "codex-reclaim", sessionA)), false);
    assert.equal(existsSync(sessionTemp(userRoot, "codex-reclaim", sessionB)), true);
    assert.equal(existsSync(path.join(userRoot, "runtime-instances", "codex-reclaim", "home")), true);
    // Reclaiming an already-reclaimed session is a no-op, not an error.
    store.reclaimRuntimeTempDirectory("codex-reclaim", sessionA);
    assert.equal(existsSync(sessionTemp(userRoot, "codex-reclaim", sessionA)), false);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("operator-environment instances never mint or reclaim a per-run temp directory", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-operator-temp-"));
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed],
      env: { PATH: "/runtime/tools", HOME: "/operator/home", TMPDIR: "/operator/tmp" },
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-operator-temp",
      name: "Codex Operator Temp",
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
    const launch = await store.prepareLaunch("codex-operator-temp", {
      cwd: "/workspace/repo",
      prompt: "Operator run",
      runtimeSessionId: sessionA,
    });
    assert.equal(launch.env.TMPDIR, "/operator/tmp");
    assert.equal(existsSync(path.join(userRoot, "runtime-instances")), false);
    store.reclaimRuntimeTempDirectory("codex-operator-temp", sessionA);
    assert.equal(existsSync(path.join(userRoot, "runtime-instances")), false);
    // An unknown instance has no state root to reclaim; the call stays a no-op.
    store.reclaimRuntimeTempDirectory("codex-missing", sessionA);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("a session id outside the spawner-minted shape never reaches the temp path join", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-temp-shape-"));
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed],
      resolveCredential: () => "instance-secret",
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-temp-shape",
      name: "Codex Temp Shape",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: {},
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-temp-shape" },
    });
    for (const forged of ["../../elsewhere", "runtime_SHORT", "runtime_zzzzzzzzzzzzzzzzzzzzzzzz"]) {
      await assert.rejects(
        store.prepareLaunch("codex-temp-shape", {
          cwd: "/workspace/repo",
          prompt: "Forged session",
          runtimeSessionId: forged,
        }),
        (error: unknown) => codedAs(error, "invalid_runtime_session_id"),
      );
      // The reclaim path reads session ids back from disk (adopted dispatch streams), so it
      // skips a forged shape instead of throwing or deleting.
      store.reclaimRuntimeTempDirectory("codex-temp-shape", forged);
      assert.equal(existsSync(path.join(userRoot, "runtime-instances", "codex-temp-shape", "tmp", forged)), false);
    }
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
