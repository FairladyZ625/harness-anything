// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  configuredDaemonAttachTimeoutMs,
  DAEMON_ATTACH_TIMEOUT_ENV,
  DEFAULT_DAEMON_ATTACH_TIMEOUT_MS,
  MAX_DAEMON_ATTACH_TIMEOUT_MS,
  parseDaemonAttachTimeoutMs,
  resolveDaemonAttachTimeoutMs,
} from "../src/daemon-host/attach-timeout.ts";
import { ensureLocalDaemonRunning } from "../src/daemon-host/client/daemon-autostart.ts";
import { daemonPidPath, daemonSingletonLockPath } from "../src/daemon-host/daemon-singleton.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

const binEntry = path.resolve(import.meta.dirname, "../src/daemon-host/bin.ts");

test("resolveDaemonAttachTimeoutMs defaults to 60_000 when unset and honors env and CLI override", () => {
  assert.equal(DEFAULT_DAEMON_ATTACH_TIMEOUT_MS, 60_000);
  assert.equal(resolveDaemonAttachTimeoutMs({}), 60_000);
  assert.equal(resolveDaemonAttachTimeoutMs({ [DAEMON_ATTACH_TIMEOUT_ENV]: "900000" }), 900_000);
  assert.equal(resolveDaemonAttachTimeoutMs({ [DAEMON_ATTACH_TIMEOUT_ENV]: " 120000 " }), 120_000);
  assert.equal(resolveDaemonAttachTimeoutMs({ [DAEMON_ATTACH_TIMEOUT_ENV]: "1" }), 1);
  assert.equal(
    resolveDaemonAttachTimeoutMs({ [DAEMON_ATTACH_TIMEOUT_ENV]: String(MAX_DAEMON_ATTACH_TIMEOUT_MS) }),
    MAX_DAEMON_ATTACH_TIMEOUT_MS,
  );
  assert.equal(
    resolveDaemonAttachTimeoutMs({ [DAEMON_ATTACH_TIMEOUT_ENV]: "900000" }, "180000"),
    180_000,
    "explicit --attach-timeout-ms override takes precedence over env",
  );
  assert.equal(configuredDaemonAttachTimeoutMs(undefined), 60_000);
  assert.equal(configuredDaemonAttachTimeoutMs(250_000), 250_000);
});

test("parseDaemonAttachTimeoutMs rejects empty, non-positive, non-integer, and overflowing values fail-closed", () => {
  for (const invalid of [
    "",
    "   ",
    "0",
    "-1",
    "-60000",
    "0100",
    "1.5",
    "1e5",
    "60000ms",
    "abc",
    String(MAX_DAEMON_ATTACH_TIMEOUT_MS + 1),
    "99999999999999999999",
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_DAEMON_ATTACH_TIMEOUT_MS + 1,
  ]) {
    assert.throws(
      () => parseDaemonAttachTimeoutMs(invalid),
      /Invalid HARNESS_DAEMON_ATTACH_TIMEOUT_MS/u,
      `expected ${JSON.stringify(invalid)} to fail closed`,
    );
  }
  assert.throws(() => configuredDaemonAttachTimeoutMs(0), /Invalid attachTimeoutMs/u);
  assert.throws(() => configuredDaemonAttachTimeoutMs(-10), /Invalid attachTimeoutMs/u);
  assert.throws(() => configuredDaemonAttachTimeoutMs(12.5), /Invalid attachTimeoutMs/u);
  assert.throws(() => configuredDaemonAttachTimeoutMs(MAX_DAEMON_ATTACH_TIMEOUT_MS + 1), /Invalid attachTimeoutMs/u);
  assert.throws(() => resolveDaemonAttachTimeoutMs({}, "0"), /Invalid --attach-timeout-ms/u);
});

test("ensureLocalDaemonRunning rejects invalid attach timeout env or CLI flag before spawning", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-autostart-attach-invalid-"));
  try {
    for (const spec of [
      {
        label: "invalid env",
        args: [binEntry, "serve", "--user-root", userRoot, "--daemon-id", "bad-env"],
        env: { [DAEMON_ATTACH_TIMEOUT_ENV]: "0" },
        pattern: /Invalid HARNESS_DAEMON_ATTACH_TIMEOUT_MS/u,
      },
      {
        label: "invalid flag",
        args: [binEntry, "serve", "--user-root", userRoot, "--daemon-id", "bad-flag", "--attach-timeout-ms", "-5"],
        env: {},
        pattern: /Invalid --attach-timeout-ms/u,
      },
      {
        label: "missing flag value",
        args: [binEntry, "serve", "--user-root", userRoot, "--daemon-id", "missing-flag", "--attach-timeout-ms"],
        env: {},
        pattern: /Missing value for --attach-timeout-ms/u,
      },
    ]) {
      let spawns = 0;
      const result = await ensureLocalDaemonRunning({
        socketPath: path.join(userRoot, `${spec.label.replace(/\s+/gu, "-")}.sock`),
        invokingRoot: userRoot,
        launch: () => ({ command: process.execPath, args: spec.args, env: spec.env }),
        probe: async () => false,
        spawnDetached: async () => {
          spawns += 1;
        },
      });
      assert.equal(result.ok, false, spec.label);
      assert.equal(result.code, "daemon_start_failed", spec.label);
      assert.equal(spawns, 0, `${spec.label} must fail before spawning`);
      assert.match(result.hint, spec.pattern, spec.label);
    }
  } finally {
    removeTempRepository(userRoot);
  }
});

test("daemon bin entrypoint rejects invalid HARNESS_DAEMON_ATTACH_TIMEOUT_MS and --attach-timeout-ms fail-closed", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-bin-attach-invalid-"));
  try {
    const baseEnv = { ...process.env };
    delete baseEnv.HARNESS_ACTOR;
    delete baseEnv[DAEMON_ATTACH_TIMEOUT_ENV];
    for (const scenario of [
      {
        label: "env zero",
        args: [binEntry, "serve", "--user-root", userRoot, "--daemon-id", "bin-zero"],
        env: { ...baseEnv, [DAEMON_ATTACH_TIMEOUT_ENV]: "0" },
        pattern: /Invalid HARNESS_DAEMON_ATTACH_TIMEOUT_MS/u,
      },
      {
        label: "env whitespace",
        args: [binEntry, "serve", "--user-root", userRoot, "--daemon-id", "bin-blank"],
        env: { ...baseEnv, [DAEMON_ATTACH_TIMEOUT_ENV]: "   " },
        pattern: /Invalid HARNESS_DAEMON_ATTACH_TIMEOUT_MS/u,
      },
      ...(process.platform === "win32"
        ? []
        : [
            {
              label: "env empty",
              args: [binEntry, "serve", "--user-root", userRoot, "--daemon-id", "bin-empty"],
              env: { ...baseEnv, [DAEMON_ATTACH_TIMEOUT_ENV]: "" },
              pattern: /Invalid HARNESS_DAEMON_ATTACH_TIMEOUT_MS/u,
            },
          ]),
      {
        label: "env non-numeric",
        args: [binEntry, "serve", "--user-root", userRoot, "--daemon-id", "bin-text"],
        env: { ...baseEnv, [DAEMON_ATTACH_TIMEOUT_ENV]: "not-a-number" },
        pattern: /Invalid HARNESS_DAEMON_ATTACH_TIMEOUT_MS/u,
      },
      {
        label: "flag negative",
        args: [binEntry, "serve", "--user-root", userRoot, "--daemon-id", "bin-neg", "--attach-timeout-ms", "-1"],
        env: baseEnv,
        pattern: /Invalid --attach-timeout-ms/u,
      },
      {
        label: "flag missing value",
        args: [binEntry, "serve", "--user-root", userRoot, "--daemon-id", "bin-missing", "--attach-timeout-ms"],
        env: baseEnv,
        pattern: /Missing value for --attach-timeout-ms/u,
      },
    ]) {
      const result = spawnSync(process.execPath, scenario.args, {
        env: scenario.env,
        encoding: "utf8",
        timeout: 15_000,
      });
      assert.equal(result.status, 1, `${scenario.label}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, scenario.pattern, scenario.label);
    }
    assert.equal(existsSync(daemonPidPath(userRoot, "bin-zero")), false);
    assert.equal(existsSync(daemonSingletonLockPath(userRoot, "bin-zero")), false);
  } finally {
    removeTempRepository(userRoot);
  }
});
