// @slice-activation PLT-Daemon W3 transport adapters exported for daemon composition roots.
import net from "node:net";
import type { DaemonAuthenticationContext } from "./auth-context.ts";
import { serveJsonRpcStream, type DaemonTransportConnection } from "./json-rpc-stream.ts";
import { authenticateSshForcedCommandFrame } from "./ssh-forced-command.ts";
import type { JsonRpcProtocolServer } from "../protocol/json-rpc-server.ts";

export interface NamedPipeTransportOptions {
  readonly daemonId: string;
  readonly pipePath?: string;
  readonly platform?: NodeJS.Platform;
  readonly createProtocolServer: (authContext: DaemonAuthenticationContext) => JsonRpcProtocolServer;
  readonly onConnection?: (connection: DaemonTransportConnection) => void;
  readonly onConnectionClosed?: (connection: DaemonTransportConnection) => void;
  readonly acceptSshForcedCommand?: boolean;
}

export interface NamedPipeTransportServer {
  readonly kind: "named-pipe";
  readonly endpoint: string;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

export interface WindowsNamedPipeIntegrationEntry {
  readonly runnableOn: "win32";
  readonly command: string;
  readonly testFile: string;
  readonly reason: string;
}

export function defaultNamedPipePath(daemonId: string): string {
  return `\\\\.\\pipe\\harness-anything-${safeNamedPipeEndpointId(daemonId)}`;
}

export function windowsNamedPipeIntegrationEntry(): WindowsNamedPipeIntegrationEntry {
  return {
    runnableOn: "win32",
    command: "npm run test:integration",
    testFile: "packages/daemon/test/transport-integration.test.ts",
    reason: "The named pipe end-to-end case runs on Windows and is declared here for local verification when CI has no Windows runner."
  };
}

export function createNamedPipeTransportServer(options: NamedPipeTransportOptions): NamedPipeTransportServer {
  const endpoint = options.pipePath ?? defaultNamedPipePath(options.daemonId);
  const platform = options.platform ?? process.platform;
  const server = net.createServer((socket) => {
    const authContext: DaemonAuthenticationContext = {
      transportKind: "named-pipe",
      endpoint,
      namedPipeClient: { endpoint, source: "windows-named-pipe" }
    };
    const connection = serveJsonRpcStream({
      input: socket,
      output: socket,
      transportKind: "named-pipe",
      authContext,
      ...(options.acceptSshForcedCommand ? { authenticateFirstFrame: authenticateSshForcedCommandFrame } : {}),
      createProtocolServer: options.createProtocolServer
    });
    options.onConnection?.(connection);
    socket.once("close", () => options.onConnectionClosed?.(connection));
  });

  return {
    kind: "named-pipe",
    endpoint,
    start: async () => {
      if (platform !== "win32") {
        throw new Error(`Windows named pipe transport requires win32; use ${windowsNamedPipeIntegrationEntry().command} on Windows.`);
      }
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}

function safeNamedPipeEndpointId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "-");
}
