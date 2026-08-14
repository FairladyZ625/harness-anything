import { daemonGuiActionMethods, daemonGuiReadMethods, daemonGuiStreamFacets } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
export const HARNESS_PRELOAD_API = "harness";
export type PreloadApiMethod = (typeof daemonGuiReadMethods)[number]["guiBridgeMethod"] | (typeof daemonGuiActionMethods)[number]["guiBridgeMethod"] | (typeof daemonGuiStreamFacets)[number]["guiBridgeMethod"] | "configureRuntimeCredential";
const daemonGuiFacets: ReadonlyArray<{ readonly guiBridgeMethod: PreloadApiMethod }> = [...daemonGuiReadMethods, ...daemonGuiActionMethods, ...daemonGuiStreamFacets];
const localMainFacets: ReadonlyArray<{ readonly guiBridgeMethod: PreloadApiMethod }> = [{ guiBridgeMethod: "configureRuntimeCredential" }];
export interface PreloadApiCapability {
  readonly method: PreloadApiMethod;
  readonly status: "shipped";
}
export const allowedPreloadApi = Object.freeze(Object.fromEntries(
  [...daemonGuiFacets, ...localMainFacets].map(({ guiBridgeMethod }) => [guiBridgeMethod, guiBridgeMethod])
)) as { readonly [Method in PreloadApiMethod]: Method };
export const preloadApiCapabilities = Object.freeze(Object.fromEntries(
  [...daemonGuiFacets, ...localMainFacets].map(({ guiBridgeMethod }) => [guiBridgeMethod, { method: guiBridgeMethod, status: "shipped" as const }])
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
  if (containsSecretLikeKey(payload)) throw new Error("Preload payload contains a forbidden secret-like key.");
  if (method === "configureRuntimeCredential" && (!record(payload) || Object.keys(payload).some((key) => !["kindId", "baseUrl"].includes(key)) || !["claude", "codex"].includes(String(payload.kindId)) || payload.baseUrl !== undefined && typeof payload.baseUrl !== "string")) throw new Error("Runtime credential request is invalid.");
  return true;
}
function containsSecretLikeKey(value: unknown): boolean { if (Array.isArray(value)) return value.some(containsSecretLikeKey); if (!record(value)) return false; return Object.entries(value).some(([key, nested]) => /(?:secret|token|password|passphrase)/iu.test(key) || /^(?:api[-_]?key|credentialvalue)$/iu.test(key) || containsSecretLikeKey(nested)); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
