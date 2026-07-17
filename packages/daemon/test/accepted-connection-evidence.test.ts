// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import type { LocalControllerService } from "../../application/src/index.ts";
import { createInMemoryTerminalSessionService } from "../src/terminal/session-registry.ts";
import {
  createAcceptedConnectionEvidence,
  createJsonRpcProtocolServer,
  createNodeSocketAcceptedConnectionEvidenceAdapter,
  createUnixSocketTransportServer,
  connectionGeneration,
  currentDaemonProtocolVersion,
  type AcceptedConnectionBinding,
  type AuthorityConnectionDispatch,
  type DaemonTransportConnection,
  type JsonObject
} from "../src/index.ts";

test("connection-getpeereid-valid observes the same accepted Darwin socket", {
  skip: process.platform !== "darwin" ? "Darwin getpeereid fixture" : false
}, async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ha-peer-evidence-"));
  const socketPath = path.join(directory, "daemon.sock");
  const adapter = createNodeSocketAcceptedConnectionEvidenceAdapter({ platform: "darwin" });
  const observed = new Promise<Awaited<ReturnType<typeof adapter.observeAcceptedConnection>>>((resolve, reject) => {
    const server = net.createServer((socket) => {
      void adapter.observeAcceptedConnection({
        socket,
        connectionId: "darwin-connection",
        connectionGeneration: connectionGeneration("darwin-generation"),
        daemonInstanceId: "darwin-daemon"
      }).then(resolve, reject).finally(() => {
        socket.end();
        server.close();
      });
    });
    t.after(() => server.close());
    server.listen(socketPath, () => net.createConnection(socketPath));
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const evidence = await observed;
  assert.equal(evidence.peerCredential.available, true);
  if (evidence.peerCredential.available) {
    assert.equal(evidence.peerCredential.value.platform, "darwin");
    assert.equal(evidence.peerCredential.value.source, "getpeereid");
    assert.equal(evidence.peerCredential.value.uid, process.getuid?.());
    assert.equal(evidence.peerCredential.value.gid, process.getgid?.());
    assert.equal(evidence.peerCredential.value.pid, undefined);
  }
  assert.equal(evidence.channelBinding.digest.byteLength, 32);
});

test("connection-local-peercred-valid reaches the live stream and closes its generation", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ha-accepted-stream-"));
  const socketPath = path.join(directory, "daemon.sock");
  let protocolBinding: AcceptedConnectionBinding | undefined;
  let transportConnection: DaemonTransportConnection | undefined;
  let closeConnection: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    closeConnection = resolve;
  });
  const transport = createUnixSocketTransportServer({
    daemonId: "stream-daemon",
    socketPath,
    acceptedConnectionEvidenceAdapter: {
      observeAcceptedConnection: async (input) => createAcceptedConnectionEvidence({
        ...input,
        transportKind: "unix-socket",
        peerCredential: {
          available: true,
          value: {
            schema: "os-observed-peer-credential/v1",
            platform: "darwin",
            source: "LOCAL_PEERCRED",
            uid: 501,
            gid: 20,
            pid: 4242
          }
        },
        serverRandom: Buffer.alloc(32, 0x33)
      })
    },
    createProtocolServer: (_authContext, acceptedConnection) => {
      protocolBinding = acceptedConnection;
      return {
        handle: async (request) => {
          const single = Array.isArray(request) ? request[0]! : request;
          return { jsonrpc: "2.0", id: single.id ?? null, result: { ok: true } };
        }
      };
    },
    onConnection: (connection) => {
      transportConnection = connection;
    },
    onConnectionClosed: () => closeConnection?.()
  });
  await transport.start();

  const client = net.createConnection(socketPath);
  t.after(async () => {
    client.destroy();
    await transport.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const response = new Promise<string>((resolve) => client.once("data", (chunk) => resolve(chunk.toString("utf8"))));
  client.write('{"jsonrpc":"2.0","id":"live","method":"protocol.hello","params":{}}\n');
  assert.match(await response, /"id":"live"/u);
  assert.ok(protocolBinding);
  assert.ok(transportConnection);
  assert.equal(protocolBinding.evidence.peerCredential.available, true);
  if (protocolBinding.evidence.peerCredential.available) {
    assert.deepEqual(protocolBinding.evidence.peerCredential.value, {
      schema: "os-observed-peer-credential/v1",
      platform: "darwin",
      source: "LOCAL_PEERCRED",
      uid: 501,
      gid: 20,
      pid: 4242
    });
  }
  assert.equal(transportConnection.acceptedConnectionEvidence, protocolBinding.evidence);
  assert.equal(protocolBinding.isActive(), true);

  client.destroy();
  await closed;
  assert.equal(protocolBinding.isActive(), false);
  assert.throws(() => protocolBinding.assertActive(), /connection generation is closed/u);
});

test("client-channel-self-report-ignored and client-peer-self-report-ignored use only server evidence in the live authority context", async () => {
  const evidence = createAcceptedConnectionEvidence({
    connectionId: "server-connection",
    connectionGeneration: connectionGeneration("server-generation"),
    daemonInstanceId: "server-daemon",
    transportKind: "unix-socket",
    peerCredential: {
      available: true,
      value: {
        schema: "os-observed-peer-credential/v1",
        platform: "darwin",
        source: "getpeereid",
        uid: 501,
        gid: 20
      }
    },
    serverRandom: Buffer.alloc(32, 0x19)
  });
  const binding = activeBinding(evidence);
  let submitV2Calls = 0;
  let dispatch: AuthorityConnectionDispatch | undefined;
  const server = authorityProtocolServer(binding, (authorityConnection) => {
    dispatch = authorityConnection;
    if (authorityConnection?.available) {
      authorityConnection.assertActive();
      submitV2Calls += 1;
    }
  });

  await server.handle(helloRequest());
  await server.handle(commandRequest({
    channelNonceDigest: "client-reported-digest",
    uid: 999,
    gid: 999,
    pid: 999,
    peerCredential: { uid: 999, gid: 999, pid: 999 }
  }));

  assert.equal(submitV2Calls, 1);
  assert.equal(dispatch?.available, true);
  if (dispatch?.available) {
    assert.equal(dispatch.context.connectionId, "server-connection");
    assert.equal(dispatch.context.connectionGeneration, "server-generation");
    assert.equal(dispatch.context.repoId, "canonical");
    assert.equal(dispatch.context.actor.personId, "person_local");
    assert.equal(dispatch.context.peerCredential.uid, 501);
    assert.equal(dispatch.context.peerCredential.gid, 20);
    assert.deepEqual(dispatch.context.channelBinding.digest, evidence.channelBinding.digest);
  }
});

test("accepted daemon transport delivers evidence to the JSON-RPC live handler", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ha-live-authority-context-"));
  const socketPath = path.join(directory, "daemon.sock");
  let submitV2Calls = 0;
  let dispatchedContext: AuthorityConnectionDispatch | undefined;
  let transportConnection: DaemonTransportConnection | undefined;
  const transport = createUnixSocketTransportServer({
    daemonId: "live-authority-daemon",
    socketPath,
    acceptedConnectionEvidenceAdapter: {
      observeAcceptedConnection: async (input) => createAcceptedConnectionEvidence({
        ...input,
        transportKind: "unix-socket",
        peerCredential: {
          available: true,
          value: {
            schema: "os-observed-peer-credential/v1",
            platform: "darwin",
            source: "getpeereid",
            uid: 501,
            gid: 20
          }
        },
        serverRandom: Buffer.alloc(32, 0x69)
      })
    },
    createProtocolServer: (_authContext, acceptedConnection) => {
      assert.ok(acceptedConnection);
      return authorityProtocolServer(acceptedConnection, (authorityConnection) => {
        dispatchedContext = authorityConnection;
        if (authorityConnection?.available) {
          authorityConnection.assertActive();
          submitV2Calls += 1;
        }
      });
    },
    onConnection: (connection) => {
      transportConnection = connection;
    }
  });
  await transport.start();
  const client = net.createConnection(socketPath);
  const lines = createInterface({ input: client });
  const responses = lines[Symbol.asyncIterator]();
  t.after(async () => {
    client.destroy();
    lines.close();
    await transport.stop();
    rmSync(directory, { recursive: true, force: true });
  });

  client.write(`${JSON.stringify(helloRequest({
    channelNonceDigest: Buffer.alloc(32, 0xee).toString("hex"),
    uid: 999,
    gid: 999,
    pid: 999
  }))}\n`);
  await responses.next();
  client.write(`${JSON.stringify(commandRequest({
    channelNonceDigest: Buffer.alloc(32, 0xdd).toString("hex"),
    uid: 999,
    gid: 999,
    pid: 999
  }))}\n`);
  await responses.next();

  assert.equal(submitV2Calls, 1);
  assert.equal(dispatchedContext?.available, true);
  assert.ok(transportConnection?.acceptedConnectionEvidence);
  if (dispatchedContext?.available && transportConnection?.acceptedConnectionEvidence) {
    assert.equal(
      dispatchedContext.context.connectionId,
      transportConnection.acceptedConnectionEvidence.connectionId
    );
    assert.deepEqual(
      dispatchedContext.context.channelBinding.digest,
      transportConnection.acceptedConnectionEvidence.channelBinding.digest
    );
    assert.equal(dispatchedContext.context.peerCredential.uid, 501);
  }
});

test("socket-owner-only-i1 and digest-with-unavailable-credential keep I1 live and submitV2 calls=0", async () => {
  const evidence = createAcceptedConnectionEvidence({
    connectionId: "unavailable-connection",
    connectionGeneration: connectionGeneration("unavailable-generation"),
    daemonInstanceId: "server-daemon",
    transportKind: "unix-socket",
    peerCredential: {
      available: false,
      code: "observation_failed",
      source: "os-peer-credential-adapter"
    },
    compatibilityBoundary: {
      ownerUid: 501,
      source: "unix-socket-filesystem-owner-boundary"
    },
    serverRandom: Buffer.alloc(32, 0x29)
  });
  const availableEvidence = createAcceptedConnectionEvidence({
    connectionId: evidence.connectionId,
    connectionGeneration: evidence.connectionGeneration,
    daemonInstanceId: "server-daemon",
    transportKind: "unix-socket",
    peerCredential: {
      available: true,
      value: {
        schema: "os-observed-peer-credential/v1",
        platform: "darwin",
        source: "getpeereid",
        uid: 0
      }
    },
    serverRandom: Buffer.alloc(32, 0x29)
  });

  const result = await exerciseNegativeLiveHandler(activeBinding(evidence), {
    channelNonceDigest: Buffer.alloc(32, 0xaa).toString("hex"),
    uid: 501,
    gid: 20,
    pid: 1234
  });

  assert.equal(evidence.channelBinding.digest.byteLength, 32);
  assert.deepEqual(evidence.compatibilityBoundary, {
    ownerUid: 501,
    source: "unix-socket-filesystem-owner-boundary"
  });
  assert.notDeepEqual(evidence.channelBinding.digest, availableEvidence.channelBinding.digest);
  assert.equal(result.submitV2Calls, 0);
  assert.deepEqual(result.dispatch, { available: false, code: "peer_credential_unavailable" });
});

test("os-peer-mismatch fails closed in the live handler with submitV2 calls=0", async () => {
  const evidence = availableEvidence({ connectionId: "policy-connection", uid: 777 });
  const result = await exerciseNegativeLiveHandler(activeBinding(evidence), {
    uid: 501,
    gid: 20,
    pid: 1234
  });

  assert.equal(result.submitV2Calls, 0);
  assert.deepEqual(result.dispatch, { available: false, code: "peer_policy_mismatch" });
});

test("cross-connection-splice is rejected by the live handler with submitV2 calls=0", async () => {
  const evidence = availableEvidence({ connectionId: "connection-a", uid: 501 });
  const binding: AcceptedConnectionBinding = {
    ...activeBinding(evidence),
    connectionId: "connection-b",
    connectionGeneration: connectionGeneration("generation-b")
  };
  const result = await exerciseNegativeLiveHandler(binding, {
    connectionId: "connection-b",
    channelNonceDigest: Buffer.alloc(32, 0xbb).toString("hex")
  });

  assert.equal(result.submitV2Calls, 0);
  assert.deepEqual(result.dispatch, { available: false, code: "connection_tuple_mismatch" });
});

test("stale-generation-reuse is rejected by the live handler with submitV2 calls=0", async () => {
  const evidence = availableEvidence({ connectionId: "closed-connection", uid: 501 });
  const binding: AcceptedConnectionBinding = {
    ...activeBinding(evidence),
    isActive: () => false,
    assertActive: () => {
      throw new Error("accepted connection generation is closed");
    }
  };
  const result = await exerciseNegativeLiveHandler(binding, {
    connectionGeneration: evidence.connectionGeneration,
    channelNonceDigest: Buffer.alloc(32, 0xcc).toString("hex")
  });

  assert.equal(result.submitV2Calls, 0);
  assert.deepEqual(result.dispatch, { available: false, code: "connection_generation_closed" });
});

test("connection-so-peercred-valid preserves the honest Linux source in the live handler", async () => {
  const evidence = createAcceptedConnectionEvidence({
    connectionId: "linux-live-connection",
    connectionGeneration: connectionGeneration("linux-live-generation"),
    daemonInstanceId: "server-daemon",
    transportKind: "unix-socket",
    peerCredential: {
      available: true,
      value: {
        schema: "os-observed-peer-credential/v1",
        platform: "linux",
        source: "SO_PEERCRED",
        uid: 501,
        gid: 20,
        pid: 4242
      }
    },
    serverRandom: Buffer.alloc(32, 0x79)
  });
  let dispatch: AuthorityConnectionDispatch | undefined;
  const server = authorityProtocolServer(activeBinding(evidence), (connection) => {
    dispatch = connection;
  });

  await server.handle(helloRequest());
  await server.handle(commandRequest());

  assert.equal(dispatch?.available, true);
  if (dispatch?.available) {
    assert.equal(dispatch.context.peerCredential.platform, "linux");
    assert.equal(dispatch.context.peerCredential.source, "SO_PEERCRED");
    assert.equal(dispatch.context.peerCredential.pid, 4242);
  }
});

test("Linux SO_PEERCRED remains typed unavailable when no Node adapter exists", async () => {
  const socket = new net.Socket();
  const adapter = createNodeSocketAcceptedConnectionEvidenceAdapter({
    platform: "linux",
    transportKind: "unix-socket",
    serverRandom: () => Buffer.alloc(32, 0x49)
  });
  const evidence = await adapter.observeAcceptedConnection({
    socket,
    connectionId: "linux-connection",
    connectionGeneration: connectionGeneration("linux-generation"),
    daemonInstanceId: "linux-daemon"
  });

  assert.deepEqual(evidence.peerCredential, {
    available: false,
    code: "observation_failed",
    source: "os-peer-credential-adapter"
  });
  assert.equal(evidence.channelBinding.digest.byteLength, 32);
  socket.destroy();
});

test("Windows named pipe evidence is fixed platform_unsupported", async () => {
  const socket = new net.Socket();
  const adapter = createNodeSocketAcceptedConnectionEvidenceAdapter({
    platform: "win32",
    transportKind: "named-pipe",
    serverRandom: () => Buffer.alloc(32, 0x59)
  });
  const evidence = await adapter.observeAcceptedConnection({
    socket,
    connectionId: "windows-connection",
    connectionGeneration: connectionGeneration("windows-generation"),
    daemonInstanceId: "windows-daemon"
  });

  assert.equal(evidence.transportKind, "named-pipe");
  assert.deepEqual(evidence.peerCredential, {
    available: false,
    code: "platform_unsupported",
    source: "os-peer-credential-adapter"
  });
  assert.equal(evidence.channelBinding.digest.byteLength, 32);
  socket.destroy();
});

function activeBinding(evidence: ReturnType<typeof createAcceptedConnectionEvidence>): AcceptedConnectionBinding {
  return {
    evidence,
    connectionId: evidence.connectionId,
    connectionGeneration: evidence.connectionGeneration,
    isActive: () => true,
    assertActive: () => undefined
  };
}

function availableEvidence(input: { readonly connectionId: string; readonly uid: number }) {
  return createAcceptedConnectionEvidence({
    connectionId: input.connectionId,
    connectionGeneration: connectionGeneration(`${input.connectionId}-generation`),
    daemonInstanceId: "server-daemon",
    transportKind: "unix-socket",
    peerCredential: {
      available: true,
      value: {
        schema: "os-observed-peer-credential/v1",
        platform: "darwin",
        source: "getpeereid",
        uid: input.uid,
        gid: 20
      }
    },
    serverRandom: Buffer.alloc(32, 0x39)
  });
}

async function exerciseNegativeLiveHandler(
  acceptedConnection: AcceptedConnectionBinding,
  clientReport: JsonObject
): Promise<{
  readonly submitV2Calls: number;
  readonly dispatch: AuthorityConnectionDispatch | undefined;
}> {
  let submitV2Calls = 0;
  let dispatch: AuthorityConnectionDispatch | undefined;
  const submitV2 = (): void => {
    submitV2Calls += 1;
  };
  const server = authorityProtocolServer(acceptedConnection, (authorityConnection) => {
    dispatch = authorityConnection;
    if (authorityConnection?.available) {
      authorityConnection.assertActive();
      submitV2();
    }
  });
  await server.handle(helloRequest());
  await server.handle(commandRequest(clientReport));
  return { submitV2Calls, dispatch };
}

function authorityProtocolServer(
  acceptedConnection: AcceptedConnectionBinding,
  onAuthorityConnection: (connection: AuthorityConnectionDispatch | undefined) => void
) {
  return createJsonRpcProtocolServer({
    daemonId: "authority-context-test",
    repos: [{ repoId: "canonical", canonicalRoot: "/tmp/canonical" }],
    acceptedConnection,
    authorityPeerPolicy: ({ actor, peerCredential }) =>
      actor.personId === "person_local"
      && actor.resolvedCredential.kind === "unix-socket-owner-boundary"
      && actor.resolvedCredential.subject === String(peerCredential.uid),
    authContext: {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: { ownerUid: 501, source: "unix-socket-filesystem-owner-boundary" }
    },
    identityProvider: {
      providerId: "fixture-identity/v1",
      authenticate: async () => ({
        ok: true,
        personId: "person_local",
        providerId: "fixture-identity/v1",
        credential: {
          kind: "unix-socket-owner-boundary",
          issuer: "host:fixture",
          subject: "501"
        }
      }),
      authorize: async () => ({ ok: true })
    },
    personRegistry: {
      schema: "harness-persons/v1",
      people: [{ personId: "person_local", displayName: "Local Person" }],
      find: (personId) => personId === "person_local"
        ? { personId: "person_local", displayName: "Local Person" }
        : undefined
    },
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService(),
      CliCommandService: {
        runCommand: async (_payload, context) => {
          onAuthorityConnection(context?.authorityConnection);
          return commandReceipt();
        }
      }
    }
  });
}

function helloRequest(clientReport: JsonObject = {}) {
  return {
    jsonrpc: "2.0" as const,
    id: "hello",
    method: "protocol.hello",
    params: { protocolVersion: currentDaemonProtocolVersion, ...clientReport }
  };
}

function commandRequest(clientReport: JsonObject = {}) {
  return {
    jsonrpc: "2.0" as const,
    id: "command",
    method: "repo.command.run",
    params: {
      repo: { repoId: "canonical" },
      payload: {
        command: {
          rootDir: "/tmp/canonical",
          json: true,
          action: { kind: "version" }
        },
        ...clientReport
      }
    }
  };
}

function commandReceipt() {
  return {
    ok: true as const,
    schema: "command-receipt/v2" as const,
    command: "version",
    action: "version",
    summary: "version",
    details: {},
    meta: {
      generatedAt: "2026-07-16T00:00:00.000Z",
      compatibility: { legacyReceipt: "CommandReceipt/v1" as const }
    }
  };
}

function emptyLocalController(): LocalControllerService {
  return {
    getTasks: () => ({ ok: true, tasks: [], warnings: [] }),
    getTaskDetail: async () => ({ ok: true }),
    getTaskDocument: async () => ({ ok: true }),
    getRelationGraph: () => ({ ok: true, edges: [], coverageRows: [], factAnchors: [], warnings: [] }),
    getDecisions: () => ({ ok: true, decisions: [], warnings: [] }),
    getDecisionDetail: () => ({ ok: false, error: { code: "decision_not_found", hint: "missing" } }),
    getTaskFacts: async () => ({ ok: true, taskId: "task", path: "facts.md", facts: [] }),
    setTaskStatus: async () => ({ ok: true }),
    reviewTask: async () => ({ ok: true }),
    appendTaskProgress: async () => ({ ok: true, appended: true }),
    rebuildGovernance: () => ({ ok: true, tasks: [], warnings: [] }),
    archiveTask: () => ({ ok: true }),
    openShell: () => ({
      ok: true,
      policy: { displayOnly: true, outputCreatesTaskState: false }
    })
  };
}
