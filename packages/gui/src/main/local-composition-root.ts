import path from "node:path";
import { daemonProtocolError, type DaemonGuiStreamPayloadMap } from "../../../daemon/src/protocol/daemon-protocol.contract.ts"; import { parseDaemonGuiReadResponse } from "../../../daemon/src/protocol/gui-result-validation.ts";
import { validateProjectPath } from "../api/local-api.ts";
import { createGuiServiceBridgeForDaemon, type GuiServiceBridge, type ShippedGuiRoute } from "../api/service-bridge.ts";
import { streamAgentRuntimeAt } from "./agent-runtime-stream-client.ts";
type JsonObject = { readonly [key: string]: JsonValue }; type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;
interface DaemonClient { readonly resolveLocalDaemonTarget: (input: { readonly rootDir: string; readonly repoIdOverride?: string }) => {
  readonly repoId: string; readonly socketPath: string; readonly canonicalRoot: string; readonly userRoot: string; readonly daemonId: string };
  readonly requestLocalDaemonJsonRpcForTarget: (target: ReturnType<DaemonClient["resolveLocalDaemonTarget"]>, method: string, params: JsonObject, timeoutMs?: number) => Promise<JsonObject> }
let client: Promise<DaemonClient> | undefined;
export function createLocalGuiServiceBridge(rootDir: string, _layoutOverrides?: { readonly authoredRoot?: string }): GuiServiceBridge {
  const root = path.resolve(rootDir); validateProjectPath(root, "."); return createGuiServiceBridgeForDaemon((route, payload) => request(root, route, payload), async (_route, payload, emit) => { const daemon = await loadClient(), target = daemon.resolveLocalDaemonTarget({ rootDir: root, repoIdOverride: process.env.HARNESS_DAEMON_REPO_ID }); return streamAgentRuntimeAt({ socketPath: target.socketPath, repoId: target.repoId, payload: payload as DaemonGuiStreamPayloadMap["repo.agentRuntime.attach"], onValue: emit }); }); }
async function request(rootDir: string, route: ShippedGuiRoute, payload: unknown): Promise<JsonObject> { try {
  const daemon = await loadClient(), target = daemon.resolveLocalDaemonTarget({ rootDir, repoIdOverride: process.env.HARNESS_DAEMON_REPO_ID });
  const params = { repo: { repoId: target.repoId }, ...(route.inputSchemaId === "gui.empty/v1" ? {} : { payload: (payload ?? {}) as JsonObject }) };
  return parseDaemonGuiReadResponse(route.rpcMethod, await daemon.requestLocalDaemonJsonRpcForTarget(target, route.rpcMethod, params, 200)) as unknown as JsonObject;
} catch (error) { return daemonProtocolError(route.rpcMethod, "daemon_unavailable", `Start the explicit daemon and retry. Cause: ${error instanceof Error ? error.message : String(error)}`) as unknown as JsonObject; } }
async function loadClient(): Promise<DaemonClient> { client ??= import("../../../daemon/src/client/local-json-rpc-client.ts") as Promise<DaemonClient>; return client; }
