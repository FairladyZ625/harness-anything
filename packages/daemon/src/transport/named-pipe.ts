// @slice-activation PLT-Daemon W3 transport adapters exported for daemon composition roots.
import { randomUUID } from "node:crypto";
import net from "node:net";
import type { AcceptedConnectionBinding } from "../protocol/connection-context.ts";
import type { JsonRpcProtocolServer } from "../protocol/json-rpc-server.ts";
import { connectionGeneration, createAcceptedConnectionEvidence } from "./accepted-connection-evidence.ts";
import type {
  AcceptedConnectionEvidenceAdapter,
  DaemonAuthenticationContext
} from "./auth-context.ts";
import { serveJsonRpcStream, type DaemonTransportConnection } from "./json-rpc-stream.ts";
import type { JsonRpcNotification } from "../protocol/json-rpc-types.ts";
import { authenticateSshForcedCommandFrame, type AcceptSshForcedCommand } from "./ssh-forced-command.ts";
import { createNodeSocketAcceptedConnectionEvidenceAdapter } from "./node-socket-peer-credential.ts";
import { gracefullyCloseSocketServer } from "./graceful-socket-shutdown.ts";

export interface NamedPipeTransportOptions {
  readonly daemonId: string;
  readonly pipePath?: string;
  readonly platform?: NodeJS.Platform;
  readonly acceptedConnectionEvidenceAdapter?: AcceptedConnectionEvidenceAdapter<net.Socket>;
  readonly createProtocolServer: (
    authContext: DaemonAuthenticationContext,
    acceptedConnection: AcceptedConnectionBinding | undefined,
    notificationSink: (notification: JsonRpcNotification) => void
  ) => JsonRpcProtocolServer;
  readonly onConnection?: (connection: DaemonTransportConnection) => void;
  readonly onConnectionClosed?: (connection: DaemonTransportConnection) => void;
  readonly acceptSshForcedCommand?: boolean | AcceptSshForcedCommand;
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
  const evidenceAdapter = options.acceptedConnectionEvidenceAdapter
    ?? createNodeSocketAcceptedConnectionEvidenceAdapter({ platform, transportKind: "named-pipe" });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    void acceptNamedPipeConnection(socket);
  });

  async function acceptNamedPipeConnection(socket: net.Socket): Promise<void> {
    const authContext: DaemonAuthenticationContext = {
      transportKind: "named-pipe",
      endpoint,
      namedPipeClient: { endpoint, source: "windows-named-pipe" }
    };
    const connectionId = randomUUID();
    const generation = connectionGeneration();
    const acceptedConnectionEvidence = await evidenceAdapter.observeAcceptedConnection({
      socket,
      connectionId,
      connectionGeneration: generation,
      daemonInstanceId: options.daemonId
    }).catch(() => createAcceptedConnectionEvidence({
      connectionId,
      connectionGeneration: generation,
      daemonInstanceId: options.daemonId,
      transportKind: "named-pipe",
      peerCredential: {
        available: false,
        code: "platform_unsupported",
        source: "os-peer-credential-adapter"
      }
    }));
    if (socket.destroyed) return;
    const connection = serveJsonRpcStream({
      input: socket,
      output: socket,
      transportKind: "named-pipe",
      authContext,
      connectionId,
      acceptedConnectionEvidence,
      ...(options.acceptSshForcedCommand ? {
        authenticateFirstFrame: (frame: unknown, context: DaemonAuthenticationContext) => authenticateSshForcedCommandFrame(
          frame,
          context,
          typeof options.acceptSshForcedCommand === "function" ? options.acceptSshForcedCommand : undefined
        )
      } : {}),
      createProtocolServer: options.createProtocolServer
    });
    options.onConnection?.(connection);
    socket.once("close", () => options.onConnectionClosed?.(connection));
  }

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
      await gracefullyCloseSocketServer(server, sockets);
    }
  };
}

function safeNamedPipeEndpointId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "-");
}
