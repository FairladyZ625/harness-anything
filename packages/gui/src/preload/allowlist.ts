import { daemonGuiReadMethods, daemonGuiStreamFacets } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
export const HARNESS_PRELOAD_API = "harness";
export type PreloadApiMethod = (typeof daemonGuiReadMethods)[number]["guiBridgeMethod"] | (typeof daemonGuiStreamFacets)[number]["guiBridgeMethod"];
const daemonGuiFacets: ReadonlyArray<{ readonly guiBridgeMethod: PreloadApiMethod }> = [...daemonGuiReadMethods, ...daemonGuiStreamFacets];
export interface PreloadApiCapability {
  readonly method: PreloadApiMethod;
  readonly status: "shipped";
}
export const allowedPreloadApi = Object.freeze(Object.fromEntries(
  daemonGuiFacets.map(({ guiBridgeMethod }) => [guiBridgeMethod, guiBridgeMethod])
)) as { readonly [Method in PreloadApiMethod]: Method };
export const preloadApiCapabilities = Object.freeze(Object.fromEntries(
  daemonGuiFacets.map(({ guiBridgeMethod }) => [guiBridgeMethod, { method: guiBridgeMethod, status: "shipped" as const }])
)) as Record<PreloadApiMethod, PreloadApiCapability>;
export const preloadAllowlist = Object.freeze(Object.values(allowedPreloadApi)) as ReadonlyArray<PreloadApiMethod>;
export const shippedPreloadMethods = preloadAllowlist;
export function isAllowedPreloadApiMethod(method: string): method is PreloadApiMethod {
  return preloadAllowlist.includes(method as PreloadApiMethod);
}
export function getPreloadApiCapability(method: PreloadApiMethod): PreloadApiCapability {
  return preloadApiCapabilities[method];
}
export function assertPreloadPayload(method: string, payload: unknown): true {
  if (!isAllowedPreloadApiMethod(method)) throw new Error(`Preload method is not allowed: ${method}`);
  if (payload !== null && (typeof payload !== "object" || Array.isArray(payload))) {
    throw new Error("Preload payload must be an object or null.");
  }
  return true;
}
