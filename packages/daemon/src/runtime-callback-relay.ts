import { chmodSync, lstatSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { localUserDaemonEndpoint, perUserSocketRoot } from "./client/local-daemon-target.ts";
import type { RuntimeCallbackRelay, RuntimeDaemonRoute } from "./runtime-spawn-types.ts";

export function runtimeCallbackRelaySpec(
  dispatchId: string,
  route: RuntimeDaemonRoute,
  platform: NodeJS.Platform = process.platform,
): RuntimeCallbackRelay {
  assertEndpointIdentity(route, platform);
  return { endpoint: route.endpoint, path: runtimeCallbackRelayPath(dispatchId) };
}

/** A sealed Codex worker that may write, or only read, reaches the daemon through a per-dispatch relay socket. */
export function dispatchCallbackRelay(
  dispatchId: string,
  route: RuntimeDaemonRoute | undefined,
  instance: { readonly kindId: string; readonly isolationState?: string } | undefined,
  permissionMode: string | undefined,
): RuntimeCallbackRelay | undefined {
  return process.platform !== "win32" &&
    route &&
    isSealedRuntimeDaemonRoute(route) &&
    instance?.kindId === "codex" &&
    instance.isolationState === "enforced" &&
    (permissionMode === "workspace-write" || permissionMode === "read-only")
    ? runtimeCallbackRelaySpec(dispatchId, route)
    : undefined;
}

export function isSealedRuntimeDaemonRoute(
  route: RuntimeDaemonRoute,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return endpointIdentityMatches(route, platform);
}

export function validateRuntimeCallbackRelayPath(dispatchId: string, relayPath: string): void {
  if (!/^dispatch_[a-f0-9]{24}$/u.test(dispatchId)) throw new Error("runtime callback dispatch id is invalid");
  if (path.resolve(relayPath) !== runtimeCallbackRelayPath(dispatchId))
    throw new Error("runtime callback relay path is invalid");
}

export function createRuntimeCallbackRelay(input: {
  readonly dispatchId: string;
  readonly route: RuntimeDaemonRoute;
  readonly relayPath: string;
}): RuntimeCallbackRelayServer {
  validateRuntimeCallbackRelayPath(input.dispatchId, input.relayPath);
  assertEndpointIdentity(input.route);
  const sockets = new Set<net.Socket>();
  mkdirSecurely(path.dirname(input.relayPath));
  removeStaleRelay(input.relayPath);
  const server = net.createServer((client) => {
    sockets.add(client);
    const upstream = createDaemonSocket(input.route.endpoint);
    sockets.add(upstream);
    const closeBoth = (): void => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.once("error", closeBoth);
    upstream.once("error", closeBoth);
    client.once("close", () => sockets.delete(client));
    upstream.once("close", () => sockets.delete(upstream));
    client.pipe(upstream).pipe(client);
  });
  let started = false;
  return {
    endpoint: input.relayPath,
    start: async () => {
      if (started) return;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(input.relayPath, () => {
          server.off("error", reject);
          started = true;
          if (process.platform !== "win32") chmodRelay(input.relayPath);
          resolve();
        });
      });
    },
    stop: async () => {
      if (!started) {
        removeStaleRelay(input.relayPath);
        return;
      }
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      started = false;
      removeStaleRelay(input.relayPath);
    },
  };
}

export function removeRuntimeCallbackRelay(dispatchId: string): void {
  if (!/^dispatch_[a-f0-9]{24}$/u.test(dispatchId)) return;
  rmSync(runtimeCallbackRelayPath(dispatchId), { force: true });
}

export interface RuntimeCallbackRelayServer {
  readonly endpoint: string;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

/** The relay socket lives under the short per-user socket root: a repository path has unbounded
 * length and macOS caps a unix-socket address at 104 bytes, which used to fail the bind with
 * listen EINVAL before the provider could start. */
function runtimeCallbackRelayPath(dispatchId: string): string {
  return path.join(perUserSocketRoot(), relayName(dispatchId));
}

function assertEndpointIdentity(route: RuntimeDaemonRoute, platform: NodeJS.Platform = process.platform): void {
  if (!endpointIdentityMatches(route, platform))
    throw new Error("runtime callback endpoint identity does not match the sealed daemon route");
}

function endpointIdentityMatches(route: RuntimeDaemonRoute, platform: NodeJS.Platform): boolean {
  const expected = localUserDaemonEndpoint(route.userRoot, route.daemonId, platform),
    actual = route.endpoint;
  if (actual.startsWith("\0")) {
    return actual.slice(1) === path.basename(expected);
  }
  return platform !== "win32" ? path.basename(actual) === path.basename(expected) : actual === expected;
}

function mkdirSecurely(target: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const info = lstatSync(target);
  // mkdirSync leaves a pre-existing directory's mode untouched, and sticky /tmp lets any user
  // pre-create this name; a directory that is not a 0700 owner directory would silently void
  // the per-user boundary the socket path claims.
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
    throw new Error("runtime callback relay directory is unsafe");
}

function removeStaleRelay(target: string): void {
  // BigInt stats: target is the relay socket, and a numeric stat of it would
  // poison the shared buffer Node's realpath cache reads.
  const info = lstatSync(target, { throwIfNoEntry: false, bigint: true });
  if (!info) return;
  if (info.isSymbolicLink()) throw new Error("runtime callback relay socket must not be a symbolic link");
  unlinkSync(target);
}

function chmodRelay(target: string): void {
  chmodSync(target, 0o600);
}

function createDaemonSocket(endpoint: string): net.Socket {
  if (!endpoint.startsWith("tcp://")) return net.createConnection(endpoint);
  const url = new URL(endpoint);
  return net.createConnection({ host: url.hostname.replace(/^\[|\]$/gu, ""), port: Number(url.port) });
}

function relayName(dispatchId: string): string {
  return `r-${dispatchId.slice("dispatch_".length)}.sock`;
}
