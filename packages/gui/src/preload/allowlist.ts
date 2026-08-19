import { daemonGuiActionMethods, daemonGuiReadMethods, daemonGuiStreamFacets } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { containsSecretLikeKey } from "../api/entity-payload-hygiene.ts";
export const HARNESS_PRELOAD_API = "harness";
export const localMainPreloadMethods = ["listRuntimeInstances", "showRuntimeInstance", "createRuntimeInstance", "updateRuntimeInstance", "deleteRuntimeInstance", "validateRuntimeInstanceAuth", "signInRuntimeInstance", "reauthRuntimeInstance", "signOutRuntimeInstance"] as const;
export type PreloadApiMethod = (typeof daemonGuiReadMethods)[number]["guiBridgeMethod"] | (typeof daemonGuiActionMethods)[number]["guiBridgeMethod"] | (typeof daemonGuiStreamFacets)[number]["guiBridgeMethod"] | (typeof localMainPreloadMethods)[number];
const daemonGuiFacets: ReadonlyArray<{ readonly guiBridgeMethod: PreloadApiMethod }> = [...daemonGuiReadMethods, ...daemonGuiActionMethods, ...daemonGuiStreamFacets];
const localMainFacets: ReadonlyArray<{ readonly guiBridgeMethod: PreloadApiMethod }> = localMainPreloadMethods.map((guiBridgeMethod) => ({ guiBridgeMethod }));
type PreloadFacet = { readonly guiBridgeMethod: string; readonly requiresRepo?: boolean; readonly inputSchemaId: string };
export function deriveRepoScopedMethods(facets: readonly PreloadFacet[]): ReadonlySet<string> { return new Set(facets.filter(({ requiresRepo }) => requiresRepo).map(({ guiBridgeMethod }) => guiBridgeMethod)); }
export function deriveEmptyRepoMethods(facets: readonly PreloadFacet[]): ReadonlySet<string> { return new Set(facets.filter(({ requiresRepo, inputSchemaId }) => requiresRepo && inputSchemaId === "gui.empty/v1").map(({ guiBridgeMethod }) => guiBridgeMethod)); }
const repoScopedMethods: ReadonlySet<string> = deriveRepoScopedMethods([...daemonGuiReadMethods, ...daemonGuiActionMethods, ...daemonGuiStreamFacets]);
const emptyRepoMethods: ReadonlySet<string> = deriveEmptyRepoMethods([...daemonGuiReadMethods, ...daemonGuiActionMethods, ...daemonGuiStreamFacets]);
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
  if (containsSecretLikeKey(payload, method === "createRuntimeInstance")) throw new Error("Preload payload contains a forbidden secret-like key.");
  if (["signInRuntimeInstance", "reauthRuntimeInstance", "signOutRuntimeInstance"].includes(method)) { if (!isPreloadPayloadRecord(payload) || typeof payload.repoId !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(payload.repoId)) throw new Error(`Preload ${method} payload requires an exact repoId.`); return true; }
  if (repoScopedMethods.has(method as PreloadApiMethod)) {
    if (!isPreloadPayloadRecord(payload) || typeof payload.repoId !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(payload.repoId)) {
      throw new Error(`Preload ${method} payload requires an exact repoId.`);
    }
    if (emptyRepoMethods.has(method) && Object.keys(payload).some((key) => key !== "repoId")) throw new Error(`Preload ${method} fields are not allowed.`);
  } else if (isPreloadPayloadRecord(payload) && Object.hasOwn(payload, "repoId")) {
    throw new Error(`Preload ${method} payload: repoId is not allowed.`);
  }
  if (method === "getSystemStatus" && isPreloadPayloadRecord(payload) && Object.keys(payload).length > 0) throw new Error("Preload getSystemStatus fields are not allowed.");
  if (method === "listRuntimeInstances" && payload !== null && (!isPreloadPayloadRecord(payload) || Object.keys(payload).length > 0)) throw new Error("Runtime instance list fields are not allowed.");
  if (["showRuntimeInstance", "deleteRuntimeInstance", "validateRuntimeInstanceAuth"].includes(method) && !exactStrings(payload, ["instanceId"])) throw new Error(`Preload ${method} request is invalid.`);
  if (method === "updateRuntimeInstance" && (!isPreloadPayloadRecord(payload) || Object.keys(payload).length !== 2 || typeof payload.instanceId !== "string" || !payload.instanceId || typeof payload.enabled !== "boolean")) throw new Error("Preload updateRuntimeInstance request is invalid.");
  if (["signInRuntimeInstance", "reauthRuntimeInstance", "signOutRuntimeInstance"].includes(method) && !exactStrings(payload, ["repoId", "instanceId", "idempotencyKey"])) throw new Error(`Preload ${method} request is invalid.`);
  if (method === "createRuntimeInstance" && (!isPreloadPayloadRecord(payload) || !closed(payload, ["instanceId", "name", "kindId", "installationId", "providerId", "model", "claude", "codex", "authMode", "apiKey"]) || !["claude", "codex"].includes(String(payload.kindId)) || !["subscription", "api-key"].includes(String(payload.authMode)) || !["instanceId", "name", "kindId", "installationId", "providerId", "model", "authMode"].every((key) => typeof payload[key] === "string" && String(payload[key]).length > 0) || (String(payload.authMode) === "api-key" ? typeof payload.apiKey !== "string" || payload.apiKey.trim().length === 0 : payload.apiKey !== undefined) || !validRuntimeKindConfig(payload))) throw new Error("Runtime instance create request is invalid.");
  return true;
}
// The only secret the preload ever forwards is the top-level `apiKey` the user just
// typed into the create-instance form, and only for `createRuntimeInstance` in
// api-key mode; main stores it in the native vault and the daemon receives just an
// opaque reference. Every other secret-like key name — at any depth, on any
// method, including `apiKey` nested inside a kind config — stays rejected.
// (containsSecretLikeKey itself lives in api/entity-payload-hygiene.ts, shared with
// the renderer read clients so the credential vocabulary stays out of renderer source.)
function validRuntimeKindConfig(value: Record<string, unknown>): boolean { const field = value.kindId === "codex" ? "codex" : "claude", other = field === "codex" ? "claude" : "codex", config = value[field]; if (value[other] !== undefined || !isPreloadPayloadRecord(config)) return false; if (field === "claude") return closed(config, ["baseUrl"]) && (config.baseUrl === undefined || typeof config.baseUrl === "string"); return closed(config, ["reasoningEffort", "baseUrl", "wireApi", "requiresOpenAiAuth", "httpHeaders"]) && (config.reasoningEffort === undefined || typeof config.reasoningEffort === "string") && (config.baseUrl === undefined || typeof config.baseUrl === "string") && (config.wireApi === undefined || typeof config.wireApi === "string") && (config.requiresOpenAiAuth === undefined || typeof config.requiresOpenAiAuth === "boolean") && (config.httpHeaders === undefined || isPreloadPayloadRecord(config.httpHeaders) && Object.values(config.httpHeaders).every((item) => typeof item === "string")); }
function exactStrings(value: unknown, fields: readonly string[]): boolean { return isPreloadPayloadRecord(value) && Object.keys(value).length === fields.length && fields.every((field) => typeof value[field] === "string" && String(value[field]).length > 0); }
function closed(value: Record<string, unknown>, fields: readonly string[]): boolean { return Object.keys(value).every((key) => fields.includes(key)); }
function isPreloadPayloadRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
