// @slice-activation PLT-Daemon W3 transport adapters exported for daemon composition roots.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, chmodSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { DaemonAuthenticationContext } from "./auth-context.ts";
import { serveJsonRpcStream, type DaemonTransportConnection } from "./json-rpc-stream.ts";
import type { JsonRpcProtocolServer } from "../protocol/json-rpc-server.ts";

export interface UnixSocketTransportOptions {
  readonly daemonId: string;
  readonly socketPath?: string;
  readonly createProtocolServer: (
    authContext: DaemonAuthenticationContext,
    emit: (method: string, params: Record<string, unknown>) => Promise<void>,
    connectionId: string,
    signal: AbortSignal,
  ) => JsonRpcProtocolServer;
  readonly onConnection?: (connection: DaemonTransportConnection) => void;
  readonly onConnectionClosed?: (connection: DaemonTransportConnection) => void;
}

export interface UnixSocketTransportServer {
  readonly kind: "unix-socket";
  readonly endpoint: string;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

export function defaultUnixSocketPath(daemonId: string, uid = process.getuid?.() ?? 0): string {
  return path.join(os.tmpdir(), "harness-anything", `daemon-${uid}-${safeUnixSocketEndpointId(daemonId)}.sock`);
}

export function createUnixSocketTransportServer(options: UnixSocketTransportOptions): UnixSocketTransportServer {
  const connections = new Set<DaemonTransportConnection>();
  const connectionClosures = new Map<DaemonTransportConnection, Promise<void>>();
  const endpoint = options.socketPath ?? defaultUnixSocketPath(options.daemonId);
  const server = net.createServer((socket) => {
    // Windows endpoints are named pipes, which have no filesystem owner to
    // stat: statSync raises EBUSY on \\.\pipe\*. Fall back to the process uid,
    // the convention defaultUnixSocketPath already uses where getuid is absent.
    const ownerUid = process.platform === "win32" ? (process.getuid?.() ?? 0) : statSync(endpoint).uid;
    const authContext: DaemonAuthenticationContext = {
      transportKind: "unix-socket",
      endpoint,
      // 0700 parent + 0600 socket authorize only this filesystem owner. This
      // identifies that access boundary; it does not observe the client process.
      unixSocketOwnerBoundary: {
        ownerUid,
        source: "unix-socket-filesystem-owner-boundary",
      },
    };
    // One id per accepted socket, minted before the stream server exists so the transport
    // connection, its protocol server, and any per-connection log share a single correlation key.
    const connectionId = randomUUID();
    const connection = serveJsonRpcStream({
      input: socket,
      output: socket,
      transportKind: "unix-socket",
      authContext,
      connectionId,
      createProtocolServer: options.createProtocolServer,
    });
    connections.add(connection);
    options.onConnection?.(connection);
    let confirmClosed!: () => void;
    connectionClosures.set(connection, new Promise((resolve) => (confirmClosed = resolve)));
    socket.once("close", () => {
      connections.delete(connection);
      options.onConnectionClosed?.(connection);
      confirmClosed();
      connectionClosures.delete(connection);
    });
  });

  return {
    kind: "unix-socket",
    endpoint,
    start: async () => {
      // A named pipe is not a filesystem node. In particular, path.dirname()
      // treats its Windows spelling as a relative path on POSIX, while on
      // Windows mkdir/rm/chmod against \\.\pipe itself are invalid.
      if (process.platform !== "win32") {
        mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
        rmSync(endpoint, { force: true });
      }
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, () => {
          server.off("error", reject);
          if (process.platform !== "win32") chmodSync(endpoint, 0o600);
          resolve();
        });
      });
    },
    stop: async () => {
      // Stop accepting new work before draining already accepted connections. A client holding a
      // stream subscription never disconnects on its own, so each connection is then closed to
      // bound the wait (notably on Windows named pipes, where half-close delivery is async).
      const serverClosed = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
        closing = [...connections].map((connection) => ({
          connection,
          closed: connectionClosures.get(connection) ?? Promise.resolve(),
        }));
      await Promise.all(closing.map(async ({ connection, closed }) => Promise.all([connection.close(), closed])));
      await serverClosed;
      if (process.platform !== "win32") rmSync(endpoint, { force: true });
    },
  };
}

function safeUnixSocketEndpointId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "-");
}
