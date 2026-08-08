// @slice-activation PLT-Boundary W1 exposes this module through the package root API.
import { createHash } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  readDaemonRegistry,
  registerDaemonRepo,
  resolveDaemonRepoByRoot,
  type DaemonRegistry,
  type DaemonRegistryRepo
} from "@harness-anything/kernel/daemon/registry";
import { currentDaemonProtocolVersion } from "../protocol/method-registry.ts";
import type { JsonObject } from "../protocol/json-rpc-types.ts";
import { defaultNamedPipePath } from "../transport/named-pipe.ts";
import { defaultUnixSocketPath, type UnixSocketPathOptions } from "../transport/unix-socket.ts";
import {
  createDaemonLaunchConfiguration,
  type DaemonLaunchConfiguration
} from "./daemon-launch-configuration.ts";
import { DaemonRepoRootResolutionError } from "./daemon-repo-root-resolution-error.ts";
import {
  connectUnixSocketWithLegacyFallback,
  connectUnixSocketWithNamespaceDiagnostic
} from "./daemon-socket-connection.ts";
import {
  DaemonJsonRpcRequestTimeoutError,
  DaemonJsonRpcResponseError,
  defaultDaemonJsonRpcRequestTimeoutMs,
  JsonRpcLineClient
} from "./json-rpc-line-client.ts";
import {
  daemonAutostartRootLifetimeEnvironmentVariable,
  daemonRootIdentity
} from "../lifecycle/daemon-root-lifetime.ts";
import { daemonServerHostEnvironment } from "./daemon-server-host-environment.ts";
import {
  daemonAutostartFailureError,
  spawnDetachedDaemonAutostart,
  type SpawnedDaemonAutostartProcess
} from "./daemon-autostart-process.ts";
import {
  boundedDeadlineTimeout,
  createDaemonAutostartFlightManager,
  delay
} from "./daemon-autostart-flight.ts";

export {
  createDaemonLaunchConfiguration,
  daemonLaunchOptionsResolvedFlag,
  projectDaemonLaunchConfiguration,
  type DaemonLaunchConfiguration,
  type DaemonLaunchConfigurationInput
} from "./daemon-launch-configuration.ts";
export {
  createDaemonLaunchConfigurationFromPersistedPolicy,
  daemonLaunchEndpointIdentity,
  daemonLaunchSpecPath,
  daemonLaunchSpecSchema,
  DaemonLaunchSpecReadError,
  parseDaemonLaunchArgv,
  readPersistedDaemonLaunchSpec,
  type DaemonLaunchOptions,
  type ParsedDaemonLaunchArgv
} from "./daemon-launch-spec-store.ts";
export { daemonServerHostEnvironment } from "./daemon-server-host-environment.ts";
export {
  daemonAutostartRootIdentity,
  daemonAutostartRootLifetimeEnabled,
  daemonAutostartRootLifetimeEnvironmentVariable
} from "../lifecycle/daemon-root-lifetime.ts";

// Cold authority readiness measured ~7.2s, so a 6s budget could never confirm it.
export const defaultDaemonAutostartTimeoutMs = 30_000;
// dec_01KZA1ZS0JHS9ZRQXESMC1W5HB: resident by default; 750ms misread pauses as session end. Override: --idle-ms.
export const defaultDaemonIdleExitMs = 0;
export const localDaemonRetryIntervalMs = 100;
const minimumReadyProbeResponseTimeoutMs = 500;

export {
  DaemonAutostartCircuitOpenError,
  DaemonAutostartProcessExitedError,
  DaemonAutostartTimeoutError
} from "./daemon-autostart-process.ts";
export { resetDaemonAutostartCircuit } from "./daemon-autostart-circuit.ts";

export {
  DaemonJsonRpcRequestTimeoutError,
  DaemonJsonRpcResponseError,
  defaultDaemonJsonRpcRequestTimeoutMs,
  JsonRpcLineClient
} from "./json-rpc-line-client.ts";

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
  readonly requestTimeoutMs?: number;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly execArgv?: ReadonlyArray<string>;
  readonly launchConfiguration?: DaemonLaunchConfiguration;
  readonly onPhase?: (phase: LocalDaemonAutostartPhase) => void;
}

export type LocalDaemonAutostartPhase =
  | "connect-start"
  | "launch-start"
  | "ready"
  | "request-start"
  | "request-end";

export interface LocalDaemonJsonRpcOptions {
  readonly userRoot?: string;
  readonly daemonId?: string;
  readonly socketPath?: string;
  readonly repoIdOverride?: string;
  readonly autoRegisterSingleRepo?: boolean;
  readonly allowLegacySocket?: boolean;
  readonly requestTimeoutMs?: number;
  readonly autostart?: LocalDaemonAutostartOptions;
  readonly env?: NodeJS.ProcessEnv;
}

type SpawnLocalDaemonResult = number | void | SpawnedDaemonAutostartProcess;
type SpawnLocalDaemon = (target: LocalDaemonTarget, options: LocalDaemonAutostartOptions) => SpawnLocalDaemonResult;

let spawnLocalDaemonImplementation: SpawnLocalDaemon = spawnLocalDaemonProcess;

// PLT-Honest: the autostart flight manager owns single-flight dedup AND the
// resurrection-chain guard (join a live spawned pid; open the breaker after N
// genuine deaths). Created once with launchLocalDaemon + tuning constants.
const daemonAutostartFlight = createDaemonAutostartFlightManager<LocalDaemonTarget, LocalDaemonAutostartOptions>({
  launchLocalDaemon: (target, options) => launchLocalDaemon(target, options),
  localDaemonRetryIntervalMs,
  minimumReadyProbeResponseTimeoutMs
});

export function daemonIdForRoot(rootDir: string): string {
  return `repo-${createHash("sha256").update(rootDir).digest("hex").slice(0, 16)}`;
}

export function daemonIdForUserRoot(userRoot: string, daemonId = "default"): string {
  return `u-${createHash("sha256").update(`${path.resolve(userRoot)}\0${daemonId}`).digest("hex").slice(0, 16)}`;
}

export function localDaemonSocketPath(rootDir: string): string {
  return defaultUnixSocketPath(daemonIdForRoot(rootDir));
}

export function localUserDaemonSocketPath(
  userRoot = daemonUserRoot(),
  daemonId = daemonIdFromEnv(),
  pathOptions: UnixSocketPathOptions = {}
): string {
  return defaultUnixSocketPath(daemonIdForUserRoot(userRoot, daemonId), pathOptions);
}

export function localUserDaemonEndpoint(
  userRoot = daemonUserRoot(),
  daemonId = daemonIdFromEnv(),
  platform: NodeJS.Platform = process.platform,
  pathOptions: Omit<UnixSocketPathOptions, "platform"> = {}
): string {
  const endpointId = daemonIdForUserRoot(userRoot, daemonId);
  return platform === "win32"
    ? defaultNamedPipePath(endpointId)
    : defaultUnixSocketPath(endpointId, { ...pathOptions, platform });
}

export function daemonUserRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = readNonEmptyDaemonEnv(env, "HOME") ?? os.homedir();
  return path.resolve(readNonEmptyDaemonEnv(env, "HARNESS_DAEMON_USER_ROOT") ?? path.join(home, ".harness"));
}

export function daemonUserRootForRepo(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
  projectUserRoot?: string
): string {
  const explicit = readNonEmptyDaemonEnv(env, "HARNESS_DAEMON_USER_ROOT");
  if (explicit) return path.resolve(explicit);
  if (projectUserRoot) return path.resolve(projectUserRoot);
  const profile = readNonEmptyDaemonEnv(env, "HARNESS_DAEMON_PROFILE") ?? "default";
  if (profile === "default") return daemonUserRoot(env);
  if (profile === "isolated") return path.resolve(rootDir, ".harness", "daemon-profile");
  throw new Error("HARNESS_DAEMON_PROFILE must be default or isolated.");
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
  const userRoot = path.resolve(input.userRoot ?? daemonUserRootForRepo(input.rootDir, env));
  const daemonId = input.daemonId ?? daemonIdFromEnv(env);
  const repoIdOverride = input.repoIdOverride ?? readNonEmptyDaemonEnv(env, "HARNESS_DAEMON_REPO_ID");
  const registry = readDaemonRegistry({ userRoot });
  const socketPath = localUserDaemonEndpoint(userRoot, daemonId);
  const legacySocketPath = process.platform === "win32" ? socketPath : localDaemonSocketPath(input.rootDir);

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

  throw new DaemonRepoRootResolutionError(path.resolve(input.rootDir));
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
  const socketPath = options.socketPath ?? localUserDaemonEndpoint(userRoot, options.daemonId ?? daemonIdFromEnv(options.env));
  const legacySocketPath = process.platform === "win32" ? undefined : localDaemonSocketPath(rootDir);
  const socket = await connectUnixSocketWithLegacyFallback(socketPath, options.allowLegacySocket === false ? undefined : legacySocketPath, timeoutMs);
  return requestWithSocket(socket, method, params, options.requestTimeoutMs);
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

export function spawnLocalDaemon(target: LocalDaemonTarget, options: LocalDaemonAutostartOptions): number | undefined {
  return launchLocalDaemon(target, options).pid;
}

export function replaceSpawnLocalDaemonForTest(replacement: SpawnLocalDaemon): () => void {
  const previous = spawnLocalDaemonImplementation;
  spawnLocalDaemonImplementation = replacement;
  return () => {
    spawnLocalDaemonImplementation = previous;
  };
}

function spawnLocalDaemonProcess(
  target: LocalDaemonTarget,
  options: LocalDaemonAutostartOptions
): SpawnedDaemonAutostartProcess {
  const expectedRootIdentity = daemonRootIdentity(target.canonicalRoot) ?? "missing";
  const launchConfiguration = options.launchConfiguration ?? createDaemonLaunchConfiguration({
    target,
    entrypoint: options.entryPath,
    idleExitMs: options.idleExitMs ?? defaultDaemonIdleExitMs,
    ...(options.layoutOverrides?.authoredRoot ? { authoredRoot: options.layoutOverrides.authoredRoot } : {}),
    ...(options.execPath ? { execPath: options.execPath } : {}),
    ...(options.execArgv ? { execArgv: options.execArgv } : {}),
    env: options.env ?? process.env
  });
  return spawnDetachedDaemonAutostart({
    execPath: launchConfiguration.execPath,
    argv: [
      ...launchConfiguration.execArgv,
      launchConfiguration.entrypoint,
      ...launchConfiguration.args
    ],
    env: {
      ...daemonServerHostEnvironment(options.env ?? process.env, target),
      [daemonAutostartRootLifetimeEnvironmentVariable]: expectedRootIdentity
    },
    userRoot: target.userRoot
  });
}

async function requestLocalDaemonJsonRpcWithAutostart(
  target: LocalDaemonTarget,
  method: string,
  params: JsonObject,
  connectTimeoutMs: number,
  autostart: LocalDaemonAutostartOptions
): Promise<JsonObject> {
  const autostartTimeoutMs = autostart.timeoutMs ?? defaultDaemonAutostartTimeoutMs;
  const deadline = Date.now() + autostartTimeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    let socket: net.Socket;
    try {
      autostart.onPhase?.("connect-start");
      socket = await connectUnixSocketWithNamespaceDiagnostic(
        target.socketPath,
        boundedDeadlineTimeout(connectTimeoutMs, deadline)
      );
    } catch (error) {
      lastError = error;
      await daemonAutostartFlight.ensureLocalDaemonStarted(target, autostart, connectTimeoutMs, deadline, autostartTimeoutMs);
      continue;
    }
    try {
      autostart.onPhase?.("request-start");
      return await requestWithSocket(
        socket,
        method,
        params,
        autostart.requestTimeoutMs ?? defaultDaemonJsonRpcRequestTimeoutMs
      );
    } catch (error) {
      if (error instanceof DaemonJsonRpcResponseError || error instanceof DaemonJsonRpcRequestTimeoutError) throw error;
      lastError = error;
      await delay(Math.min(localDaemonRetryIntervalMs, Math.max(1, deadline - Date.now())));
    } finally {
      autostart.onPhase?.("request-end");
    }
  }
  throw daemonAutostartFailureError(autostartTimeoutMs, lastError);
}

async function requestWithSocket(
  socket: net.Socket,
  method: string,
  params: JsonObject,
  timeoutMs = defaultDaemonJsonRpcRequestTimeoutMs
): Promise<JsonObject> {
  const client = new JsonRpcLineClient(socket, socket);
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    await client.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, remaining());
    return await client.request(method, params, remaining());
  } finally {
    socket.destroy();
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

function launchLocalDaemon(
  target: LocalDaemonTarget,
  options: LocalDaemonAutostartOptions
): SpawnedDaemonAutostartProcess {
  const launched = spawnLocalDaemonImplementation(target, options);
  return typeof launched === "number" ? { pid: launched } : launched ?? {};
}
