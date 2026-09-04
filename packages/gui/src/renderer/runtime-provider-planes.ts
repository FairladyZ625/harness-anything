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
  readonly effortValues: readonly string[];
  readonly permissions: boolean;
}

const PLANES: Readonly<Record<RuntimeKindId, RuntimeProviderPlane>> = {
  agy: {
    // Product identifiers/defaults; not covered by the capability matrix.
    kindId: "agy",
    defaultProviderId: "google",
    // Matrix dimension 13 (C): subscription login only.
    authShape: "subscription-only",
    authModes: ["subscription"],
    // Product model-catalog constraint; unverified and not covered by matrix dimension 11.
    modelFamily: "gemini-only",
    // Matrix dimension 12: flag registration is E; these values remain H (unverified).
    effort: "enum",
    effortValues: ["low", "medium", "high"],
    // Matrix dimensions 5-6 (C/E): harness exposes no mapped permission control for agy.
    permissions: false,
  },
  claude: {
    // Product identifiers/defaults; not covered by the capability matrix.
    kindId: "claude",
    defaultProviderId: "anthropic",
    // Matrix dimension 13 (C): subscription login plus API-key override.
    authShape: "api-override",
    authModes: ["subscription", "api-key"],
    // Product model-catalog constraint; unverified and not covered by matrix dimension 11.
    modelFamily: "open",
    // Claude 2.1.260 实测接受 effort 且 launch 侧已在传，但提交链路在 preload/protocol/store 三处缺字段，
    // 见 task_ec4aa7c3fc0a66a574dba873ab；在那条修完之前这里保持 none，以免渲染一个存不下的输入框。
    effort: "none",
    effortValues: [],
    // Matrix dimensions 5-6 (C/E): harness maps permission and isolation controls.
    permissions: true,
  },
  codex: {
    // Product identifiers/defaults; not covered by the capability matrix.
    kindId: "codex",
    defaultProviderId: "openai",
    // Matrix dimension 13 (C): subscription and API-key instances are separate.
    authShape: "separate",
    authModes: ["subscription", "api-key"],
    // Product model-catalog constraint; unverified and not covered by matrix dimension 11.
    modelFamily: "codex-only",
    // Matrix dimension 12 (C): harness passes a free TOML effort value.
    effort: "free",
    effortValues: [],
    // Matrix dimensions 5-6 (C/E): harness maps permission and sandbox controls.
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
