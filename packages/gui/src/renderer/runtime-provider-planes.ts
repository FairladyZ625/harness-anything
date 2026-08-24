export type RuntimeKindId = "claude" | "codex" | "agy";
export type RuntimeAuthMode = "subscription" | "api-key";

// The three provider planes, as adjudicated 2026-08-20. The configuration surface is
// derived from this table so the form can never offer a combination the provider cannot
// actually run:
//   agy    — subscription login only; no API mode at all.
//   claude — one instance covers both: the subscription login is the default, and filling
//            the API override (base URL + model + key) switches the same instance to API,
//            which is how a third party such as GLM is adapted. No separate instance.
//   codex  — codex-family models only, and the two call paths are separate instances:
//            you pick subscription or API up front and the instance keeps that identity.
export interface RuntimeProviderPlane {
  readonly kindId: RuntimeKindId;
  readonly defaultProviderId: string;
  /** subscription-only: no choice · api-override: one instance, optional API section · separate: an up-front two-way choice */
  readonly authShape: "subscription-only" | "api-override" | "separate";
  readonly authModes: readonly RuntimeAuthMode[];
  /** Models the user may type freely, or a fixed provider family they may only pick within. */
  readonly modelFamily: "open" | "codex-only" | "gemini-only";
  readonly effort: "none" | "free" | "enum";
  readonly permissions: boolean;
}

const PLANES: Readonly<Record<RuntimeKindId, RuntimeProviderPlane>> = {
  agy: {
    kindId: "agy",
    defaultProviderId: "google",
    authShape: "subscription-only",
    authModes: ["subscription"],
    modelFamily: "gemini-only",
    effort: "enum",
    permissions: false,
  },
  claude: {
    kindId: "claude",
    defaultProviderId: "anthropic",
    authShape: "api-override",
    authModes: ["subscription", "api-key"],
    modelFamily: "open",
    effort: "none",
    permissions: true,
  },
  codex: {
    kindId: "codex",
    defaultProviderId: "openai",
    authShape: "separate",
    authModes: ["subscription", "api-key"],
    modelFamily: "codex-only",
    effort: "free",
    permissions: true,
  },
};

export const RUNTIME_KIND_IDS: readonly RuntimeKindId[] = ["claude", "codex", "agy"];
export const runtimeProviderPlane = (kindId: RuntimeKindId): RuntimeProviderPlane => PLANES[kindId];
export const planeAuthModes = (kindId: RuntimeKindId): readonly RuntimeAuthMode[] => PLANES[kindId].authModes;
/** True only for the plane that carries both call paths inside a single instance. */
export const planeUsesApiOverride = (kindId: RuntimeKindId): boolean => PLANES[kindId].authShape === "api-override";
/** Base URL is an API-mode field: it exists only where the plane has an API mode, and only while that mode is on. */
export const planeAllowsBaseUrl = (kindId: RuntimeKindId, authMode: RuntimeAuthMode): boolean =>
  authMode === "api-key" && PLANES[kindId].authModes.includes("api-key");
export const planeAllowsApiKey = (kindId: RuntimeKindId, authMode: RuntimeAuthMode): boolean =>
  planeAllowsBaseUrl(kindId, authMode);
export const planeAllowsEffort = (kindId: RuntimeKindId): boolean => PLANES[kindId].effort !== "none";
export const planeAllowsPermissions = (kindId: RuntimeKindId): boolean => PLANES[kindId].permissions;
/** Rejects an auth mode the plane does not have, so a stale form value cannot survive a kind switch. */
export const planeAuthMode = (kindId: RuntimeKindId, requested: RuntimeAuthMode): RuntimeAuthMode =>
  PLANES[kindId].authModes.includes(requested) ? requested : "subscription";
export const planeModelHint = (kindId: RuntimeKindId): string => PLANES[kindId].modelFamily;
