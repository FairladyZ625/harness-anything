import path from "node:path";
import { validateProjectPath } from "../api/local-api.ts";
import { createGuiServiceBridgeForDaemon, type GuiServiceBridge } from "../api/service-bridge.ts";
import type { ApiRouteContract } from "../api/api-contract-registry.ts";
type JsonObject = { readonly [key: string]: JsonValue }; type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;
interface DaemonClient { readonly resolveLocalDaemonTarget: (input: { readonly rootDir: string; readonly repoIdOverride?: string }) => {
  readonly repoId: string; readonly socketPath: string; readonly canonicalRoot: string; readonly userRoot: string; readonly daemonId: string };
  readonly requestLocalDaemonJsonRpcForTarget: (target: ReturnType<DaemonClient["resolveLocalDaemonTarget"]>, method: string, params: JsonObject, timeoutMs?: number) => Promise<JsonObject> }
let client: Promise<DaemonClient> | undefined;
export function createLocalGuiServiceBridge(rootDir: string, _layoutOverrides?: { readonly authoredRoot?: string }): GuiServiceBridge {
  const root = path.resolve(rootDir); validateProjectPath(root, "."); return createGuiServiceBridgeForDaemon((route, payload) => request(root, route, payload)); }
async function request(rootDir: string, route: ApiRouteContract, _payload: unknown): Promise<JsonObject> { try {
  const daemon = await loadClient(), target = daemon.resolveLocalDaemonTarget({ rootDir, repoIdOverride: process.env.HARNESS_DAEMON_REPO_ID });
  return await daemon.requestLocalDaemonJsonRpcForTarget(target, route.rpcMethod ?? `repo.${route.id}`, { repo: { repoId: target.repoId } }, 200);
} catch (error) { return { ok: false, error: { code: "daemon_unavailable", hint: `Start the explicit daemon and retry. Cause: ${error instanceof Error ? error.message : String(error)}` } }; } }
async function loadClient(): Promise<DaemonClient> { client ??= import("../../../daemon/src/client/local-json-rpc-client.ts") as Promise<DaemonClient>; return client; }
