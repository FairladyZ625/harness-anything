import { hash as cryptoHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RuntimeSubscriptionQuotaV1 } from "@harness-anything/kernel";
import { runtimeSubscriptionQuotaPolicy } from "@harness-anything/kernel/internal/domain/runtime-instance-contract.ts";
import { writeFileDurably } from "../../../storage/src/durable-file.ts";
import { runtimeInstanceError } from "./agent-runtime-instance-config.ts";
import { runExecutable, runExecutableResult } from "./agent-runtime-installation-discovery.ts";
import {
  parseCodexChatgptBaseUrl,
  providerAuthFile,
  providerConfigDirectory,
} from "./agent-runtime-instance-storage.ts";
import type { RuntimeCredentialSource, RuntimeInstanceKind } from "./agent-runtime-instance-types.ts";
import { JsonRpcLineClient } from "./client/local-json-rpc-client.ts";
import { applyGithubLaunchCredential } from "./runtime-github-credentials.ts";
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

export interface KeychainLookupRequest {
  readonly service: string;
  readonly authenticationUI: "fail";
  readonly userInteractionAllowed: false;
}

export type KeychainLookupResult =
  | { readonly status: "ok"; readonly secret: string }
  | { readonly status: "not_found" }
  | { readonly status: "interaction_not_allowed"; readonly osStatus: number }
  | { readonly status: "error"; readonly osStatus?: number };

export type KeychainLookupRunner = (
  request: KeychainLookupRequest,
  options: { readonly signal: AbortSignal; readonly timeoutMs: number; readonly env: NodeJS.ProcessEnv },
) => Promise<KeychainLookupResult>;

/**
 * Native macOS Security.framework non-interactive generic-password lookup via JXA.
 * Disables UI at BOTH CDSA (`SecKeychainSetUserInteractionAllowed(false)`) and modern
 * SecItem (`kSecUseAuthenticationUI: kSecUseAuthenticationUIFail`) layers so locked
 * keychains or ACL-protected items fail immediately with `-25308` instead of opening dialogs.
 */
const macOsNonInteractiveKeychainScript = [
  'ObjC.import("Foundation");',
  'ObjC.import("Security");',
  "function run(argv) {",
  "  var service = argv && argv.length > 0 ? String(argv[0]) : '';",
  "  if (!service) return JSON.stringify({ status: 'error' });",
  "  var uiStatus = $.SecKeychainSetUserInteractionAllowed(false);",
  "  if (uiStatus !== 0) return JSON.stringify({ status: 'error', osStatus: Number(uiStatus) });",
  "  var query = $.NSMutableDictionary.dictionary;",
  '  query.setObjectForKey($("genp"), $("class"));',
  '  query.setObjectForKey($(service), $("svce"));',
  '  query.setObjectForKey($(true), $("r_Data"));',
  '  query.setObjectForKey($("m_LimitOne"), $("m_Limit"));',
  '  query.setObjectForKey($("u_AuthUIF"), $("u_AuthUI"));',
  "  var out = Ref();",
  "  var status = Number($.SecItemCopyMatching(query, out));",
  "  if (status === -25308) return JSON.stringify({ status: 'interaction_not_allowed', osStatus: status });",
  "  if (status === -25300) return JSON.stringify({ status: 'not_found' });",
  "  if (status !== 0) return JSON.stringify({ status: 'error', osStatus: status });",
  "  var raw = out[0];",
  "  var nsData = raw && typeof raw.length === 'number' ? raw : ObjC.castRefToObject(raw);",
  "  var text = $.NSString.alloc.initWithDataEncoding(nsData, $.NSUTF8StringEncoding);",
  "  if (!text) return JSON.stringify({ status: 'error' });",
  "  return JSON.stringify({ status: 'ok', secret: ObjC.unwrap(text) });",
  "}",
].join("\n");

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

const noBrowserLauncherNames = ["open", "xdg-open", "gio", "start"] as const;
const noBrowserShimDirs = new Map<string, string>();

function ensureNoBrowserLauncherShimDir(platform: NodeJS.Platform): string {
  const baseTmp = tmpdir(),
    cacheKey = `${platform}:${baseTmp}`,
    existing = noBrowserShimDirs.get(cacheKey),
    sentinelName = platform === "win32" ? `${noBrowserLauncherNames[0]}.cmd` : noBrowserLauncherNames[0];
  if (existing && existsSync(path.join(existing, sentinelName))) return existing;
  const dir = path.join(baseTmp, `ha-no-browser-shim-${randomUUID()}`);
  for (const name of noBrowserLauncherNames) {
    if (platform === "win32") {
      writeFileDurably(path.join(dir, `${name}.cmd`), "@exit /b 126\r\n", 0o755);
    } else {
      writeFileDurably(path.join(dir, name), "#!/bin/sh\nexit 126\n", 0o755);
    }
  }
  noBrowserShimDirs.set(cacheKey, dir);
  return dir;
}

export function agyNonInteractiveProbeEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const shimDir = ensureNoBrowserLauncherShimDir(platform);
  const existingPath = env.PATH ?? env.Path ?? process.env.PATH ?? "";
  const guardedPath = existingPath ? `${shimDir}${path.delimiter}${existingPath}` : shimDir;
  return {
    ...env,
    // Enforce non-interactive headless background execution: suppress browser launch (both via
    // env conventions and by shadowing OS URL launchers on PATH) and CLI auto-update (`"true"`).
    PATH: guardedPath,
    CI: "1",
    BROWSER: "false",
    NO_BROWSER: "1",
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    NO_UPDATE_NOTIFIER: "1",
    ...(env.SSH_CONNECTION ? {} : { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 22" }),
  };
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
  const probeEnv = agyNonInteractiveProbeEnv(env, platform);
  // Prefer modern `agy -p /usage --output-format json` (>=1.2.2); fall back to legacy `/quota`
  // when `/usage` is unsupported or returns an unrecognized command envelope.
  const usageResult = await runExecutableResult(platform, executablePath, ["-p", "/usage", "--output-format", "json"], {
    env: probeEnv,
    timeoutMs,
    input: "",
    signal,
  });
  if (usageResult.exitCode === 0) {
    const parsedUsage = tryParseAgyQuota(usageResult.stdout, observedAt, { expectedCommand: "usage" });
    if (parsedUsage.ok) return parsedUsage.value;
  }
  if (signal.aborted) throw signal.reason;
  const legacyResult = await runExecutableResult(
    platform,
    executablePath,
    ["-p", "/quota", "--output-format", "json"],
    {
      env: probeEnv,
      timeoutMs,
      input: "",
      signal,
    },
  );
  if (legacyResult.exitCode !== 0)
    throw runtimeInstanceError(
      "runtime_quota_probe_failed",
      `AGY quota probe exited with status ${legacyResult.exitCode}.`,
    );
  return parseAgyQuotaResponse(legacyResult.stdout, observedAt, { expectedCommand: "quota" });
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

async function readMacOsKeychainNonInteractive(
  platform: NodeJS.Platform,
  request: KeychainLookupRequest,
  options: { readonly signal: AbortSignal; readonly timeoutMs: number; readonly env: NodeJS.ProcessEnv },
): Promise<KeychainLookupResult> {
  const result = await runExecutableResult(
    platform,
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", macOsNonInteractiveKeychainScript, "--", request.service],
    {
      env: options.env,
      timeoutMs: options.timeoutMs,
      input: "",
      signal: options.signal,
    },
  );
  if (result.exitCode !== 0) return { status: "error" };
  const parsed = tryParseJsonObject(result.stdout);
  if (!parsed.ok) return { status: "error" };
  const status = parsed.value.status;
  if (status === "ok" && typeof parsed.value.secret === "string") return { status: "ok", secret: parsed.value.secret };
  if (status === "not_found") return { status: "not_found" };
  if (status === "interaction_not_allowed") {
    return {
      status: "interaction_not_allowed",
      osStatus: typeof parsed.value.osStatus === "number" ? parsed.value.osStatus : -25308,
    };
  }
  return {
    status: "error",
    ...(typeof parsed.value.osStatus === "number" ? { osStatus: parsed.value.osStatus } : {}),
  };
}

async function readClaudeMacOsKeychainCredentials(
  platform: NodeJS.Platform,
  input: SubscriptionQuotaProbeInput,
): Promise<{ readonly accessToken: string; readonly plan: string | null } | null> {
  const timeoutMs = Math.min(input.timeoutMs, keychainReadTimeoutMs);
  const runner: KeychainLookupRunner =
    input.runKeychainLookup ?? ((request, options) => readMacOsKeychainNonInteractive(platform, request, options));
  const keychainSignal = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]);
  const lookup = await runner(
    {
      service: claudeKeychainService,
      authenticationUI: "fail",
      userInteractionAllowed: false,
    },
    { signal: keychainSignal, timeoutMs, env: input.env },
  ).then(
    (result) => result,
    () => null,
  );
  if (!lookup || lookup.status !== "ok") return null;
  const parsed = parseKeychainJsonPayload(lookup.secret);
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
 * Reuses the exact daemon launch GitHub credential injection (`applyGithubLaunchCredential`)
 * and Copilot CLI authentication precedence so quota always reflects the launched account:
 * 1. Apply the store's launch GitHub token (`GH_TOKEN`) to a copy of the instance environment.
 * 2. Read `COPILOT_GITHUB_TOKEN` -> `GH_TOKEN` -> `GITHUB_TOKEN` from that launch-effective env.
 * 3. Only when no launch env token is present, match the active `github.com` user in CLI-owned
 *    `$COPILOT_HOME/{config,hosts,apps}.json` (defaulting to `~/.copilot`, never editor
 *    `~/.config/github-copilot/*` files, and never falling back from `COPILOT_HOME` to `~/.copilot`).
 */
async function readCopilotTokenReadOnly(input: SubscriptionQuotaProbeInput): Promise<string | null> {
  const effectiveEnv: NodeJS.ProcessEnv = { ...input.env };
  if (input.resolveGithubToken) {
    const launchToken = await input.resolveGithubToken().then(
      (token) => usableEnvToken(token),
      () => null,
    );
    applyGithubLaunchCredential(effectiveEnv, launchToken);
  }
  const fromEnv =
    usableEnvToken(effectiveEnv.COPILOT_GITHUB_TOKEN) ??
    usableEnvToken(effectiveEnv.GH_TOKEN) ??
    usableEnvToken(effectiveEnv.GITHUB_TOKEN);
  if (fromEnv) return fromEnv;
  const copilotHome = resolveCopilotHome(effectiveEnv);
  if (!copilotHome) return null;
  const active = await readCopilotActiveAccount(copilotHome, input.signal);
  if (active.host !== null && active.host !== "github.com") return null;
  const candidates = [path.join(copilotHome, "hosts.json"), path.join(copilotHome, "apps.json")];
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

function usableEnvToken(value: unknown): string | null {
  const token = nonEmptyString(value);
  return token && !/\s/u.test(token) ? token : null;
}

async function readCopilotActiveAccount(
  copilotHome: string,
  signal: AbortSignal,
): Promise<{ readonly user: string | null; readonly host: string | null }> {
  const config = await readJsonFileReadOnly(path.join(copilotHome, "config.json"), signal);
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

function tryParseAgyQuota(
  output: string,
  observedAt: string,
  options: { readonly expectedCommand?: "usage" | "quota" },
): { readonly ok: true; readonly value: RuntimeSubscriptionQuotaV1 } | { readonly ok: false } {
  try {
    return { ok: true, value: parseAgyQuotaResponse(output, observedAt, options) };
  } catch {
    return { ok: false };
  }
}

function tryReadFileBytes(filePath: string): { readonly ok: true; readonly value: Buffer } | { readonly ok: false } {
  try {
    return { ok: true, value: readFileSync(filePath) };
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

function resolveCopilotHome(env: NodeJS.ProcessEnv): string | null {
  if (nonEmptyString(env.COPILOT_HOME)) return env.COPILOT_HOME!.trim();
  const home = nonEmptyString(env.HOME) ?? nonEmptyString(env.USERPROFILE);
  return home ? path.join(home, ".copilot") : null;
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

/**
 * Computes an in-memory SHA-256 fingerprint of an instance's active subscription credential files
 * (and Copilot env tokens) so an async probe started before a credential swap fails closed on commit.
 * Never persists, logs, or returns raw credential bytes.
 */
export function subscriptionCredentialGeneration(kindId: RuntimeInstanceKind, env: NodeJS.ProcessEnv): string {
  const chunks: Buffer[] = [Buffer.from(`${kindId}\0`)];
  const candidates: string[] = [];
  const home = nonEmptyString(env.HOME) ?? nonEmptyString(env.USERPROFILE);
  if (kindId === "codex" || kindId === "codex-acp") {
    const codexHome = resolveCodexHome(env);
    if (codexHome) candidates.push(path.join(codexHome, "auth.json"));
  } else if (kindId === "claude" || kindId === "claude-acp") {
    const claudeDir = resolveClaudeConfigDir(env);
    if (claudeDir) candidates.push(path.join(claudeDir, ".credentials.json"));
  } else if (kindId === "agy" || kindId === "agy-acp") {
    if (home) {
      const configDir = providerConfigDirectory(home, kindId);
      candidates.push(
        path.join(configDir, "antigravity-oauth-token"),
        path.join(configDir, "antigravity-cli", "antigravity-oauth-token"),
        path.join(configDir, "oauth_creds.json"),
        path.join(configDir, "jetski_state.pbtxt"),
      );
    }
  } else if (kindId === "copilot") {
    for (const key of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const) {
      chunks.push(Buffer.from(`env:${key}=${usableEnvToken(env[key]) ?? ""}\0`));
    }
    const copilotHome = resolveCopilotHome(env);
    if (copilotHome) {
      chunks.push(Buffer.from(`copilotHome:${copilotHome}\0`));
      candidates.push(
        path.join(copilotHome, "config.json"),
        path.join(copilotHome, "hosts.json"),
        path.join(copilotHome, "apps.json"),
      );
    }
  } else {
    const authFile = providerAuthFile(kindId);
    if (home && authFile) candidates.push(path.join(providerConfigDirectory(home, kindId), authFile));
  }
  for (const filePath of candidates) {
    chunks.push(Buffer.from(`file:${filePath}\0`));
    if (existsSync(filePath)) {
      const file = tryReadFileBytes(filePath);
      chunks.push(file.ok ? Buffer.concat([Buffer.from("present:"), file.value]) : Buffer.from("unreadable"));
    } else {
      chunks.push(Buffer.from("absent"));
    }
    chunks.push(Buffer.from("\0"));
  }
  return cryptoHash("sha256", Buffer.concat(chunks), "hex");
}
