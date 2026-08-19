// @slice-activation PLT-Daemon W3 transport adapters exported for daemon composition roots.
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
  readonly createProtocolServer: (authContext: DaemonAuthenticationContext, emit: (method: string, params: Record<string, unknown>) => Promise<void>) => JsonRpcProtocolServer;
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
  const sockets = new Set<net.Socket>();
  const endpoint = options.socketPath ?? defaultUnixSocketPath(options.daemonId);
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    // Windows endpoints are named pipes, which have no filesystem owner to
    // stat: statSync raises EBUSY on \\.\pipe\*. Fall back to the process uid,
    // the convention defaultUnixSocketPath already uses where getuid is absent.
    const ownerUid = process.platform === "win32" ? process.getuid?.() ?? 0 : statSync(endpoint).uid;
    const authContext: DaemonAuthenticationContext = {
      transportKind: "unix-socket",
      endpoint,
      // 0700 parent + 0600 socket authorize only this filesystem owner. This
      // identifies that access boundary; it does not observe the client process.
      unixSocketOwnerBoundary: {
        ownerUid,
        source: "unix-socket-filesystem-owner-boundary"
      }
    };
    const connection = serveJsonRpcStream({
      input: socket,
      output: socket,
      transportKind: "unix-socket",
      authContext,
      createProtocolServer: options.createProtocolServer
    });
    options.onConnection?.(connection);
    socket.once("close", () => options.onConnectionClosed?.(connection));
  });

  return {
    kind: "unix-socket",
    endpoint,
    start: async () => {
      mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
      rmSync(endpoint, { force: true });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, () => {
          server.off("error", reject);
          chmodSync(endpoint, 0o600);
          resolve();
        });
      });
    },
    stop: async () => {
      // server.close() waits for every accepted socket. A stream subscription
      // or long JSON-RPC request is allowed to outlive the daemon only until
      // shutdown starts; destroy those sockets first so the close callback is
      // not held behind an unbounded request queue (notably on Windows named
      // pipes, where half-close delivery is asynchronous).
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      rmSync(endpoint, { force: true });
    }
  };
}

function safeUnixSocketEndpointId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "-");
}
