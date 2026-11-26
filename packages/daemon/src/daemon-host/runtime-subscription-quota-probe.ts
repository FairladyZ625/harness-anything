import { hash as cryptoHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
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
import { createHostScratchDirectory } from "./host-environment-io.ts";
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
  /** Reports a verified account identity digest independent of OAuth token rotation. */
  readonly onCredentialFingerprint?: (fingerprint: string) => void;
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
  const baseEnv: NodeJS.ProcessEnv = {};
  let envPath: string | undefined;
  for (const [key, value] of Object.entries(env)) {
    if (platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH") {
      if (key === "PATH" && value !== undefined) envPath = value;
      else if (envPath === undefined && value !== undefined) envPath = value;
      continue;
    }
    baseEnv[key] = value;
  }
  const existingPath = envPath ?? process.env.PATH ?? process.env.Path ?? "";
  const guardedPath = existingPath ? `${shimDir}${path.delimiter}${existingPath}` : shimDir;
  return {
    ...baseEnv,
    // Enforce non-interactive headless background execution: suppress browser launch (both via
    // env conventions and by shadowing OS URL launchers on PATH) and CLI auto-update (`"true"`).
    // Never fabricate SSH_CONNECTION here: isolated instances already set it in isolatedEnvironment,
    // while operator-environment instances rely on it staying unset for host Keychain login.
    PATH: guardedPath,
    CI: "1",
    BROWSER: "false",
    NO_BROWSER: "1",
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    NO_UPDATE_NOTIFIER: "1",
  };
}

const agyStagedReadOnlyFiles = [
  "antigravity-oauth-token",
  "oauth_creds.json",
  "google_accounts.json",
  "settings.json",
  "jetski_state.pbtxt",
  path.join("antigravity-cli", "antigravity-oauth-token"),
  path.join("antigravity-cli", "jetski_state.pbtxt"),
  path.join("antigravity-cli", "settings.json"),
] as const;

/**
 * Isolates native provider CLI file writes in a mode-0700 scratch directory.
 */
function stageReadOnlyProbeHome(
  kind: "agy" | "codex",
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  codexAuth?: Record<string, unknown> | null,
): { readonly env: NodeJS.ProcessEnv; readonly cwd: string; readonly close: () => void } {
  const scratch = createHostScratchDirectory("providerProbeHome");
  try {
    if (platform !== "win32") chmodSync(scratch.directory, 0o700);
    const stageFile = (sourceFile: string, destinationFile: string): void => {
      if (!statSync(sourceFile, { throwIfNoEntry: false })?.isFile()) return;
      const bytes = tryReadFileBytes(sourceFile);
      if (!bytes.ok) return;
      writeFileDurably(destinationFile, bytes.value, 0o600);
    };
    const stagedEnv: NodeJS.ProcessEnv = {
      ...env,
      HOME: scratch.directory,
      USERPROFILE: scratch.directory,
      XDG_CONFIG_HOME: path.join(scratch.directory, ".config"),
      XDG_DATA_HOME: path.join(scratch.directory, ".local", "share"),
      XDG_CACHE_HOME: path.join(scratch.directory, ".cache"),
    };
    if (kind === "codex") {
      const realCodexHome = resolveCodexHome(env);
      const stagedCodexHome = path.join(scratch.directory, ".codex");
      if (realCodexHome) {
        stageFile(path.join(realCodexHome, "config.toml"), path.join(stagedCodexHome, "config.toml"));
        if (isRecord(codexAuth?.tokens)) {
          const { access_token, id_token, account_id } = codexAuth.tokens;
          // Codex requires a string refresh_token even in externally managed auth mode.
          writeFileDurably(
            path.join(stagedCodexHome, "auth.json"),
            JSON.stringify({
              auth_mode: "chatgptAuthTokens",
              tokens: { access_token, id_token, account_id, refresh_token: "" },
              last_refresh: codexAuth.last_refresh,
            }),
            0o600,
          );
        }
      }
      if (platform !== "win32" && existsSync(stagedCodexHome)) chmodSync(stagedCodexHome, 0o700);
      stagedEnv.CODEX_HOME = stagedCodexHome;
    } else {
      const realHome = requireAccountHome(env, "AGY");
      const realGeminiDir = providerConfigDirectory(realHome, "agy");
      const stagedGeminiDir = providerConfigDirectory(scratch.directory, "agy");
      for (const relativePath of agyStagedReadOnlyFiles) {
        stageFile(path.join(realGeminiDir, relativePath), path.join(stagedGeminiDir, relativePath));
      }
      if (platform !== "win32" && existsSync(stagedGeminiDir)) chmodSync(stagedGeminiDir, 0o700);
    }
    return { env: stagedEnv, cwd: scratch.directory, close: scratch.close };
  } catch (error) {
    scratch.close();
    throw error;
  }
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
  const staged = stageReadOnlyProbeHome("agy", env, platform);
  try {
    const probeEnv = agyNonInteractiveProbeEnv(staged.env, platform);
    // Prefer modern `agy -p /usage --output-format json` (>=1.2.2); fall back to legacy `/quota`
    // when `/usage` is unsupported or returns an unrecognized command envelope.
    const usageResult = await runExecutableResult(
      platform,
      executablePath,
      ["-p", "/usage", "--output-format", "json"],
      {
        env: probeEnv,
        cwd: staged.cwd,
        timeoutMs,
        input: "",
        signal,
      },
    );
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
        cwd: staged.cwd,
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
  } finally {
    staged.close();
  }
}

async function probeCodexQuota(
  platform: NodeJS.Platform,
  input: SubscriptionQuotaProbeInput,
): Promise<RuntimeSubscriptionQuotaV1 | null> {
  const observedAt = input.now(),
    codexHome = resolveCodexHome(input.env),
    auth = codexHome ? await readJsonFileReadOnly(path.join(codexHome, "auth.json"), input.signal) : null,
    tokens = isRecord(auth?.tokens) ? auth.tokens : auth;
  reportAccountFingerprint(input, nonEmptyString(tokens?.account_id));
  if (input.executablePath) {
    const rpcQuota = await probeCodexAppServerQuota(
      platform,
      input.executablePath,
      input.env,
      input.signal,
      input.timeoutMs,
      observedAt,
      auth,
    ).then(
      (quota) => quota,
      () => null,
    );
    if (rpcQuota !== null) return rpcQuota;
  }
  return codexHome && auth ? probeCodexOAuthQuota(input, observedAt, codexHome, auth) : null;
}

async function probeCodexAppServerQuota(
  platform: NodeJS.Platform,
  executablePath: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeoutMs: number,
  observedAt: string,
  auth: Record<string, unknown> | null,
): Promise<RuntimeSubscriptionQuotaV1 | null> {
  const staged = stageReadOnlyProbeHome("codex", env, platform, auth);
  try {
    let result: RuntimeSubscriptionQuotaV1 | null = null;
    await runExecutable(platform, executablePath, ["app-server"], {
      env: staged.env,
      cwd: staged.cwd,
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
  } finally {
    staged.close();
  }
}

async function probeCodexOAuthQuota(
  input: SubscriptionQuotaProbeInput,
  observedAt: string,
  codexHome: string,
  auth: Record<string, unknown>,
): Promise<RuntimeSubscriptionQuotaV1 | null> {
  const configTomlPath = path.join(codexHome, "config.toml");
  const chatgptBaseUrl = existsSync(configTomlPath)
    ? parseCodexChatgptBaseUrl(readFileSync(configTomlPath, "utf8"))
    : null;
  // A subscription Codex instance configured with a custom OpenAI gateway (and no explicit
  // chatgpt_base_url) does not talk to chatgpt.com's backend-api.
  if (chatgptBaseUrl === null && input.hasCustomProviderBaseUrl === true) return null;
  const url = resolveCodexUsageUrl(chatgptBaseUrl);
  if (url === null) return null;
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
  }).finally(async () => {
    const active = await readClaudeCredentialsReadOnly(platform, input);
    if (!active) throw runtimeInstanceError("runtime_quota_probe_failed", "Claude credentials could not be rechecked.");
    if (active.accessToken !== credentials.accessToken || active.identity !== credentials.identity)
      throw runtimeInstanceError("runtime_instance_probe_stale", "Claude credentials changed during the quota probe.");
    reportAccountFingerprint(input, active.identity);
  });
  const quota = parseClaudeOAuthUsage(payload, credentials.plan, input.now());
  // An opaque token proves continuity only for observations made with that same token.
  if (quota && !credentials.identity) {
    input.onCredentialFingerprint?.(`credential:${cryptoHash("sha256", credentials.accessToken, "hex")}`);
  }
  return quota;
}

type ClaudeQuotaCredentials = {
  readonly accessToken: string;
  readonly plan: string | null;
  readonly identity: string | null;
};

async function readClaudeCredentialsReadOnly(
  platform: NodeJS.Platform,
  input: SubscriptionQuotaProbeInput,
): Promise<ClaudeQuotaCredentials | null> {
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

function extractClaudeCredentials(parsed: Record<string, unknown>): ClaudeQuotaCredentials | null {
  const oauth = isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : isRecord(parsed.oauth) ? parsed.oauth : parsed;
  const accessToken = nonEmptyString(oauth.accessToken) ?? nonEmptyString(oauth.access_token);
  if (!accessToken) return null;
  const plan = sanitizeQuotaText(oauth.subscriptionType, 48) ?? sanitizeQuotaText(oauth.rateLimitTier, 48);
  const jwtPayload = accessToken.split(".")[1];
  const claims = jwtPayload ? tryParseJsonObject(Buffer.from(jwtPayload, "base64url").toString("utf8")) : null;
  const subject = nonEmptyString(oauth.accountUuid) ?? (claims?.ok ? nonEmptyString(claims.value.sub) : null);
  return {
    accessToken,
    plan,
    identity: subject ? JSON.stringify([subject, nonEmptyString(oauth.organizationUuid)]) : null,
  };
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
): Promise<ClaudeQuotaCredentials | null> {
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
  const options = {
    fetchImpl: input.fetchImpl ?? fetch,
    signal: boundedHttpSignal(input.signal, input.timeoutMs),
    providerLabel: "Copilot",
  };
  const authorization = `token ${token}`;
  const identity = input.onCredentialFingerprint
    ? fetchQuotaJson({ ...options, url: "https://api.github.com/user", headers: { Authorization: authorization } })
    : null;
  const usage = fetchQuotaJson({
    ...options,
    url: COPILOT_USAGE_URL,
    headers: {
      Authorization: authorization,
      Accept: "application/json",
      "Editor-Version": "vscode/1.96.2",
      "Editor-Plugin-Version": "copilot-chat/0.26.7",
      "User-Agent": "harness-anything",
      "X-Github-Api-Version": "2025-04-01",
    },
  });
  const [account, payload] = await Promise.allSettled([identity, usage]);
  if (account.status === "fulfilled" && typeof account.value?.id === "number")
    reportAccountFingerprint(input, String(account.value.id));
  if (payload.status === "rejected") throw payload.reason;
  return parseCopilotQuota(payload.value, input.now());
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
  const config = await readJsonFileReadOnly(path.join(copilotHome, "config.json"), input.signal);
  const active = parseCopilotActiveAccount(config);
  if (active.host !== null && active.host !== "github.com") return null;
  const candidates = [path.join(copilotHome, "hosts.json"), path.join(copilotHome, "apps.json")];
  const fileEntries: Array<{ readonly user: string | null; readonly token: string }> = [];
  for (const candidate of candidates) {
    const parsed = await readJsonFileReadOnly(candidate, input.signal);
    if (!parsed) continue;
    for (const [hostKey, entry] of Object.entries(parsed)) {
      if (!isGithubDotComHostKey(hostKey) || !isRecord(entry)) continue;
      const oauthToken = usableEnvToken(entry.oauth_token);
      if (!oauthToken) continue;
      const user = nonEmptyString(entry.user)?.toLowerCase() ?? null;
      fileEntries.push({ user, token: oauthToken });
    }
  }
  const selectOwnedToken = (
    entries: readonly { readonly user: string | null; readonly token: string }[],
  ): string | null => {
    if (active.user !== null) {
      const activeTokens = new Set(entries.filter((entry) => entry.user === active.user).map((entry) => entry.token));
      return activeTokens.size === 1 ? [...activeTokens][0]! : null;
    }
    const knownUsers = new Set<string>(active.loggedInUsers);
    for (const entry of entries) {
      if (entry.user !== null) knownUsers.add(entry.user);
    }
    if (knownUsers.size > 1) return null;
    const distinctTokens = new Set(entries.map((entry) => entry.token));
    return distinctTokens.size === 1 ? [...distinctTokens][0]! : null;
  };
  const hasFileCandidates =
    active.user !== null ? fileEntries.some((entry) => entry.user === active.user) : fileEntries.length > 0;
  if (hasFileCandidates) return selectOwnedToken(fileEntries);
  const configEntries = extractCopilotConfigTokens(config, active.user);
  return selectOwnedToken(configEntries);
}

function usableEnvToken(value: unknown): string | null {
  const token = nonEmptyString(value);
  return token && !/\s/u.test(token) ? token : null;
}

function normalizeCopilotHost(rawHost: unknown): string | null {
  const text = nonEmptyString(rawHost)?.toLowerCase() ?? null;
  if (!text) return null;
  return text.replace(/^https?:\/\//u, "").replace(/\/.*$/u, "");
}

function parseCopilotActiveAccount(config: Record<string, unknown> | null): {
  readonly user: string | null;
  readonly host: string | null;
  readonly loggedInUsers: readonly string[];
} {
  if (!config) return { user: null, host: null, loggedInUsers: [] };
  const last = isRecord(config.last_logged_in_user) ? config.last_logged_in_user : null;
  const user =
    nonEmptyString(last?.login)?.toLowerCase() ??
    nonEmptyString(last?.user)?.toLowerCase() ??
    nonEmptyString(config.active_user)?.toLowerCase() ??
    nonEmptyString(config.user)?.toLowerCase() ??
    null;
  const host = normalizeCopilotHost(last?.host);
  const loggedInUsers: string[] = [];
  if (Array.isArray(config.logged_in_users)) {
    for (const entry of config.logged_in_users) {
      if (!isRecord(entry)) continue;
      const entryHost = normalizeCopilotHost(entry.host);
      if (entryHost !== null && entryHost !== "github.com") continue;
      const entryUser = (nonEmptyString(entry.login) ?? nonEmptyString(entry.user))?.toLowerCase() ?? null;
      if (entryUser) loggedInUsers.push(entryUser);
    }
  }
  return { user, host, loggedInUsers };
}

function extractCopilotTokenValue(value: unknown): string | null {
  const direct = usableEnvToken(value);
  if (direct) return direct;
  if (!isRecord(value)) return null;
  return usableEnvToken(value.oauth_token) ?? usableEnvToken(value.token) ?? usableEnvToken(value.access_token);
}

function parseCopilotConfigTokenKey(rawKey: string): { readonly host: string; readonly user: string } | null {
  const stripped = rawKey.trim().replace(/^https?:\/\//iu, "");
  const separator = stripped.lastIndexOf(":");
  if (separator <= 0 || separator >= stripped.length - 1) return null;
  const host = stripped.slice(0, separator).replace(/\/+$/u, "").toLowerCase();
  const user = stripped
    .slice(separator + 1)
    .trim()
    .toLowerCase();
  if (!host || !user) return null;
  return { host, user };
}

/**
 * Extracts GitHub Copilot CLI's native plaintext OAuth tokens from `~/.copilot/config.json`
 * (written when the OS keychain is unavailable), accepting only `github.com` entries and
 * binding every token to its declared account login so callers fail closed on mismatch/ambiguity.
 */
function extractCopilotConfigTokens(
  config: Record<string, unknown> | null,
  activeUser: string | null,
): Array<{ readonly user: string | null; readonly token: string }> {
  if (!config) return [];
  const entries: Array<{ readonly user: string | null; readonly token: string }> = [];
  if (isRecord(config.copilot_tokens)) {
    for (const [rawKey, rawValue] of Object.entries(config.copilot_tokens)) {
      const parsedKey = parseCopilotConfigTokenKey(rawKey);
      if (!parsedKey || parsedKey.host !== "github.com") continue;
      const token = extractCopilotTokenValue(rawValue);
      if (!token) continue;
      entries.push({ user: parsedKey.user, token });
    }
  }
  if (Array.isArray(config.logged_in_users)) {
    for (const item of config.logged_in_users) {
      if (!isRecord(item)) continue;
      const host = normalizeCopilotHost(item.host);
      if (host !== null && host !== "github.com") continue;
      const token = extractCopilotTokenValue(item);
      if (!token) continue;
      const user = (nonEmptyString(item.login) ?? nonEmptyString(item.user))?.toLowerCase() ?? null;
      entries.push({ user, token });
    }
  }
  if (isRecord(config.last_logged_in_user)) {
    const host = normalizeCopilotHost(config.last_logged_in_user.host);
    if (host === null || host === "github.com") {
      const token = extractCopilotTokenValue(config.last_logged_in_user);
      if (token) entries.push({ user: activeUser, token });
    }
  }
  return entries;
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

function reportAccountFingerprint(input: SubscriptionQuotaProbeInput, identity: string | null): void {
  if (identity) input.onCredentialFingerprint?.(`account:${cryptoHash("sha256", identity, "hex")}`);
}

/**
 * Computes an in-memory SHA-256 fingerprint of an instance's active subscription credential files
 * (and Copilot env tokens) so an async probe started before a credential swap fails closed on commit.
 * Used only as an in-flight fence, never as a persisted account identity.
 */
export function subscriptionCredentialGeneration(
  kindId: RuntimeInstanceKind,
  env: NodeJS.ProcessEnv,
  resolvedGithubToken?: string | null,
): string {
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
    const effectiveEnv: NodeJS.ProcessEnv = { ...env };
    if (resolvedGithubToken !== undefined) {
      applyGithubLaunchCredential(effectiveEnv, usableEnvToken(resolvedGithubToken));
    }
    for (const key of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const) {
      chunks.push(Buffer.from(`env:${key}=${usableEnvToken(effectiveEnv[key]) ?? ""}\0`));
    }
    const copilotHome = resolveCopilotHome(effectiveEnv);
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
