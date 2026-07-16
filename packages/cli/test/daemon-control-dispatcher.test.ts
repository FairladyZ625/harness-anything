// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { renderDaemonHelp } from "../src/commands/daemon/help.ts";
import { runDaemonProductCommand } from "../src/commands/daemon/productization.ts";

type ControlRequest = {
  readonly method: string;
  readonly params: Record<string, unknown>;
};

test("daemon dispatcher routes restart and every refresh trigger through canonical admin RPC", async () => {
  const scenarios = [
    { action: "restart", args: ["restart"], method: "admin.daemon.restart", trigger: undefined },
    { action: "refresh", args: ["refresh"], method: "admin.daemon.refresh", trigger: "explicit" },
    { action: "refresh", args: ["refresh", "--trigger", "post-merge"], method: "admin.daemon.refresh", trigger: "post-merge" },
    { action: "refresh", args: ["refresh", "--trigger", "dist-watcher"], method: "admin.daemon.refresh", trigger: "dist-watcher" }
  ] as const;

  for (const scenario of scenarios) {
    const requests: ControlRequest[] = [];
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      const exitCode = await runDaemonProductCommand({
        rootDir: "/repo",
        json: true,
        args: ["daemon", ...scenario.args, "--timeout-ms", "30000"],
        runServe: async () => undefined,
        requestDaemonControl: async (request: ControlRequest) => {
          requests.push(request);
          return {
            schema: "daemon-control-accepted/v1",
            accepted: true,
            operationId: `control-${scenario.action}`,
            kind: scenario.action,
            scope: "service",
            requestedAt: "2026-07-16T08:30:00.000Z",
            before: {
              pid: 42,
              loadedIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              repoCount: 2,
              queueDepth: 0
            }
          };
        }
      });

      assert.equal(exitCode, 0);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.method, scenario.method);
      const payload = requests[0]?.params.payload as Record<string, unknown>;
      assert.equal(payload.drainTimeoutMs, 30_000);
      assert.equal(typeof payload.reason, "string");
      if (scenario.trigger) assert.equal(payload.trigger, scenario.trigger);
      else assert.equal("trigger" in payload, false);

      const receipt = JSON.parse(output.at(-1) ?? "") as Record<string, unknown>;
      assert.equal(receipt.ok, true);
      assert.equal(receipt.schema, "daemon-command/v1");
      assert.equal(receipt.command, `daemon-${scenario.action}`);
      assert.equal(receipt.operationId, `control-${scenario.action}`);
      assert.equal(receipt.controlSchema, "daemon-control-accepted/v1");
    } finally {
      console.log = originalLog;
    }
  }
});

test("daemon control RPC rejection is returned as a failed daemon receipt", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => output.push(String(message));
  try {
    const exitCode = await runDaemonProductCommand({
      rootDir: "/repo",
      json: true,
      args: ["daemon", "refresh"],
      runServe: async () => undefined,
      requestDaemonControl: async () => {
        throw new Error("daemon control rejected");
      }
    });

    assert.equal(exitCode, 1);
    const receipt = JSON.parse(output.at(-1) ?? "") as {
      readonly ok: boolean;
      readonly error: { readonly hint: string };
    };
    assert.equal(receipt.ok, false);
    assert.match(receipt.error.hint, /daemon control rejected/u);
  } finally {
    console.log = originalLog;
  }
});

test("daemon help exposes restart, refresh, and refresh trigger selection", () => {
  const help = renderDaemonHelp();
  assert.match(help, /restart/u);
  assert.match(help, /refresh/u);
  assert.match(help, /explicit\|post-merge\|dist-watcher/u);
});
