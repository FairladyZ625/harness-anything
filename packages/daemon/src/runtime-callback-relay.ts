import { chmodSync, lstatSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { localUserDaemonEndpoint } from "./client/local-daemon-target.ts";
import type { RuntimeCallbackRelay, RuntimeDaemonRoute } from "./runtime-spawn-types.ts";

const relayDirectory = ".harness";

export function runtimeCallbackRelaySpec(
  rootDir: string,
  dispatchId: string,
  route: RuntimeDaemonRoute,
  platform: NodeJS.Platform = process.platform,
): RuntimeCallbackRelay {
  assertEndpointIdentity(route, platform);
  const relayPath = path.join(path.resolve(rootDir), relayDirectory, relayName(dispatchId));
  validateRuntimeCallbackRelayPath(rootDir, dispatchId, relayPath, route, platform);
  return { endpoint: route.endpoint, path: relayPath };
}

export function isSealedRuntimeDaemonRoute(
  route: RuntimeDaemonRoute,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return endpointIdentityMatches(route, platform);
}

export function validateRuntimeCallbackRelayPath(
  rootDir: string,
  dispatchId: string,
  relayPath: string,
  route: RuntimeDaemonRoute,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!/^dispatch_[a-f0-9]{24}$/u.test(dispatchId)) throw new Error("runtime callback dispatch id is invalid");
  const root = path.resolve(rootDir),
    expected = runtimeCallbackRelayPath(root, dispatchId, route, platform);
  if (path.resolve(relayPath) !== expected) throw new Error("runtime callback relay path is invalid");
  if (platform === "win32") return;
  for (const component of pathComponents(root, expected)) {
    const info = lstatSync(component, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) throw new Error("runtime callback relay path contains a symbolic link");
  }
}

export function createRuntimeCallbackRelay(input: {
  readonly rootDir: string;
  readonly dispatchId: string;
  readonly route: RuntimeDaemonRoute;
  readonly relayPath: string;
}): RuntimeCallbackRelayServer {
  validateRuntimeCallbackRelayPath(input.rootDir, input.dispatchId, input.relayPath, input.route);
  assertEndpointIdentity(input.route);
  const parent = path.dirname(input.relayPath),
    sockets = new Set<net.Socket>();
  mkdirSecurely(input.rootDir, parent);
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

export function removeRuntimeCallbackRelay(rootDir: string, dispatchId: string): void {
  if (!/^dispatch_[a-f0-9]{24}$/u.test(dispatchId)) return;
  const root = path.resolve(rootDir),
    directory = path.join(root, relayDirectory),
    target = path.join(directory, `r-${dispatchId.slice("dispatch_".length)}.sock`);
  for (const component of pathComponents(root, target)) {
    const info = lstatSync(component, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) return;
  }
  rmSync(target, { force: true });
}

export interface RuntimeCallbackRelayServer {
  readonly endpoint: string;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

function runtimeCallbackRelayPath(
  rootDir: string,
  dispatchId: string,
  _route: RuntimeDaemonRoute,
  _platform: NodeJS.Platform,
): string {
  return path.join(path.resolve(rootDir), relayDirectory, relayName(dispatchId));
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

function pathComponents(root: string, target: string): readonly string[] {
  const relative = path.relative(root, target),
    components: string[] = [root];
  let current = root;
  for (const part of relative.split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    components.push(current);
  }
  return components;
}

function mkdirSecurely(root: string, target: string): void {
  for (const component of pathComponents(root, target)) {
    mkdirSync(component, { recursive: true, mode: 0o700 });
    const info = lstatSync(component);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("runtime callback relay directory is unsafe");
  }
}

function removeStaleRelay(target: string): void {
  const info = lstatSync(target, { throwIfNoEntry: false });
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
