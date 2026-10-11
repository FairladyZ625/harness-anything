// harness-test-tier: contract
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instances.ts";
import { sweepSettledRuntimeTempDirectories } from "../src/runtime-spawn-adoption.ts";
import { codedAs, observed } from "./agent-runtime-instance-environment.fixture.ts";

const sessionA = "runtime_0123456789abcdef01234567",
  sessionB = "runtime_89abcdef0123456789abcdef",
  sessionC = "runtime_abababababababababababab",
  sessionD = "runtime_cdcdcdcdcdcdcdcdcdcdcdcd";

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
      assert.equal(store.reclaimRuntimeTempDirectory("codex-temp-shape", forged), null);
      assert.equal(existsSync(path.join(userRoot, "runtime-instances", "codex-temp-shape", "tmp", forged)), false);
    }
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("a reclaim the filesystem refuses returns the failure instead of swallowing it", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-reclaim-refused-"));
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed],
      resolveCredential: () => "instance-secret",
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-reclaim-refused",
      name: "Codex Reclaim Refused",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: {},
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-reclaim-refused" },
    });
    for (const session of [sessionA, sessionB]) {
      await store.prepareLaunch("codex-reclaim-refused", {
        cwd: "/workspace/repo",
        prompt: session,
        runtimeSessionId: session,
      });
    }
    // A directory holding content and without write permission refuses recursive removal for
    // its owner: the reclaim returns that refusal (the terminal body records it; the startup
    // sweep retries) while the sibling session still reclaims normally.
    const lockedRoot = sessionTemp(userRoot, "codex-reclaim-refused", sessionA);
    mkdirSync(path.join(lockedRoot, "scratch"));
    writeFileSync(path.join(lockedRoot, "scratch", "payload.txt"), "one-off fixture");
    chmodSync(lockedRoot, 0o500);
    const refused = store.reclaimRuntimeTempDirectory("codex-reclaim-refused", sessionA);
    assert.equal(refused instanceof Error, true);
    assert.equal(typeof (refused as NodeJS.ErrnoException).message, "string");
    assert.equal(existsSync(sessionTemp(userRoot, "codex-reclaim-refused", sessionA)), true);
    assert.equal(store.reclaimRuntimeTempDirectory("codex-reclaim-refused", sessionB), null);
    assert.equal(existsSync(sessionTemp(userRoot, "codex-reclaim-refused", sessionB)), false);
    // Unlock for the cleanup below.
    chmodSync(sessionTemp(userRoot, "codex-reclaim-refused", sessionA), 0o700);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("the settled-session sweep reclaims only settled per-run directories it owns", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-temp-sweep-"));
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed],
      resolveCredential: () => "instance-secret",
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-sweep",
      name: "Codex Sweep",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: {},
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-sweep" },
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-sweep-operator",
      name: "Codex Sweep Operator",
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
    for (const session of [sessionA, sessionB, sessionC, sessionD]) {
      await store.prepareLaunch("codex-sweep", {
        cwd: "/workspace/repo",
        prompt: session,
        runtimeSessionId: session,
      });
    }
    // An operator-environment instance never owns per-run directories; one planted manually
    // under its state root must stay untouched, as must non-session entries in the tmp root.
    const operatorSession = sessionTemp(userRoot, "codex-sweep-operator", sessionA);
    mkdirSync(operatorSession, { recursive: true });
    const sweepTmpRoot = path.join(userRoot, "runtime-instances", "codex-sweep", "tmp");
    mkdirSync(path.join(sweepTmpRoot, "operator-notes"));
    writeFileSync(path.join(sweepTmpRoot, "runtime_ffffffffffffffffffffffff"), "a file, not a session directory\n");
    // sessionA: settled but locked (the failure the sweep retries every start); sessionB:
    // still live; sessionC: settled; sessionD: settled.
    const lockedRoot = sessionTemp(userRoot, "codex-sweep", sessionA);
    mkdirSync(path.join(lockedRoot, "scratch"));
    writeFileSync(path.join(lockedRoot, "scratch", "payload.txt"), "one-off fixture");
    chmodSync(lockedRoot, 0o500);
    const failures = store.reclaimSettledRuntimeTempDirectories([sessionA, sessionC, sessionD]);
    assert.deepEqual(
      failures.map((failure) => [failure.instanceId, failure.runtimeSessionId]),
      [["codex-sweep", sessionA]],
    );
    assert.equal(failures[0]?.error instanceof Error, true);
    assert.equal(existsSync(sessionTemp(userRoot, "codex-sweep", sessionA)), true, "locked directory stays");
    assert.equal(existsSync(sessionTemp(userRoot, "codex-sweep", sessionB)), true, "live session stays");
    assert.equal(existsSync(sessionTemp(userRoot, "codex-sweep", sessionC)), false, "settled session reclaimed");
    assert.equal(existsSync(sessionTemp(userRoot, "codex-sweep", sessionD)), false, "settled session reclaimed");
    assert.equal(existsSync(operatorSession), true, "another instance's directories stay");
    assert.equal(existsSync(path.join(sweepTmpRoot, "operator-notes")), true, "non-session entries stay");
    // Unlock for the cleanup below.
    chmodSync(sessionTemp(userRoot, "codex-sweep", sessionA), 0o700);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("a repository sweep preserves another repository's live, settled and unregistered temp directories", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-two-repos-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], resolveCredential: () => "secret" });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-shared",
      name: "Shared",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: {},
      auth: { mode: "api-key", credentialRef: "credential:v1:shared" },
    });
    const ids = Array.from({ length: 6 }, (_, index) => `runtime_${String(index + 1).repeat(24)}`);
    for (const [index, runtimeSessionId] of ids.entries()) {
      await store.prepareLaunch("codex-shared", {
        cwd: index < 3 ? "/workspace/repo-a" : "/workspace/repo-b",
        prompt: "Fixture",
        runtimeSessionId,
      });
      writeFileSync(path.join(sessionTemp(userRoot, "codex-shared", runtimeSessionId), "scratch"), "payload");
    }
    const sweep = (sessions: { runtimeSessionId: string; outcome: string | null }[]) =>
      sweepSettledRuntimeTempDirectories({
        input: { reclaimSettledRuntimeTempDirectories: store.reclaimSettledRuntimeTempDirectories },
        processes: new Map(),
        exiting: new Set(),
        requiredRuntimeProjection: () => ({ readRuntimeSessions: () => sessions }),
      } as never);
    await sweep([]);
    for (const id of ids)
      assert.equal(existsSync(sessionTemp(userRoot, "codex-shared", id)), true, "empty repo owns none");
    await sweep([
      { runtimeSessionId: ids[0]!, outcome: null },
      { runtimeSessionId: ids[1]!, outcome: "succeeded" },
    ]);
    for (const [index, id] of ids.entries())
      assert.equal(
        existsSync(sessionTemp(userRoot, "codex-shared", id)),
        index !== 1,
        "A reclaims only its settled session; A/B live and orphan plus B settled stay",
      );
    await sweep([
      { runtimeSessionId: ids[3]!, outcome: null },
      { runtimeSessionId: ids[4]!, outcome: "failed" },
    ]);
    for (const [index, id] of ids.entries())
      assert.equal(
        existsSync(sessionTemp(userRoot, "codex-shared", id)),
        index !== 1 && index !== 4,
        "B reclaims only its settled session; both repositories' live and orphan stay",
      );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
