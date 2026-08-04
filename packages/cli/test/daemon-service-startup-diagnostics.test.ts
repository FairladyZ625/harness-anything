// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createFixture } from "./production-authority-canonical-ingress/fixture.ts";
import {
  delay,
  pollUntil,
  runRawJsonAsync,
  runRawJsonMaybeFail,
  stopDaemon
} from "./helpers/daemon-cli.ts";

test("service startup persists child stderr and reports the exit code and log path", { timeout: 45_000 }, async () => {
  const fixture = createFixture();
  const firstUserRoot = path.join(fixture.root, "first-user");
  const blockedUserRoot = path.join(fixture.root, "blocked-user");
  const lockPath = path.join(fixture.repoRoot, ".harness/locks/global.lock");
  const first = runRawJsonAsync(
    fixture.repoRoot,
    ["daemon", "start", "--foreground", "--user-root", firstUserRoot, "--authority-manifest", fixture.manifestPath],
    daemonEnv(firstUserRoot)
  );
  try {
    await pollUntil(
      () => existsSync(lockPath),
      (exists) => exists,
      (exists, error) => JSON.stringify({ lockPath, exists, error: String(error ?? "") }),
      { timeoutMs: 20_000 }
    );
    const failed = runRawJsonMaybeFail(
      fixture.repoRoot,
      ["daemon", "start", "--service", "--user-root", blockedUserRoot, "--authority-manifest", fixture.manifestPath],
      daemonEnv(blockedUserRoot)
    );
    assert.notEqual(failed.status, 0, JSON.stringify(failed.receipt));
    const error = failed.receipt.error as { readonly context?: Record<string, unknown>; readonly hint?: string };
    assert.equal(error.context?.childExitCode, 1, JSON.stringify(failed.receipt));
    const logPath = requireLaunchLogPath(error.context?.launchLogPath, blockedUserRoot);
    assert.match(error.hint ?? "", /child exit code=1/u);
    assert.match(error.hint ?? "", new RegExp(`launch log: ${escapeRegExp(logPath)}$`, "u"));
    assert.match(readFileSync(logPath, "utf8"), /DAEMON_REPO_LOCK_SET_CONFLICT/u);
  } finally {
    await stopDaemon(fixture.repoRoot, firstUserRoot).catch(() => undefined);
    await first.catch(() => undefined);
  }
});

test("service startup timeout stops a delayed child before it can publish a lock", { timeout: 45_000 }, async () => {
  const fixture = createFixture();
  const userRoot = path.join(fixture.root, "slow-user");
  const lockPath = path.join(fixture.repoRoot, ".harness/locks/global.lock");
  const preloadPath = path.join(fixture.root, "slow-start-preload.mjs");
  writeFileSync(preloadPath, [
    'if (process.env.HARNESS_DAEMON_SERVER_HOST === "1") {',
    '  const delayMs = Number.parseInt(process.env.HARNESS_DIAGNOSTIC_START_DELAY_MS ?? "0", 10);',
    '  if (Number.isSafeInteger(delayMs) && delayMs > 0) {',
    '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);',
    "  }",
    "}",
    ""
  ].join("\n"), "utf8");
  try {
    const failed = runRawJsonMaybeFail(
      fixture.repoRoot,
      ["daemon", "start", "--service", "--user-root", userRoot, "--authority-manifest", fixture.manifestPath],
      daemonEnv(userRoot, {
        HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "1000",
        HARNESS_DIAGNOSTIC_START_DELAY_MS: "8000",
        NODE_OPTIONS: `--import=${preloadPath}`
      })
    );
    assert.notEqual(failed.status, 0, JSON.stringify(failed.receipt));
    const error = failed.receipt.error as { readonly context?: Record<string, unknown>; readonly hint?: string };
    assert.equal(error.context?.childExitCode, null, JSON.stringify(failed.receipt));
    const logPath = requireLaunchLogPath(error.context?.launchLogPath, userRoot);
    assert.match(error.hint ?? "", /child exit code=null/u);
    assert.match(error.hint ?? "", new RegExp(`launch log: ${escapeRegExp(logPath)}$`, "u"));
    await delay(2_500);
    const status = runRawJsonMaybeFail(
      fixture.repoRoot,
      ["daemon", "status", "--user-root", userRoot],
      daemonEnv(userRoot)
    );
    assert.equal(status.receipt.reachable, false, JSON.stringify(status.receipt));
    assert.equal(existsSync(lockPath), false, `startup timeout left lock: ${lockPath}`);
    assert.equal(readFileSync(logPath, "utf8").includes("startup timeout"), true);
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
  }
});

function daemonEnv(userRoot: string, overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    HARNESS_DAEMON_REQUEST_TIMEOUT_MS: "35000",
    ...overrides
  };
}

function requireLaunchLogPath(value: unknown, userRoot: string): string {
  assert.equal(typeof value, "string", JSON.stringify({ value, userRoot }));
  const logPath = value as string;
  const relative = path.relative(path.resolve(userRoot), path.resolve(logPath));
  assert.equal(relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)), true, logPath);
  assert.equal(existsSync(logPath), true, logPath);
  return logPath;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
