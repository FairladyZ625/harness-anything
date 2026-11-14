// harness-test-tier: integration
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonJsonRpcClientAt, requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { daemonDiagnosticsEndpoint, localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { waitForDurableValue } from "../../../tools/fixtures/event-arrival.ts";

// The fixture announces actual transport readiness. Only connect has a watchdog; response waits
// follow JSON-RPC arrival and the enclosing node:test timeout is their hang guard.
const connectWatchdogMs = 20_000;
// The paired 16-worker/4-vCPU campaign exceeded the old 20s whole-test watchdog during
// fixture cold start. This bounds a hung test; correctness still depends only on RPC/state arrival.

async function fixture(mode: string) {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-diag-")),
    endpoint = localUserDaemonEndpoint(userRoot, `diagnostics-${mode}`),
    child = fork(new URL("./daemon-diagnostics.fixture.ts", import.meta.url), [userRoot, endpoint, mode], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += chunk;
  });
  const message = async (key: string) => {
    for (;;) {
      const [value] = await Promise.race([
        once(child, "message"),
        once(child, "exit").then(([code]) => {
          throw new Error(`child exited ${code}: ${stderr}`);
        }),
      ]);
      if (value[key]) return value;
    }
  };
  await message("ready");
  return {
    userRoot,
    endpoint,
    child,
    message,
    close: async () => {
      if (child.connected) {
        const exited = once(child, "exit");
        child.send(mode === "drain" ? "release" : "close");
        await exited;
      }
      rmSync(userRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    },
  };
}
async function diagnostic(endpoint: string) {
  return requestDaemonJsonRpcAt(daemonDiagnosticsEndpoint(endpoint), "daemon.status", {}, connectWatchdogMs);
}
async function until(endpoint: string, predicate: (value: Record<string, unknown>) => boolean) {
  return waitForDurableValue(async () => {
    const value = await diagnostic(endpoint);
    return predicate(value) ? value : null;
  });
}
for (const mode of ["javascript", "native"]) {
  test(`independent diagnostics records an in-flight ${mode} stall and recovery`, { timeout: 90_000 }, async () => {
    const f = await fixture(mode);
    let client: Awaited<ReturnType<typeof openDaemonJsonRpcClientAt>> | undefined;
    try {
      // Complete the real protocol handshake before arming fault injection: under contention its
      // own authentication stall must not be mistaken for the status operation we intend to block.
      client = await openDaemonJsonRpcClientAt(f.endpoint, connectWatchdogMs);
      const normal = await until(f.endpoint, (value) => value.metrics !== null);
      assert.equal(normal.state, "running");
      if (process.platform !== "win32")
        assert.equal(statSync(daemonDiagnosticsEndpoint(f.endpoint)).mode & 0o777, 0o600);
      const armed = f.message("armed");
      f.child.send("arm");
      await armed;
      const request = client.request("daemon.status", {});
      const [, blockedOperation] = await Promise.all([
        request,
        (async () => {
          const stalled = await until(
              f.endpoint,
              (value) =>
                value.stalled === true &&
                (value.inFlight as { method: string; phase: string }[]).some(
                  (operation) => operation.method === "daemon.status" && operation.phase === mode,
                ),
            ),
            inFlight = stalled.inFlight as { id: string; method: string; actor: string; phase: string }[];
          console.log("stall evidence during request", mode, JSON.stringify(stalled));
          assert.equal(inFlight.length, 1);
          assert.equal(inFlight[0]!.method, "daemon.status");
          assert.match(inFlight[0]!.actor, /^local-user-/u);
          assert.equal(inFlight[0]!.phase, mode);
          assert.equal(typeof stalled.rss, "number");
          await assert.rejects(
            requestDaemonJsonRpcAt(daemonDiagnosticsEndpoint(f.endpoint), "daemon.stop", {}, connectWatchdogMs),
            /Read-only/u,
          );
          return inFlight[0]!;
        })(),
      ]);
      const readRecords = () =>
        readdirSync(path.join(f.userRoot, "logs"))
          .filter((name) => name.includes("diagnostics"))
          .flatMap((name) =>
            readFileSync(path.join(f.userRoot, "logs", name), "utf8")
              .split("\n")
              .slice(0, -1)
              .map((line) => JSON.parse(line)),
          );
      const includesBlockedOperation = (record: Record<string, unknown>) =>
        Array.isArray(record.inFlight) &&
        record.inFlight.some((operation) => operation.id === blockedOperation.id && operation.phase === mode);
      const recovered = await until(f.endpoint, (value) => {
        const record = (value.recentStalls as Record<string, unknown>[]).find(includesBlockedOperation);
        return (
          (value.inFlight as unknown[]).length === 0 &&
          typeof record?.durationMs === "number" &&
          record.stackStatus !== "pending" &&
          readRecords().some((row) => row.reason === "stall_ended" && includesBlockedOperation(row)) &&
          readRecords().some((row) => row.reason === "metrics" && row.metrics?.eventLoopDelayMs.max > 1_000)
        );
      });
      console.log("stack experiment", mode, JSON.stringify(recovered.recentStalls));
      const records = readRecords();
      assert.ok(records.some((row) => row.reason === "stall_started" && includesBlockedOperation(row)));
      assert.ok(
        records.some((row) => row.reason === "stall_ended" && includesBlockedOperation(row) && row.durationMs >= 2_000),
      );
      assert.ok(records.some((row) => row.reason === "metrics" && row.metrics?.eventLoopDelayMs.max > 1_000));
    } finally {
      client?.close();
      await f.close();
    }
  });
}

test("real daemon keeps independent status available while a shutdown item is held", { timeout: 90_000 }, async () => {
  const f = await fixture("drain");
  try {
    const draining = f.message("draining");
    f.child.send("stop");
    await draining;
    const status = await diagnostic(f.endpoint);
    assert.equal(status.state, "stopping");
    assert.ok((status.inFlight as { method: string }[]).some((operation) => operation.method === "daemon.close"));
  } finally {
    await f.close();
  }
});
