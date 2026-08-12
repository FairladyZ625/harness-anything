import type { PreloadApiMethod } from "../preload/allowlist.ts";
import { apiRouteContracts, type ApiRouteContract } from "./api-contract-registry.ts";

export interface GuiServiceBridge { readonly invoke: (method: string, payload: unknown) => Promise<unknown>; }

type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;
type ShippedGuiRoute = ApiRouteContract & { readonly guiBridgeMethod: PreloadApiMethod; readonly rpcMethod: string };

export type GuiDaemonRequester = (route: ShippedGuiRoute, payload: unknown) => Promise<JsonObject>;

const shippedRoutes = apiRouteContracts.filter((route): route is ShippedGuiRoute =>
  typeof route.guiBridgeMethod === "string" && typeof route.rpcMethod === "string"
);
const routeByGuiMethod = new Map(shippedRoutes.map((route) => [route.guiBridgeMethod, route]));

export function getShippedGuiBridgeMethods(): ReadonlyArray<PreloadApiMethod> {
  return shippedRoutes.map((route) => route.guiBridgeMethod);
}

export function createGuiServiceBridgeForDaemon(request: GuiDaemonRequester): GuiServiceBridge {
  // The daemon-contract-backed requester owns all repository path validation and reads.
  return {
    invoke: async (method, payload) => {
      const route = routeByGuiMethod.get(method as PreloadApiMethod);
      if (!route) return failure("method_not_allowed", `Unsupported GUI service method: ${method}`);
      if (payload !== undefined && payload !== null && (typeof payload !== "object" || Array.isArray(payload))) {
        return failure("invalid_payload", "GUI read payload must be an object or null.");
      }
      return request(route, payload);
    }
  };
}

function failure(code: string, hint: string): JsonObject {
  return { ok: false, error: { code, hint } };
}
