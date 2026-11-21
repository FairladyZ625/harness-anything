import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { RuntimeSubscriptionQuotaV1 } from "@harness-anything/kernel";
import { runtimeSubscriptionQuotaPolicy } from "@harness-anything/kernel/internal/domain/runtime-instance-contract.ts";
import { runtimeInstanceError } from "./agent-runtime-instance-config.ts";
import { runExecutable, runExecutableResult } from "./agent-runtime-installation-discovery.ts";
import { parseCodexChatgptBaseUrl } from "./agent-runtime-instance-storage.ts";
import type { RuntimeCredentialSource, RuntimeInstanceKind } from "./agent-runtime-instance-types.ts";
import { JsonRpcLineClient } from "./client/local-json-rpc-client.ts";
import { registerSecretValue, scrubSecretText } from "../runtime-engine/secret-scrub.ts";
import {
  CLAUDE_OAUTH_USAGE_URL,
  COPILOT_USAGE_URL,
  parseAgyQuotaResponse,
  parseClaudeOAuthUsage,
  parseCodexRateLimits,
  parseCopilotQuota,
  resolveCodexUsageUrl,
  sanitizeQuotaText,
} from "./runtime-subscription-quota-parse.ts";

export { parseAgyQuotaResponse, resolveCodexUsageUrl };

const quotaHttpTimeoutMs = runtimeSubscriptionQuotaPolicy.defaultValue.httpTimeoutMs;
const keychainReadTimeoutMs = runtimeSubscriptionQuotaPolicy.defaultValue.keychainReadTimeoutMs;
const credentialReadRetryDelayMs = runtimeSubscriptionQuotaPolicy.defaultValue.credentialReadRetryDelayMs;
const credentialReadAttempts = runtimeSubscriptionQuotaPolicy.defaultValue.credentialReadAttempts;
const claudeKeychainService = "Claude Code-credentials";

export type KeychainLookupRunner = (
  args: readonly string[],
  options: { readonly signal: AbortSignal; readonly timeoutMs: number; readonly env: NodeJS.ProcessEnv },
) => Promise<{ readonly exitCode: number | null; readonly stdout: string }>;

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
  readonly runKeychainLookup?: KeychainLookupRunner;
}

/**
 * Read-only subscription quota probe across supported providers (AGY, Codex, Claude, Copilot).
 * Never modifies CLI credential files, pins OAuth usage endpoints to their issuing origins,
 * enforces `redirect: "error"` with bounded timeouts on every HTTP request, and degrades
 * cleanly when macOS Keychain access is locked or denied.
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
    return probeClaudeOAuthQuota(platform, input);
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
  const url = resolveCodexUsageUrl(chatgptBaseUrl);
  if (url === null) return null;
  const auth = await readJsonFileReadOnly(path.join(codexHome, "auth.json"), input.signal);
  if (!auth) return null;
  const tokens = isRecord(auth.tokens) ? auth.tokens : null;
  const accessToken = nonEmptyString(tokens?.access_token) ?? nonEmptyString(auth.access_token);
  if (!accessToken) return null;
  registerSecretValue(accessToken);
  const accountId = nonEmptyString(tokens?.account_id) ?? nonEmptyString(auth.account_id);
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

async function probeClaudeOAuthQuota(
  platform: NodeJS.Platform,
  input: SubscriptionQuotaProbeInput,
): Promise<RuntimeSubscriptionQuotaV1 | null> {
  const credentials = await readClaudeCredentialsReadOnly(platform, input);
  if (!credentials) return null;
  registerSecretValue(credentials.accessToken);
  const payload = await fetchQuotaJson({
    fetchImpl: input.fetchImpl ?? fetch,
    url: CLAUDE_OAUTH_USAGE_URL,
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
  platform: NodeJS.Platform,
  input: SubscriptionQuotaProbeInput,
): Promise<{ readonly accessToken: string; readonly plan: string | null } | null> {
  const configDir = resolveClaudeConfigDir(input.env);
  if (configDir) {
    const parsed = await readJsonFileReadOnly(path.join(configDir, ".credentials.json"), input.signal);
    const extracted = parsed ? extractClaudeCredentials(parsed) : null;
    if (extracted) return extracted;
  }
  if (platform !== "darwin" || input.credentialSource !== "operator") return null;
  if (input.env.HARNESS_DISABLE_KEYCHAIN_PROBE === "1") return null;
  return readClaudeMacOsKeychainCredentials(platform, input);
}

function extractClaudeCredentials(
  parsed: Record<string, unknown>,
): { readonly accessToken: string; readonly plan: string | null } | null {
  const oauth = isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : isRecord(parsed.oauth) ? parsed.oauth : parsed;
  const accessToken = nonEmptyString(oauth.accessToken) ?? nonEmptyString(oauth.access_token);
  if (!accessToken) return null;
  const plan = sanitizeQuotaText(oauth.subscriptionType, 48) ?? sanitizeQuotaText(oauth.rateLimitTier, 48);
  return { accessToken, plan };
}

async function readClaudeMacOsKeychainCredentials(
  platform: NodeJS.Platform,
  input: SubscriptionQuotaProbeInput,
): Promise<{ readonly accessToken: string; readonly plan: string | null } | null> {
  const timeoutMs = Math.min(input.timeoutMs, keychainReadTimeoutMs);
  const runner: KeychainLookupRunner =
    input.runKeychainLookup ?? ((args, options) => runExecutableResult(platform, "/usr/bin/security", args, options));
  const keychainSignal = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]);
  const readKeychain = (args: readonly string[]) =>
    runner(args, { signal: keychainSignal, timeoutMs, env: input.env }).then(
      (result) => result,
      () => null,
    );
  // Metadata check first (no `-w`): exits non-zero without touching ACL when absent.
  const exists = await readKeychain(["find-generic-password", "-s", claudeKeychainService]);
  if (!exists || exists.exitCode !== 0) return null;
  const secret = await readKeychain(["find-generic-password", "-s", claudeKeychainService, "-w"]);
  if (!secret || secret.exitCode !== 0) return null;
  const parsed = parseKeychainJsonPayload(secret.stdout);
  return parsed ? extractClaudeCredentials(parsed) : null;
}

function parseKeychainJsonPayload(rawOutput: string): Record<string, unknown> | null {
  const trimmed = rawOutput.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  if (/^[0-9a-f]+$/iu.test(trimmed) && trimmed.length % 2 === 0) {
    candidates.push(Buffer.from(trimmed, "hex").toString("utf8").trim());
  }
  for (const candidate of candidates) {
    const parsed = tryParseJsonObject(candidate);
    if (parsed.ok) return parsed.value;
  }
  return null;
}

async function probeCopilotOAuthQuota(input: SubscriptionQuotaProbeInput): Promise<RuntimeSubscriptionQuotaV1 | null> {
  const token = await readCopilotTokenReadOnly(input);
  if (!token) return null;
  registerSecretValue(token);
  const payload = await fetchQuotaJson({
    fetchImpl: input.fetchImpl ?? fetch,
    url: COPILOT_USAGE_URL,
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

/**
 * Aligns Copilot token resolution with Copilot CLI & daemon launch precedence:
 * 1. `COPILOT_GITHUB_TOKEN` -> `GH_TOKEN` -> `GITHUB_TOKEN`
 * 2. Operator injected GitHub token (applied as `GH_TOKEN` at launch for operator instances)
 * 3. Configured active `github.com` account in local Copilot `hosts.json`/`apps.json`
 *    (returns null rather than guessing when multiple accounts exist without an active match).
 */
async function readCopilotTokenReadOnly(input: SubscriptionQuotaProbeInput): Promise<string | null> {
  const fromEnv =
    nonEmptyString(input.env.COPILOT_GITHUB_TOKEN) ??
    nonEmptyString(input.env.GH_TOKEN) ??
    nonEmptyString(input.env.GITHUB_TOKEN);
  if (fromEnv) return fromEnv;
  if (input.credentialSource === "operator" && input.resolveGithubToken) {
    const resolved = nonEmptyString(await input.resolveGithubToken());
    if (resolved) return resolved;
  }
  const home = input.env.HOME ?? input.env.USERPROFILE;
  if (!home) return null;
  const active = await readCopilotActiveAccount(home, input.signal);
  if (active.host !== null && active.host !== "github.com") return null;
  const candidates = [
    path.join(home, ".copilot", "hosts.json"),
    path.join(home, ".copilot", "apps.json"),
    path.join(home, ".config", "github-copilot", "hosts.json"),
    path.join(home, ".config", "github-copilot", "apps.json"),
  ];
  const matchedEntries: Array<{ readonly user: string | null; readonly token: string }> = [];
  for (const candidate of candidates) {
    const parsed = await readJsonFileReadOnly(candidate, input.signal);
    if (!parsed) continue;
    for (const [hostKey, entry] of Object.entries(parsed)) {
      if (!isGithubDotComHostKey(hostKey) || !isRecord(entry)) continue;
      const oauthToken = nonEmptyString(entry.oauth_token);
      if (!oauthToken) continue;
      const user = nonEmptyString(entry.user)?.toLowerCase() ?? null;
      matchedEntries.push({ user, token: oauthToken });
    }
  }
  if (active.user !== null) {
    const activeTokens = new Set(
      matchedEntries.filter((entry) => entry.user === active.user).map((entry) => entry.token),
    );
    return activeTokens.size === 1 ? [...activeTokens][0]! : null;
  }
  const distinctTokens = new Set(matchedEntries.map((entry) => entry.token));
  return distinctTokens.size === 1 ? [...distinctTokens][0]! : null;
}

async function readCopilotActiveAccount(
  home: string,
  signal: AbortSignal,
): Promise<{ readonly user: string | null; readonly host: string | null }> {
  const config = await readJsonFileReadOnly(path.join(home, ".copilot", "config.json"), signal);
  if (!config) return { user: null, host: null };
  const last = isRecord(config.last_logged_in_user) ? config.last_logged_in_user : null;
  const user =
    nonEmptyString(last?.login)?.toLowerCase() ??
    nonEmptyString(last?.user)?.toLowerCase() ??
    nonEmptyString(config.active_user)?.toLowerCase() ??
    nonEmptyString(config.user)?.toLowerCase() ??
    null;
  const rawHost = nonEmptyString(last?.host)?.toLowerCase() ?? null;
  const host = rawHost ? rawHost.replace(/^https?:\/\//u, "").replace(/\/.*$/u, "") : null;
  return { user, host };
}

function isGithubDotComHostKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return normalized === "github.com" || normalized.startsWith("github.com:");
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

function tryParseJsonObject(
  content: string,
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false } {
  try {
    if (content.trim().length === 0) return { ok: false };
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? { ok: true, value: parsed } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function tryReadJsonObject(
  filePath: string,
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false } {
  try {
    return tryParseJsonObject(readFileSync(filePath, "utf8"));
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

function requireAccountHome(env: NodeJS.ProcessEnv, label: string): string {
  const home = env.HOME ?? env.USERPROFILE;
  if (!home)
    throw runtimeInstanceError("runtime_auth_probe_failed", `${label} account probe could not determine its HOME.`);
  return home;
}

function boundedHttpSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(Math.min(timeoutMs, quotaHttpTimeoutMs))]);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
