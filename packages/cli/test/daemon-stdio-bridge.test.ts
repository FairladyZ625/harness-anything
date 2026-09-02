// harness-test-tier: fast
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { buildSshArgs } from "../../daemon/src/client/remote-json-rpc-client.ts";
import { runDaemonStdioBridge } from "../src/daemon/stdio-bridge.ts";

test("SSH arguments target a user-managed local endpoint without tunnel-specific knowledge", () => {
  assert.deepEqual(
    buildSshArgs({
      host: "127.0.0.1",
      port: 22022,
      user: "cyr",
      identityFile: "C:/Users/test/.ssh/harness-company-internal",
      hostKeyAlias: "company-internal-host",
      remoteCommand: ["ha", "daemon", "connect", "--stdio"],
    }),
    [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "HostKeyAlias=company-internal-host",
      "-o",
      "IdentitiesOnly=yes",
      "-i",
      "C:/Users/test/.ssh/harness-company-internal",
      "-p",
      "22022",
      "cyr@127.0.0.1",
      "ha",
      "daemon",
      "connect",
      "--stdio",
    ],
  );
});

test("SSH arguments defer endpoint resolution to an OpenSSH config alias", () => {
  assert.deepEqual(
    buildSshArgs({
      sshConfigHost: "harness-company-via-uu",
      remoteCommand: ["ha", "daemon", "connect", "--stdio"],
    }),
    [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "harness-company-via-uu",
      "ha",
      "daemon",
      "connect",
      "--stdio",
    ],
  );
});

test("stdio bridge forwards bytes and exits cleanly when the caller closes", async () => {
  const input = new PassThrough(),
    output = new PassThrough(),
    socket = new PassThrough(),
    received: Buffer[] = [];
  output.on("data", (chunk: Buffer) => received.push(chunk));
  const result = runDaemonStdioBridge({
    socketPath: "/tmp/daemon.sock",
    input,
    output,
    connect: async () => socket,
  });
  input.end("json-rpc-line\n");
  assert.equal(await result, 0);
  assert.equal(Buffer.concat(received).toString("utf8"), "json-rpc-line\n");
});

test("stdio bridge reports a local daemon connection failure without writing protocol output", async () => {
  const errors: string[] = [],
    output = new PassThrough();
  const result = await runDaemonStdioBridge({
    socketPath: "/tmp/missing.sock",
    output,
    connect: async () => {
      throw new Error("connect refused");
    },
    reportError: (message) => errors.push(message),
  });
  assert.equal(result, 1);
  assert.deepEqual(errors, ["daemon stdio bridge could not connect: connect refused"]);
  assert.equal(output.read(), null);
});
