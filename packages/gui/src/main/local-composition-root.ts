import path from "node:path";
import { daemonProtocolError, isDaemonGuiActionMethod, type DaemonGuiStreamPayloadMap } from "@harness-anything/daemon/protocol/daemon-protocol.contract"; import { parseDaemonGuiActionResponse, parseDaemonGuiReadResponse, parseDaemonGuiReadResult } from "@harness-anything/daemon/protocol/gui-result-validation";
import { ensureLocalDaemonRunning, isDaemonUnreachable } from "@harness-anything/daemon/client/daemon-autostart";
import { validateProjectPath } from "../api/local-api.ts";
import { createGuiServiceBridgeForDaemon, type GuiServiceBridge, type ShippedGuiRoute } from "../api/service-bridge.ts";
import { daemonServeLaunch, type PackagedRuntime } from "./daemon-serve-launch.ts";
import { streamDaemonFacetAt } from "./agent-runtime-stream-client.ts";
type JsonObject = { readonly [key: string]: JsonValue }; type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;
interface DaemonClient { readonly resolveLocalDaemonTarget: (input: { readonly rootDir: string; readonly repoIdOverride?: string }) => {
    readonly repoId: string; readonly socketPath: string; readonly canonicalRoot: string; readonly userRoot: string; readonly daemonId: string };
  readonly daemonUserRoot: () => string; readonly daemonIdFromEnv: () => string; readonly localUserDaemonEndpoint: (userRoot?: string, daemonId?: string) => string;
  readonly requestLocalDaemonJsonRpcForTarget: (target: { readonly socketPath: string }, method: string, params: JsonObject, timeoutMs?: number) => Promise<JsonObject> }
let client: Promise<DaemonClient> | undefined;
export function createLocalGuiServiceBridge(rootDir: string, _layoutOverrides?: { readonly authoredRoot?: string }, options: { readonly packaged?: PackagedRuntime } = {}): GuiServiceBridge {
  const root = path.resolve(rootDir); validateProjectPath(root, "."); return createGuiServiceBridgeForDaemon((route, payload) => request(root, route, payload, options.packaged), async (route, payload, emit) => {
    const daemon = await loadClient(), scoped = repoPayload(payload), target = daemon.resolveLocalDaemonTarget({ rootDir: root, repoIdOverride: scoped.repoId });
    return streamDaemonFacetAt({ socketPath: target.socketPath, repoId: target.repoId, method: route.rpcMethod as keyof DaemonGuiStreamPayloadMap, payload: scoped.payload as DaemonGuiStreamPayloadMap[keyof DaemonGuiStreamPayloadMap], onValue: emit });
  }); }
// Owner decision (autostart, plan A): when the daemon is unreachable the trusted
// main process starts it (bounded: two attempts), then retries the request once.
// Anything that is not a connection-level failure — an unregistered workspace, a
// protocol rejection — is reported as-is and never triggers a launch.
async function request(rootDir: string, route: ShippedGuiRoute, payload: unknown, packaged?: PackagedRuntime): Promise<JsonObject> { try {
  const daemon = await loadClient(), scoped = route.requiresRepo ? repoPayload(payload) : null;
  const target = scoped ? daemon.resolveLocalDaemonTarget({ rootDir, repoIdOverride: scoped.repoId }) : globalTarget(daemon);
  const daemonPayload = scoped?.payload ?? (payload ?? {}) as JsonObject;
  const body: JsonObject = route.inputSchemaId === "gui.empty/v1" ? {} : { payload: daemonPayload }, params: JsonObject = route.requiresRepo ? { repo: { repoId: scoped!.repoId }, ...body } : body;
  const parse = (result: JsonObject) => (isDaemonGuiActionMethod(route.rpcMethod) ? parseDaemonGuiActionResponse(route.rpcMethod, result) : route.rpcMethod === "daemon.gui.control.receipt" ? parseDaemonGuiReadResult(route.rpcMethod, result) : parseDaemonGuiReadResponse(route.rpcMethod, result)) as unknown as JsonObject;
  const invoke = () => daemon.requestLocalDaemonJsonRpcForTarget(target, route.rpcMethod, params, 200);
  try { return parse(await invoke()); }
  catch (connectError) {
    if (!isDaemonUnreachable(connectError)) throw connectError;
    const started = await ensureLocalDaemonRunning({ socketPath: target.socketPath, launch: () => daemonServeLaunch(target, packaged) });
    if (!started.ok) return daemonProtocolError(route.rpcMethod, started.code ?? "daemon_start_failed", started.hint) as unknown as JsonObject;
    return parse(await invoke());
  }
} catch (error) { return daemonProtocolError(route.rpcMethod, "daemon_unavailable", `Local daemon request failed. Cause: ${error instanceof Error ? error.message : String(error)}`) as unknown as JsonObject; } }
function repoPayload(value: unknown): { readonly repoId: string; readonly payload: JsonObject } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Repository GUI request requires repoId.");
  const { repoId, ...payload } = value as Record<string, JsonValue>;
  if (typeof repoId !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(repoId)) throw new Error("Repository GUI request has an invalid repoId.");
  return { repoId, payload };
}
function globalTarget(daemon: DaemonClient): { readonly socketPath: string; readonly userRoot: string; readonly daemonId: string } { const userRoot = daemon.daemonUserRoot(), daemonId = daemon.daemonIdFromEnv(); return { socketPath: daemon.localUserDaemonEndpoint(userRoot, daemonId), userRoot, daemonId }; }
async function loadClient(): Promise<DaemonClient> { client ??= import("@harness-anything/daemon/client/local-json-rpc-client") as Promise<DaemonClient>; return client; }
