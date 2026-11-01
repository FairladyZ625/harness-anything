// harness-test-tier: integration
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { readDaemonLifecycleRecords } from "../src/lifecycle-log.ts";
import { rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "fixture state did not arrive");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("a cell that never closes forces process exit with a recorded deadline reason", { timeout: 30_000 }, async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-stop-deadline-")),
    userRoot = path.join(parent, "user"),
    rootDir = path.join(parent, "repo"),
    daemonId = "stop-deadline";
  rosterRepo(rootDir, daemonId);
  registerBootstrappedDaemonRepo({
    canonicalRoot: rootDir,
    repoId: daemonId,
    userRoot,
    createConvenienceLinks: false,
  });
  const child = fork(
    new URL("./fixtures/daemon-stop-deadline-child.ts", import.meta.url),
    [userRoot, daemonId, "100"],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const exited = once(child, "exit");
  try {
    await once(child, "message");
    const endpoint = localUserDaemonEndpoint(userRoot, daemonId);
    await waitUntil(async () => {
      const status = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2_000, 2_000);
      return (status.repos as { state: string }[])[0]?.state === "attached";
    });
    child.send("stop");
    assert.deepEqual(await exited, [1, null]);
    const exit = readDaemonLifecycleRecords(userRoot, daemonId).find(
      (entry) => entry.event === "process_exit" && entry.outcome === "shutdown_deadline_exceeded",
    );
    assert.equal(exit?.reason, "stop_requested");
    assert.equal(exit?.durationMs, 100);
    assert.match(exit?.error ?? "", /attachingRepositories|activeResources/u);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    rmSync(parent, { recursive: true, force: true });
  }
});
