// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  daemonLaunchSpecPath,
  persistDaemonLaunchSpec,
  readPersistedDaemonLaunchSpec,
  resolveRestoredLaunchOptions,
  type DaemonLaunchConfiguration
} from "../src/daemon/daemon-launch-spec.ts";

const persisted: DaemonLaunchConfiguration = {
  execPath: "/old/node",
  execArgv: ["--old-runtime"],
  entrypoint: "/old/ha.js",
  args: [
    "--root", "/repo",
    "--authored-root", "/old/authored",
    "daemon", "serve",
    "--socket", "/old.sock",
    "--authority-manifest", "/old/manifest.json"
  ]
};

test("persisted daemon launch spec round-trips the RPC launch configuration structure privately", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-launch-spec-"));
  try {
    persistDaemonLaunchSpec(userRoot, "default", persisted);
    assert.deepEqual(readPersistedDaemonLaunchSpec(userRoot, "default"), persisted);
    const document = JSON.parse(readFileSync(daemonLaunchSpecPath(userRoot, "default"), "utf8")) as Record<string, unknown>;
    assert.equal(document.schema, "daemon-launch-spec/v1");
    if (process.platform !== "win32") assert.equal(statSync(daemonLaunchSpecPath(userRoot, "default")).mode & 0o777, 0o600);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("cold start restores the omitted authority manifest and authored root from the persisted spec", () => {
  const restored = resolveRestoredLaunchOptions(persisted, {});
  assert.equal(restored.authorityManifest, "/old/manifest.json");
  assert.equal(restored.authoredRoot, "/old/authored");
});

test("explicit launch values take precedence over the persisted spec (no raw-argv merge)", () => {
  const restored = resolveRestoredLaunchOptions(persisted, {
    authorityManifest: "/new/manifest.json",
    authoredRoot: "/new/authored"
  });
  assert.equal(restored.authorityManifest, "/new/manifest.json");
  assert.equal(restored.authoredRoot, "/new/authored");
});

test("each restored option resolves independently: an explicit manifest keeps the restored authored root", () => {
  const restored = resolveRestoredLaunchOptions(persisted, { authorityManifest: "/env/manifest.json" });
  assert.equal(restored.authorityManifest, "/env/manifest.json");
  assert.equal(restored.authoredRoot, "/old/authored");
});

test("no persisted spec and no explicit values leaves restored options undefined (fail closed upstream)", () => {
  const restored = resolveRestoredLaunchOptions(undefined, {});
  assert.equal(restored.authorityManifest, undefined);
  assert.equal(restored.authoredRoot, undefined);
});

test("incompatible persisted launch specs fail closed with a rebuild command", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-launch-spec-"));
  try {
    writeFileSync(daemonLaunchSpecPath(userRoot, "default"), JSON.stringify({ schema: "daemon-launch-spec/v0" }), "utf8");
    assert.throws(
      () => readPersistedDaemonLaunchSpec(userRoot, "default"),
      /DAEMON_LAUNCH_SPEC_INCOMPATIBLE.*ha daemon start --service --user-root <user-root> --authority-manifest <path>/u
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("launch specs are isolated per daemon id so one daemon's cold start cannot adopt another's manifest", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-launch-spec-"));
  try {
    persistDaemonLaunchSpec(userRoot, "alpha", persisted);
    assert.deepEqual(readPersistedDaemonLaunchSpec(userRoot, "alpha"), persisted);
    assert.equal(readPersistedDaemonLaunchSpec(userRoot, "beta"), undefined);
    assert.notEqual(daemonLaunchSpecPath(userRoot, "alpha"), daemonLaunchSpecPath(userRoot, "beta"));
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("a persisted manifest flag with no value is not filled from the following flag (fail closed)", () => {
  const corrupted: DaemonLaunchConfiguration = {
    ...persisted,
    args: ["--root", "/repo", "daemon", "serve", "--authority-manifest", "--authored-root", "/x"]
  };
  const restored = resolveRestoredLaunchOptions(corrupted, {});
  assert.equal(restored.authorityManifest, undefined);
  assert.equal(restored.authoredRoot, "/x");
});
