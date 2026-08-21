import { daemonGuiActionMethods, daemonGuiReadMethods, daemonGuiStreamFacets } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { containsSecretLikeKey } from "../api/entity-payload-hygiene.ts";
export const HARNESS_PRELOAD_API = "harness";
export const localMainPreloadMethods = ["listRuntimeInstances", "showRuntimeInstance", "createRuntimeInstance", "updateRuntimeInstance", "deleteRuntimeInstance", "validateRuntimeInstanceAuth", "signInRuntimeInstance", "reauthRuntimeInstance", "signOutRuntimeInstance"] as const;
export type PreloadApiMethod = (typeof daemonGuiReadMethods)[number]["guiBridgeMethod"] | (typeof daemonGuiActionMethods)[number]["guiBridgeMethod"] | (typeof daemonGuiStreamFacets)[number]["guiBridgeMethod"] | (typeof localMainPreloadMethods)[number];
const daemonGuiFacets: ReadonlyArray<{ readonly guiBridgeMethod: PreloadApiMethod }> = [...daemonGuiReadMethods, ...daemonGuiActionMethods, ...daemonGuiStreamFacets];
const localMainFacets: ReadonlyArray<{ readonly guiBridgeMethod: PreloadApiMethod }> = localMainPreloadMethods.map((guiBridgeMethod) => ({ guiBridgeMethod }));
const runtimeInstanceCreateFields = ["instanceId", "name", "kindId", "installationId", "providerId", "models", "defaultModel", "permissionMode", "isolationState", "claude", "codex", "agy", "authMode", "apiKey"] as const;
type PreloadFacet = { readonly guiBridgeMethod: string; readonly requiresRepo?: boolean; readonly inputSchemaId: string };
export function deriveRepoScopedMethods(facets: readonly PreloadFacet[]): ReadonlySet<string> { return new Set(facets.filter(({ requiresRepo }) => requiresRepo).map(({ guiBridgeMethod }) => guiBridgeMethod)); }
export function deriveEmptyRepoMethods(facets: readonly PreloadFacet[]): ReadonlySet<string> { return new Set(facets.filter(({ requiresRepo, inputSchemaId }) => requiresRepo && inputSchemaId === "gui.empty/v1").map(({ guiBridgeMethod }) => guiBridgeMethod)); }
export function deriveQueryRepoMethods(facets: readonly PreloadFacet[]): ReadonlySet<string> { return new Set(facets.filter(({ requiresRepo, inputSchemaId }) => requiresRepo && (inputSchemaId === "gui.task-query/v1" || inputSchemaId === "gui.relation-query/v1" || inputSchemaId === "gui.agenda-query/v1")).map(({ guiBridgeMethod }) => guiBridgeMethod)); }
const repoScopedMethods: ReadonlySet<string> = deriveRepoScopedMethods([...daemonGuiReadMethods, ...daemonGuiActionMethods, ...daemonGuiStreamFacets]);
const emptyRepoMethods: ReadonlySet<string> = deriveEmptyRepoMethods([...daemonGuiReadMethods, ...daemonGuiActionMethods, ...daemonGuiStreamFacets]);
const queryRepoMethods: ReadonlySet<string> = deriveQueryRepoMethods([...daemonGuiReadMethods, ...daemonGuiActionMethods, ...daemonGuiStreamFacets]);
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
    if (queryRepoMethods.has(method as PreloadApiMethod)) {
      if (!closed(payload, method === "getAgenda" ? ["repoId", "limit", "cursor"] : ["repoId", "status", "updatedAfter", "updatedBefore", "limit", "cursor"])) throw new Error(`Preload ${method} fields are not allowed.`);
      if (!validQueryPayload(method, payload)) throw new Error(`Preload ${method} query facets are invalid.`);
    }
    if (method === "getTaskDispatches" && !validTaskDispatchesPayload(payload)) throw new Error("Preload getTaskDispatches request is invalid.");
  } else if (isPreloadPayloadRecord(payload) && Object.hasOwn(payload, "repoId")) {
    throw new Error(`Preload ${method} payload: repoId is not allowed.`);
  }
  if (method === "getSystemStatus" && isPreloadPayloadRecord(payload) && Object.keys(payload).length > 0) throw new Error("Preload getSystemStatus fields are not allowed.");
  if (method === "listRuntimeInstances" && payload !== null && (!isPreloadPayloadRecord(payload) || Object.keys(payload).length > 0)) throw new Error("Runtime instance list fields are not allowed.");
  if (["showRuntimeInstance", "deleteRuntimeInstance", "validateRuntimeInstanceAuth"].includes(method) && !exactStrings(payload, ["instanceId"])) throw new Error(`Preload ${method} request is invalid.`);
  if (method === "updateRuntimeInstance" && !validRuntimeInstanceUpdate(payload)) throw new Error("Preload updateRuntimeInstance request is invalid.");
  if (["signInRuntimeInstance", "reauthRuntimeInstance", "signOutRuntimeInstance"].includes(method) && !exactStrings(payload, ["repoId", "instanceId", "idempotencyKey"])) throw new Error(`Preload ${method} request is invalid.`);
  if (method === "createRuntimeInstance") {
    const problem = runtimeInstanceCreateProblem(payload);
    if (problem !== undefined) throw new Error(`Runtime instance create request is invalid: ${problem}`);
  }
  return true;
}
// The only secret the preload ever forwards is the top-level `apiKey` the user just
// typed into the create-instance form, and only for `createRuntimeInstance` in
// api-key mode; main stores it in the native vault and the daemon receives just an
// opaque reference. Every other secret-like key name — at any depth, on any
// method, including `apiKey` nested inside a kind config — stays rejected.
// (containsSecretLikeKey itself lives in api/entity-payload-hygiene.ts, shared with
// the renderer read clients so the credential vocabulary stays out of renderer source.)
function runtimeInstanceCreateProblem(value: unknown): string | undefined {
  if (!isPreloadPayloadRecord(value)) return 'field "payload" must be an object.';
  if (!closed(value, runtimeInstanceCreateFields)) { const field = Object.keys(value).find((key) => !runtimeInstanceCreateFields.some((allowed) => allowed === key)); return `unexpected field "${field}"; expected only ${runtimeInstanceCreateFields.join(", ")}.`; }
  for (const field of ["instanceId", "name", "installationId", "providerId"]) if (typeof value[field] !== "string" || value[field].trim().length === 0) return `field "${field}" must be a non-blank string.`;
  if (!["claude", "codex", "agy"].includes(String(value.kindId))) return 'field "kindId" must be claude, codex, or agy.';
  if (!Array.isArray(value.models) || value.models.length === 0 || value.models.some((model) => typeof model !== "string" || model.trim().length === 0) || new Set(value.models).size !== value.models.length) return 'field "models" must be a non-empty array of non-blank strings with no duplicates.';
  if (value.defaultModel !== undefined && (typeof value.defaultModel !== "string" || !value.models.includes(value.defaultModel))) return 'field "defaultModel" must be one of the listed models.';
  if (!["subscription", "api-key"].includes(String(value.authMode))) return 'field "authMode" must be subscription or api-key.';
  if (value.kindId === "agy" && value.authMode !== "subscription") return 'field "authMode" must be subscription for agy.';
  if (value.permissionMode !== undefined && !["bypass", "workspace-write", "read-only"].includes(String(value.permissionMode))) return 'field "permissionMode" must be bypass, workspace-write, or read-only.';
  if (value.kindId === "agy" && value.permissionMode !== undefined) return 'field "permissionMode" must be omitted for agy.';
  if (value.isolationState !== undefined && !["enforced", "operator-environment"].includes(String(value.isolationState))) return 'field "isolationState" must be enforced or operator-environment.';
  if (value.kindId === "agy" && value.isolationState !== undefined && value.isolationState !== "operator-environment") return 'field "isolationState" must be operator-environment for agy.';
  if (value.kindId === "codex" && value.authMode === "api-key" && value.isolationState === "operator-environment") return 'field "isolationState" must be enforced for codex API-key auth.';
  if (value.authMode === "api-key" && (typeof value.apiKey !== "string" || value.apiKey.trim().length === 0)) return 'field "apiKey" must be a non-blank string for api-key auth.';
  if (value.authMode === "subscription" && value.apiKey !== undefined) return 'field "apiKey" must be omitted for subscription auth.';
  return runtimeKindConfigProblem(value);
}
function runtimeKindConfigProblem(value: Record<string, unknown>): string | undefined {
  const field = value.kindId === "codex" ? "codex" : value.kindId === "agy" ? "agy" : "claude", other = ["claude", "codex", "agy"].filter((item) => item !== field), config = value[field];
  const wrongKind = other.find((key) => value[key] !== undefined); if (wrongKind !== undefined) return `field "${wrongKind}" must be omitted when kindId is ${field}.`;
  if (!isPreloadPayloadRecord(config)) return `field "${field}" must be an object.`;
  const fields = field === "claude" ? ["baseUrl"] : field === "agy" ? ["effort"] : ["reasoningEffort", "baseUrl", "wireApi", "requiresOpenAiAuth", "httpHeaders"];
  if (!closed(config, fields)) { const nested = Object.keys(config).find((key) => !fields.includes(key)); return `unexpected field "${field}.${nested}"; expected only ${fields.join(", ")}.`; }
  if (field === "claude") return config.baseUrl === undefined || typeof config.baseUrl === "string" ? undefined : 'field "claude.baseUrl" must be a string.';
  if (field === "agy") return config.effort === undefined || ["low", "medium", "high"].includes(String(config.effort)) ? undefined : 'field "agy.effort" must be low, medium, or high.';
  if (config.reasoningEffort !== undefined && typeof config.reasoningEffort !== "string") return 'field "codex.reasoningEffort" must be a string.';
  if (config.baseUrl !== undefined && typeof config.baseUrl !== "string") return 'field "codex.baseUrl" must be a string.';
  if (config.wireApi !== undefined && typeof config.wireApi !== "string") return 'field "codex.wireApi" must be a string.';
  if (config.requiresOpenAiAuth !== undefined && typeof config.requiresOpenAiAuth !== "boolean") return 'field "codex.requiresOpenAiAuth" must be a boolean.';
  if (config.httpHeaders !== undefined && (!isPreloadPayloadRecord(config.httpHeaders) || Object.values(config.httpHeaders).some((item) => typeof item !== "string"))) return 'field "codex.httpHeaders" must be an object with string values.';
  return undefined;
}
function validRuntimeInstanceUpdate(value: unknown): boolean { return isPreloadPayloadRecord(value) && closed(value, ["instanceId", "enabled", "permissionMode", "isolationState"]) && typeof value.instanceId === "string" && value.instanceId.length > 0 && [value.enabled, value.permissionMode, value.isolationState].some((field) => field !== undefined) && (value.enabled === undefined || typeof value.enabled === "boolean") && (value.permissionMode === undefined || ["bypass", "workspace-write", "read-only"].includes(String(value.permissionMode))) && (value.isolationState === undefined || ["enforced", "operator-environment"].includes(String(value.isolationState))); }
function exactStrings(value: unknown, fields: readonly string[]): boolean { return isPreloadPayloadRecord(value) && Object.keys(value).length === fields.length && fields.every((field) => typeof value[field] === "string" && String(value[field]).length > 0); }
function closed(value: Record<string, unknown>, fields: readonly string[]): boolean { return Object.keys(value).every((key) => fields.includes(key)); }
// The wide task reads accept exactly the optional narrow/paged facets the daemon
// validates; unknown keys were already rejected above, so this constrains the values.
function validQueryPayload(method: string, value: Record<string, unknown>): boolean { const after = value.updatedAfter, before = value.updatedBefore, states = method === "getTasks" ? ["planned", "active", "blocked", "in_review", "done", "cancelled"] : ["active", "edge_retired", "deleted"], common = (value.limit === undefined || Number.isSafeInteger(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 500) && (value.cursor === undefined || typeof value.cursor === "string" && value.cursor.length > 0); return method === "getAgenda" ? common : common && (value.status === undefined || typeof value.status === "string" && states.includes(value.status)) && [after, before].every((item) => item === undefined || typeof item === "string" && Number.isFinite(Date.parse(item))) && !(typeof after === "string" && typeof before === "string" && after > before); }
function validTaskDispatchesPayload(value: Record<string, unknown>): boolean { if (!closed(value, ["repoId", "taskId", "taskIds", "limit", "cursor"])) return false; const single = typeof value.taskId === "string" && value.taskId.length > 0 && value.taskIds === undefined && value.limit === undefined && value.cursor === undefined, taskIds = value.taskIds; return single || value.taskId === undefined && Array.isArray(taskIds) && taskIds.length > 0 && taskIds.length <= 500 && taskIds.every((taskId) => typeof taskId === "string" && taskId.length > 0) && new Set(taskIds).size === taskIds.length && (value.limit === undefined || Number.isSafeInteger(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 500) && (value.cursor === undefined || typeof value.cursor === "string" && value.cursor.length > 0); }
function isPreloadPayloadRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
