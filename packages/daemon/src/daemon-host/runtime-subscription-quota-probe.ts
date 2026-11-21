import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  RuntimeQuotaCreditsV1,
  RuntimeQuotaWindowKind,
  RuntimeQuotaWindowV1,
  RuntimeSubscriptionQuotaV1,
} from "@harness-anything/kernel";
import { runtimeSubscriptionQuotaPolicy } from "@harness-anything/kernel/internal/domain/runtime-instance-contract.ts";
import { runtimeInstanceError } from "./agent-runtime-instance-config.ts";
import { runExecutable, runExecutableResult } from "./agent-runtime-installation-discovery.ts";
import type { RuntimeCredentialSource, RuntimeInstanceKind } from "./agent-runtime-instance-types.ts";
import { JsonRpcLineClient } from "./client/local-json-rpc-client.ts";
import { registerSecretValue, scrubSecretText } from "../runtime-engine/secret-scrub.ts";

const quotaHttpTimeoutMs = runtimeSubscriptionQuotaPolicy.defaultValue.httpTimeoutMs;
const credentialReadRetryDelayMs = runtimeSubscriptionQuotaPolicy.defaultValue.credentialReadRetryDelayMs;
const credentialReadAttempts = runtimeSubscriptionQuotaPolicy.defaultValue.credentialReadAttempts;
const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_GITHUB_API_URL = "https://api.github.com";

export interface SubscriptionQuotaProbeInput {
  readonly kindId: RuntimeInstanceKind;
  readonly credentialSource: RuntimeCredentialSource;
  readonly executablePath?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly hasCustomProviderBaseUrl?: boolean;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly now: () => string;
  readonly fetchImpl?: typeof fetch;
  readonly resolveGithubToken?: () => Promise<string | null>;
}

/**
 * Read-only subscription quota probe across supported providers (AGY, Codex, Claude, Copilot).
 * Never modifies CLI credential files, never triggers interactive OS Keychain or browser flows,
 * and enforces `redirect: "error"` with bounded timeouts on every HTTP request.
 */
export async function probeProviderSubscriptionQuota(
  platform: NodeJS.Platform,
  input: SubscriptionQuotaProbeInput,
): Promise<RuntimeSubscriptionQuotaV1 | null> {
  if (input.kindId === "agy" || input.kindId === "agy-acp") {
    if (!input.executablePath) return null;
    return probeAgyCliQuota(platform, input.executablePath, input.env, input.signal, input.timeoutMs, input.now());
  }
  if (input.kindId === "codex" || input.kindId === "codex-acp") {
    return probeCodexQuota(platform, input);
  }
  if (input.kindId === "claude" || input.kindId === "claude-acp") {
    return probeClaudeOAuthQuota(input);
  }
  if (input.kindId === "copilot") {
    return probeCopilotOAuthQuota(input);
  }
  return null;
}

export async function probeAgyCliQuota(
  platform: NodeJS.Platform,
  executablePath: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeoutMs: number,
  observedAt: string,
): Promise<RuntimeSubscriptionQuotaV1> {
  requireAccountHome(env, "AGY");
  const result = await runExecutableResult(platform, executablePath, ["-p", "/quota", "--output-format", "json"], {
    env,
    timeoutMs,
    signal,
  });
  if (result.exitCode !== 0)
    throw runtimeInstanceError("runtime_quota_probe_failed", `AGY quota probe exited with status ${result.exitCode}.`);
  return parseAgyQuotaResponse(result.stdout, observedAt);
}

/**
 * Parses both `agy -p /quota --output-format json` (`command.data.groups[].buckets[]`)
 * and `>=1.2.2` `/usage --output-format json` (`data.groups[].buckets[]` or `groups[].buckets[]`).
 */
export function parseAgyQuotaResponse(
  output: string,
  observedAt = new Date().toISOString(),
): RuntimeSubscriptionQuotaV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw runtimeInstanceError("runtime_quota_response_invalid", "AGY quota response is not valid JSON.");
  }
  const root = requireRecord(parsed, "AGY quota response");
  const data = agyQuotaDataRecord(root);
  if (!Array.isArray(data.groups) || data.groups.length === 0)
    throw runtimeInstanceError("runtime_quota_response_invalid", "AGY quota response has no groups array.");
  const windows: RuntimeQuotaWindowV1[] = [];
  const usedIds = new Set<string>();
  for (let groupIndex = 0; groupIndex < data.groups.length; groupIndex += 1) {
    const group = requireRecord(data.groups[groupIndex], "AGY quota group");
    if (!Array.isArray(group.buckets))
      throw runtimeInstanceError("runtime_quota_response_invalid", "AGY quota group has no buckets array.");
    const groupLabel =
      nonEmptyString(group.display_name) ?? nonEmptyString(group.name) ?? nonEmptyString(group.group_id);
    for (let bucketIndex = 0; bucketIndex < group.buckets.length; bucketIndex += 1) {
      const bucket = requireRecord(group.buckets[bucketIndex], "AGY quota bucket");
      if (bucket.disabled === true) continue;
      const fraction = agyBucketRemainingFraction(bucket);
      if (fraction === null)
        throw runtimeInstanceError(
          "runtime_quota_response_invalid",
          "AGY quota bucket has no numeric remaining_fraction.",
        );
      const remainingFraction = roundFraction(fraction);
      const rawId =
        nonEmptyString(bucket.bucket_id) ??
        nonEmptyString(bucket.id) ??
        nonEmptyString(group.group_id) ??
        nonEmptyString(group.id) ??
        `bucket-${groupIndex + 1}-${bucketIndex + 1}`;
      const id = uniqueId(rawId, usedIds);
      const bucketLabel = nonEmptyString(bucket.display_name) ?? nonEmptyString(bucket.name);
      const label =
        bucketLabel && groupLabel && bucketLabel.toLowerCase() !== groupLabel.toLowerCase()
          ? `${groupLabel} · ${bucketLabel}`
          : (bucketLabel ?? groupLabel ?? id);
      const resetsAt = parseIsoTimestamp(bucket.reset_time ?? bucket.resets_at);
      windows.push({
        id,
        label,
        kind: inferWindowKind(id, label, "bucket"),
        remainingFraction,
        usedPercent: roundPercent((1 - remainingFraction) * 100),
        resetsAt,
      });
    }
  }
  const plan = nonEmptyString(data.plan) ?? nonEmptyString(data.plan_name) ?? nonEmptyString(data.tier);
  return {
    schemaVersion: 1,
    observedAt,
    source: "agy-cli",
    plan,
    windows,
  };
}

function agyQuotaDataRecord(root: Record<string, unknown>): Record<string, unknown> {
  if (root.command !== undefined) {
    const command = requireRecord(root.command, "AGY quota command response");
    return requireRecord(command.data, "AGY quota command data");
  }
  if (root.data !== undefined) return requireRecord(root.data, "AGY quota data");
  if (root.groups !== undefined) return root;
  throw runtimeInstanceError("runtime_quota_response_invalid", "AGY quota command response is invalid.");
}

function agyBucketRemainingFraction(bucket: Record<string, unknown>): number | null {
  if (typeof bucket.remaining_fraction === "number" && Number.isFinite(bucket.remaining_fraction))
    return bucket.remaining_fraction;
  if (typeof bucket.remainingFraction === "number" && Number.isFinite(bucket.remainingFraction))
    return bucket.remainingFraction;
  if (typeof bucket.remaining_percent === "number" && Number.isFinite(bucket.remaining_percent))
    return bucket.remaining_percent / 100;
  return null;
}

async function probeCodexQuota(
  platform: NodeJS.Platform,
  input: SubscriptionQuotaProbeInput,
): Promise<RuntimeSubscriptionQuotaV1 | null> {
  const observedAt = input.now();
  if (input.executablePath) {
    const rpcQuota = await probeCodexAppServerQuota(
      platform,
      input.executablePath,
      input.env,
      input.signal,
      input.timeoutMs,
      observedAt,
    ).then(
      (quota) => quota,
      () => null,
    );
    if (rpcQuota !== null) return rpcQuota;
  }
  return probeCodexOAuthQuota(input, observedAt);
}

async function probeCodexAppServerQuota(
  platform: NodeJS.Platform,
  executablePath: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeoutMs: number,
  observedAt: string,
): Promise<RuntimeSubscriptionQuotaV1 | null> {
  const rawCwd = env.HOME ?? env.USERPROFILE,
    cwd = rawCwd && existsSync(rawCwd) ? rawCwd : undefined;
  let result: RuntimeSubscriptionQuotaV1 | null = null;
  await runExecutable(platform, executablePath, ["app-server"], {
    env,
    cwd,
    signal,
    timeoutMs: Math.min(timeoutMs, quotaHttpTimeoutMs),
    captureOutput: true,
    input: async (child) => {
      const rpc = new JsonRpcLineClient(child.stdout!, child.stdin!);
      try {
        const rpcTimeout = Math.min(timeoutMs, quotaHttpTimeoutMs);
        await rpc.request("initialize", { clientInfo: { name: "harness-anything", version: "0.1.0" } }, rpcTimeout);
        child.stdin!.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
        const payload = await rpc.request("account/rateLimits/read", {}, rpcTimeout);
        result = parseCodexRateLimits(payload, "codex-app-server", observedAt);
      } finally {
        rpc.close();
      }
    },
  });
  return result;
}

async function probeCodexOAuthQuota(
  input: SubscriptionQuotaProbeInput,
  observedAt: string,
): Promise<RuntimeSubscriptionQuotaV1 | null> {
  const codexHome = resolveCodexHome(input.env);
  if (!codexHome) return null;
  const configTomlPath = path.join(codexHome, "config.toml");
  const chatgptBaseUrl = existsSync(configTomlPath)
    ? parseCodexChatgptBaseUrl(readFileSync(configTomlPath, "utf8"))
    : null;
  // A subscription Codex instance configured with a custom OpenAI gateway (and no explicit
  // chatgpt_base_url) does not talk to chatgpt.com's backend-api.
  if (chatgptBaseUrl === null && input.hasCustomProviderBaseUrl === true) return null;
  const auth = await readJsonFileReadOnly(path.join(codexHome, "auth.json"), input.signal);
  if (!auth) return null;
  const tokens = isRecord(auth.tokens) ? auth.tokens : null;
  const accessToken = nonEmptyString(tokens?.access_token) ?? nonEmptyString(auth.access_token);
  if (!accessToken) return null;
  registerSecretValue(accessToken);
  const accountId = nonEmptyString(tokens?.account_id) ?? nonEmptyString(auth.account_id);
  const url = resolveCodexUsageUrl(chatgptBaseUrl);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "harness-anything",
    ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
  };
  const payload = await fetchQuotaJson({
    fetchImpl: input.fetchImpl ?? fetch,
    url,
    headers,
    signal: boundedHttpSignal(input.signal, input.timeoutMs),
    providerLabel: "Codex",
  });
  return parseCodexRateLimits(payload, "codex-oauth", observedAt);
}

function parseCodexRateLimits(
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
    observedAt,
    usedIds,
  );
  if (primary) windows.push(primary);
  const secondary = codexWindow(
    rateLimit.secondary ?? rateLimit.secondary_window,
    "secondary",
    "7d",
    "weekly",
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
    if (!isRecord(item)) continue;
    const limitName = nonEmptyString(item.limit_name) ?? nonEmptyString(item.limitName) ?? "additional";
    const nested = isRecord(item.rate_limit) ? item.rate_limit : isRecord(item.rateLimits) ? item.rateLimits : item;
    const nestedPrimary = codexWindow(
      nested.primary_window ?? nested.primary,
      slugify(limitName),
      limitName,
      "bucket",
      observedAt,
      usedIds,
    );
    if (nestedPrimary) windows.push(nestedPrimary);
  }
  const credits = parseCodexCredits(container.credits ?? payload.credits);
  if (windows.length === 0 && credits === undefined) return null;
  const plan =
    nonEmptyString(container.planType) ??
    nonEmptyString(container.plan_type) ??
    nonEmptyString(payload.planType) ??
    nonEmptyString(payload.plan_type);
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
  observedAt: string,
  usedIds: Set<string>,
): RuntimeQuotaWindowV1 | null {
  if (!isRecord(value)) return null;
  const usedRaw = finiteNumber(value.usedPercent ?? value.used_percent);
  const remainingRaw = finiteNumber(value.remainingPercent ?? value.remaining_percent);
  if (usedRaw === null && remainingRaw === null) return null;
  const usedPercent =
    usedRaw !== null ? roundPercent(clamp(usedRaw, 0, 100)) : roundPercent(clamp(100 - remainingRaw!, 0, 100));
  const remainingFraction = roundFraction(1 - usedPercent / 100);
  const durationMins =
    finiteNumber(value.windowDurationMins) ??
    (finiteNumber(value.limit_window_seconds) !== null ? finiteNumber(value.limit_window_seconds)! / 60 : null);
  const label =
    durationMins !== null && fallbackId === "primary"
      ? formatWindowDuration(durationMins, fallbackLabel)
      : durationMins !== null && fallbackId === "secondary"
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

async function probeClaudeOAuthQuota(input: SubscriptionQuotaProbeInput): Promise<RuntimeSubscriptionQuotaV1 | null> {
  const credentials = await readClaudeCredentialsReadOnly(input.env, input.signal);
  if (!credentials) return null;
  registerSecretValue(credentials.accessToken);
  const base = (input.env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL).trim().replace(/\/+$/u, "");
  const url = `${base}/api/oauth/usage`;
  const payload = await fetchQuotaJson({
    fetchImpl: input.fetchImpl ?? fetch,
    url,
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
      "User-Agent": "harness-anything",
    },
    signal: boundedHttpSignal(input.signal, input.timeoutMs),
    providerLabel: "Claude",
  });
  return parseClaudeOAuthUsage(payload, credentials.plan, input.now());
}

async function readClaudeCredentialsReadOnly(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<{ readonly accessToken: string; readonly plan: string | null } | null> {
  const configDir = resolveClaudeConfigDir(env);
  if (!configDir) return null;
  const parsed = await readJsonFileReadOnly(path.join(configDir, ".credentials.json"), signal);
  if (!parsed) return null;
  const oauth = isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : isRecord(parsed.oauth) ? parsed.oauth : parsed;
  const accessToken = nonEmptyString(oauth.accessToken) ?? nonEmptyString(oauth.access_token);
  if (!accessToken) return null;
  const plan = nonEmptyString(oauth.subscriptionType) ?? nonEmptyString(oauth.rateLimitTier);
  return { accessToken, plan };
}

function parseClaudeOAuthUsage(
  payload: Record<string, unknown>,
  fallbackPlan: string | null,
  observedAt: string,
): RuntimeSubscriptionQuotaV1 | null {
  const windows: RuntimeQuotaWindowV1[] = [];
  const specs: readonly [string, string, RuntimeQuotaWindowKind][] = [
    ["five_hour", "5h", "session"],
    ["seven_day", "7d", "weekly"],
    ["seven_day_sonnet", "7d Sonnet", "weekly"],
    ["seven_day_opus", "7d Opus", "weekly"],
    ["seven_day_oauth_apps", "7d OAuth", "weekly"],
  ];
  for (const [key, label, kind] of specs) {
    const raw = payload[key];
    if (!isRecord(raw)) continue;
    const utilization = finiteNumber(raw.utilization);
    if (utilization === null) continue;
    const usedPercent = roundPercent(clamp(utilization, 0, 100));
    const remainingFraction = roundFraction(1 - usedPercent / 100);
    windows.push({
      id: key,
      label,
      kind,
      remainingFraction,
      usedPercent,
      resetsAt: parseIsoTimestamp(raw.resets_at ?? raw.resetsAt),
    });
  }
  const credits = parseClaudeExtraUsage(payload.extra_usage);
  if (windows.length === 0 && credits === undefined) return null;
  const plan = nonEmptyString(payload.plan) ?? nonEmptyString(payload.rate_limit_tier) ?? fallbackPlan;
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

async function probeCopilotOAuthQuota(input: SubscriptionQuotaProbeInput): Promise<RuntimeSubscriptionQuotaV1 | null> {
  const token = await readCopilotTokenReadOnly(input);
  if (!token) return null;
  registerSecretValue(token);
  const base = (input.env.GITHUB_API_URL ?? DEFAULT_GITHUB_API_URL).trim().replace(/\/+$/u, "");
  const url = `${base}/copilot_internal/user`;
  const payload = await fetchQuotaJson({
    fetchImpl: input.fetchImpl ?? fetch,
    url,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/json",
      "Editor-Version": "vscode/1.96.2",
      "Editor-Plugin-Version": "copilot-chat/0.26.7",
      "User-Agent": "harness-anything",
      "X-Github-Api-Version": "2025-04-01",
    },
    signal: boundedHttpSignal(input.signal, input.timeoutMs),
    providerLabel: "Copilot",
  });
  return parseCopilotQuota(payload, input.now());
}

async function readCopilotTokenReadOnly(input: SubscriptionQuotaProbeInput): Promise<string | null> {
  const home = input.env.HOME ?? input.env.USERPROFILE;
  if (home) {
    const candidates = [
      path.join(home, ".copilot", "hosts.json"),
      path.join(home, ".copilot", "apps.json"),
      path.join(home, ".config", "github-copilot", "hosts.json"),
      path.join(home, ".config", "github-copilot", "apps.json"),
    ];
    for (const candidate of candidates) {
      const parsed = await readJsonFileReadOnly(candidate, input.signal);
      if (!parsed) continue;
      for (const entry of Object.values(parsed)) {
        if (!isRecord(entry)) continue;
        const oauthToken = nonEmptyString(entry.oauth_token);
        if (oauthToken) return oauthToken;
      }
    }
  }
  const fromEnv = nonEmptyString(input.env.GH_TOKEN) ?? nonEmptyString(input.env.GITHUB_TOKEN);
  if (fromEnv) return fromEnv;
  if (input.credentialSource === "operator" && input.resolveGithubToken) {
    const resolved = await input.resolveGithubToken();
    if (resolved) return resolved;
  }
  return null;
}

function parseCopilotQuota(payload: Record<string, unknown>, observedAt: string): RuntimeSubscriptionQuotaV1 | null {
  const defaultResetAt = parseIsoTimestamp(payload.quota_reset_date_utc ?? payload.quota_reset_date);
  const windows: RuntimeQuotaWindowV1[] = [];
  const snapshots = isRecord(payload.quota_snapshots) ? payload.quota_snapshots : null;
  if (snapshots) {
    const specs: readonly [string, string][] = [
      ["premium_interactions", "Premium"],
      ["chat", "Chat"],
      ["completions", "Completions"],
    ];
    for (const [key, label] of specs) {
      const snapshot = snapshots[key];
      if (!isRecord(snapshot)) continue;
      const unlimited = snapshot.unlimited === true;
      const percentRemaining = finiteNumber(snapshot.percent_remaining);
      const remaining = finiteNumber(snapshot.remaining);
      const entitlement = finiteNumber(snapshot.entitlement);
      let remainingFraction: number | null = null;
      if (unlimited) remainingFraction = 1;
      else if (percentRemaining !== null) remainingFraction = roundFraction(percentRemaining / 100);
      else if (remaining !== null && entitlement !== null && entitlement > 0)
        remainingFraction = roundFraction(remaining / entitlement);
      if (remainingFraction === null) continue;
      windows.push({
        id: key,
        label,
        kind: "monthly",
        remainingFraction,
        usedPercent: roundPercent((1 - remainingFraction) * 100),
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
      const remainingFraction = roundFraction(remaining / entitlement);
      windows.push({
        id: key,
        label,
        kind: "monthly",
        remainingFraction,
        usedPercent: roundPercent((1 - remainingFraction) * 100),
        resetsAt: defaultResetAt,
      });
    }
  }
  if (windows.length === 0) return null;
  return {
    schemaVersion: 1,
    observedAt,
    source: "copilot-oauth",
    plan: nonEmptyString(payload.copilot_plan),
    windows,
  };
}

async function fetchQuotaJson(input: {
  readonly fetchImpl: typeof fetch;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal;
  readonly providerLabel: string;
}): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await input.fetchImpl(input.url, {
      method: "GET",
      headers: input.headers,
      redirect: "error",
      signal: input.signal,
    });
  } catch (error) {
    const kind = error instanceof Error ? error.name : "network_error";
    throw runtimeInstanceError(
      "runtime_quota_probe_failed",
      `${input.providerLabel} quota request failed (${scrubSecretText(kind)}).`,
    );
  }
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const retrySeconds = retryAfter && /^\d+$/u.test(retryAfter.trim()) ? Number(retryAfter.trim()) : null;
    await response.arrayBuffer().then(
      () => undefined,
      () => undefined,
    );
    const retryNote = retrySeconds !== null ? ` (retry-after ${retrySeconds}s)` : "";
    throw runtimeInstanceError(
      "runtime_quota_probe_failed",
      `${input.providerLabel} quota endpoint returned HTTP ${response.status}${retryNote}.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw runtimeInstanceError(
      "runtime_quota_response_invalid",
      `${input.providerLabel} quota response is not valid JSON.`,
    );
  }
  if (!isRecord(parsed))
    throw runtimeInstanceError(
      "runtime_quota_response_invalid",
      `${input.providerLabel} quota response must be a JSON object.`,
    );
  return parsed;
}

function tryReadJsonObject(
  filePath: string,
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false } {
  try {
    const content = readFileSync(filePath, "utf8");
    if (content.trim().length === 0) return { ok: false };
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? { ok: true, value: parsed } : { ok: false };
  } catch {
    return { ok: false };
  }
}

async function readJsonFileReadOnly(filePath: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  if (!existsSync(filePath)) return null;
  for (let index = 0; index < credentialReadAttempts; index += 1) {
    if (signal.aborted) throw signal.reason;
    const read = tryReadJsonObject(filePath);
    if (read.ok) return read.value;
    if (index + 1 >= credentialReadAttempts) return null;
    await delayAbortable(credentialReadRetryDelayMs, signal);
  }
  return null;
}

function delayAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function resolveCodexHome(env: NodeJS.ProcessEnv): string | null {
  if (nonEmptyString(env.CODEX_HOME)) return env.CODEX_HOME!.trim();
  const home = nonEmptyString(env.HOME) ?? nonEmptyString(env.USERPROFILE);
  return home ? path.join(home, ".codex") : null;
}

function resolveClaudeConfigDir(env: NodeJS.ProcessEnv): string | null {
  if (nonEmptyString(env.CLAUDE_CONFIG_DIR)) return env.CLAUDE_CONFIG_DIR!.trim();
  const home = nonEmptyString(env.HOME) ?? nonEmptyString(env.USERPROFILE);
  return home ? path.join(home, ".claude") : null;
}

function parseCodexChatgptBaseUrl(tomlText: string): string | null {
  for (const rawLine of tomlText.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith("[")) break;
    const match = /^chatgpt_base_url\s*=\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)')$/u.exec(line);
    if (!match) continue;
    const raw = match[1] !== undefined ? match[1].replace(/\\"/gu, '"').replace(/\\\\/gu, "\\") : (match[2] ?? "");
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function stripTomlComment(line: string): string {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (inDouble) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (char === "'") inSingle = false;
      continue;
    }
    if (char === '"') inDouble = true;
    else if (char === "'") inSingle = true;
    else if (char === "#") return line.slice(0, index);
  }
  return line;
}

function resolveCodexUsageUrl(rawBaseUrl: string | null): string {
  const base = (rawBaseUrl ?? DEFAULT_CHATGPT_BASE_URL).trim().replace(/\/+$/u, "");
  if (/\/wham\/usage$/iu.test(base)) return base;
  if (/^https?:\/\/(?:chatgpt\.com|chat\.openai\.com)$/iu.test(base)) return `${base}/backend-api/wham/usage`;
  return `${base}/wham/usage`;
}

function requireAccountHome(env: NodeJS.ProcessEnv, label: string): string {
  const home = env.HOME ?? env.USERPROFILE;
  if (!home)
    throw runtimeInstanceError("runtime_auth_probe_failed", `${label} account probe could not determine its HOME.`);
  return home;
}

function boundedHttpSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(Math.min(timeoutMs, quotaHttpTimeoutMs))]);
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
  const base = candidate.trim() || "window";
  if (!seen.has(base)) {
    seen.add(base);
    return base;
  }
  let suffix = 2;
  while (seen.has(`${base}-${suffix}`)) suffix += 1;
  const next = `${base}-${suffix}`;
  seen.add(next);
  return next;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || "window"
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundPercent(value: number): number {
  return Math.round(clamp(value, 0, 100) * 10) / 10;
}

function roundFraction(value: number): number {
  return Math.round(clamp(value, 0, 1) * 10_000) / 10_000;
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

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw runtimeInstanceError("runtime_quota_response_invalid", `${label} is invalid.`);
}
