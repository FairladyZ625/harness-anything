// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requestDaemonJsonRpcAt } from "../../daemon/src/client/local-json-rpc-client.ts";
import { terminateProcess } from "../../daemon/src/process-port.ts";
import { readDaemonPid, startDaemon, type RunningDaemon } from "../../daemon/src/runtime.ts";
import { createLocalGuiServiceBridge } from "../src/index.ts";

test("GUI worktree refuses an absent daemon then reuses the canonical resident", async (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-gui-host-root-")),
    rootDir = path.join(parent, "repo"),
    worktree = path.join(rootDir, ".worktrees", "feature"),
    userRoot = path.join(parent, "user"),
    daemonId = "gui-host-root",
    previousRoot = process.env.HARNESS_DAEMON_USER_ROOT,
    previousId = process.env.HARNESS_DAEMON_ID;
  process.env.HARNESS_DAEMON_USER_ROOT = userRoot;
  process.env.HARNESS_DAEMON_ID = daemonId;
  const daemon = resident(await startDaemon({ daemonId, userRoot }));
  try {
    const bootstrapped = await requestDaemonJsonRpcAt(
      daemon.endpoint,
      "daemon.repo.bootstrap",
      { rootDir, repoId: "gui-host-root", personId: "person-gui", displayName: "GUI Host Root" },
      1_000,
    );
    assert.equal(bootstrapped.ok, true, JSON.stringify(bootstrapped));
    await daemon.stop();
    mkdirSync(worktree, { recursive: true });
    writeFileSync(path.join(worktree, ".git"), "gitdir: ../../.git/worktrees/feature\n", "utf8");

    const refusal = (await createLocalGuiServiceBridge(worktree).invoke("getTasks", {
      repoId: "gui-host-root",
    })) as Failure;
    assert.equal(refusal.error?.code, "daemon_start_noncanonical_checkout", JSON.stringify(refusal));
    assert.match(refusal.error?.hint ?? "", /A worktree may connect to an existing daemon but cannot host it/u);
    assert.equal(readDaemonPid(userRoot, daemonId), null, "the worktree must not claim the daemon slot");

    const canonical = await createLocalGuiServiceBridge(rootDir).invoke("getTasks", { repoId: "gui-host-root" });
    assert.equal(canonical.ok, true, JSON.stringify(canonical));
    const canonicalPid = readDaemonPid(userRoot, daemonId);
    assert.ok(canonicalPid, "canonical GUI request must autostart the resident daemon");
    const reused = await createLocalGuiServiceBridge(worktree).invoke("getTasks", { repoId: "gui-host-root" });
    assert.equal(reused.ok, true, JSON.stringify(reused));
    assert.equal(readDaemonPid(userRoot, daemonId), canonicalPid, "the worktree must reuse the canonical resident");
    context.diagnostic(
      `GUI worktree refusal=${refusal.error?.code}; canonical autostart pid=${canonicalPid}; existing daemon reused`,
    );
    await stopResident(userRoot, daemonId);
  } finally {
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previousRoot);
    restoreEnv("HARNESS_DAEMON_ID", previousId);
    await daemon.stop().catch(() => undefined);
    rmSync(parent, { recursive: true, force: true });
  }
});

interface Failure {
  readonly error?: { readonly code: string; readonly hint: string };
}

function resident(daemon: Awaited<ReturnType<typeof startDaemon>>): RunningDaemon {
  if (!Reflect.has(daemon, "stop")) throw new Error(`fixture unexpectedly deferred to pid ${String(daemon.pid)}`);
  return daemon as RunningDaemon;
}

async function stopResident(userRoot: string, daemonId: string): Promise<void> {
  const pid = readDaemonPid(userRoot, daemonId);
  if (pid === null) return;
  terminateProcess(pid);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
