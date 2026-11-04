// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type TLSSocket } from "node:tls";
import test, { type TestContext } from "node:test";
import { runFleetReplicaStream } from "../src/fleet/peer.ts";

test("a replica stopped during token resolution never enters the session handshake", async (t) => {
  await cancellationAt(t, "token");
});
test("a replica stopped while awaiting session.ready releases its connection", { timeout: 10_000 }, async (t) => {
  await cancellationAt(t, "handshake");
});

async function cancellationAt(t: TestContext, phase: "token" | "handshake"): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-handshake-")),
    keyFile = path.join(root, "key.pem"),
    certFile = path.join(root, "cert.pem");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const hello = Promise.withResolvers<"hello">(),
    sockets = new Set<TLSSocket>(),
    server = createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.once("close", () => sockets.delete(socket));
      // Deliberately no session.ready: cancellation must end the stream before this wait.
      socket.once("data", () => hello.resolve("hello"));
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let tokenReads = 0;
  let terminalError: unknown;
  const controller = new AbortController(),
    stopped = new Error("fixture replica replaced"),
    running = runFleetReplicaStream({
      hostname: "127.0.0.1",
      port: address.port,
      ca: readFileSync(certFile),
      servername: "localhost",
      nodeId: "edge-one",
      credential: "fixture-secret",
      repoId: "handshake-repo",
      viewRoot: path.join(root, "view"),
      diskQuotaBytes: 64 * 1024 * 1024,
      signal: controller.signal,
      readAccessToken: async () => {
        tokenReads++;
        if (phase === "token") controller.abort(stopped);
        return "fixture-token";
      },
    }).then(
      () => "completed" as const,
      (error: unknown) => {
        terminalError = error;
        return "stopped" as const;
      },
    );
  t.after(async () => {
    controller.abort(stopped);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await running;
  });
  if (phase === "handshake") {
    await hello.promise;
    controller.abort(stopped);
    assert.equal(await running, "stopped");
  } else {
    assert.equal(await Promise.race([running, hello.promise]), "stopped");
  }
  assert.equal(tokenReads, 1, "the stream reached the asynchronous token boundary");
  assert.equal(terminalError, stopped, "cancellation preserves its original reason");
}
