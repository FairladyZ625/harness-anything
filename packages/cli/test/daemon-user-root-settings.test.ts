// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "@harness-anything/daemon";
import { readProjectHarnessSettings } from "../src/commands/settings.ts";
import { readDaemonClientConfig, resolveLocalDaemonTarget } from "../src/daemon/client.ts";

test("project daemon user root resolves once for config, registry target, socket, and autostart", () => {
  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  identity:",
      "    mode: local",
      "    personId: person_test",
      "  daemon:",
      "    userRoot: state/daemon",
      "  tasks:",
      "    leaseEnforcement: true",
      ""
    ]);

    const env = cleanDaemonEnv({ HOME: path.join(rootDir, "home") });
    const expected = path.resolve(rootDir, "state/daemon");
    const config = readDaemonClientConfig(env, rootDir);
    const target = resolveLocalDaemonTarget({ rootDir, env, autoRegisterSingleRepo: false });
    const settings = readProjectHarnessSettings(rootDir);

    assert.equal(settings.ok, true);
    if (!settings.ok) return;
    assert.deepEqual(settings.settings.daemon, { userRoot: "state/daemon" });
    assert.equal(settings.settings.identity?.personId, "person_test");
    assert.equal(settings.settings.tasks.leaseEnforcement, true);
    assert.equal(config.userRoot, expected);
    assert.equal(target.userRoot, expected);
    assert.equal(target.socketPath, localUserDaemonEndpoint(expected, config.daemonId));

    const nestedRoot = path.join(rootDir, "workspace/nested");
    mkdirSync(nestedRoot, { recursive: true });
    assert.equal(readDaemonClientConfig(env, nestedRoot).userRoot, expected);
  });
});

test("daemon user root precedence preserves defaults and isolated profile", () => {
  withTempRoot((rootDir) => {
    const home = path.join(rootDir, "home");
    const baseEnv = cleanDaemonEnv({ HOME: home });
    assert.equal(readDaemonClientConfig(baseEnv, rootDir).userRoot, path.resolve(home, ".harness"));
    assert.equal(
      readDaemonClientConfig({ ...baseEnv, HARNESS_DAEMON_PROFILE: "isolated" }, rootDir).userRoot,
      path.resolve(rootDir, ".harness/daemon-profile")
    );

    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  daemon:",
      "    userRoot: project-daemon",
      ""
    ]);
    assert.equal(
      readDaemonClientConfig({ ...baseEnv, HARNESS_DAEMON_PROFILE: "isolated" }, rootDir).userRoot,
      path.resolve(rootDir, "project-daemon")
    );
    assert.equal(
      readDaemonClientConfig({
        ...baseEnv,
        HARNESS_DAEMON_PROFILE: "isolated",
        HARNESS_DAEMON_USER_ROOT: path.join(rootDir, "operations-override")
      }, rootDir).userRoot,
      path.resolve(rootDir, "operations-override")
    );
  });
});

test("daemon client request timeout is bounded by default and accepts an explicit budget", () => {
  withTempRoot((rootDir) => {
    const baseEnv = cleanDaemonEnv({ HOME: path.join(rootDir, "home") });
    assert.equal(readDaemonClientConfig(baseEnv, rootDir).requestTimeoutMs, 35_000);
    assert.equal(readDaemonClientConfig({
      ...baseEnv,
      HARNESS_DAEMON_REQUEST_TIMEOUT_MS: "1250"
    }, rootDir).requestTimeoutMs, 1_250);
  });
});

test("project daemon user root expands home and accepts absolute paths", () => {
  withTempRoot((rootDir) => {
    const home = path.join(rootDir, "configured-home");
    const env = cleanDaemonEnv({ HOME: home });
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  daemon:",
      "    userRoot: ~/.harness-project",
      ""
    ]);
    assert.equal(readDaemonClientConfig(env, rootDir).userRoot, path.resolve(home, ".harness-project"));

    const absolute = path.join(rootDir, "absolute-daemon");
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  daemon:",
      `    userRoot: ${absolute}`,
      ""
    ]);
    assert.equal(readDaemonClientConfig(env, rootDir).userRoot, path.resolve(absolute));
  });
});

test("settings daemon userRoot validates path-shaped scalar input", () => {
  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  daemon:",
      "    userRoot: ~another-user/daemon",
      ""
    ]);
    const result = readProjectHarnessSettings(rootDir);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.result.error?.hint ?? "", /supports only ~ or ~\//u);
    assert.throws(
      () => readDaemonClientConfig(cleanDaemonEnv({ HOME: path.join(rootDir, "home") }), rootDir),
      /settings\.daemon\.userRoot supports only ~ or ~\//u
    );
  });
});

test("daemon user root reads settings through an authored-root override", () => {
  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  daemon:",
      "    userRoot: state/default-daemon",
      ""
    ]);
    const authoredRoot = "authority/config";
    const authoredRootPath = path.join(rootDir, authoredRoot);
    mkdirSync(authoredRootPath, { recursive: true });
    writeFileSync(path.join(authoredRootPath, "harness.yaml"), [
      "schema: harness-anything/v1",
      "settings:",
      "  daemon:",
      "    userRoot: state/authority-daemon",
      ""
    ].join("\n"), "utf8");

    const env = cleanDaemonEnv({ HOME: path.join(rootDir, "home") });
    const layoutOverrides = { authoredRoot };
    const expected = path.join(rootDir, "state/authority-daemon");
    assert.equal(readDaemonClientConfig(env, rootDir, undefined, undefined, layoutOverrides).userRoot, expected);
    assert.equal(resolveLocalDaemonTarget({ rootDir, env, layoutOverrides }).userRoot, expected);
  });
});

function withTempRoot(run: (rootDir: string) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-daemon-settings-"));
  try {
    run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeHarnessConfig(rootDir: string, lines: ReadonlyArray<string>): void {
  const harnessDir = path.join(rootDir, "harness");
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(path.join(harnessDir, "harness.yaml"), lines.join("\n"), "utf8");
}

function cleanDaemonEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: os.homedir(),
    ...overrides
  };
}
