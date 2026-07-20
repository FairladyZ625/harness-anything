// @slice-activation PLT-Daemon W3 transport adapters exported for daemon composition roots.
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { connectionGeneration, createAcceptedConnectionEvidence } from "./accepted-connection-evidence.ts";
import type { AcceptedConnectionBinding } from "../protocol/connection-context.ts";
import type {
  AcceptedConnectionEvidence,
  AcceptedConnectionEvidenceAdapter,
  DaemonAuthenticationContext
} from "./auth-context.ts";
import type {
  AuthorityWireIngressHandler,
  AuthorityWireIngressSession
} from "./authority-wire-ingress.ts";
import { serveJsonRpcStream, type DaemonTransportConnection } from "./json-rpc-stream.ts";
import { createNodeSocketAcceptedConnectionEvidenceAdapter } from "./node-socket-peer-credential.ts";
import {
  authenticateSshAuthorityWireFrame,
  authenticateSshForcedCommandFrame,
  isAuthorityWireFrameType,
  isSshAuthorityWireBootstrapFrame,
  type AcceptSshForcedCommand
} from "./ssh-forced-command.ts";
import type { JsonRpcNotification } from "../protocol/json-rpc-types.ts";
import type { JsonRpcProtocolServer } from "../protocol/json-rpc-server.ts";

export interface UnixSocketTransportOptions {
  readonly daemonId: string;
  readonly socketPath?: string;
  readonly acceptedConnectionEvidenceAdapter?: AcceptedConnectionEvidenceAdapter<net.Socket>;
  readonly createProtocolServer: (
    authContext: DaemonAuthenticationContext,
    acceptedConnection: AcceptedConnectionBinding | undefined,
    notificationSink: (notification: JsonRpcNotification) => void
  ) => JsonRpcProtocolServer;
  readonly onConnection?: (connection: DaemonTransportConnection) => void;
  readonly onConnectionClosed?: (connection: DaemonTransportConnection) => void;
  readonly acceptSshForcedCommand?: boolean | AcceptSshForcedCommand;
  readonly authorityWireIngress?: AuthorityWireIngressHandler;
}

export interface UnixSocketPathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly tmpdir?: string;
  readonly linuxRuntimeRoot?: string;
}

export interface UnixSocketTransportServer {
  readonly kind: "unix-socket";
  readonly endpoint: string;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

class UnsafeUnixSocketDirectoryError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "UnsafeUnixSocketDirectoryError";
  }
}

export function defaultUnixSocketPath(
  daemonId: string,
  options: UnixSocketPathOptions | number = {}
): string {
  const normalized = typeof options === "number" ? { uid: options } : options;
  const uid = normalized.uid ?? process.getuid?.() ?? 0;
  const platform = normalized.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.join(
    unixSocketDirectory({ ...normalized, uid }),
    `daemon-${uid}-${safeUnixSocketEndpointId(daemonId)}.sock`
  );
}

export function unixSocketDirectory(options: UnixSocketPathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const tmpdir = readNonEmptyPath(env.TMPDIR, pathApi) ?? options.tmpdir ?? os.tmpdir();

  if (platform === "linux") {
    const xdgRuntimeDir = readNonEmptyPath(env.XDG_RUNTIME_DIR, pathApi);
    if (xdgRuntimeDir) return pathApi.join(xdgRuntimeDir, "harness-anything");

    const userRuntimeDir = pathApi.join(options.linuxRuntimeRoot ?? "/run/user", String(uid));
    if (existsSync(userRuntimeDir)) return pathApi.join(userRuntimeDir, "harness-anything");
  }

  // macOS os.tmpdir() normally resolves to Darwin's per-user temporary
  // directory. The uid suffix also keeps the fallback safe if it resolves to
  // a shared directory such as /tmp on any POSIX platform.
  return pathApi.join(tmpdir, `harness-anything-${uid}`);
}

export function ensurePrivateUnixSocketDirectory(directory: string, uid = process.getuid?.() ?? 0): void {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw privateDirectoryError(directory, uid, undefined, undefined, error);
  }

  let ownerUid: number;
  let mode: number;
  try {
    const stat = lstatSync(directory);
    ownerUid = stat.uid;
    mode = stat.mode & 0o777;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw privateDirectoryError(directory, uid, ownerUid, mode, undefined, "not a real directory");
    }
  } catch (error) {
    if (error instanceof UnsafeUnixSocketDirectoryError) throw error;
    throw privateDirectoryError(directory, uid, undefined, undefined, error);
  }

  if (ownerUid !== uid || mode !== 0o700) {
    throw privateDirectoryError(directory, uid, ownerUid, mode);
  }
}

export function createUnixSocketTransportServer(options: UnixSocketTransportOptions): UnixSocketTransportServer {
  const endpoint = options.socketPath ?? defaultUnixSocketPath(options.daemonId);
  const evidenceAdapter = options.acceptedConnectionEvidenceAdapter
    ?? createNodeSocketAcceptedConnectionEvidenceAdapter();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    void acceptUnixSocket(socket);
  });

  async function acceptUnixSocket(socket: net.Socket): Promise<void> {
    const ownerUid = statSync(endpoint).uid;
    const compatibilityBoundary = {
      ownerUid,
      source: "unix-socket-filesystem-owner-boundary" as const
    };
    const authContext: DaemonAuthenticationContext = {
      transportKind: "unix-socket",
      endpoint,
      // 0700 parent + 0600 socket authorize only this filesystem owner. This
      // identifies that access boundary; it does not observe the client process.
      unixSocketOwnerBoundary: compatibilityBoundary
    };
    const connectionId = randomUUID();
    const generation = connectionGeneration();
    const acceptedConnectionEvidence = await evidenceAdapter.observeAcceptedConnection({
      socket,
      connectionId,
      connectionGeneration: generation,
      daemonInstanceId: options.daemonId,
      compatibilityBoundary
    }).catch(() => createAcceptedConnectionEvidence({
      connectionId,
      connectionGeneration: generation,
      daemonInstanceId: options.daemonId,
      transportKind: "unix-socket",
      peerCredential: {
        available: false,
        code: "observation_failed",
        source: "os-peer-credential-adapter"
      },
      compatibilityBoundary
    }));
    if (socket.destroyed) return;
    let connection: DaemonTransportConnection;
    try {
      connection = serveUnixSocketProtocolRouter({
        socket,
        authContext,
        connectionId,
        acceptedConnectionEvidence,
        createProtocolServer: options.createProtocolServer,
        acceptSshForcedCommand: options.acceptSshForcedCommand,
        authorityWireIngress: options.authorityWireIngress
      });
    } catch {
      socket.destroy();
      return;
    }
    options.onConnection?.(connection);
    socket.once("close", () => options.onConnectionClosed?.(connection));
  }

  return {
    kind: "unix-socket",
    endpoint,
    start: async () => {
      ensurePrivateUnixSocketDirectory(path.dirname(endpoint));
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
      const stopped = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      for (const socket of sockets) socket.destroy();
      await stopped;
      rmSync(endpoint, { force: true });
    }
  };
}

interface UnixSocketProtocolRouterOptions {
  readonly socket: net.Socket;
  readonly authContext: DaemonAuthenticationContext;
  readonly connectionId: string;
  readonly acceptedConnectionEvidence: AcceptedConnectionEvidence;
  readonly createProtocolServer: UnixSocketTransportOptions["createProtocolServer"];
  readonly acceptSshForcedCommand?: UnixSocketTransportOptions["acceptSshForcedCommand"];
  readonly authorityWireIngress?: AuthorityWireIngressHandler;
}

const maximumBootstrapLineBytes = 64 * 1024;

function serveUnixSocketProtocolRouter(options: UnixSocketProtocolRouterOptions): DaemonTransportConnection {
  const { socket, acceptedConnectionEvidence: evidence } = options;
  let active = true;
  let buffered = Buffer.alloc(0);
  let jsonConnection: DaemonTransportConnection | undefined;
  let authoritySession: AuthorityWireIngressSession | undefined;
  let routedAuthContext = options.authContext;
  const acceptedConnection = liveAcceptedConnectionBinding(socket, evidence, options.connectionId, () => active);

  const connection: DaemonTransportConnection = {
    connectionId: options.connectionId,
    transportKind: "unix-socket",
    get authContext() {
      return jsonConnection?.authContext ?? routedAuthContext;
    },
    acceptedConnectionEvidence: evidence,
    isConnectionGenerationActive: () => active && !socket.destroyed,
    close: async () => {
      active = false;
      if (jsonConnection) {
        await jsonConnection.close();
        return;
      }
      await authoritySession?.close();
      socket.destroy();
    }
  };

  const invalidate = () => {
    if (!active) return;
    active = false;
    void authoritySession?.close().catch(() => undefined);
  };
  socket.once("close", invalidate);
  socket.on("data", routeFirstLine);
  socket.resume();
  return connection;

  function routeFirstLine(chunk: Buffer): void {
    buffered = buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, chunk]);
    const newline = buffered.indexOf(0x0a);
    if (newline < 0) {
      if (buffered.length > maximumBootstrapLineBytes) failClosed();
      return;
    }
    socket.pause();
    socket.off("data", routeFirstLine);
    const firstLine = buffered.subarray(0, newline).toString("utf8").replace(/\r$/u, "");
    const remainder = buffered.subarray(newline + 1);
    const frame = parseJson(firstLine);
    if (!isAuthorityWireFrameType(frame)) {
      routeJsonRpc();
      return;
    }
    if (!isSshAuthorityWireBootstrapFrame(frame)) {
      failClosed();
      return;
    }
    const accept = authorityBootstrapAcceptance(options.acceptSshForcedCommand);
    const authenticated = authenticateSshAuthorityWireFrame(frame, options.authContext, accept);
    if (!authenticated.ok || !authenticated.authContext?.sshForcedCommand || !options.authorityWireIngress) {
      failClosed();
      return;
    }
    if (!evidence.peerCredential.available) {
      failClosed();
      return;
    }
    routedAuthContext = authenticated.authContext;
    if (remainder.length > 0) socket.unshift(remainder);
    void Promise.resolve(options.authorityWireIngress({
      bootstrap: frame,
      authContext: authenticated.authContext as typeof routedAuthContext & {
        readonly sshForcedCommand: NonNullable<DaemonAuthenticationContext["sshForcedCommand"]>;
      },
      input: socket,
      output: socket,
      acceptedConnection,
      acceptedConnectionEvidence: evidence
    })).then((session) => {
      if (session) authoritySession = session;
      if (!active) return session?.close();
      socket.resume();
    }).catch(() => failClosed());

    function routeJsonRpc(): void {
      socket.unshift(buffered);
      jsonConnection = serveJsonRpcStream({
        input: socket,
        output: socket,
        transportKind: "unix-socket",
        authContext: options.authContext,
        connectionId: options.connectionId,
        acceptedConnectionEvidence: evidence,
        ...(options.acceptSshForcedCommand ? {
          authenticateFirstFrame: (candidate: unknown, context: DaemonAuthenticationContext) => authenticateSshForcedCommandFrame(
            candidate,
            context,
            typeof options.acceptSshForcedCommand === "function" ? options.acceptSshForcedCommand : undefined
          )
        } : {}),
        createProtocolServer: options.createProtocolServer
      });
      socket.resume();
    }
  }

  function failClosed(): void {
    active = false;
    socket.off("data", routeFirstLine);
    socket.destroy();
  }
}

function liveAcceptedConnectionBinding(
  socket: net.Socket,
  evidence: AcceptedConnectionEvidence,
  connectionId: string,
  active: () => boolean
): AcceptedConnectionBinding {
  if (evidence.connectionId !== connectionId
    || evidence.transportKind !== "unix-socket"
    || evidence.channelBinding.source !== "transport-observed"
    || evidence.channelBinding.digest.byteLength !== 32) {
    throw new Error("accepted connection evidence does not match the live Unix socket");
  }
  return Object.freeze({
    evidence,
    connectionId,
    connectionGeneration: evidence.connectionGeneration,
    isActive: () => active() && !socket.destroyed,
    assertActive: () => {
      if (!active() || socket.destroyed) throw new Error("accepted connection generation is closed");
    }
  });
}

function authorityBootstrapAcceptance(
  configured: UnixSocketTransportOptions["acceptSshForcedCommand"]
): AcceptSshForcedCommand {
  if (typeof configured === "function") return configured;
  return configured === true ? () => true : () => false;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function safeUnixSocketEndpointId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "-");
}

function readNonEmptyPath(value: string | undefined, pathApi: path.PlatformPath = path): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? pathApi.resolve(trimmed) : undefined;
}

function privateDirectoryError(
  directory: string,
  expectedUid: number,
  ownerUid: number | undefined,
  mode: number | undefined,
  cause?: unknown,
  detail?: string
): Error {
  const observed = detail
    ?? `owner uid ${ownerUid ?? "unknown"}, mode ${mode === undefined ? "unknown" : `0${mode.toString(8)}`}`;
  const message = [
    `Unsafe daemon socket directory ${JSON.stringify(directory)} (${observed}); expected a real directory owned by uid ${expectedUid} with mode 0700.`,
    "Set XDG_RUNTIME_DIR or TMPDIR to a private per-user runtime directory."
  ].join(" ");
  return new UnsafeUnixSocketDirectoryError(message, cause);
}
