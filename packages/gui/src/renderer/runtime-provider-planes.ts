import {
  runtimeKindForId,
  runtimeKindIds,
  type RuntimeAuthMode,
  type RuntimeEndpointAvailability,
  type RuntimeKindId,
} from "@harness-anything/daemon/protocol";
export type { RuntimeAuthMode, RuntimeKindId } from "@harness-anything/daemon/protocol";

// Provider call paths and controls are derived from the daemon's runtime declaration:
//   agy    — subscription login only; no API mode at all.
//   claude — one instance covers both: the subscription login is the default, and filling
//            the API override (base URL + model + key) switches the same instance to API,
//            which is how a third party such as GLM is adapted. No separate instance.
//   codex  — codex-family models only, and the two call paths are separate instances:
//            you pick subscription or API up front and the instance keeps that identity.
export interface RuntimeProviderPlane {
  readonly kindId: string;
  readonly defaultProviderId: string;
  /** subscription-only: no choice · api-override: one instance, optional API section · separate: an up-front two-way choice */
  readonly authShape: "subscription-only" | "api-override" | "separate";
  readonly authModes: readonly RuntimeAuthMode[];
  readonly apiKeyIsolation?: "enforced";
  readonly subscriptionIsolation?: "operator-environment";
  /** Models the user may type freely, or a fixed provider family they may only pick within. */
  readonly modelFamily: "open" | "codex-only" | "gemini-only";
  readonly effort: "none" | "free" | "enum";
  readonly effortValues: readonly string[];
  readonly wireApiValues?: readonly string[];
  readonly permissions: boolean;
}

export const RUNTIME_KIND_IDS: readonly RuntimeKindId[] = runtimeKindIds;
export const runtimeProviderPlane = (kindId: string): RuntimeProviderPlane => {
  const declaration = runtimeKindForId(kindId);
  return {
    kindId,
    defaultProviderId: declaration.defaultProviderId,
    authShape: declaration.auth.shape,
    authModes: declaration.auth.modes,
    ...("apiKeyIsolation" in declaration.auth ? { apiKeyIsolation: declaration.auth.apiKeyIsolation } : {}),
    ...("subscriptionIsolation" in declaration.auth
      ? { subscriptionIsolation: declaration.auth.subscriptionIsolation }
      : {}),
    modelFamily: declaration.gui.modelFamily,
    effort: declaration.gui.effort,
    effortValues: declaration.gui.effortValues,
    wireApiValues: "choices" in declaration.configuration ? declaration.configuration.choices?.wireApi : undefined,
    permissions: declaration.permissions.available,
  };
};
export const planeAuthModes = (kindId: string): readonly RuntimeAuthMode[] => runtimeProviderPlane(kindId).authModes;
/** True only for the plane that carries both call paths inside a single instance. */
export const planeUsesApiOverride = (kindId: string): boolean =>
  runtimeProviderPlane(kindId).authShape === "api-override";
/** The endpoint availability the catalog declares for this kind ("none" | "optional" | "required"). */
export const planeBaseUrlEndpoint = (kindId: string): RuntimeEndpointAvailability =>
  runtimeKindForId(kindId).auth.endpoints.baseUrl;
/** The endpoint availability in effect under an auth mode: the field exists only while
 * the API call path is on. Endpoint configurability is a catalog declaration, not an
 * auth.modes derivation — an API-key call path can use provider config rather than an
 * ACP authenticate handshake. */
export const baseUrlAvailability = (
  endpoint: RuntimeEndpointAvailability,
  authMode: RuntimeAuthMode,
): RuntimeEndpointAvailability => (authMode === "api-key" ? endpoint : "none");
export const planeAllowsBaseUrl = (kindId: string, authMode: RuntimeAuthMode): boolean =>
  baseUrlAvailability(planeBaseUrlEndpoint(kindId), authMode) !== "none";
/** A "required" endpoint declaration means the API call path has no built-in default to
 * fall back to, so the form cannot submit an empty base URL. */
export const planeRequiresBaseUrl = (kindId: string, authMode: RuntimeAuthMode): boolean =>
  baseUrlAvailability(planeBaseUrlEndpoint(kindId), authMode) === "required";
/** The API key field follows auth modes even when a provider has no endpoint override. */
export const planeAllowsApiKey = (kindId: string, authMode: RuntimeAuthMode): boolean =>
  authMode === "api-key" && runtimeProviderPlane(kindId).authModes.includes("api-key");
export const planeAllowsEffort = (kindId: string): boolean => runtimeProviderPlane(kindId).effort !== "none";
export const planeAllowsPermissions = (kindId: string): boolean => runtimeProviderPlane(kindId).permissions;
/** True when the kind declares a real isolation choice (more than one state); a
 * single-state declaration has nothing to pick and the field is not offered. */
export const planeAllowsIsolation = (kindId: string): boolean => runtimeKindForId(kindId).isolation.states.length > 1;
/** Rejects an auth mode the plane does not have, so a stale form value cannot survive a kind switch. */
export const planeAuthMode = (kindId: string, requested: RuntimeAuthMode): RuntimeAuthMode => {
  const modes = runtimeProviderPlane(kindId).authModes;
  return modes.includes(requested) ? requested : (modes[0] ?? "subscription");
};
export const planeModelHint = (kindId: string): string => runtimeProviderPlane(kindId).modelFamily;
