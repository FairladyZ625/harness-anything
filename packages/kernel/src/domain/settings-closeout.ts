import { isRecord } from "./write-chain.contract.ts";

export const closeoutProfiles = ["standard", "strict"] as const;
export type CloseoutProfile = (typeof closeoutProfiles)[number];
export const closeoutOverrideKeys = ["review", "consent", "fact", "factDisposition", "codeDoc"] as const;
export type CloseoutOverrideKey = (typeof closeoutOverrideKeys)[number];
/**
 * The override keys a repository settings facet may carry. `fact` is deliberately absent: Fact
 * production is not closeout ceremony a repository switches off — only a task-bound profile
 * declaration (the lightweight profile, frozen onto the task) lifts it, so baseline tasks keep
 * the requirement under every repository profile.
 */
export const settingsCloseoutOverrideKeys = ["review", "consent", "factDisposition", "codeDoc"] as const;
export type CloseoutOverridesV1 = Readonly<Partial<Record<CloseoutOverrideKey, boolean>>>;
export interface CloseoutSettingsV1 {
  readonly profile?: CloseoutProfile;
  readonly overrides?: CloseoutOverridesV1;
}
export type CloseoutGate = CloseoutOverrideKey;

export const DEFAULT_CLOSEOUT_SETTINGS: CloseoutSettingsV1 = Object.freeze({});

export function isValidCloseoutOverrides(value: unknown): value is CloseoutOverridesV1 {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, entry]) => (closeoutOverrideKeys as readonly string[]).includes(key) && typeof entry === "boolean",
    )
  );
}

/**
 * The one effective closeout gate set every submit/complete judgment shares: a task-bound
 * override (declared by the preset profile and frozen onto the task at creation) wins over the
 * repository profile and its overrides, which fill the rest. `codeDoc` additionally stays on
 * whenever the task's own completion gates declare code-doc reconciliation, and `fact` ignores
 * the repository baseline entirely — it is on unless the task's own declaration lifted it.
 */
export function effectiveCloseoutGates(
  closeout: CloseoutSettingsV1,
  taskGateIds: readonly string[] = [],
  taskOverrides?: CloseoutOverridesV1,
  domainDefaults: CloseoutOverridesV1 = {},
): Readonly<Record<CloseoutGate, boolean>> {
  const gate = (key: CloseoutOverrideKey) =>
    taskOverrides?.[key] ??
    closeout.overrides?.[key] ??
    (closeout.profile === undefined ? (domainDefaults[key] ?? false) : closeout.profile === "strict");
  return Object.freeze({
    review: gate("review"),
    consent: gate("consent"),
    fact: taskOverrides?.fact ?? true,
    factDisposition: gate("factDisposition"),
    codeDoc: gate("codeDoc") || taskGateIds.includes("code-doc-reconciliation"),
  });
}

export function isValidCloseoutGateRecord(value: unknown): value is Readonly<Record<CloseoutGate, boolean>> {
  return (
    typeof value === "object" &&
    value !== null &&
    closeoutOverrideKeys.every((key) => {
      const gate = (value as Record<CloseoutGate, unknown>)[key];
      return typeof gate === "boolean";
    })
  );
}
