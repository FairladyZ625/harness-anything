import type {
  RuntimeQuotaCreditsV1,
  RuntimeQuotaWindowKind,
  RuntimeQuotaWindowScope,
  RuntimeQuotaWindowV1,
  RuntimeSubscriptionQuotaV1,
} from "@harness-anything/kernel";
import { runtimeInstanceError } from "./agent-runtime-instance-config.ts";
import { scrubSecretText } from "../runtime-engine/secret-scrub.ts";

export const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";
export const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";

const controlCharPattern = /[\u0000-\u001F\u007F-\u009F]/gu;
const maxPlanLength = 48;
const maxWindowIdLength = 64;
const maxWindowLabelLength = 64;
const maxWindowCount = 64;

/**
 * Validates and resolves a Codex OAuth usage URL against trusted HTTPS OpenAI/ChatGPT origins.
 * Rejects plaintext HTTP, embedded credentials, and untrusted hosts so OAuth bearer tokens
 * can never be redirected to an arbitrary endpoint.
 */
export function resolveCodexUsageUrl(rawBaseUrl: string | null): string | null {
  const candidate = (rawBaseUrl ?? DEFAULT_CHATGPT_BASE_URL).trim();
  if (!candidate || !URL.canParse(candidate)) return null;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  const host = parsed.hostname.toLowerCase();
  const trustedHost =
    host === "chatgpt.com" ||
    host === "chat.openai.com" ||
    host.endsWith(".chatgpt.com") ||
    host.endsWith(".openai.com");
  if (!trustedHost) return null;
  const cleanPath = parsed.pathname.replace(/\/+$/u, "");
  if (/\/wham\/usage$/iu.test(cleanPath)) return `${parsed.origin}${cleanPath}`;
  if (cleanPath === "") return `${parsed.origin}/backend-api/wham/usage`;
  return `${parsed.origin}${cleanPath}/wham/usage`;
}

export interface ParseAgyQuotaOptions {
  readonly expectedCommand?: "usage" | "quota";
}

/**
 * Parses both `agy -p /usage --output-format json` (`>=1.2.2` `command.name === "usage"` with
 * flat or nested `remaining.remaining_fraction`, plus `data.groups[]` / bare `groups[]`)
 * and legacy `agy -p /quota --output-format json` (`command.data.groups[].buckets[]`).
 */
export function parseAgyQuotaResponse(
  output: string,
  observedAt = new Date().toISOString(),
  options: ParseAgyQuotaOptions = {},
): RuntimeSubscriptionQuotaV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw runtimeInstanceError("runtime_quota_response_invalid", "AGY quota response is not valid JSON.");
  }
  const root = requireRecord(parsed, "AGY quota response");
  const normalizedRootStatus = typeof root.status === "string" ? root.status.trim().toLowerCase() : null;
  if (
    root.ok === false ||
    (root.error !== undefined && root.error !== null) ||
    (normalizedRootStatus !== null && normalizedRootStatus !== "success")
  )
    throw runtimeInstanceError("runtime_quota_response_invalid", "AGY quota response reported a command failure.");
  if (options.expectedCommand === "usage" && normalizedRootStatus !== "success")
    throw runtimeInstanceError(
      "runtime_quota_response_invalid",
      'AGY /usage envelope must report top-level status "SUCCESS".',
    );
  const data = agyQuotaDataRecord(root, options.expectedCommand);
  if (!Array.isArray(data.groups) || data.groups.length === 0)
    throw runtimeInstanceError("runtime_quota_response_invalid", "AGY quota response has no groups array.");
  const windows: RuntimeQuotaWindowV1[] = [];
  const usedIds = new Set<string>();
  for (let groupIndex = 0; groupIndex < data.groups.length; groupIndex += 1) {
    const group = requireRecord(data.groups[groupIndex], "AGY quota group");
    if (!Array.isArray(group.buckets))
      throw runtimeInstanceError("runtime_quota_response_invalid", "AGY quota group has no buckets array.");
    const groupLabel =
      sanitizeQuotaText(group.display_name, maxWindowLabelLength) ??
      sanitizeQuotaText(group.name, maxWindowLabelLength) ??
      sanitizeQuotaText(group.group_id, maxWindowLabelLength);
    const groupModels = sanitizeQuotaModelList(group.models ?? group.model_ids);
    for (let bucketIndex = 0; bucketIndex < group.buckets.length; bucketIndex += 1) {
      if (windows.length >= maxWindowCount) break;
      const bucket = requireRecord(group.buckets[bucketIndex], "AGY quota bucket");
      if (bucket.disabled === true) continue;
      const fractionState = agyBucketRemainingFraction(bucket);
      if (fractionState.kind === "invalid")
        throw runtimeInstanceError(
          "runtime_quota_response_invalid",
          "AGY quota bucket has a non-numeric remaining_fraction.",
        );
      if (fractionState.kind === "missing") continue;
      const remainingFraction = unroundedRemainingFraction(fractionState.value);
      const fallbackId = `bucket-${groupIndex + 1}-${bucketIndex + 1}`;
      const rawId =
        sanitizeQuotaId(bucket.bucket_id) ??
        sanitizeQuotaId(bucket.id) ??
        sanitizeQuotaId(group.group_id) ??
        sanitizeQuotaId(group.id) ??
        fallbackId;
      const id = uniqueId(rawId, usedIds);
      const bucketLabel =
        sanitizeQuotaText(bucket.display_name, maxWindowLabelLength) ??
        sanitizeQuotaText(bucket.name, maxWindowLabelLength);
      const combinedLabel =
        bucketLabel && groupLabel && bucketLabel.toLowerCase() !== groupLabel.toLowerCase()
          ? `${groupLabel} · ${bucketLabel}`.slice(0, maxWindowLabelLength).trim()
          : (bucketLabel ?? groupLabel ?? id);
      const remainingObj = isRecord(bucket.remaining) ? bucket.remaining : null;
      const resetsAt = parseIsoTimestamp(
        bucket.reset_time ?? bucket.resets_at ?? remainingObj?.reset_time ?? remainingObj?.resets_at,
      );
      const bucketModels = sanitizeQuotaModelList(bucket.models ?? bucket.model_ids) ?? groupModels;
      windows.push({
        id,
        label: combinedLabel,
        kind: inferWindowKind(id, combinedLabel, "bucket"),
        scope: "primary",
        ...(bucketModels ? { models: bucketModels } : {}),
        remainingFraction,
        usedPercent: usedPercentFromRemaining(remainingFraction),
        resetsAt,
      });
    }
  }
  if (windows.length === 0)
    throw runtimeInstanceError("runtime_quota_response_invalid", "AGY quota response has no usable buckets.");
  const plan =
    sanitizeQuotaText(data.plan, maxPlanLength) ??
    sanitizeQuotaText(data.plan_name, maxPlanLength) ??
    sanitizeQuotaText(data.tier, maxPlanLength);
  return {
    schemaVersion: 1,
    observedAt,
    source: "agy-cli",
    plan,
    windows,
  };
}

function agyQuotaDataRecord(
  root: Record<string, unknown>,
  expectedCommand?: "usage" | "quota",
): Record<string, unknown> {
  if (root.command !== undefined) {
    const command = requireRecord(root.command, "AGY quota command response");
    const normalizedCommandStatus = typeof command.status === "string" ? command.status.trim().toLowerCase() : null;
    if (
      command.ok === false ||
      command.success === false ||
      (normalizedCommandStatus !== null && normalizedCommandStatus !== "success") ||
      (command.error !== undefined && command.error !== null)
    ) {
      throw runtimeInstanceError("runtime_quota_response_invalid", "AGY quota command envelope reported failure.");
    }
    if (expectedCommand !== undefined) {
      const normalizedName =
        typeof command.name === "string" ? command.name.trim().replace(/^\/+/u, "").toLowerCase() : null;
      if (expectedCommand === "usage" && normalizedName !== "usage") {
        throw runtimeInstanceError(
          "runtime_quota_response_invalid",
          "AGY /usage envelope did not report command usage.",
        );
      }
      if (normalizedName !== null && normalizedName !== expectedCommand) {
        throw runtimeInstanceError(
          "runtime_quota_response_invalid",
          "AGY command envelope name did not match request.",
        );
      }
    }
    return requireRecord(command.data, "AGY quota command data");
  }
  if (expectedCommand === "usage") {
    throw runtimeInstanceError(
      "runtime_quota_response_invalid",
      'AGY /usage envelope must include command.name === "usage".',
    );
  }
  if (root.data !== undefined) return requireRecord(root.data, "AGY quota data");
  if (root.groups !== undefined) return root;
  throw runtimeInstanceError("runtime_quota_response_invalid", "AGY quota command response is invalid.");
}

function agyBucketRemainingFraction(
  bucket: Record<string, unknown>,
): { readonly kind: "value"; readonly value: number } | { readonly kind: "missing" } | { readonly kind: "invalid" } {
  const candidates: ReadonlyArray<readonly [unknown, number]> = [
    [bucket.remaining_fraction, 1],
    [bucket.remainingFraction, 1],
    [bucket.remaining_percent, 100],
  ];
  for (const [raw, divisor] of candidates) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "number" && Number.isFinite(raw)) return { kind: "value", value: raw / divisor };
    return { kind: "invalid" };
  }
  if (bucket.remaining !== undefined && bucket.remaining !== null) {
    if (!isRecord(bucket.remaining)) return { kind: "invalid" };
    const nested: ReadonlyArray<readonly [unknown, number]> = [
      [bucket.remaining.remaining_fraction, 1],
      [bucket.remaining.remainingFraction, 1],
      [bucket.remaining.fraction, 1],
      [bucket.remaining.remaining_percent, 100],
    ];
    for (const [raw, divisor] of nested) {
      if (raw === undefined || raw === null) continue;
      if (typeof raw === "number" && Number.isFinite(raw)) return { kind: "value", value: raw / divisor };
      return { kind: "invalid" };
    }
  }
  return { kind: "missing" };
}

function sanitizeQuotaModelList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const models: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (models.length >= maxWindowCount) break;
    const raw = isRecord(entry) ? (entry.id ?? entry.model_id ?? entry.name) : entry;
    const cleaned = sanitizeQuotaText(raw, 128);
    if (cleaned === null) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(cleaned);
  }
  return models.length > 0 ? models : undefined;
}

export function parseCodexRateLimits(
  payload: Record<string, unknown>,
  source: "codex-app-server" | "codex-oauth",
  observedAt: string,
): RuntimeSubscriptionQuotaV1 | null {
  const container = isRecord(payload.rateLimits)
    ? payload.rateLimits
    : isRecord(payload.rate_limits)
      ? payload.rate_limits
      : payload;
  const rateLimit = isRecord(container.rate_limit) ? container.rate_limit : container;
  const windows: RuntimeQuotaWindowV1[] = [];
  const usedIds = new Set<string>();
  const primary = codexWindow(
    rateLimit.primary ?? rateLimit.primary_window,
    "primary",
    "5h",
    "session",
    "primary",
    observedAt,
    usedIds,
  );
  if (primary) windows.push(primary);
  const secondary = codexWindow(
    rateLimit.secondary ?? rateLimit.secondary_window,
    "secondary",
    "7d",
    "weekly",
    "primary",
    observedAt,
    usedIds,
  );
  if (secondary) windows.push(secondary);
  const codeReview = isRecord(container.code_review_rate_limit)
    ? codexWindow(
        container.code_review_rate_limit.primary_window ?? container.code_review_rate_limit.primary,
        "code-review",
        "Code Review",
        "bucket",
        "auxiliary",
        observedAt,
        usedIds,
      )
    : null;
  if (codeReview) windows.push(codeReview);
  const additional = Array.isArray(container.additional_rate_limits)
    ? container.additional_rate_limits
    : Array.isArray(container.additionalRateLimits)
      ? container.additionalRateLimits
      : [];
  for (const item of additional) {
    if (windows.length >= maxWindowCount) break;
    if (!isRecord(item)) continue;
    const limitName =
      sanitizeQuotaText(item.limit_name, maxWindowLabelLength) ??
      sanitizeQuotaText(item.limitName, maxWindowLabelLength) ??
      "additional";
    const nested = isRecord(item.rate_limit) ? item.rate_limit : isRecord(item.rateLimits) ? item.rateLimits : item;
    const nestedPrimary = codexWindow(
      nested.primary_window ?? nested.primary,
      slugify(limitName),
      limitName,
      "bucket",
      "auxiliary",
      observedAt,
      usedIds,
    );
    if (nestedPrimary) windows.push(nestedPrimary);
  }
  const credits = parseCodexCredits(container.credits ?? payload.credits);
  if (windows.length === 0 && credits === undefined) return null;
  const plan =
    sanitizeQuotaText(container.planType, maxPlanLength) ??
    sanitizeQuotaText(container.plan_type, maxPlanLength) ??
    sanitizeQuotaText(payload.planType, maxPlanLength) ??
    sanitizeQuotaText(payload.plan_type, maxPlanLength);
  return {
    schemaVersion: 1,
    observedAt,
    source,
    plan,
    windows,
    ...(credits ? { credits } : {}),
  };
}

function codexWindow(
  value: unknown,
  fallbackId: string,
  fallbackLabel: string,
  fallbackKind: RuntimeQuotaWindowKind,
  scope: RuntimeQuotaWindowScope,
  observedAt: string,
  usedIds: Set<string>,
): RuntimeQuotaWindowV1 | null {
  if (!isRecord(value)) return null;
  const usedRaw = finiteNumber(value.usedPercent ?? value.used_percent);
  const remainingRaw = finiteNumber(value.remainingPercent ?? value.remaining_percent);
  if (usedRaw === null && remainingRaw === null) return null;
  const remainingFraction =
    remainingRaw !== null
      ? unroundedRemainingFraction(remainingRaw / 100)
      : unroundedRemainingFraction(1 - clamp(usedRaw!, 0, 100) / 100);
  const usedPercent = usedPercentFromRemaining(remainingFraction);
  const durationMins =
    finiteNumber(value.windowDurationMins) ??
    (finiteNumber(value.limit_window_seconds) !== null ? finiteNumber(value.limit_window_seconds)! / 60 : null);
  const label =
    durationMins !== null && (fallbackId === "primary" || fallbackId === "secondary")
      ? formatWindowDuration(durationMins, fallbackLabel)
      : fallbackLabel;
  const kind: RuntimeQuotaWindowKind =
    fallbackKind === "bucket" ? "bucket" : durationMins !== null && durationMins >= 24 * 60 ? "weekly" : fallbackKind;
  const resetsAt =
    parseIsoTimestamp(value.resetsAt ?? value.reset_at ?? value.resets_at) ??
    resetAfterSecondsToIso(value.reset_after_seconds ?? value.resetAfterSeconds, observedAt);
  return {
    id: uniqueId(fallbackId, usedIds),
    label,
    kind,
    scope,
    remainingFraction,
    usedPercent,
    resetsAt,
  };
}

function parseCodexCredits(value: unknown): RuntimeQuotaCreditsV1 | undefined {
  if (!isRecord(value)) return undefined;
  const unlimited = value.unlimited === true;
  const remaining = parseNumericField(value.balance ?? value.remaining);
  const limit = parseNumericField(value.limit);
  const hasCredits = value.hasCredits === true || value.has_credits === true;
  if (!hasCredits && !unlimited && remaining === null && limit === null) return undefined;
  return { remaining, limit, unlimited };
}

export function parseClaudeOAuthUsage(
  payload: Record<string, unknown>,
  fallbackPlan: string | null,
  observedAt: string,
): RuntimeSubscriptionQuotaV1 | null {
  const windows: RuntimeQuotaWindowV1[] = [];
  const specs: readonly [string, string, RuntimeQuotaWindowKind, RuntimeQuotaWindowScope][] = [
    ["five_hour", "5h", "session", "primary"],
    ["seven_day", "7d", "weekly", "primary"],
    ["seven_day_sonnet", "7d Sonnet", "weekly", "auxiliary"],
    ["seven_day_opus", "7d Opus", "weekly", "auxiliary"],
    ["seven_day_oauth_apps", "7d OAuth", "weekly", "auxiliary"],
  ];
  for (const [key, label, kind, scope] of specs) {
    const raw = payload[key];
    if (!isRecord(raw)) continue;
    const utilization = finiteNumber(raw.utilization);
    if (utilization === null) continue;
    const remainingFraction = unroundedRemainingFraction(1 - clamp(utilization, 0, 100) / 100);
    windows.push({
      id: key,
      label,
      kind,
      scope,
      remainingFraction,
      usedPercent: usedPercentFromRemaining(remainingFraction),
      resetsAt: parseIsoTimestamp(raw.resets_at ?? raw.resetsAt),
    });
  }
  const credits = parseClaudeExtraUsage(payload.extra_usage);
  if (windows.length === 0 && credits === undefined) return null;
  const plan =
    sanitizeQuotaText(payload.plan, maxPlanLength) ??
    sanitizeQuotaText(payload.rate_limit_tier, maxPlanLength) ??
    sanitizeQuotaText(fallbackPlan, maxPlanLength);
  return {
    schemaVersion: 1,
    observedAt,
    source: "claude-oauth",
    plan,
    windows,
    ...(credits ? { credits } : {}),
  };
}

function parseClaudeExtraUsage(value: unknown): RuntimeQuotaCreditsV1 | undefined {
  if (!isRecord(value)) return undefined;
  if (value.is_enabled === false) return undefined;
  const limit = parseNumericField(value.monthly_limit);
  const used = parseNumericField(value.used_credits);
  if (limit === null && used === null) return undefined;
  const remaining = limit !== null && used !== null ? Math.max(0, limit - used) : null;
  const extraUnlimited = value.unlimited === true;
  return { remaining, limit, unlimited: extraUnlimited };
}

export function parseCopilotQuota(
  payload: Record<string, unknown>,
  observedAt: string,
): RuntimeSubscriptionQuotaV1 | null {
  const defaultResetAt = parseIsoTimestamp(payload.quota_reset_date_utc ?? payload.quota_reset_date);
  const windows: RuntimeQuotaWindowV1[] = [];
  const snapshots = isRecord(payload.quota_snapshots) ? payload.quota_snapshots : null;
  if (snapshots) {
    const hasPremium = isRecord(snapshots.premium_interactions);
    const specs: readonly [string, string, RuntimeQuotaWindowScope][] = [
      ["premium_interactions", "Premium", "primary"],
      ["chat", "Chat", hasPremium ? "auxiliary" : "primary"],
      ["completions", "Completions", hasPremium ? "auxiliary" : "primary"],
    ];
    for (const [key, label, scope] of specs) {
      const snapshot = snapshots[key];
      if (!isRecord(snapshot)) continue;
      const unlimited = snapshot.unlimited === true;
      const percentRemaining = finiteNumber(snapshot.percent_remaining);
      const remaining = finiteNumber(snapshot.remaining);
      const entitlement = finiteNumber(snapshot.entitlement);
      let remainingFraction: number | null = null;
      if (unlimited) remainingFraction = 1;
      else if (percentRemaining !== null) remainingFraction = unroundedRemainingFraction(percentRemaining / 100);
      else if (remaining !== null && entitlement !== null && entitlement > 0)
        remainingFraction = unroundedRemainingFraction(remaining / entitlement);
      if (remainingFraction === null) continue;
      windows.push({
        id: key,
        label,
        kind: "monthly",
        scope,
        remainingFraction,
        usedPercent: usedPercentFromRemaining(remainingFraction),
        resetsAt: parseIsoTimestamp(snapshot.quota_reset_date_utc ?? snapshot.quota_reset_date) ?? defaultResetAt,
      });
    }
  } else if (isRecord(payload.limited_user_quotas) && isRecord(payload.monthly_quotas)) {
    for (const [key, label] of [
      ["chat", "Chat"],
      ["completions", "Completions"],
    ] as const) {
      const remaining = finiteNumber(payload.limited_user_quotas[key]);
      const entitlement = finiteNumber(payload.monthly_quotas[key]);
      if (remaining === null || entitlement === null || entitlement <= 0) continue;
      const remainingFraction = unroundedRemainingFraction(remaining / entitlement);
      windows.push({
        id: key,
        label,
        kind: "monthly",
        scope: "primary",
        remainingFraction,
        usedPercent: usedPercentFromRemaining(remainingFraction),
        resetsAt: defaultResetAt,
      });
    }
  }
  if (windows.length === 0) return null;
  return {
    schemaVersion: 1,
    observedAt,
    source: "copilot-oauth",
    plan: sanitizeQuotaText(payload.copilot_plan, maxPlanLength),
    windows,
  };
}

/**
 * Strips control characters, collapses whitespace, enforces length bounds, and drops any string
 * containing registered secrets or credential patterns before it can reach DTOs, disk, or logs.
 */
export function sanitizeQuotaText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(controlCharPattern, " ").replace(/\s+/gu, " ").trim();
  if (cleaned.length === 0) return null;
  const scrubbed = scrubSecretText(cleaned);
  if (scrubbed !== cleaned || scrubbed.includes("[REDACTED]")) return null;
  const bounded = scrubbed.slice(0, maxLength).trim();
  return bounded.length > 0 ? bounded : null;
}

function sanitizeQuotaId(value: unknown): string | null {
  const cleaned = sanitizeQuotaText(value, maxWindowIdLength);
  if (cleaned === null) return null;
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(cleaned)) return cleaned;
  const slug = slugify(cleaned).slice(0, maxWindowIdLength);
  return slug.length > 0 ? slug : null;
}

function parseIsoTimestamp(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 10_000_000_000 ? value * 1_000 : value;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
}

function resetAfterSecondsToIso(value: unknown, observedAt: string): string | null {
  const seconds = finiteNumber(value);
  const baseTime = Date.parse(observedAt);
  if (seconds === null || seconds < 0 || !Number.isFinite(baseTime)) return null;
  return new Date(baseTime + seconds * 1_000).toISOString();
}

function formatWindowDuration(minutes: number, fallback: string): string {
  if (minutes <= 0) return fallback;
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

function inferWindowKind(id: string, label: string, fallback: RuntimeQuotaWindowKind): RuntimeQuotaWindowKind {
  const text = `${id} ${label}`.toLowerCase();
  if (/\b(?:7d|week|weekly)\b/u.test(text)) return "weekly";
  if (/\b(?:5h|session|5-hour|five_hour)\b/u.test(text)) return "session";
  if (/\b(?:month|monthly|30d)\b/u.test(text)) return "monthly";
  return fallback;
}

function uniqueId(candidate: string, seen: Set<string>): string {
  const base = (candidate.trim() || "window").slice(0, maxWindowIdLength);
  if (!seen.has(base)) {
    seen.add(base);
    return base;
  }
  let suffix = 2;
  while (seen.has(`${base.slice(0, maxWindowIdLength - String(suffix).length - 1)}-${suffix}`)) suffix += 1;
  const next = `${base.slice(0, maxWindowIdLength - String(suffix).length - 1)}-${suffix}`;
  seen.add(next);
  return next;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, maxWindowIdLength) || "window"
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function unroundedRemainingFraction(value: number): number {
  const clamped = clamp(value, 0, 1);
  if (clamped <= 0) return 0;
  if (clamped >= 1) return 1;
  return Number(clamped.toPrecision(6));
}

function usedPercentFromRemaining(remainingFraction: number): number {
  if (remainingFraction <= 0) return 100;
  if (remainingFraction >= 1) return 0;
  return Math.min(99.9, Math.round(clamp((1 - remainingFraction) * 100, 0, 100) * 10) / 10);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseNumericField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw runtimeInstanceError("runtime_quota_response_invalid", `${label} is invalid.`);
}
