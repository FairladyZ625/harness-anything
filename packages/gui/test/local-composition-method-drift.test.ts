// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "../../daemon/src/client/local-daemon-target.ts";
import { createLocalGuiServiceBridge } from "../src/main/local-composition-root.ts";

test("GUI names daemon method-set drift before sending the unavailable request", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-gui-method-drift-")),
    socketPath = localUserDaemonEndpoint(parent, "method-drift"),
    seen: string[] = [],
    server = net.createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
          const request = JSON.parse(line) as { readonly id: number; readonly method: string };
          seen.push(request.method);
          const result = {
            ok: true,
            methods: ["protocol.hello"],
            build: { commit: "daemon-old-build" },
          };
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        }
      });
    }),
    previousEndpoint = process.env.HARNESS_DAEMON_ENDPOINT,
    previousUserRoot = process.env.HARNESS_DAEMON_USER_ROOT,
    previousDaemonId = process.env.HARNESS_DAEMON_ID;
  mkdirSync(path.dirname(socketPath), { recursive: true });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  process.env.HARNESS_DAEMON_ENDPOINT = socketPath;
  process.env.HARNESS_DAEMON_USER_ROOT = parent;
  process.env.HARNESS_DAEMON_ID = "method-drift";
  try {
    const result = (await createLocalGuiServiceBridge(parent).invoke("getSystemStatus", {})) as {
      readonly ok: boolean;
      readonly error: { readonly code: string; readonly hint: string };
    };
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "daemon_method_unavailable");
    assert.equal(
      result.error.hint,
      "Local daemon request failed. Cause: Attached local daemon build daemon-old-build does not advertise requested " +
        "method daemon.gui.system.read. The GUI and attached local daemon expose different RPC method sets. Restart " +
        "the resident daemon from an operator shell, or run `ha gui` to use the canonical GUI build.",
    );
    assert.deepEqual(seen, ["protocol.hello"], "the GUI must fail before sending the unavailable method");
  } finally {
    if (previousEndpoint === undefined) delete process.env.HARNESS_DAEMON_ENDPOINT;
    else process.env.HARNESS_DAEMON_ENDPOINT = previousEndpoint;
    if (previousUserRoot === undefined) delete process.env.HARNESS_DAEMON_USER_ROOT;
    else process.env.HARNESS_DAEMON_USER_ROOT = previousUserRoot;
    if (previousDaemonId === undefined) delete process.env.HARNESS_DAEMON_ID;
    else process.env.HARNESS_DAEMON_ID = previousDaemonId;
    server.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
