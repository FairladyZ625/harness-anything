import { timestamp } from "./timestamp.ts";
import { hasOnlyFields, isNonEmptyString, isRecord } from "./write-chain.contract.ts";

export const runtimeQuotaWindowKinds = Object.freeze(["session", "weekly", "monthly", "bucket"] as const);
export type RuntimeQuotaWindowKind = (typeof runtimeQuotaWindowKinds)[number];

export interface RuntimeQuotaWindowV1 {
  readonly id: string;
  readonly label: string;
  readonly kind: RuntimeQuotaWindowKind;
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
          remainingFraction: {
            type: "number" as const,
            minimum: 0,
            maximum: 1,
            description: "Remaining fraction in [0, 1].",
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

const windowFields = ["id", "label", "kind", "remainingFraction", "usedPercent", "resetsAt"] as const;
const creditsFields = ["remaining", "limit", "unlimited"] as const;
const quotaRequiredFields = ["schemaVersion", "observedAt", "source", "plan", "windows"] as const;
const quotaAllFields = [...quotaRequiredFields, "credits"] as const;

export function validRuntimeSubscriptionQuota(value: unknown): value is RuntimeSubscriptionQuotaV1 {
  if (!isRecord(value)) return false;
  const expectedFields = Object.hasOwn(value, "credits") ? quotaAllFields : quotaRequiredFields;
  if (!hasOnlyFields(value, expectedFields)) return false;
  if (value.schemaVersion !== 1) return false;
  if (!isNonEmptyString(value.observedAt) || !timestamp(value.observedAt)) return false;
  if (!isNonEmptyString(value.source)) return false;
  if (value.plan !== null && !isNonEmptyString(value.plan)) return false;
  if (!Array.isArray(value.windows) || !value.windows.every(validQuotaWindow)) return false;
  if (value.credits !== undefined && !validQuotaCredits(value.credits)) return false;
  return true;
}

function validQuotaWindow(value: unknown): value is RuntimeQuotaWindowV1 {
  return (
    isRecord(value) &&
    windowFields.every((field) => Object.hasOwn(value, field)) &&
    hasOnlyFields(value, windowFields) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.label) &&
    (runtimeQuotaWindowKinds as readonly string[]).includes(String(value.kind)) &&
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

/**
 * Selects the latest valid reset time among exhausted windows (`remainingFraction <= 0`).
 * When `now` is supplied, only future reset timestamps (`resetsAt > now`) trigger cooldown.
 */
export function findExhaustedSubscriptionQuotaWindow(
  quota: RuntimeSubscriptionQuotaV1,
  now?: string,
): { readonly window: RuntimeQuotaWindowV1; readonly resetAt: string } | null {
  const nowTime = now === undefined ? Number.NEGATIVE_INFINITY : Date.parse(now);
  let selected: { readonly window: RuntimeQuotaWindowV1; readonly resetAt: string; readonly time: number } | null =
    null;
  for (const window of quota.windows) {
    if (window.remainingFraction > 0 || window.resetsAt === null) continue;
    const resetTime = Date.parse(window.resetsAt);
    if (!Number.isFinite(resetTime)) continue;
    if (Number.isFinite(nowTime) && resetTime <= nowTime) continue;
    if (selected === null || resetTime > selected.time)
      selected = { window, resetAt: window.resetsAt, time: resetTime };
  }
  return selected === null ? null : { window: selected.window, resetAt: selected.resetAt };
}

/** Formats a concise operator-facing summary of observed subscription quota windows and reset times. */
export function formatSubscriptionQuotaSummary(quota: RuntimeSubscriptionQuotaV1 | undefined): string {
  if (!quota) return "-";
  const windowParts = quota.windows.map((window) => {
    const remainingPercent = Math.round(Math.max(0, Math.min(1, window.remainingFraction)) * 100);
    return window.resetsAt
      ? `${window.label} ${remainingPercent}% (resets ${window.resetsAt})`
      : `${window.label} ${remainingPercent}%`;
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
