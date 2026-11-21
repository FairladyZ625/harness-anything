import { timestamp } from "./timestamp.ts";
import { hasOnlyFields, isNonEmptyString, isRecord } from "./contract-validation.ts";

export const runtimeQuotaWindowKinds = Object.freeze(["session", "weekly", "monthly", "bucket"] as const);
export type RuntimeQuotaWindowKind = (typeof runtimeQuotaWindowKinds)[number];

export const runtimeQuotaWindowScopes = Object.freeze(["primary", "auxiliary"] as const);
export type RuntimeQuotaWindowScope = (typeof runtimeQuotaWindowScopes)[number];

export interface RuntimeQuotaWindowV1 {
  readonly id: string;
  readonly label: string;
  readonly kind: RuntimeQuotaWindowKind;
  readonly scope?: RuntimeQuotaWindowScope;
  readonly models?: readonly string[];
  readonly remainingFraction: number;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
}

export interface RuntimeQuotaCreditsV1 {
  readonly remaining: number | null;
  readonly limit: number | null;
  readonly unlimited: boolean;
}

export interface RuntimeSubscriptionQuotaV1 {
  readonly schemaVersion: 1;
  readonly observedAt: string;
  readonly source: string;
  readonly plan: string | null;
  readonly windows: readonly RuntimeQuotaWindowV1[];
  readonly credits?: RuntimeQuotaCreditsV1;
}

export const runtimeSubscriptionQuotaSchema = Object.freeze({
  type: "object" as const,
  additionalProperties: false as const,
  required: ["schemaVersion", "observedAt", "source", "plan", "windows"] as const,
  properties: {
    schemaVersion: { type: "integer" as const, const: 1, description: "Subscription quota snapshot schema version." },
    observedAt: {
      type: "string" as const,
      description: "ISO-8601 UTC timestamp when this quota snapshot was observed.",
    },
    source: {
      type: "string" as const,
      minLength: 1,
      description: "Read-only probe transport that produced this snapshot.",
    },
    plan: {
      type: "string" as const,
      "x-nullable": true,
      description: "Observed subscription tier or plan label, if reported.",
    },
    windows: {
      type: "array" as const,
      items: {
        type: "object" as const,
        additionalProperties: false as const,
        required: ["id", "label", "kind", "remainingFraction", "usedPercent", "resetsAt"] as const,
        properties: {
          id: { type: "string" as const, minLength: 1, description: "Stable window identifier." },
          label: { type: "string" as const, minLength: 1, description: "Operator-facing window label." },
          kind: { type: "string" as const, enum: runtimeQuotaWindowKinds, description: "Window classification." },
          scope: {
            type: "string" as const,
            enum: runtimeQuotaWindowScopes,
            description: "Whether exhaustion of this window blocks general account dispatch (primary) or is auxiliary.",
          },
          models: {
            type: "array" as const,
            items: { type: "string" as const, minLength: 1 },
            description: "Optional provider-declared model ids governed by this bucket.",
          },
          remainingFraction: {
            type: "number" as const,
            minimum: 0,
            maximum: 1,
            description: "Unrounded remaining fraction in [0, 1].",
          },
          usedPercent: {
            type: "number" as const,
            minimum: 0,
            maximum: 100,
            description: "Used percentage in [0, 100].",
          },
          resetsAt: {
            type: "string" as const,
            "x-nullable": true,
            description: "ISO-8601 UTC reset time, or null when not reported.",
          },
        },
      },
      description: "Observed quota windows and model-group buckets.",
    },
    credits: {
      type: "object" as const,
      additionalProperties: false as const,
      required: ["remaining", "limit", "unlimited"] as const,
      properties: {
        remaining: {
          type: "number" as const,
          "x-nullable": true,
          description: "Remaining credit balance, if reported.",
        },
        limit: { type: "number" as const, "x-nullable": true, description: "Credit limit, if reported." },
        unlimited: { type: "boolean" as const, description: "Whether credits are unlimited." },
      },
      description: "Optional credit/extra-usage balance.",
    },
  },
  description: "Node-local observed subscription quota snapshot.",
});

const windowRequiredFields = ["id", "label", "kind", "remainingFraction", "usedPercent", "resetsAt"] as const;
const windowOptionalFields = ["scope", "models"] as const;
const creditsFields = ["remaining", "limit", "unlimited"] as const;
const quotaRequiredFields = ["schemaVersion", "observedAt", "source", "plan", "windows"] as const;
const quotaAllFields = [...quotaRequiredFields, "credits"] as const;
const controlCharPattern = /[\u0000-\u001F\u007F-\u009F]/u;

function isBoundedSafeText(value: unknown, maxLength: number): value is string {
  return isNonEmptyString(value) && value.length <= maxLength && !controlCharPattern.test(value);
}

export function validRuntimeSubscriptionQuota(value: unknown): value is RuntimeSubscriptionQuotaV1 {
  if (!isRecord(value)) return false;
  const expectedFields = Object.hasOwn(value, "credits") ? quotaAllFields : quotaRequiredFields;
  if (!hasOnlyFields(value, expectedFields)) return false;
  if (value.schemaVersion !== 1) return false;
  if (!isNonEmptyString(value.observedAt) || !timestamp(value.observedAt)) return false;
  if (!isBoundedSafeText(value.source, 64)) return false;
  if (value.plan !== null && !isBoundedSafeText(value.plan, 64)) return false;
  if (!Array.isArray(value.windows) || value.windows.length > 64 || !value.windows.every(validQuotaWindow))
    return false;
  if (value.credits !== undefined && !validQuotaCredits(value.credits)) return false;
  return true;
}

function validQuotaWindow(value: unknown): value is RuntimeQuotaWindowV1 {
  if (!isRecord(value)) return false;
  const expectedFields = [
    ...windowRequiredFields,
    ...windowOptionalFields.filter((field) => Object.hasOwn(value, field)),
  ];
  return (
    windowRequiredFields.every((field) => Object.hasOwn(value, field)) &&
    hasOnlyFields(value, expectedFields) &&
    isBoundedSafeText(value.id, 64) &&
    isBoundedSafeText(value.label, 80) &&
    typeof value.kind === "string" &&
    (runtimeQuotaWindowKinds as readonly string[]).includes(value.kind) &&
    (value.scope === undefined ||
      (typeof value.scope === "string" && (runtimeQuotaWindowScopes as readonly string[]).includes(value.scope))) &&
    (value.models === undefined ||
      (Array.isArray(value.models) &&
        value.models.length > 0 &&
        value.models.length <= 64 &&
        value.models.every((model) => isBoundedSafeText(model, 128)))) &&
    typeof value.remainingFraction === "number" &&
    Number.isFinite(value.remainingFraction) &&
    value.remainingFraction >= 0 &&
    value.remainingFraction <= 1 &&
    typeof value.usedPercent === "number" &&
    Number.isFinite(value.usedPercent) &&
    value.usedPercent >= 0 &&
    value.usedPercent <= 100 &&
    (value.resetsAt === null || (isNonEmptyString(value.resetsAt) && timestamp(value.resetsAt)))
  );
}

function validQuotaCredits(value: unknown): value is RuntimeQuotaCreditsV1 {
  return (
    isRecord(value) &&
    creditsFields.every((field) => Object.hasOwn(value, field)) &&
    hasOnlyFields(value, creditsFields) &&
    (value.remaining === null || (typeof value.remaining === "number" && Number.isFinite(value.remaining))) &&
    (value.limit === null || (typeof value.limit === "number" && Number.isFinite(value.limit))) &&
    typeof value.unlimited === "boolean"
  );
}

const subFamilyTokens: ReadonlyArray<readonly [string, RegExp]> = [
  ["argon", /\bargon\b/iu],
  ["carbon", /\bcarbon\b/iu],
  ["hydrogen", /\bhydrogen\b/iu],
  ["neon", /\bneon\b/iu],
  ["sonnet", /\bsonnet\b/iu],
  ["opus", /\bopus\b/iu],
  ["haiku", /\bhaiku\b/iu],
];

const broadFamilyTokens: ReadonlyArray<readonly [string, RegExp]> = [
  ["gemini", /\bgemini\b/iu],
  ["claude", /\bclaude\b/iu],
  ["gpt", /\b(?:gpt|o1|o3|o4|codex)\b/iu],
];

const genericWindowTokens = new Set([
  "primary",
  "secondary",
  "session",
  "weekly",
  "monthly",
  "bucket",
  "buckets",
  "quota",
  "usage",
  "limit",
  "limits",
  "window",
  "plan",
  "default",
  "general",
  "all",
  "total",
  "account",
  "global",
  "five",
  "seven",
  "hour",
  "hours",
  "day",
  "days",
  "week",
  "weeks",
  "month",
  "months",
  "premium",
  "interactions",
  "chat",
  "completions",
  "oauth",
  "apps",
  "code",
  "review",
  "pro",
  "ultra",
  "plus",
  "max",
  "free",
  "team",
]);

function normalizeTokens(text: string): readonly string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
}

function matchedTokens(text: string, table: ReadonlyArray<readonly [string, RegExp]>): readonly string[] {
  const normalized = text.replace(/[^A-Za-z0-9]+/gu, " ");
  return table.filter(([, pattern]) => pattern.test(normalized)).map(([family]) => family);
}

function unknownBucketSlugTokens(window: RuntimeQuotaWindowV1): readonly string[] {
  return [
    ...new Set(
      normalizeTokens(`${window.id} ${window.label}`).filter(
        (token) =>
          !/^\d+[smhdw]?$/u.test(token) &&
          !genericWindowTokens.has(token) &&
          !subFamilyTokens.some(([name]) => name === token) &&
          !broadFamilyTokens.some(([name]) => name === token),
      ),
    ),
  ];
}

function windowHasModelQualifier(window: RuntimeQuotaWindowV1): boolean {
  if (window.models && window.models.length > 0) return true;
  const text = `${window.id} ${window.label}`;
  return (
    matchedTokens(text, subFamilyTokens).length > 0 ||
    matchedTokens(text, broadFamilyTokens).length > 0 ||
    unknownBucketSlugTokens(window).length > 0
  );
}

function windowAppliesToModel(
  window: RuntimeQuotaWindowV1,
  model: string,
  allWindows: readonly RuntimeQuotaWindowV1[],
): boolean {
  const normalizedModel = model.trim().toLowerCase();
  if (!normalizedModel) return false;
  if (window.models && window.models.length > 0) {
    return window.models.some((candidate) => candidate.trim().toLowerCase() === normalizedModel);
  }
  const windowText = `${window.id} ${window.label}`;
  const windowSubFamilies = matchedTokens(windowText, subFamilyTokens);
  const windowBroadFamilies = matchedTokens(windowText, broadFamilyTokens);
  const windowUnknownSlugs = unknownBucketSlugTokens(window);

  if (windowSubFamilies.length === 0 && windowBroadFamilies.length === 0 && windowUnknownSlugs.length === 0) {
    return window.scope !== "auxiliary";
  }

  const modelSubFamilies = matchedTokens(model, subFamilyTokens);
  const modelBroadFamilies = matchedTokens(model, broadFamilyTokens);
  const modelWordTokens = new Set(normalizeTokens(model));

  if (windowSubFamilies.length > 0) {
    return windowSubFamilies.some((family) => modelSubFamilies.includes(family));
  }
  if (windowBroadFamilies.length > 0) {
    if (!windowBroadFamilies.some((family) => modelBroadFamilies.includes(family))) return false;
    // When another bucket in the same snapshot explicitly owns this model's dedicated sub-family
    // (e.g. an independent Argon bucket alongside Gemini), scope the model to its dedicated bucket.
    const ownedByDedicatedSubBucket =
      modelSubFamilies.length > 0 &&
      allWindows.some(
        (other) =>
          other !== window &&
          matchedTokens(`${other.id} ${other.label}`, subFamilyTokens).some((sub) => modelSubFamilies.includes(sub)),
      );
    return !ownedByDedicatedSubBucket;
  }
  return windowUnknownSlugs.some((slug) => modelWordTokens.has(slug));
}

function windowsForModel(quota: RuntimeSubscriptionQuotaV1, model: string): readonly RuntimeQuotaWindowV1[] {
  const matched = quota.windows.filter((window) => windowAppliesToModel(window, model, quota.windows));
  return matched;
}

function windowResetExpired(window: RuntimeQuotaWindowV1, nowTime: number): boolean {
  const resetTime = window.resetsAt === null ? Number.NaN : Date.parse(window.resetsAt);
  return Number.isFinite(nowTime) && Number.isFinite(resetTime) && resetTime <= nowTime;
}

function latestExhaustedWindow(
  windows: readonly RuntimeQuotaWindowV1[],
  nowTime: number,
): { readonly window: RuntimeQuotaWindowV1; readonly resetAt: string; readonly time: number } | null {
  let selected: { readonly window: RuntimeQuotaWindowV1; readonly resetAt: string; readonly time: number } | null =
    null;
  for (const window of windows) {
    if (window.remainingFraction > 0 || window.resetsAt === null) continue;
    const resetTime = Date.parse(window.resetsAt);
    if (!Number.isFinite(resetTime)) continue;
    if (Number.isFinite(nowTime) && resetTime <= nowTime) continue;
    if (selected === null || resetTime > selected.time)
      selected = { window, resetAt: window.resetsAt, time: resetTime };
  }
  return selected;
}

function modelHasUnresolvedZeroWindow(windows: readonly RuntimeQuotaWindowV1[], nowTime: number): boolean {
  return windows.some((window) => window.remainingFraction <= 0 && !windowResetExpired(window, nowTime));
}

/**
 * Selects the blocking exhausted window and reset timestamp for an instance (or specific model).
 * - Account-wide primary windows (`5h`, `7d`, etc.) block every model.
 * - Model-scoped buckets (AGY `Gemini`/`Claude/GPT`/`Argon`/`Carbon`/`Hydrogen` or unknown named buckets,
 *   Claude `seven_day_sonnet`, etc.) apply only to matching models; an exhausted inapplicable or unknown bucket
 *   never blocks unrelated models.
 * - For a multi-model set, the instance is considered exhausted only when every configured model is blocked,
 *   returning the earliest model recovery time (for a single model or shared account-wide windows, this is the
 *   latest reset among that model's exhausted windows).
 */
export function findExhaustedSubscriptionQuotaWindow(
  quota: RuntimeSubscriptionQuotaV1,
  now?: string,
  options?: { readonly models?: readonly string[] },
): { readonly window: RuntimeQuotaWindowV1; readonly resetAt: string } | null {
  const nowTime = now === undefined ? Number.NEGATIVE_INFINITY : Date.parse(now);
  const normalizedModels = options?.models?.map((model) => model.trim()).filter((model) => model.length > 0) ?? [];
  if (normalizedModels.length === 0) {
    const primaryWindows = quota.windows.filter((window) => window.scope !== "auxiliary");
    const selected = latestExhaustedWindow(primaryWindows, nowTime);
    return selected === null ? null : { window: selected.window, resetAt: selected.resetAt };
  }
  let earliestModelUnblock: {
    readonly window: RuntimeQuotaWindowV1;
    readonly resetAt: string;
    readonly time: number;
  } | null = null;
  for (const model of normalizedModels) {
    const applicable = windowsForModel(quota, model);
    if (applicable.length === 0) return null;
    const exhausted = latestExhaustedWindow(applicable, nowTime);
    if (exhausted === null) return null;
    if (earliestModelUnblock === null || exhausted.time < earliestModelUnblock.time) {
      earliestModelUnblock = exhausted;
    }
  }
  return earliestModelUnblock === null
    ? null
    : { window: earliestModelUnblock.window, resetAt: earliestModelUnblock.resetAt };
}

function quotaWindowsMatch(left: RuntimeQuotaWindowV1, right: RuntimeQuotaWindowV1): boolean {
  if (left.id.trim().toLowerCase() === right.id.trim().toLowerCase()) return true;
  if (
    (left.kind === "session" || left.kind === "weekly" || left.kind === "monthly") &&
    left.kind === right.kind &&
    (left.scope ?? "primary") === (right.scope ?? "primary") &&
    !windowHasModelQualifier(left) &&
    !windowHasModelQualifier(right)
  ) {
    return true;
  }
  return false;
}

/**
 * Merges a new quota observation with the previously cached snapshot for the same account.
 * Known future-resetting exhausted windows (e.g. a 7d=0 window) that are omitted by a
 * subsequent partial response (e.g. only reporting a healthy 5h window) are preserved until
 * either their reset clock elapses or a fresh observation explicitly reports that window.
 */
export function mergeSubscriptionQuotaObservation(
  previous: RuntimeSubscriptionQuotaV1 | undefined,
  incoming: RuntimeSubscriptionQuotaV1,
  now?: string,
): RuntimeSubscriptionQuotaV1 {
  if (!previous) return incoming;
  const nowTime = now === undefined ? Date.parse(incoming.observedAt) : Date.parse(now);
  const preserved: RuntimeQuotaWindowV1[] = [];
  for (const prevWindow of previous.windows) {
    if (prevWindow.remainingFraction > 0 || prevWindow.resetsAt === null) continue;
    const resetTime = Date.parse(prevWindow.resetsAt);
    if (!Number.isFinite(resetTime) || (Number.isFinite(nowTime) && resetTime <= nowTime)) continue;
    if (incoming.windows.some((nextWindow) => quotaWindowsMatch(prevWindow, nextWindow))) continue;
    preserved.push(prevWindow);
  }
  if (preserved.length === 0) return incoming;
  const mergedWindows = [...incoming.windows, ...preserved].slice(0, 64);
  return {
    ...incoming,
    windows: mergedWindows,
  };
}

/**
 * Classifies whether an exhausted window governs the entire account or a specific model subset
 * so runtime health success recovery only clears exhaustion for the matching scope.
 */
export function subscriptionQuotaExhaustionScope(
  quota: RuntimeSubscriptionQuotaV1,
  window: RuntimeQuotaWindowV1,
  configuredModels?: readonly string[],
): { readonly scope: "account" | "model"; readonly models?: readonly string[] } {
  if (!windowHasModelQualifier(window)) return { scope: "account" };
  const normalizedConfigured = configuredModels?.map((model) => model.trim()).filter((model) => model.length > 0) ?? [];
  const matched =
    normalizedConfigured.length > 0
      ? normalizedConfigured.filter((model) => windowAppliesToModel(window, model, quota.windows))
      : [...(window.models ?? [])];
  return matched.length > 0 ? { scope: "model", models: matched } : { scope: "model" };
}

/**
 * Returns true only when the snapshot proves positive capacity across applicable blocking windows
 * (and contains no 0%-remaining applicable window with missing or future reset time). Credits-only,
 * partial responses that omit a still-active exhausted window from `previousQuota`, or
 * 0%-without-resetAt snapshots return false so they never clear known quota exhaustion.
 */
export function hasRecoveredSubscriptionQuota(
  quota: RuntimeSubscriptionQuotaV1,
  now?: string,
  options?: { readonly models?: readonly string[]; readonly previousQuota?: RuntimeSubscriptionQuotaV1 },
): boolean {
  const effectiveQuota = options?.previousQuota
    ? mergeSubscriptionQuotaObservation(options.previousQuota, quota, now)
    : quota;
  const nowTime = now === undefined ? Number.NEGATIVE_INFINITY : Date.parse(now);
  const normalizedModels = options?.models?.map((model) => model.trim()).filter((model) => model.length > 0) ?? [];
  if (normalizedModels.length === 0) {
    const primaryWindows = effectiveQuota.windows.filter((window) => window.scope !== "auxiliary");
    return primaryWindows.length > 0 && !modelHasUnresolvedZeroWindow(primaryWindows, nowTime);
  }
  return normalizedModels.some((model) => {
    const applicable = windowsForModel(effectiveQuota, model);
    return applicable.length > 0 && !modelHasUnresolvedZeroWindow(applicable, nowTime);
  });
}

/**
 * Selects the tightest applicable non-expired window for operator headline/rail display,
 * sharing the exact same model-bucket applicability rules as dispatch exhaustion.
 */
export function selectSubscriptionQuotaHeadlineWindow(
  quota: RuntimeSubscriptionQuotaV1,
  now?: string,
  options?: { readonly models?: readonly string[] },
): { readonly window: RuntimeQuotaWindowV1; readonly exhausted: boolean } | null {
  const nowTime = now === undefined ? Number.NEGATIVE_INFINITY : Date.parse(now);
  const normalizedModels = options?.models?.map((model) => model.trim()).filter((model) => model.length > 0) ?? [];
  const applicable =
    normalizedModels.length > 0
      ? [...new Set(normalizedModels.flatMap((model) => windowsForModel(quota, model)))]
      : quota.windows.filter((window) => window.scope !== "auxiliary" || !windowHasModelQualifier(window));
  const pool = applicable.length > 0 ? applicable : quota.windows;
  if (pool.length === 0) return null;
  const active = pool.filter((window) => !(window.remainingFraction <= 0 && windowResetExpired(window, nowTime)));
  const candidates = active.length > 0 ? active : pool;
  let lowest: RuntimeQuotaWindowV1 | null = null;
  for (const window of candidates) {
    if (lowest === null || window.remainingFraction < lowest.remainingFraction) lowest = window;
  }
  if (lowest === null) return null;
  const exhausted =
    findExhaustedSubscriptionQuotaWindow(quota, now, options) !== null ||
    (lowest.remainingFraction <= 0 && !windowResetExpired(lowest, nowTime) && normalizedModels.length === 0);
  return { window: lowest, exhausted };
}

/** Formats a concise operator-facing summary of observed subscription quota windows and reset times. */
export function formatSubscriptionQuotaSummary(quota: RuntimeSubscriptionQuotaV1 | undefined): string {
  if (!quota) return "-";
  const windowParts = quota.windows.map((window) => {
    const clamped = Math.max(0, Math.min(1, window.remainingFraction));
    const rounded = Math.round(clamped * 100);
    const percentText = clamped > 0 && rounded === 0 ? "<1%" : `${rounded}%`;
    return window.resetsAt
      ? `${window.label} ${percentText} (resets ${window.resetsAt})`
      : `${window.label} ${percentText}`;
  });
  const creditPart = quota.credits
    ? quota.credits.unlimited
      ? "credits unlimited"
      : quota.credits.remaining !== null && quota.credits.limit !== null
        ? `credits ${formatNumber(quota.credits.remaining)}/${formatNumber(quota.credits.limit)}`
        : quota.credits.remaining !== null
          ? `credits ${formatNumber(quota.credits.remaining)}`
          : null
    : null;
  const parts = [...windowParts, ...(creditPart ? [creditPart] : [])];
  if (parts.length === 0) return quota.plan ? `[${quota.plan}] -` : "-";
  const body = parts.join(", ");
  return quota.plan ? `[${quota.plan}] ${body}` : body;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/u, "");
}
