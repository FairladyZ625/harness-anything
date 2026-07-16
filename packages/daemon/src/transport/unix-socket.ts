// @slice-activation PLT-Daemon W3 transport adapters exported for daemon composition roots.
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { DaemonAuthenticationContext } from "./auth-context.ts";
import { serveJsonRpcStream, type DaemonTransportConnection } from "./json-rpc-stream.ts";
import { authenticateSshForcedCommandFrame, type AcceptSshForcedCommand } from "./ssh-forced-command.ts";
import type { JsonRpcProtocolServer } from "../protocol/json-rpc-server.ts";

export interface UnixSocketTransportOptions {
  readonly daemonId: string;
  readonly socketPath?: string;
  readonly createProtocolServer: (authContext: DaemonAuthenticationContext) => JsonRpcProtocolServer;
  readonly onConnection?: (connection: DaemonTransportConnection) => void;
  readonly onConnectionClosed?: (connection: DaemonTransportConnection) => void;
  readonly acceptSshForcedCommand?: boolean | AcceptSshForcedCommand;
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
    if (error instanceof Error && error.message.startsWith("Unsafe daemon socket directory")) throw error;
    throw privateDirectoryError(directory, uid, undefined, undefined, error);
  }

  if (ownerUid !== uid || mode !== 0o700) {
    throw privateDirectoryError(directory, uid, ownerUid, mode);
  }
}

export function createUnixSocketTransportServer(options: UnixSocketTransportOptions): UnixSocketTransportServer {
  const endpoint = options.socketPath ?? defaultUnixSocketPath(options.daemonId);
  const server = net.createServer((socket) => {
    const ownerUid = statSync(endpoint).uid;
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
  });

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
  return new Error(message, cause === undefined ? undefined : { cause });
}
