// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "../../daemon/src/index.ts";
import { createFixture } from "./production-authority-canonical-ingress/fixture.ts";
import { delay, runRawJsonMaybeFail, stopDaemon } from "./helpers/daemon-cli.ts";

test("autostart reports the daemon child's real startup failure", { timeout: 30_000 }, (t) => {
  if (process.platform === "win32") return;
  const fixture = createFixture();
  const userRoot = path.join(fixture.root, "autostart-failure-user");
  const daemon = testDaemonLocation(fixture.root, userRoot);
  const endpoint = daemon.socketPath;
  mkdirSync(endpoint, { recursive: true });
  writeFileSync(path.join(endpoint, "blocker"), "keep the occupied endpoint non-empty\n", "utf8");
  t.after(() => {
    rmSync(endpoint, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const failed = runRawJsonMaybeFail(fixture.repoRoot, ["task", "list"], daemon.env);

  assert.notEqual(failed.status, 0, JSON.stringify(failed.receipt));
  const error = failed.receipt.error as { readonly hint?: string };
  assert.match(error.hint ?? "", new RegExp(
    `DAEMON_SOCKET_NAMESPACE_INVALID:path=${escapeRegExp(endpoint)};.*connectCode=ERR_FS_EISDIR`,
    "u"
  ));
});

test("autostart does not describe an exited daemon process as still starting", { timeout: 30_000 }, (t) => {
  if (process.platform === "win32") return;
  const fixture = createFixture();
  const userRoot = path.join(fixture.root, "autostart-exited-user");
  const daemon = testDaemonLocation(fixture.root, userRoot);
  const endpoint = daemon.socketPath;
  mkdirSync(endpoint, { recursive: true });
  writeFileSync(path.join(endpoint, "blocker"), "keep the occupied endpoint non-empty\n", "utf8");
  t.after(() => {
    rmSync(endpoint, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const failed = runRawJsonMaybeFail(fixture.repoRoot, ["task", "list"], daemon.env);

  assert.notEqual(failed.status, 0, JSON.stringify(failed.receipt));
  const error = failed.receipt.error as { readonly hint?: string };
  assert.match(error.hint ?? "", /DAEMON_AUTOSTART_PROCESS_EXITED:.*exited before readiness/u);
  assert.doesNotMatch(error.hint ?? "", /may still be starting/u);
  assert.match(error.hint ?? "", new RegExp(
    `DAEMON_SOCKET_NAMESPACE_INVALID:path=${escapeRegExp(endpoint)};.*connectCode=ERR_FS_EISDIR`,
    "u"
  ));
});

test("autostart keeps waiting while a live daemon is slowly starting", { timeout: 45_000 }, async (t) => {
  const fixture = createFixture();
  const userRoot = path.join(fixture.root, "slow-autostart-user");
  const daemon = testDaemonLocation(fixture.root, userRoot);
  const preloadPath = path.join(fixture.root, "slow-autostart-preload.mjs");
  const startupDelayMs = 1_200;
  writeFileSync(preloadPath, [
    'if (process.env.HARNESS_DAEMON_SERVER_HOST === "1") {',
    `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${startupDelayMs});`,
    "}",
    ""
  ].join("\n"), "utf8");
  t.after(async () => {
    await stopDaemon(fixture.repoRoot, userRoot, daemon.runtimeEnv).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const startedAt = Date.now();
  const outcome = runRawJsonMaybeFail(fixture.repoRoot, ["task", "list"], {
    ...daemon.env,
    NODE_OPTIONS: `--import=${preloadPath}`,
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "10000"
  });

  assert.equal(outcome.status, 0, JSON.stringify(outcome.receipt));
  assert.ok(Date.now() - startedAt >= startupDelayMs, "the caller returned before the injected startup delay elapsed");
});

test("an autostarted daemon stays alive after its calling CLI exits", { timeout: 45_000 }, async (t) => {
  const fixture = createFixture();
  const userRoot = path.join(fixture.root, "detached-autostart-user");
  const daemon = testDaemonLocation(fixture.root, userRoot);
  t.after(async () => {
    await stopDaemon(fixture.repoRoot, userRoot, daemon.runtimeEnv).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const launched = runRawJsonMaybeFail(fixture.repoRoot, ["task", "list"], daemon.env);
  assert.equal(launched.status, 0, JSON.stringify(launched.receipt));
  await delay(200);

  const status = runRawJsonMaybeFail(
    fixture.repoRoot,
    ["daemon", "status", "--user-root", userRoot],
    daemon.env
  );
  assert.equal(status.status, 0, JSON.stringify(status.receipt));
  assert.equal(status.receipt.reachable, true, JSON.stringify(status.receipt));
  assert.equal(typeof status.receipt.pid, "number", JSON.stringify(status.receipt));
  assert.doesNotThrow(() => process.kill(status.receipt.pid as number, 0));
});

interface TestDaemonLocation {
  readonly socketPath: string;
  readonly runtimeEnv: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>>;
}

function testDaemonLocation(rootDir: string, userRoot: string): TestDaemonLocation {
  const runtimeDir = path.join(rootDir, ".daemon-runtime");
  const runtimeEnv = {
    XDG_RUNTIME_DIR: runtimeDir,
    TMPDIR: runtimeDir
  };
  const socketPath = localUserDaemonEndpoint(userRoot, "default", process.platform, {
    env: runtimeEnv
  });
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  return {
    socketPath,
    runtimeEnv,
    env: daemonEnv(userRoot, runtimeEnv)
  };
}

function daemonEnv(
  userRoot: string,
  runtimeEnv: Readonly<Record<string, string>>
): Record<string, string> {
  return {
    ...runtimeEnv,
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "5000",
    HARNESS_DAEMON_REQUEST_TIMEOUT_MS: "10000"
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
