// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requestDaemonJsonRpcAt } from "../../daemon/src/client/local-json-rpc-client.ts";
import { readDaemonPid, startDaemon, type RunningDaemon } from "../../daemon/src/runtime.ts";
import { createLocalGuiServiceBridge } from "../src/index.ts";

interface Failure {
  readonly ok: boolean;
  readonly error?: { readonly code: string };
}

function resident(daemon: Awaited<ReturnType<typeof startDaemon>>): RunningDaemon {
  if (!("stop" in daemon))
    throw new Error(
      `startDaemon deferred to incumbent pid ${String(daemon.pid)} in a fixture that expects a fresh daemon`,
    );
  return daemon;
}

test("GUI bridge is attach-only even when its first request finds no daemon", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-gui-first-attach-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    daemonId = "gui-first-attach";
  const previous = process.env.HARNESS_DAEMON_USER_ROOT,
    previousId = process.env.HARNESS_DAEMON_ID,
    previousEndpoint = process.env.HARNESS_DAEMON_ENDPOINT,
    previousTmp = process.env.TMPDIR;
  process.env.HARNESS_DAEMON_USER_ROOT = userRoot;
  process.env.HARNESS_DAEMON_ID = daemonId;
  delete process.env.HARNESS_DAEMON_ENDPOINT;
  process.env.TMPDIR = "/tmp";
  const daemon = resident(await startDaemon({ daemonId, userRoot }));
  try {
    assert.equal(
      (
        await requestDaemonJsonRpcAt(
          daemon.endpoint,
          "daemon.repo.bootstrap",
          { rootDir, repoId: "gui-first-attach", personId: "person-gui", displayName: "GUI Attach" },
          1_000,
        )
      ).ok,
      true,
    );
    await daemon.stop();
    const failure = (await createLocalGuiServiceBridge(rootDir).invoke("getTasks", {
      repoId: "gui-first-attach",
    })) as Failure;
    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "daemon_unavailable");
    assert.equal(readDaemonPid(userRoot, daemonId), null, "a first GUI request must not spawn a daemon");
  } finally {
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previous);
    restoreEnv("HARNESS_DAEMON_ID", previousId);
    restoreEnv("HARNESS_DAEMON_ENDPOINT", previousEndpoint);
    restoreEnv("TMPDIR", previousTmp);
    await daemon.stop().catch(() => undefined);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("GUI bridge reuses a resident daemon and does not respawn it after an explicit stop", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-gui-resident-attach-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    daemonId = "gui-resident-attach";
  const previous = process.env.HARNESS_DAEMON_USER_ROOT,
    previousId = process.env.HARNESS_DAEMON_ID,
    previousEndpoint = process.env.HARNESS_DAEMON_ENDPOINT,
    previousTmp = process.env.TMPDIR;
  process.env.HARNESS_DAEMON_USER_ROOT = userRoot;
  process.env.HARNESS_DAEMON_ID = daemonId;
  delete process.env.HARNESS_DAEMON_ENDPOINT;
  process.env.TMPDIR = "/tmp";
  const daemon = resident(await startDaemon({ daemonId, userRoot }));
  try {
    assert.equal(
      (
        await requestDaemonJsonRpcAt(
          daemon.endpoint,
          "daemon.repo.bootstrap",
          { rootDir, repoId: "gui-resident-attach", personId: "person-gui", displayName: "GUI Attach" },
          1_000,
        )
      ).ok,
      true,
    );
    const bridge = createLocalGuiServiceBridge(rootDir),
      beforePid = readDaemonPid(userRoot, daemonId);
    assert.ok(beforePid);
    assert.equal((await bridge.invoke("getTasks", { repoId: "gui-resident-attach" })).ok, true);
    assert.equal(readDaemonPid(userRoot, daemonId), beforePid, "attaching must not replace the resident generation");
    await daemon.stop();
    const stopped = (await bridge.invoke("getTasks", { repoId: "gui-resident-attach" })) as Failure;
    assert.equal(stopped.ok, false);
    assert.equal(stopped.error?.code, "daemon_unavailable");
    assert.equal(readDaemonPid(userRoot, daemonId), null, "a stopped daemon must remain stopped while the GUI is open");
  } finally {
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previous);
    restoreEnv("HARNESS_DAEMON_ID", previousId);
    restoreEnv("HARNESS_DAEMON_ENDPOINT", previousEndpoint);
    restoreEnv("TMPDIR", previousTmp);
    await daemon.stop().catch(() => undefined);
    rmSync(parent, { recursive: true, force: true });
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
