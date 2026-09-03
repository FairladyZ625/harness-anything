// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requestDaemonJsonRpcAt } from "../../daemon/src/client/local-json-rpc-client.ts";
import { readDaemonPid, startDaemon, type RunningDaemon } from "../../daemon/src/runtime.ts";
import { createLocalGuiServiceBridge } from "../src/index.ts";

test("GUI worktree stays attach-only when absent then reuses a canonical resident", async (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-gui-host-root-")),
    rootDir = path.join(parent, "repo"),
    worktree = path.join(rootDir, ".worktrees", "feature"),
    userRoot = path.join(parent, "user"),
    daemonId = "gui-host-root",
    previousRoot = process.env.HARNESS_DAEMON_USER_ROOT,
    previousId = process.env.HARNESS_DAEMON_ID,
    previousEndpoint = process.env.HARNESS_DAEMON_ENDPOINT,
    previousTmp = process.env.TMPDIR;
  process.env.HARNESS_DAEMON_USER_ROOT = userRoot;
  process.env.HARNESS_DAEMON_ID = daemonId;
  delete process.env.HARNESS_DAEMON_ENDPOINT;
  process.env.TMPDIR = "/tmp";
  const daemon = resident(await startDaemon({ daemonId, userRoot }));
  try {
    const bootstrapped = await requestDaemonJsonRpcAt(
      daemon.endpoint,
      "daemon.repo.bootstrap",
      { rootDir, repoId: "gui-host-root", personId: "person-gui", displayName: "GUI Host Root" },
      1_000,
    );
    assert.equal(bootstrapped.ok, true, JSON.stringify(bootstrapped));
    mkdirSync(path.join(rootDir, ".git", "worktrees", "feature"), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(path.join(worktree, ".git"), "gitdir: ../../.git/worktrees/feature\n", "utf8");
    writeFileSync(path.join(rootDir, ".git", "worktrees", "feature", "commondir"), "../..\n", "utf8");

    const canonical = await createLocalGuiServiceBridge(rootDir).invoke("getTasks", { repoId: "gui-host-root" });
    assert.equal(canonical.ok, true, JSON.stringify(canonical));
    const canonicalPid = readDaemonPid(userRoot, daemonId);
    assert.ok(canonicalPid, "the operator-started canonical resident must be reachable");
    const reused = await createLocalGuiServiceBridge(worktree).invoke("getTasks", { repoId: "gui-host-root" });
    assert.equal(reused.ok, true, JSON.stringify(reused));
    assert.equal(readDaemonPid(userRoot, daemonId), canonicalPid, "the worktree must reuse the canonical resident");
    await daemon.stop();
    const refusal = (await createLocalGuiServiceBridge(worktree).invoke("getTasks", {
      repoId: "gui-host-root",
    })) as Failure;
    assert.equal(refusal.error?.code, "daemon_unavailable", JSON.stringify(refusal));
    assert.equal(readDaemonPid(userRoot, daemonId), null, "the worktree must not claim the daemon slot");
    context.diagnostic(
      `operator-started canonical pid=${canonicalPid}; worktree reused it; post-stop refusal=${refusal.error?.code}`,
    );
  } finally {
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previousRoot);
    restoreEnv("HARNESS_DAEMON_ID", previousId);
    restoreEnv("HARNESS_DAEMON_ENDPOINT", previousEndpoint);
    restoreEnv("TMPDIR", previousTmp);
    await daemon.stop().catch(() => undefined);
    rmSync(parent, { recursive: true, force: true });
  }
});

interface Failure {
  readonly error?: { readonly code: string };
}

function resident(daemon: Awaited<ReturnType<typeof startDaemon>>): RunningDaemon {
  if (!Reflect.has(daemon, "stop")) throw new Error(`fixture unexpectedly deferred to pid ${String(daemon.pid)}`);
  return daemon as RunningDaemon;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
