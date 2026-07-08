import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
// eslint-disable-next-line no-restricted-imports -- The daemon client must not import the kernel barrel because GUI dynamically loads this module and the barrel exports sqlite projection code.
import {
  readDaemonRegistry,
  registerDaemonRepo,
  resolveDaemonRepoByRoot,
  type DaemonRegistry,
  type DaemonRegistryRepo
} from "../../../kernel/src/daemon/registry.ts";
import { currentDaemonProtocolVersion } from "../protocol/method-registry.ts";
import { type JsonObject, type JsonRpcRequest, type JsonRpcResponse } from "../protocol/json-rpc-types.ts";
import { encodeJsonLineFrame } from "../transport/frame-codec.ts";
import { defaultUnixSocketPath } from "../transport/unix-socket.ts";

export const defaultDaemonAutostartTimeoutMs = 6_000;
export const defaultDaemonIdleExitMs = 750;

export interface LocalDaemonTarget {
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly socketPath: string;
  readonly legacySocketPath: string;
  readonly registered: boolean;
}

interface HarnessLayoutOverrides {
  readonly authoredRoot?: string;
}

export interface LocalDaemonAutostartOptions {
  readonly entryPath: string;
  readonly idleExitMs?: number;
  readonly timeoutMs?: number;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly execArgv?: ReadonlyArray<string>;
}

export interface LocalDaemonJsonRpcOptions {
  readonly userRoot?: string;
  readonly daemonId?: string;
  readonly socketPath?: string;
  readonly repoIdOverride?: string;
  readonly autoRegisterSingleRepo?: boolean;
  readonly allowLegacySocket?: boolean;
  readonly autostart?: LocalDaemonAutostartOptions;
  readonly env?: NodeJS.ProcessEnv;
}

export function daemonIdForRoot(rootDir: string): string {
  return `repo-${createHash("sha256").update(rootDir).digest("hex").slice(0, 16)}`;
}

export function daemonIdForUserRoot(userRoot: string, daemonId = "default"): string {
  return `u-${createHash("sha256").update(`${path.resolve(userRoot)}\0${daemonId}`).digest("hex").slice(0, 16)}`;
}

export function localDaemonSocketPath(rootDir: string): string {
  return defaultUnixSocketPath(daemonIdForRoot(rootDir));
}

export function localUserDaemonSocketPath(userRoot = daemonUserRoot(), daemonId = daemonIdFromEnv()): string {
  return defaultUnixSocketPath(daemonIdForUserRoot(userRoot, daemonId));
}

export function daemonUserRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(readNonEmptyDaemonEnv(env, "HARNESS_DAEMON_USER_ROOT") ?? path.join(os.homedir(), ".harness"));
}

export function daemonIdFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return readNonEmptyDaemonEnv(env, "HARNESS_DAEMON_ID") ?? "default";
}

export function resolveLocalDaemonTarget(input: {
  readonly rootDir: string;
  readonly repoIdOverride?: string;
  readonly userRoot?: string;
  readonly daemonId?: string;
  readonly autoRegisterSingleRepo?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): LocalDaemonTarget {
  const env = input.env ?? process.env;
  const userRoot = path.resolve(input.userRoot ?? daemonUserRoot(env));
  const daemonId = input.daemonId ?? daemonIdFromEnv(env);
  const repoIdOverride = input.repoIdOverride ?? readNonEmptyDaemonEnv(env, "HARNESS_DAEMON_REPO_ID");
  const registry = readDaemonRegistry({ userRoot });
  const legacySocketPath = localDaemonSocketPath(input.rootDir);
  const socketPath = localUserDaemonSocketPath(userRoot, daemonId);

  if (repoIdOverride) {
    const registered = registry.repos.find((repo) => repo.repoId === repoIdOverride && repo.state === "enabled");
    return daemonTarget({
      repoId: repoIdOverride,
      canonicalRoot: registered?.canonicalRoot ?? path.resolve(input.rootDir),
      userRoot,
      daemonId,
      socketPath,
      legacySocketPath,
      registered: Boolean(registered)
    });
  }

  const matchingRepo = resolveRegistryRepoByRoot(input.rootDir, registry, userRoot);
  if (matchingRepo?.state === "enabled") {
    return daemonTarget({
      repoId: matchingRepo.repoId,
      canonicalRoot: matchingRepo.canonicalRoot,
      userRoot,
      daemonId,
      socketPath,
      legacySocketPath,
      registered: true
    });
  }

  const enabledRepos = registry.repos.filter((repo) => repo.state === "enabled");
  if (enabledRepos.length === 0) {
    if (input.autoRegisterSingleRepo) {
      const registered = tryRegisterCanonicalRepo(input.rootDir, userRoot);
      if (registered) {
        return daemonTarget({
          repoId: registered.repoId,
          canonicalRoot: registered.canonicalRoot,
          userRoot,
          daemonId,
          socketPath,
          legacySocketPath,
          registered: true
        });
      }
    }
    return daemonTarget({
      repoId: "canonical",
      canonicalRoot: path.resolve(input.rootDir),
      userRoot,
      daemonId,
      socketPath,
      legacySocketPath,
      registered: false
    });
  }

  throw new Error(`current root is not registered with the user daemon registry. Run: ha daemon repo register --repo-id <id> --root ${JSON.stringify(path.resolve(input.rootDir))}`);
}

export async function requestLocalDaemonJsonRpc(
  rootDir: string,
  method: string,
  params: JsonObject,
  timeoutMs = 1_000,
  options: LocalDaemonJsonRpcOptions = {}
): Promise<JsonObject> {
  if (options.autostart) {
    const target = resolveLocalDaemonTarget({
      rootDir,
      repoIdOverride: options.repoIdOverride,
      userRoot: options.userRoot,
      daemonId: options.daemonId,
      autoRegisterSingleRepo: options.autoRegisterSingleRepo ?? true,
      env: options.env
    });
    return requestLocalDaemonJsonRpcWithAutostart(target, method, params, timeoutMs, options.autostart);
  }

  const userRoot = path.resolve(options.userRoot ?? daemonUserRoot(options.env));
  const socketPath = options.socketPath ?? localUserDaemonSocketPath(userRoot, options.daemonId ?? daemonIdFromEnv(options.env));
  const socket = await connectUnixSocketWithLegacyFallback(socketPath, options.allowLegacySocket === false ? undefined : localDaemonSocketPath(rootDir), timeoutMs);
  return requestWithSocket(socket, method, params);
}

export async function requestLocalDaemonJsonRpcForTarget(
  target: LocalDaemonTarget,
  method: string,
  params: JsonObject,
  timeoutMs = 1_000,
  autostart?: LocalDaemonAutostartOptions
): Promise<JsonObject> {
  if (!autostart) {
    const socket = await connectUnixSocketWithLegacyFallback(target.socketPath, target.legacySocketPath, timeoutMs);
    return requestWithSocket(socket, method, params);
  }
  return requestLocalDaemonJsonRpcWithAutostart(target, method, params, timeoutMs, autostart);
}

export function spawnLocalDaemon(target: LocalDaemonTarget, options: LocalDaemonAutostartOptions): void {
  const child = spawn(options.execPath ?? process.execPath, [
    ...(options.execArgv ?? process.execArgv),
    options.entryPath,
    "--root",
    target.canonicalRoot,
    ...(options.layoutOverrides?.authoredRoot ? ["--authored-root", options.layoutOverrides.authoredRoot] : []),
    "daemon",
    "serve",
    "--repo",
    target.repoId,
    "--socket",
    target.socketPath,
    "--user-root",
    target.userRoot,
    "--idle-ms",
    String(options.idleExitMs ?? defaultDaemonIdleExitMs)
  ], {
    detached: true,
    stdio: "ignore",
    env: {
      ...(options.env ?? process.env),
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DAEMON_USER_ROOT: target.userRoot,
      HARNESS_DAEMON_ID: target.daemonId
    }
  });
  child.unref();
}

export class JsonRpcLineClient {
  private nextId = 1;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly owner?: ChildProcessWithoutNullStreams;

  constructor(input: Readable, output: Writable, owner?: ChildProcessWithoutNullStreams) {
    this.input = input;
    this.output = output;
    this.owner = owner;
  }

  async request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = this.nextId++;
    const responsePromise = this.readResponse(id);
    const request = { jsonrpc: "2.0", id, method, params } satisfies JsonRpcRequest;
    this.output.write(encodeJsonLineFrame(request));
    const response = await responsePromise;
    if ("error" in response) throw new Error(response.error.message);
    if (!isPlainRecord(response.result)) throw new Error(`daemon returned non-object result for ${method}`);
    return response.result as JsonObject;
  }

  close(): void {
    this.output.end();
    this.owner?.kill("SIGTERM");
  }

  private async readResponse(id: number): Promise<JsonRpcResponse> {
    const lines = createInterface({ input: this.input });
    const iterator = lines[Symbol.asyncIterator]();
    while (true) {
      const next = await iterator.next();
      if (next.done) throw new Error(`daemon closed before JSON-RPC response ${id}`);
      const response = JSON.parse(next.value) as JsonRpcResponse;
      if (response.id === id) return response;
    }
  }
}

async function requestLocalDaemonJsonRpcWithAutostart(
  target: LocalDaemonTarget,
  method: string,
  params: JsonObject,
  connectTimeoutMs: number,
  autostart: LocalDaemonAutostartOptions
): Promise<JsonObject> {
  const deadline = Date.now() + (autostart.timeoutMs ?? defaultDaemonAutostartTimeoutMs);
  let nextSpawnAt = 0;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      const socket = await connectUnixSocket(target.socketPath, connectTimeoutMs);
      return await requestWithSocket(socket, method, params);
    } catch (error) {
      lastError = error;
      if (Date.now() >= nextSpawnAt) {
        spawnLocalDaemon(target, autostart);
        nextSpawnAt = Date.now() + 500;
      }
      await delay(100);
    }
  }
  throw lastError ?? new Error("local daemon did not become reachable");
}

async function requestWithSocket(socket: net.Socket, method: string, params: JsonObject): Promise<JsonObject> {
  const client = new JsonRpcLineClient(socket, socket);
  try {
    await client.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion });
    return await client.request(method, params);
  } finally {
    client.close();
  }
}

function connectUnixSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to daemon socket: ${socketPath}`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function connectUnixSocketWithLegacyFallback(socketPath: string, legacySocketPath: string | undefined, timeoutMs: number): Promise<net.Socket> {
  try {
    return await connectUnixSocket(socketPath, timeoutMs);
  } catch (error) {
    if (!legacySocketPath || legacySocketPath === socketPath) throw error;
    return connectUnixSocket(legacySocketPath, timeoutMs);
  }
}

function readNonEmptyDaemonEnv(env: NodeJS.ProcessEnv | undefined, name: string): string | undefined {
  const value = env?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveRegistryRepoByRoot(rootDir: string, registry: DaemonRegistry, userRoot: string): DaemonRegistryRepo | undefined {
  try {
    return resolveDaemonRepoByRoot(rootDir, { userRoot });
  } catch {
    const resolvedRoot = path.resolve(rootDir);
    return registry.repos.find((repo) => path.resolve(repo.canonicalRoot) === resolvedRoot);
  }
}

function tryRegisterCanonicalRepo(rootDir: string, userRoot: string): DaemonRegistryRepo | undefined {
  try {
    return registerDaemonRepo({
      userRoot,
      canonicalRoot: rootDir,
      repoId: "canonical"
    }).repo;
  } catch {
    return undefined;
  }
}

function daemonTarget(input: LocalDaemonTarget): LocalDaemonTarget {
  return input;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
