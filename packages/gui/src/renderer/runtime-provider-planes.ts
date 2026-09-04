import {
  runtimeKindForId,
  runtimeKindIds,
  type RuntimeAuthMode,
  type RuntimeKindId,
} from "../../../daemon/src/runtime-inventory.ts";
export type { RuntimeAuthMode, RuntimeKindId } from "../../../daemon/src/runtime-inventory.ts";

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
  readonly kindId: string;
  readonly defaultProviderId: string;
  /** subscription-only: no choice · api-override: one instance, optional API section · separate: an up-front two-way choice */
  readonly authShape: "subscription-only" | "api-override" | "separate";
  readonly authModes: readonly RuntimeAuthMode[];
  /** Models the user may type freely, or a fixed provider family they may only pick within. */
  readonly modelFamily: "open" | "codex-only" | "gemini-only";
  readonly effort: "none" | "free" | "enum";
  readonly effortValues: readonly string[];
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
    modelFamily: declaration.gui.modelFamily,
    effort: declaration.gui.effort,
    effortValues: declaration.gui.effortValues,
    permissions: declaration.permissions.available,
  };
};
export const planeAuthModes = (kindId: string): readonly RuntimeAuthMode[] => runtimeProviderPlane(kindId).authModes;
/** True only for the plane that carries both call paths inside a single instance. */
export const planeUsesApiOverride = (kindId: string): boolean =>
  runtimeProviderPlane(kindId).authShape === "api-override";
/** Base URL is an API-mode field: it exists only where the plane has an API mode, and only while that mode is on. */
export const planeAllowsBaseUrl = (kindId: string, authMode: RuntimeAuthMode): boolean =>
  authMode === "api-key" && runtimeProviderPlane(kindId).authModes.includes("api-key");
export const planeAllowsApiKey = (kindId: string, authMode: RuntimeAuthMode): boolean =>
  planeAllowsBaseUrl(kindId, authMode);
export const planeAllowsEffort = (kindId: string): boolean => runtimeProviderPlane(kindId).effort !== "none";
export const planeAllowsPermissions = (kindId: string): boolean => runtimeProviderPlane(kindId).permissions;
/** Rejects an auth mode the plane does not have, so a stale form value cannot survive a kind switch. */
export const planeAuthMode = (kindId: string, requested: RuntimeAuthMode): RuntimeAuthMode =>
  runtimeProviderPlane(kindId).authModes.includes(requested) ? requested : "subscription";
export const planeModelHint = (kindId: string): string => runtimeProviderPlane(kindId).modelFamily;
