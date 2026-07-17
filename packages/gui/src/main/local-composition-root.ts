import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateProjectPath } from "../api/local-api.ts";
import { createGuiServiceBridgeForDaemon } from "../api/service-bridge.ts";
import type { ApiRouteContract } from "../api/api-contract-registry.ts";
import type { GuiServiceBridge } from "../api/service-bridge.ts";

const defaultDaemonAutostartTimeoutMs = 6_000;
const defaultDaemonIdleExitMs = 5 * 60_000;

type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;

interface LocalDaemonTarget {
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

interface LocalDaemonClientModule {
  readonly daemonUserRoot: (env?: NodeJS.ProcessEnv) => string;
  readonly daemonIdFromEnv: (env?: NodeJS.ProcessEnv) => string;
  readonly resolveLocalDaemonTarget: (input: {
    readonly rootDir: string;
    readonly repoIdOverride?: string;
    readonly userRoot?: string;
    readonly daemonId?: string;
    readonly autoRegisterSingleRepo?: boolean;
    readonly env?: NodeJS.ProcessEnv;
  }) => LocalDaemonTarget;
  readonly requestLocalDaemonJsonRpcForTarget: (
    target: LocalDaemonTarget,
    method: string,
    params: JsonObject,
    timeoutMs?: number,
    autostart?: {
      readonly entryPath: string;
      readonly idleExitMs?: number;
      readonly timeoutMs?: number;
      readonly layoutOverrides?: HarnessLayoutOverrides;
      readonly env?: NodeJS.ProcessEnv;
      readonly execPath?: string;
      readonly execArgv?: ReadonlyArray<string>;
    }
  ) => Promise<JsonObject>;
}

let daemonClientModulePromise: Promise<LocalDaemonClientModule> | undefined;

interface GuiDaemonBridgeState {
  layoutOverrideDaemonStarted: boolean;
}

export function createLocalGuiServiceBridge(rootDir: string, layoutOverrides?: HarnessLayoutOverrides): GuiServiceBridge {
  const resolvedRootDir = path.resolve(rootDir);
  validateProjectPath(resolvedRootDir, ".");
  const state: GuiDaemonBridgeState = { layoutOverrideDaemonStarted: false };
  return createGuiServiceBridgeForDaemon(async (route, payload) => requestGuiRouteViaDaemon(resolvedRootDir, layoutOverrides, state, route, payload));
}

async function requestGuiRouteViaDaemon(
  rootDir: string,
  layoutOverrides: HarnessLayoutOverrides | undefined,
  state: GuiDaemonBridgeState,
  route: ApiRouteContract,
  payload: unknown
): Promise<JsonObject> {
  try {
    const daemonClient = await loadDaemonClientModule();
    const userRoot = daemonClient.daemonUserRoot();
    const daemonId = daemonClient.daemonIdFromEnv();
    const target = daemonClient.resolveLocalDaemonTarget({
      rootDir,
      repoIdOverride: process.env.HARNESS_DAEMON_REPO_ID,
      userRoot,
      daemonId,
      autoRegisterSingleRepo: true
    });
    const customLayout = hasLayoutOverride(layoutOverrides);
    if (customLayout && !state.layoutOverrideDaemonStarted && await daemonAlreadyRunning(daemonClient, target)) {
      return {
        ok: false,
        error: {
          code: "daemon_layout_conflict",
          hint: "A Harness daemon is already running for this repo without a verifiable matching authored layout. Stop the daemon or restart the GUI without HARNESS_AUTHORED_ROOT."
        }
      };
    }
    const nodeRuntime = resolveGuiDaemonNodeRuntime();
    const method = jsonRpcMethodForGuiRoute(route);
    const params = jsonRpcParamsForGuiRoute(route, target.repoId, payload);
    // Admin control (restart) waits for accept + drain; allow a longer socket timeout.
    const timeoutMs = route.commandClass === "admin" ? 5_000 : 200;
    const receipt = await daemonClient.requestLocalDaemonJsonRpcForTarget(target, method, params, timeoutMs, {
      entryPath: cliEntrypointPath(),
      idleExitMs: resolveGuiDaemonIdleExitMs(),
      timeoutMs: daemonAutostartTimeoutMs(),
      execPath: nodeRuntime.execPath,
      execArgv: nodeRuntime.execArgv,
      env: nodeRuntime.env,
      ...(layoutOverrides ? { layoutOverrides } : {})
    });
    if (customLayout) state.layoutOverrideDaemonStarted = true;
    return receipt;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "daemon_unavailable",
        hint: `Harness daemon is unavailable: ${error instanceof Error ? error.message : String(error)}`
      }
    };
  }
}

export interface GuiDaemonNodeRuntime {
  readonly execPath: string;
  readonly execArgv: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}

export function resolveGuiDaemonNodeRuntime(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly resourcesPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly lookupNodeOnPath?: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string | undefined;
} = {}): GuiDaemonNodeRuntime {
  const env = input.env ?? process.env;
  const currentExecPath = input.execPath ?? process.execPath;
  const platform = input.platform ?? process.platform;
  const explicit = nonEmptyEnv(env, "HARNESS_NODE_BIN");
  if (explicit) return guiDaemonNodeRuntime(explicit, env);
  const packagedNode = packagedNodeExecutablePath(input.resourcesPath ?? electronResourcesPath(), platform, input.arch ?? process.arch);
  if (packagedNode && existsSync(packagedNode)) return guiDaemonNodeRuntime(packagedNode, env);
  const npmNode = nonEmptyEnv(env, "npm_node_execpath");
  if (npmNode && !sameExecutable(npmNode, currentExecPath)) return guiDaemonNodeRuntime(npmNode, env);
  const pathNode = (input.lookupNodeOnPath ?? lookupNodeOnPath)(env, platform);
  if (pathNode) return guiDaemonNodeRuntime(pathNode, env);
  throw new Error("System Node runtime not found; set HARNESS_NODE_BIN to a Node executable.");
}

function guiDaemonNodeRuntime(execPath: string, env: NodeJS.ProcessEnv): GuiDaemonNodeRuntime {
  return {
    execPath,
    execArgv: [],
    env: daemonAutostartEnv(env)
  };
}

async function daemonAlreadyRunning(daemonClient: LocalDaemonClientModule, target: LocalDaemonTarget): Promise<boolean> {
  try {
    await daemonClient.requestLocalDaemonJsonRpcForTarget(target, "repo.daemon.status", {
      repo: { repoId: target.repoId }
    }, 200);
    return true;
  } catch {
    return false;
  }
}

function hasLayoutOverride(layoutOverrides: HarnessLayoutOverrides | undefined): boolean {
  return Boolean(layoutOverrides?.authoredRoot);
}

async function loadDaemonClientModule(): Promise<LocalDaemonClientModule> {
  daemonClientModulePromise ??= import(daemonClientModuleUrl()) as Promise<LocalDaemonClientModule>;
  return daemonClientModulePromise;
}

function daemonClientModuleUrl(): string {
  return new URL("../../../daemon/src/client/local-json-rpc-client.ts", import.meta.url).href;
}

function cliEntrypointPath(): string {
  const packagedEntrypoint = packagedCliEntrypointPath(electronResourcesPath());
  const candidates = [
    ...(packagedEntrypoint ? [packagedEntrypoint] : []),
    fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url)),
    fileURLToPath(new URL("../../../cli/dist/cli/src/index.js", import.meta.url))
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`Harness CLI entrypoint not found; checked ${candidates.join(", ")}`);
  return realpathSync(found);
}

export function packagedNodeExecutablePath(
  resourcesPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
): string | undefined {
  if (!resourcesPath) return undefined;
  return path.join(resourcesPath, "node", `${platform}-${arch}`, platform === "win32" ? "node.exe" : "node");
}

export function packagedCliEntrypointPath(resourcesPath: string | undefined): string | undefined {
  if (!resourcesPath) return undefined;
  const candidate = path.join(resourcesPath, "app/packages/cli/dist/cli/src/index.js");
  return existsSync(candidate) ? candidate : undefined;
}

function electronResourcesPath(): string | undefined {
  const resourcesPath = (process as NodeJS.Process & { readonly resourcesPath?: unknown }).resourcesPath;
  return typeof resourcesPath === "string" && resourcesPath.length > 0 ? resourcesPath : undefined;
}

export function resolveGuiDaemonIdleExitMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerOr(env.HARNESS_DAEMON_IDLE_MS, defaultDaemonIdleExitMs);
}

function daemonAutostartTimeoutMs(): number {
  return positiveIntegerOr(process.env.HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS, defaultDaemonAutostartTimeoutMs);
}

function daemonAutostartEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.ELECTRON_RUN_AS_NODE;
  return next;
}

function lookupNodeOnPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const command = platform === "win32" ? "where" : "which";
  const result = spawnSync(command, ["node"], {
    encoding: "utf8",
    env,
    windowsHide: true
  });
  if (result.status !== 0 || !result.stdout) return undefined;
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
}

function nonEmptyEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sameExecutable(left: string, right: string): boolean {
  return normalizeExecutablePath(left) === normalizeExecutablePath(right);
}

function normalizeExecutablePath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function positiveIntegerOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isLocalServiceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Maps a GUI API route to the daemon JSON-RPC method name.
 * Repo-scoped routes use `repo.<routeId>`; admin control routes use the
 * explicit `admin.*` surface (daemon.restart → admin.daemon.restart).
 */
export function jsonRpcMethodForGuiRoute(route: ApiRouteContract): string {
  if (route.commandClass === "admin" && route.id === "daemon.restart") {
    return "admin.daemon.restart";
  }
  if (route.commandClass === "admin") {
    return `admin.${route.id}`;
  }
  return `repo.${route.id}`;
}

/**
 * Builds JSON-RPC params for a GUI route.
 *
 * Repo routing: renderer may put `repoId` on the bridge payload to select a
 * registered daemon repo. That field is consumed here as `params.repo.repoId`
 * and stripped from the service payload so LocalController methods never see it.
 * When absent, falls back to the composition-root target (single-repo / env default).
 */
export function jsonRpcParamsForGuiRoute(
  route: ApiRouteContract,
  fallbackRepoId: string,
  payload: unknown
): JsonObject {
  if (route.commandClass === "admin") {
    // admin.daemon.restart takes { payload: DaemonControlRequestV1 } without repo.
    const adminPayload = isLocalServiceRecord(payload) ? (payload as JsonObject) : undefined;
    return adminPayload ? { payload: adminPayload } : {};
  }
  const { repoId, servicePayload } = extractRepoScopedPayload(payload, fallbackRepoId);
  return {
    repo: { repoId },
    ...(servicePayload ? { payload: servicePayload } : {})
  };
}

/** Pull optional renderer `repoId` out of the bridge payload for multi-repo routing. */
export function extractRepoScopedPayload(
  payload: unknown,
  fallbackRepoId: string
): { readonly repoId: string; readonly servicePayload: JsonObject | undefined } {
  if (!isLocalServiceRecord(payload)) {
    return { repoId: fallbackRepoId, servicePayload: undefined };
  }
  const record = { ...(payload as Record<string, JsonValue>) };
  const explicit = record.repoId;
  const repoId =
    typeof explicit === "string" && explicit.length > 0 ? explicit : fallbackRepoId;
  delete record.repoId;
  const servicePayload =
    Object.keys(record).length > 0 ? (record as JsonObject) : undefined;
  return { repoId, servicePayload };
}
