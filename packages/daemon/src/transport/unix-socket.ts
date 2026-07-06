// @slice-activation PLT-Daemon W3 transport adapters exported for daemon composition roots.
import { mkdirSync, rmSync, chmodSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { DaemonAuthenticationContext } from "./auth-context.ts";
import { localUnixPeerCredential } from "./auth-context.ts";
import { serveJsonRpcStream, type DaemonTransportConnection } from "./json-rpc-stream.ts";
import type { JsonRpcProtocolServer } from "../protocol/json-rpc-server.ts";

export interface UnixSocketTransportOptions {
  readonly daemonId: string;
  readonly socketPath?: string;
  readonly createProtocolServer: (authContext: DaemonAuthenticationContext) => JsonRpcProtocolServer;
  readonly onConnection?: (connection: DaemonTransportConnection) => void;
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
  const endpoint = options.socketPath ?? defaultUnixSocketPath(options.daemonId);
  const server = net.createServer((socket) => {
    const authContext: DaemonAuthenticationContext = {
      transportKind: "unix-socket",
      endpoint,
      unixPeerCredential: localUnixPeerCredential()
    };
    const connection = serveJsonRpcStream({
      input: socket,
      output: socket,
      transportKind: "unix-socket",
      authContext,
      createProtocolServer: options.createProtocolServer
    });
    options.onConnection?.(connection);
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
