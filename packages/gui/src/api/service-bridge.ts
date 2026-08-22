import type { PreloadApiMethod } from "../preload/allowlist.ts";
import { apiRouteContracts, type ApiRouteContract } from "./api-contract-registry.ts";
import type { DaemonGuiActionMethod, DaemonGuiRpcReadMethod } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
export interface GuiServiceBridge { readonly invoke: (method: string, payload: unknown) => Promise<unknown>; readonly stream: (method: string, payload: unknown, emit: (value: unknown) => void) => Promise<() => void>; }
type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;
export type ShippedGuiRoute = ApiRouteContract & { readonly guiBridgeMethod: PreloadApiMethod; readonly rpcMethod: DaemonGuiRpcReadMethod | DaemonGuiActionMethod };
export type GuiDaemonRequester = (route: ShippedGuiRoute, payload: unknown) => Promise<JsonObject>;
export type GuiDaemonStreamer = (route: ApiRouteContract, payload: unknown, emit: (value: unknown) => void) => Promise<() => void>;
const shippedRoutes = apiRouteContracts.filter((route): route is ShippedGuiRoute =>
  route.method !== "STREAM" && typeof route.guiBridgeMethod === "string" && typeof route.rpcMethod === "string"
);
const routeByGuiMethod = new Map(shippedRoutes.map((route) => [route.guiBridgeMethod, route]));
const streamRouteByGuiMethod = new Map(apiRouteContracts.filter((route) => route.method === "STREAM" && route.guiBridgeMethod).map((route) => [route.guiBridgeMethod!, route]));
export function getShippedGuiBridgeMethods(): ReadonlyArray<PreloadApiMethod> {
  return shippedRoutes.map((route) => route.guiBridgeMethod);
}
export function createGuiServiceBridgeForDaemon(request: GuiDaemonRequester, stream: GuiDaemonStreamer): GuiServiceBridge {
  // The daemon-contract-backed requester owns all repository path validation and reads.
  return {
    invoke: async (method, payload) => {
      const route = routeByGuiMethod.get(method as PreloadApiMethod);
      if (!route) return failure("method_not_allowed", `Unsupported GUI service method: ${method}`);
      if (payload !== undefined && payload !== null && (typeof payload !== "object" || Array.isArray(payload))) {
        return failure("invalid_payload", "GUI read payload must be an object or null.");
      }
      return request(route, payload);
    }, stream: async (method, payload, emit) => { const route = streamRouteByGuiMethod.get(method); if (!route) throw new Error(`Unsupported GUI stream method: ${method}`); return stream(route, payload, emit); }
  };
}
function failure(code: string, hint: string): JsonObject {
  return { ok: false, error: { code, hint } };
}
