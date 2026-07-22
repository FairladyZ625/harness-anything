// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDaemonClientConfig, remoteDaemonSshArgs } from "../src/daemon/client.ts";

test("a configured checkout resolves the whole remote connection without any environment", () => {
  withTempRoot((rootDir) => {
    writeSharedConfig(rootDir);

    const config = readDaemonClientConfig(cleanDaemonEnv({ HOME: path.join(rootDir, "home") }), rootDir);

    assert.equal(config.mode, "remote");
    assert.deepEqual(config.remote, {
      host: "kty-harness",
      remoteHaPath: "/opt/harness/bin/ha",
      remoteRoot: "/srv/harness-repos/kty-harness",
      repoId: "kty-harness"
    });
    assert.deepEqual(
      config.remote ? [...remoteDaemonSshArgs(config.remote)] : [],
      ["kty-harness", "/opt/harness/bin/ha", "daemon", "connect", "--stdio"]
    );
  });
});

test("personal ssh aliases differ per operator while the shared ledger coordinates stay identical", () => {
  withTempRoot((firstRoot) => {
    withTempRoot((secondRoot) => {
      writeSharedConfig(firstRoot);
      writeSharedConfig(secondRoot);
      writeUserSettings(firstRoot, { schema: "user-settings/v1", daemon: { remote: { host: "kty-lan" } } });
      writeUserSettings(secondRoot, { schema: "user-settings/v1", daemon: { remote: { host: "kty-via-jump" } } });

      const first = readDaemonClientConfig(cleanDaemonEnv({ HOME: path.join(firstRoot, "home") }), firstRoot);
      const second = readDaemonClientConfig(cleanDaemonEnv({ HOME: path.join(secondRoot, "home") }), secondRoot);

      assert.equal(first.remote?.host, "kty-lan");
      assert.equal(second.remote?.host, "kty-via-jump");
      assert.equal(first.remote?.remoteRoot, second.remote?.remoteRoot);
      assert.equal(first.remote?.repoId, second.remote?.repoId);
    });
  });
});

test("remote settings resolve environment over personal settings over the shared project file", () => {
  withTempRoot((rootDir) => {
    writeSharedConfig(rootDir);
    const env = cleanDaemonEnv({ HOME: path.join(rootDir, "home") });

    assert.equal(readDaemonClientConfig(env, rootDir).remote?.host, "kty-harness");

    writeUserSettings(rootDir, {
      schema: "user-settings/v1",
      daemon: { remote: { host: "kty-personal", repoId: "kty-scratch" } }
    });
    const personal = readDaemonClientConfig(env, rootDir);
    assert.equal(personal.remote?.host, "kty-personal");
    assert.equal(personal.remote?.repoId, "kty-scratch");
    assert.equal(personal.remote?.remoteRoot, "/srv/harness-repos/kty-harness");

    const overridden = readDaemonClientConfig({ ...env, HARNESS_DAEMON_SSH_HOST: "kty-operations" }, rootDir);
    assert.equal(overridden.remote?.host, "kty-operations");
  });
});

test("personal settings predating the remote block keep working and stay optional", () => {
  withTempRoot((rootDir) => {
    writeSharedConfig(rootDir);
    writeUserSettings(rootDir, { schema: "user-settings/v1", devMode: { customVerticals: true } });

    const config = readDaemonClientConfig(cleanDaemonEnv({ HOME: path.join(rootDir, "home") }), rootDir);

    assert.equal(config.remote?.host, "kty-harness");
    assert.equal(config.remote?.repoId, "kty-harness");
  });
});

test("an incomplete remote connection names every layer that can supply the missing value", () => {
  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  identity:",
      "    mode: remote",
      "  daemon:",
      "    remote:",
      "      root: /srv/harness-repos/kty-harness",
      ""
    ]);

    assert.throws(
      () => readDaemonClientConfig(cleanDaemonEnv({ HOME: path.join(rootDir, "home") }), rootDir),
      /settings\.daemon\.remote\.host.*\.harness\/user-settings\.json.*HARNESS_DAEMON_SSH_HOST/su
    );
  });
});

test("malformed remote settings fail closed in both the shared file and personal settings", () => {
  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  identity:",
      "    mode: remote",
      "  daemon:",
      "    remote:",
      "      host: kty-harness",
      "      root: harness-repos/kty-harness",
      ""
    ]);
    const env = cleanDaemonEnv({ HOME: path.join(rootDir, "home") });
    assert.throws(() => readDaemonClientConfig(env, rootDir), /must be an absolute path on the remote host/u);

    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  identity:",
      "    mode: remote",
      "  daemon:",
      "    remote:",
      "      hostname: kty-harness",
      ""
    ]);
    assert.throws(() => readDaemonClientConfig(env, rootDir), /Unknown settings\.daemon\.remote key: hostname/u);

    writeSharedConfig(rootDir);
    writeUserSettings(rootDir, { schema: "user-settings/v1", daemon: { remote: { host: "kty harness" } } });
    assert.throws(() => readDaemonClientConfig(env, rootDir), /user-settings\.json daemon\.remote\.host/u);

    writeUserSettings(rootDir, { schema: "user-settings/v1", daemon: { sshHost: "kty-harness" } });
    assert.throws(() => readDaemonClientConfig(env, rootDir), /user-settings\.json daemon supports only remote/u);
  });
});

test("the shared file keeps carrying userRoot alongside the remote block", () => {
  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  identity:",
      "    mode: remote",
      "  daemon:",
      "    userRoot: state/daemon",
      "    remote:",
      "      host: kty-harness",
      "      root: /srv/harness-repos/kty-harness",
      ""
    ]);

    const config = readDaemonClientConfig(cleanDaemonEnv({ HOME: path.join(rootDir, "home") }), rootDir);

    assert.equal(config.userRoot, path.resolve(rootDir, "state/daemon"));
    assert.equal(config.remote?.host, "kty-harness");
    assert.equal(config.remote?.repoId, "canonical");
    assert.equal(config.remote?.remoteHaPath, "ha");
  });
});

function withTempRoot(run: (rootDir: string) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-daemon-remote-"));
  try {
    run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeSharedConfig(rootDir: string): void {
  writeHarnessConfig(rootDir, [
    "schema: harness-anything/v1",
    "settings:",
    "  identity:",
    "    mode: remote",
    "  daemon:",
    "    remote:",
    "      host: kty-harness",
    "      root: /srv/harness-repos/kty-harness",
    "      repoId: kty-harness",
    "      haPath: /opt/harness/bin/ha",
    ""
  ]);
}

function writeHarnessConfig(rootDir: string, lines: ReadonlyArray<string>): void {
  const harnessDir = path.join(rootDir, "harness");
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(path.join(harnessDir, "harness.yaml"), lines.join("\n"), "utf8");
}

function writeUserSettings(rootDir: string, value: Record<string, unknown>): void {
  const filePath = path.join(rootDir, ".harness/user-settings.json");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function cleanDaemonEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: os.homedir(),
    ...overrides
  };
}
