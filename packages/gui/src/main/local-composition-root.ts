import path from "node:path";
import { daemonProtocolError, isDaemonGuiActionMethod, type DaemonGuiStreamPayloadMap } from "../../../daemon/src/protocol/daemon-protocol.contract.ts"; import { parseDaemonGuiActionResponse, parseDaemonGuiReadResponse } from "../../../daemon/src/protocol/gui-result-validation.ts";
import { validateProjectPath } from "../api/local-api.ts";
import { createGuiServiceBridgeForDaemon, type GuiServiceBridge, type ShippedGuiRoute } from "../api/service-bridge.ts";
import { streamDaemonFacetAt } from "./agent-runtime-stream-client.ts";
type JsonObject = { readonly [key: string]: JsonValue }; type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;
interface DaemonClient { readonly resolveLocalDaemonTarget: (input: { readonly rootDir: string; readonly repoIdOverride?: string }) => {
  readonly repoId: string; readonly socketPath: string; readonly canonicalRoot: string; readonly userRoot: string; readonly daemonId: string };
  readonly requestLocalDaemonJsonRpcForTarget: (target: ReturnType<DaemonClient["resolveLocalDaemonTarget"]>, method: string, params: JsonObject, timeoutMs?: number) => Promise<JsonObject> }
let client: Promise<DaemonClient> | undefined;
export function createLocalGuiServiceBridge(rootDir: string, _layoutOverrides?: { readonly authoredRoot?: string }): GuiServiceBridge {
  const root = path.resolve(rootDir); validateProjectPath(root, "."); return createGuiServiceBridgeForDaemon((route, payload) => request(root, route, payload), async (route, payload, emit) => { const daemon = await loadClient(), target = daemon.resolveLocalDaemonTarget({ rootDir: root, repoIdOverride: process.env.HARNESS_DAEMON_REPO_ID }); return streamDaemonFacetAt({ socketPath: target.socketPath, repoId: target.repoId, method: route.rpcMethod as keyof DaemonGuiStreamPayloadMap, payload: payload as DaemonGuiStreamPayloadMap[keyof DaemonGuiStreamPayloadMap], onValue: emit }); }); }
async function request(rootDir: string, route: ShippedGuiRoute, payload: unknown): Promise<JsonObject> { try {
  const daemon = await loadClient(), target = daemon.resolveLocalDaemonTarget({ rootDir, repoIdOverride: process.env.HARNESS_DAEMON_REPO_ID });
  const body: JsonObject = route.inputSchemaId === "gui.empty/v1" ? {} : { payload: (payload ?? {}) as JsonObject }, params: JsonObject = route.requiresRepo ? { repo: { repoId: target.repoId }, ...body } : body;
  const result = await daemon.requestLocalDaemonJsonRpcForTarget(target, route.rpcMethod, params, 200); return (isDaemonGuiActionMethod(route.rpcMethod) ? parseDaemonGuiActionResponse(route.rpcMethod, result) : parseDaemonGuiReadResponse(route.rpcMethod, result)) as unknown as JsonObject;
} catch (error) { return daemonProtocolError(route.rpcMethod, "daemon_unavailable", `Start the explicit daemon and retry. Cause: ${error instanceof Error ? error.message : String(error)}`) as unknown as JsonObject; } }
async function loadClient(): Promise<DaemonClient> { client ??= import("../../../daemon/src/client/local-json-rpc-client.ts") as Promise<DaemonClient>; return client; }
