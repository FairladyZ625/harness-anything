import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, type Readable, type Writable } from "node:stream";
import test from "node:test";
import type { LocalControllerService } from "../../application/src/index.ts";
import { createInMemoryTerminalSessionService } from "../../gui/src/terminal/session-registry.ts";
import {
  attachTokenBootstrapFrame,
  createInMemoryAttachTokenStore,
  createJsonRpcProtocolServer,
  createNamedPipeTransportServer,
  createUnixSocketTransportServer,
  currentDaemonProtocolVersion,
  defaultNamedPipePath,
  defaultUnixSocketPath,
  encodeJsonLineFrame,
  serveSshExecBridge,
  serveSshTunnelTokenStream,
  windowsNamedPipeIntegrationEntry,
  type DaemonAuthenticationContext,
  type JsonRpcProtocolServer,
  type JsonRpcRequest,
  type JsonRpcResponse
} from "../src/index.ts";

test("unix socket transport uses single-user path and permissions on POSIX", async (t) => {
  if (process.platform === "win32") return;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-unix-"));
  const socketPath = path.join(tempDir, "daemon.sock");
  const seenAuthContexts: DaemonAuthenticationContext[] = [];
  const transport = createUnixSocketTransportServer({
    daemonId: "daemon-test",
    socketPath,
    createProtocolServer: makeProtocolServerFactory(),
    onConnection: (connection) => seenAuthContexts.push(connection.authContext)
  });
  t.after(async () => {
    await transport.stop();
  });

  await transport.start();
  const mode = statSync(socketPath).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal(defaultUnixSocketPath("daemon test").includes(`daemon-${process.getuid?.() ?? 0}-daemon-test.sock`), true);

  const socket = net.createConnection(socketPath);
  const client = frameClient(socket, socket);
  client.send(hello("unix-hello"));
  const response = await client.read();
  assert.equal(resultReceipt(response).ok, true);
  assert.equal(seenAuthContexts[0]?.transportKind, "unix-socket");
  assert.equal(seenAuthContexts[0]?.unixPeerCredential?.uid, process.getuid?.());
  socket.end();
});

test("Windows named pipe transport path and local test entry are declared", () => {
  assert.equal(defaultNamedPipePath("daemon test"), "\\\\.\\pipe\\harness-anything-daemon-test");
  assert.deepEqual(windowsNamedPipeIntegrationEntry(), {
    runnableOn: "win32",
    command: "npm run test:integration",
    testFile: "packages/daemon/test/transport-integration.test.ts",
    reason: "The named pipe end-to-end case runs on Windows and is declared here for local verification when CI has no Windows runner."
  });
});

test("named pipe transport completes JSON-RPC on Windows", { skip: process.platform !== "win32" ? windowsNamedPipeIntegrationEntry().reason : false }, async (t) => {
  const pipePath = `${defaultNamedPipePath(`transport-${process.pid}`)}-${Date.now()}`;
  const seenAuthContexts: DaemonAuthenticationContext[] = [];
  const transport = createNamedPipeTransportServer({
    daemonId: "daemon-test",
    pipePath,
    createProtocolServer: makeProtocolServerFactory(),
    onConnection: (connection) => seenAuthContexts.push(connection.authContext)
  });
  t.after(async () => {
    await transport.stop();
  });

  await transport.start();
  const socket = net.createConnection(pipePath);
  const client = frameClient(socket, socket);
  client.send(hello("pipe-hello"));
  const response = await client.read();

  assert.equal(resultReceipt(response).ok, true);
  assert.equal(seenAuthContexts[0]?.transportKind, "named-pipe");
  assert.equal(seenAuthContexts[0]?.namedPipeClient?.endpoint, pipePath);
  socket.end();
});

test("SSH exec bridge carries read and write JSON-RPC frames over stdio streams", async () => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const calls: string[] = [];
  const connection = serveSshExecBridge({
    input: clientToServer,
    output: serverToClient,
    username: "alice",
    host: "team-host",
    createProtocolServer: makeProtocolServerFactory(calls)
  });
  const client = frameClient(serverToClient, clientToServer);

  client.send(hello("ssh-hello"));
  assert.equal(resultReceipt(await client.read()).ok, true);
  client.send(repoRequest("ssh-read", "repo.tasks.list"));
  assert.equal(resultReceipt(await client.read()).command, "repo.tasks.list");
  client.send(repoRequest("ssh-write", "repo.tasks.progress.append"));
  assert.equal(resultReceipt(await client.read()).command, "repo.tasks.progress.append");

  assert.deepEqual(calls, ["getTasks", "appendTaskProgress"]);
  assert.equal(connection.authContext.sshExecUser?.username, "alice");
  await connection.close();
});

test("SSH tunnel token bootstrap accepts one connection and rejects token replay", async () => {
  const tokenStore = createInMemoryAttachTokenStore({
    createId: sequenceId(),
    createSecret: () => "secret-1",
    now: fixedTime("2026-07-07T00:00:00.000Z")
  });
  const issued = tokenStore.issue({
    subject: {
      userId: "user-a",
      hostProfileId: "host-a",
      daemonInstanceId: "daemon-a",
      sshUsername: "alice"
    },
    ttlMillis: 60_000,
    tunnelNonce: "nonce-a"
  });

  const firstClientToServer = new PassThrough();
  const firstServerToClient = new PassThrough();
  const firstConnection = serveSshTunnelTokenStream({
    input: firstClientToServer,
    output: firstServerToClient,
    endpoint: "ssh-tunnel://host-a",
    tokenStore,
    createProtocolServer: makeProtocolServerFactory()
  });
  const firstClient = frameClient(firstServerToClient, firstClientToServer);
  firstClient.send(attachTokenBootstrapFrame({
    tokenId: issued.metadata.tokenId,
    secret: issued.secret,
    tunnelNonce: issued.metadata.tunnelNonce,
    daemonInstanceId: issued.metadata.daemonInstanceId,
    hostProfileId: issued.metadata.hostProfileId
  }));
  firstClient.send(hello("tunnel-hello"));
  assert.equal(resultReceipt(await firstClient.read()).ok, true);
  assert.equal(tokenStore.listMetadata()[0]?.consumedAt, "2026-07-07T00:00:00.000Z");
  await firstConnection.close();

  const replayClientToServer = new PassThrough();
  const replayServerToClient = new PassThrough();
  const replayConnection = serveSshTunnelTokenStream({
    input: replayClientToServer,
    output: replayServerToClient,
    endpoint: "ssh-tunnel://host-a",
    tokenStore,
    createProtocolServer: makeProtocolServerFactory()
  });
  const replayClient = frameClient(replayServerToClient, replayClientToServer);
  replayClient.send(attachTokenBootstrapFrame({
    tokenId: issued.metadata.tokenId,
    secret: issued.secret,
    tunnelNonce: issued.metadata.tunnelNonce,
    daemonInstanceId: issued.metadata.daemonInstanceId,
    hostProfileId: issued.metadata.hostProfileId
  }));
  const replayResponse = await replayClient.read();
  assert.equal("error" in replayResponse, true);
  assert.equal((replayResponse as { readonly error: { readonly message: string } }).error.message, "Attach token has already been used.");
  await replayConnection.close();
});

test("SSH tunnel token bootstrap rejects an invalid token before JSON-RPC dispatch", async () => {
  const tokenStore = createInMemoryAttachTokenStore({
    createId: sequenceId(),
    createSecret: () => "secret-1",
    now: fixedTime("2026-07-07T00:00:00.000Z")
  });
  const issued = tokenStore.issue({
    subject: {
      userId: "user-a",
      hostProfileId: "host-a",
      daemonInstanceId: "daemon-a"
    },
    ttlMillis: 60_000,
    tunnelNonce: "nonce-a"
  });
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const connection = serveSshTunnelTokenStream({
    input: clientToServer,
    output: serverToClient,
    tokenStore,
    createProtocolServer: makeProtocolServerFactory()
  });
  const client = frameClient(serverToClient, clientToServer);

  client.send(attachTokenBootstrapFrame({
    tokenId: issued.metadata.tokenId,
    secret: "wrong-secret",
    tunnelNonce: issued.metadata.tunnelNonce,
    daemonInstanceId: issued.metadata.daemonInstanceId,
    hostProfileId: issued.metadata.hostProfileId
  }));
  const response = await client.read();

  assert.equal("error" in response, true);
  assert.equal((response as { readonly error: { readonly message: string } }).error.message, "Attach token secret mismatch.");
  assert.equal(tokenStore.listMetadata()[0]?.consumedAt, undefined);
  await connection.close();
});

function makeProtocolServerFactory(calls: string[] = []): (authContext: DaemonAuthenticationContext) => JsonRpcProtocolServer {
  return () => createJsonRpcProtocolServer({
    daemonId: "daemon-test",
    repos: [{ repoId: "canonical", canonicalRoot: "/tmp/canonical" }],
    services: {
      LocalControllerService: localController(calls),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" })
    }
  });
}

function localController(calls: string[]): LocalControllerService {
  return {
    getTasks: () => {
      calls.push("getTasks");
      return { ok: true, tasks: [{ id: "task-a" }], warnings: [] };
    },
    getTaskDetail: () => ({ ok: true }),
    getTaskDocument: () => ({ ok: true }),
    setTaskStatus: async () => ({ ok: true }),
    reviewTask: async () => ({ ok: true }),
    appendTaskProgress: async () => {
      calls.push("appendTaskProgress");
      return { ok: true, appended: true };
    },
    rebuildGovernance: () => ({ ok: true, tasks: [], warnings: [] }),
    archiveTask: () => ({ ok: true }),
    openShell: () => ({ ok: true, policy: { displayOnly: true, outputCreatesTaskState: false } })
  };
}

function frameClient(input: Readable, output: Writable): {
  readonly send: (frame: unknown) => void;
  readonly read: () => Promise<JsonRpcResponse>;
} {
  const lines = createInterface({ input });
  const iterator = lines[Symbol.asyncIterator]();
  return {
    send: (frame) => {
      output.write(encodeJsonLineFrame(frame));
    },
    read: async () => {
      const next = await iterator.next();
      assert.equal(next.done, false);
      return JSON.parse(next.value) as JsonRpcResponse;
    }
  };
}

function hello(id: string): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "protocol.hello",
    params: { protocolVersion: currentDaemonProtocolVersion }
  };
}

function repoRequest(id: string, method: string): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: { repo: { repoId: "canonical" }, payload: {} }
  };
}

function resultReceipt(response: JsonRpcResponse): {
  readonly ok: boolean;
  readonly command: string;
} {
  assert.equal("result" in response, true);
  return response.result as { readonly ok: boolean; readonly command: string };
}

function sequenceId(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}-${next++}`;
}

function fixedTime(value: string): () => string {
  return () => value;
}
