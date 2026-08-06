// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveLocalDaemonTarget,
  spawnLocalDaemon
} from "../../daemon/src/index.ts";
import {
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  runRawJson
} from "./helpers/daemon-cli.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("an autostarted resident daemon exits after its canonical root disappears", { timeout: 30_000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-daemon-root-lifetime-"));
  let daemonPid: number | undefined;
  try {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "local" });
    const status = runDaemonCommand(rootDir, [
      "daemon", "status", "--user-root", defaultDaemonUserRoot(rootDir), "--json"
    ]);
    assert.equal(typeof status.pid, "number", JSON.stringify(status));
    daemonPid = status.pid as number;

    assert.equal(processIsAlive(daemonPid), true, "the resident daemon must outlive its launching CLI command");
    rmSync(rootDir, { recursive: true, force: true });

    await pollUntil(
      () => processIsAlive(daemonPid),
      (alive) => !alive,
      (alive, error) => JSON.stringify({ daemonPid, alive, error: String(error ?? "") }),
      { timeoutMs: 8_000 }
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    if (daemonPid !== undefined && processIsAlive(daemonPid)) {
      process.kill(daemonPid, "SIGTERM");
      await pollUntil(
        () => processIsAlive(daemonPid),
        (alive) => !alive,
        (alive, error) => JSON.stringify({ daemonPid, alive, error: String(error ?? "") }),
        { timeoutMs: 8_000 }
      );
    }
  }
});

test("an autostarted daemon cannot revive a canonical root removed during cold start", { timeout: 30_000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-daemon-cold-root-lifetime-"));
  let daemonPid: number | undefined;
  try {
    initializeFixtureWithoutDaemon(rootDir);
    const userRoot = defaultDaemonUserRoot(rootDir);
    const target = resolveLocalDaemonTarget({ rootDir, userRoot, autoRegisterSingleRepo: true });
    daemonPid = spawnLocalDaemon(target, { entryPath: cliEntry, idleExitMs: 0 });
    assert.equal(typeof daemonPid, "number");

    rmSync(rootDir, { recursive: true, force: true });
    await pollUntil(
      () => processIsAlive(daemonPid),
      (alive) => !alive,
      (alive, error) => JSON.stringify({ daemonPid, alive, rootDir, error: String(error ?? "") }),
      { timeoutMs: 8_000 }
    );
  } finally {
    if (daemonPid !== undefined && processIsAlive(daemonPid)) {
      process.kill(daemonPid, "SIGTERM");
      await pollUntil(
        () => processIsAlive(daemonPid),
        (alive) => !alive,
        (alive, error) => JSON.stringify({ daemonPid, alive, error: String(error ?? "") }),
        { timeoutMs: 8_000 }
      );
    }
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function initializeFixtureWithoutDaemon(rootDir: string): void {
  runRawJson(rootDir, ["init"], {
    HARNESS_DAEMON_MODE: "direct",
    HARNESS_DIRECT_WRITE_REASON: "recovery"
  });
}

function processIsAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error
      && (error as { readonly code?: unknown }).code === "ESRCH") return false;
    throw error;
  }
}
