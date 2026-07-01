import { apiRouteContracts, deferredGuiBridgeContracts } from "../api/api-contract-registry.ts";

export const HARNESS_PRELOAD_API = "harness";

type ShippedPreloadApiMethod = Extract<(typeof apiRouteContracts)[number], { readonly guiBridgeMethod: string }>["guiBridgeMethod"];
type DeferredPreloadApiMethod = (typeof deferredGuiBridgeContracts)[number]["guiBridgeMethod"];
export type PreloadApiMethod = ShippedPreloadApiMethod | DeferredPreloadApiMethod;
export type PreloadApiCapabilityStatus = "shipped" | "deferred";

export interface PreloadApiCapability {
  readonly method: PreloadApiMethod;
  readonly status: PreloadApiCapabilityStatus;
  readonly reason?: string;
}

const shippedGuiBridgeRoutes = apiRouteContracts.filter((route): route is Extract<(typeof apiRouteContracts)[number], { readonly guiBridgeMethod: string }> => (
  "guiBridgeMethod" in route && typeof route.guiBridgeMethod === "string"
));

export const shippedPreloadMethods = Object.freeze(
  shippedGuiBridgeRoutes.map((route) => route.guiBridgeMethod)
) as ReadonlyArray<ShippedPreloadApiMethod>;

export const deferredPreloadMethods = Object.freeze(
  deferredGuiBridgeContracts.map((contract) => contract.guiBridgeMethod)
) as ReadonlyArray<DeferredPreloadApiMethod>;

export const preloadAllowlist = Object.freeze([
  ...shippedPreloadMethods,
  ...deferredPreloadMethods
]) as ReadonlyArray<PreloadApiMethod>;

export const allowedPreloadApi = Object.freeze(Object.fromEntries(
  preloadAllowlist.map((method) => [method, method] as const)
)) as { readonly [Method in PreloadApiMethod]: Method };

export const preloadApiCapabilities = Object.freeze(Object.fromEntries([
  ...shippedPreloadMethods.map((method) => [method, { method, status: "shipped" }] as const),
  ...deferredGuiBridgeContracts.map((contract) => [
    contract.guiBridgeMethod,
    { method: contract.guiBridgeMethod, status: "deferred", reason: contract.reason }
  ] as const)
])) as Record<PreloadApiMethod, PreloadApiCapability>;

export function isAllowedPreloadApiMethod(method: string): method is PreloadApiMethod {
  return preloadAllowlist.includes(method as PreloadApiMethod);
}

export function getPreloadApiCapability(method: PreloadApiMethod): PreloadApiCapability {
  return preloadApiCapabilities[method];
}

export function assertPreloadPayload(method: string, payload: unknown): true {
  if (!isAllowedPreloadApiMethod(method)) {
    throw new Error(`Preload method is not allowed: ${method}`);
  }
  if (payload !== null && (typeof payload !== "object" || Array.isArray(payload))) {
    throw new Error("Preload payload must be an object or null.");
  }
  return true;
}
