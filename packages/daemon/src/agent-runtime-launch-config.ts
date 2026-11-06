import { commandInterceptionNeedsFiles } from "./runtime-command-interception-files.ts";
import { commandInterceptionHook, type CommandInterceptions } from "./runtime-command-interceptions.ts";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { consumeKnownError } from "@harness-anything/kernel";
import { type RuntimeIsolationState, type RuntimePermissionMode } from "./runtime-permissions.ts";
import type {
  RuntimeInstanceKind,
  RuntimeInstanceConfig,
  RuntimeInstallationWitness,
  RuntimeAuthReadiness,
} from "./agent-runtime-instance-types.ts";
import { runExecutable, runExecutableResult } from "./agent-runtime-installation-discovery.ts";
import { providerConfigDirectory, tomlString } from "./agent-runtime-instance-storage.ts";
import {
  requiredRuntimeInstanceText,
  runtimeInstanceError,
  available,
  unavailable,
} from "./agent-runtime-instance-values.ts";
import { claudeWorkspaceWriteSandbox, runtimeKindForId, type RuntimeProviderDeclaration } from "./runtime-inventory.ts";

// Platform-derived isolation environment. POSIX keeps HOME/TMPDIR/XDG_RUNTIME_DIR
// semantics; Windows derives the same guarantees from USERPROFILE/TEMP/APPDATA and
// must not inject XDG_RUNTIME_DIR. Pass-through stays an explicit allowlist of
// machine/user-neutral variables; host credentials never leak in.
// A launch scoped to one runtime session passes its own tempDirectory so one-off
// scratch never piles up in the instance-wide root; settlement reclaims it.
export function isolatedEnvironment(
  source: NodeJS.ProcessEnv,
  stateRoot: string,
  kindId: RuntimeInstanceKind,
  platform: NodeJS.Platform,
  tempDirectory?: string,
): NodeJS.ProcessEnv {
  const home = path.join(stateRoot, "home"),
    tmp = tempDirectory ?? path.join(stateRoot, "tmp"),
    environment = runtimeKindForId(kindId).executable.configHomeEnvironment,
    kind = environment ? { [environment]: providerConfigDirectory(home, kindId) } : {};
  if (platform === "win32") {
    const result: NodeJS.ProcessEnv = {
      USERPROFILE: home,
      TEMP: tmp,
      TMP: tmp,
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
      ...kind,
    };
    for (const key of ["PATH", "PATHEXT", "LANG", "LC_ALL", "SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC"])
      if (source[key]) result[key] = source[key];
    return result;
  }
  const result: NodeJS.ProcessEnv = {
    HOME: home,
    TMPDIR: tmp,
    XDG_RUNTIME_DIR: path.join(stateRoot, "run"),
    ...kind,
  };
  for (const key of ["PATH", "LANG", "LC_ALL"]) if (source[key]) result[key] = source[key];
  return result;
}

export function launchArgs(
  config: RuntimeInstanceConfig,
  model: string,
  prompt: string,
  providerSessionId?: string,
  effort: string | null = null,
  permissionMode: RuntimePermissionMode | undefined = undefined,
  fast = false,
  callbackRelayPath?: string,
  platform: NodeJS.Platform = process.platform,
  commandInterceptions: CommandInterceptions = [],
  commandInterceptionArgs: readonly string[] = [],
): string[] {
  if (
    config.kindId === "claude" &&
    permissionMode === "workspace-write" &&
    platform !== "darwin" &&
    platform !== "linux"
  )
    throw runtimeInstanceError(
      "claude_workspace_sandbox_unavailable",
      "Claude workspace-write requires its native Bash sandbox, available on macOS and Linux/WSL2. " +
        "Choose a supported execution host or a different runtime/permission mode; unsandboxed execution is not allowed.",
    );
  const declaration = runtimeKindForId(config.kindId),
    launch: RuntimeProviderDeclaration["launch"] = declaration.launch,
    callbackProfileParent =
      permissionMode === "workspace-write" ? ":workspace" : permissionMode === "read-only" ? ":read-only" : undefined,
    permission = permissionMode
      ? ((providerSessionId ? launch.resumePermissionArgs : undefined)?.[permissionMode] ??
        launch.permissionArgs[permissionMode])
      : [];
  if (commandInterceptions.length && declaration.capabilities.commandInterception !== "supported")
    throw runtimeInstanceError(
      "runtime_command_interception_unsupported",
      `${declaration.displayName} does not support HA command interception. Rules: ${commandInterceptions.map(({ id }) => id).join(", ")}. Select a supported runtime.`,
    );
  if (commandInterceptions.length && commandInterceptionNeedsFiles(config.kindId) && !commandInterceptionArgs.length)
    throw runtimeInstanceError(
      "runtime_command_interception_unprepared",
      "Native command interception requires the runtime instance launch preparer.",
    );
  const hook = commandInterceptions.length ? commandInterceptionHook(commandInterceptions) : null,
    hookSettings = hook
      ? { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hook }] }] }
      : undefined;
  const args = launch.argumentTemplate.flatMap((token) => {
    if (token === "$claude-settings")
      return [
        JSON.stringify({
          attribution: { commit: "", pr: "", sessionUrl: false },
          ...(hookSettings ? { hooks: hookSettings, disableAllHooks: false } : {}),
          ...(permissionMode === "workspace-write"
            ? {
                sandbox: {
                  ...claudeWorkspaceWriteSandbox,
                  ...(callbackRelayPath
                    ? {
                        network: {
                          ...claudeWorkspaceWriteSandbox.network,
                          allowUnixSockets: [callbackRelayPath],
                        },
                      }
                    : {}),
                },
              }
            : {}),
        }),
      ];
    if (token === "$model") return [model];
    if (token === "$prompt") return [prompt];
    // A CLI --sandbox override selects Codex's legacy policy and discards named profiles.
    // The callback profile replaces that block for both fresh and resumed launches.
    if (token === "$permission")
      return config.kindId === "codex" && callbackRelayPath && callbackProfileParent ? [] : permission;
    if (token === "$callback-relay-socket")
      // Exact socket rules require Codex's managed proxy; an empty domain allowlist
      // keeps ordinary network access denied rather than enabling direct networking.
      return config.kindId === "codex" && callbackRelayPath && callbackProfileParent
        ? [
            "--config",
            'default_permissions="harness-callback-relay"',
            "--config",
            `permissions.harness-callback-relay.extends=${tomlString(callbackProfileParent)}`,
            ...(permissionMode === "workspace-write"
              ? ["--config", 'permissions.harness-callback-relay.filesystem={":slash_tmp"="deny",":tmpdir"="deny"}']
              : []),
            "--config",
            "features.network_proxy=true",
            "--config",
            `permissions.harness-callback-relay.network={enabled=true,domains={},unix_sockets={${tomlString(callbackRelayPath)}="allow"}}`,
          ]
        : [];
    if (token === "$resume-command" || token === "$resume") {
      // A resume token with no flag to expand would silently launch a fresh session on a
      // resume request, so the mismatch fails the launch instead.
      if (launch.resumeFlag === undefined)
        throw new Error(`${declaration.kindId} argumentTemplate carries ${token} without a launch.resumeFlag`);
      if (token === "$resume-command") return providerSessionId ? [launch.resumeFlag] : [];
      return providerSessionId ? [launch.resumeFlag, providerSessionId] : [];
    }
    if (token === "$session") return providerSessionId ? [providerSessionId] : [];
    if (token === "$effort-flag") return effort ? ["--effort", effort === "minimal" ? "low" : effort] : [];
    if (token === "$effort-config") return effort ? ["--config", `model_reasoning_effort=${tomlString(effort)}`] : [];
    // Claude --bare disables settings hooks, including --settings. Keep it only on
    // launches with no project interception rather than silently dropping the policy.
    if (token === "$api-auth") return config.auth.mode === "api-key" && !hook ? (launch.apiKeyArgs ?? []) : [];
    if (token === "$fast") return fast ? (launch.fastArgs ?? []) : [];
    return [token];
  });
  if (config.kindId === "codex" && hook)
    args.push(
      "--config",
      "features.hooks=true",
      "--config",
      `hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command=${tomlString(hook)}}]}]`,
      "--dangerously-bypass-hook-trust",
    );
  if (config.kindId === "codebuddy" && hookSettings)
    args.push("--settings", JSON.stringify({ hooks: hookSettings, disableAllHooks: false }));
  args.unshift(...commandInterceptionArgs);
  return args;
}

export async function providerSubscriptionReadiness(
  input: {
    readonly installation: RuntimeInstallationWitness;
    readonly env: NodeJS.ProcessEnv;
    readonly isolationState: RuntimeIsolationState;
    readonly codexProbe?: {
      readonly config: RuntimeInstanceConfig;
      readonly cwd: string;
      readonly model: string;
      readonly effort: string | null;
      readonly fast: boolean;
      readonly permissionMode: RuntimePermissionMode;
    };
  },
  platform: NodeJS.Platform,
): Promise<RuntimeAuthReadiness> {
  const hint =
    input.isolationState === "operator-environment"
      ? "Provider subscription authentication is unavailable in the operator environment."
      : "Provider subscription authentication is unavailable in this instance state root.";
  try {
    const declaration = runtimeKindForId(input.installation.kindId),
      probe = declaration.auth.subscriptionProbe;
    if (typeof probe === "object" && "kind" in probe) {
      const home = input.env.HOME ?? input.env.USERPROFILE;
      if (!home)
        return unavailable("runtime_auth_probe_failed", "Provider authentication probe could not determine readiness.");
      const directory = providerConfigDirectory(home, input.installation.kindId);
      if (probe.kind === "file-key") {
        const authFile = declaration.executable.authFile,
          key = "acpCredentialKey" in declaration.auth ? declaration.auth.acpCredentialKey : undefined;
        if (!authFile || !key)
          return unavailable(
            "runtime_auth_probe_failed",
            "Provider authentication probe could not determine readiness.",
          );
        const file = path.join(directory, authFile);
        // Existence of the file plus a non-empty declared key is the whole check;
        // the secret value itself is never read out, logged, or forwarded.
        return existsSync(file) &&
          new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"[^"]+"`, "mu").test(readFileSync(file, "utf8"))
          ? available()
          : unavailable("runtime_subscription_required", hint);
      }
      return jsonAuthStateReadiness(path.join(directory, probe.file), probe, hint);
    }
    await runExecutable(platform, input.installation.executablePath, probe, {
      env: input.env,
      timeoutMs: declaration.auth.subscriptionProbeTimeoutMs,
      captureOutput: false,
    });
    if (input.codexProbe && input.installation.kindId === "codex") {
      const prompt = "Reply with exactly READY. Do not use tools or inspect files.",
        args = launchArgs(
          input.codexProbe.config,
          input.codexProbe.model,
          prompt,
          undefined,
          input.codexProbe.effort,
          input.codexProbe.permissionMode,
          input.codexProbe.fast,
          undefined,
          platform,
        ),
        result = await runExecutableResult(platform, input.installation.executablePath, args, {
          env: input.env,
          timeoutMs: 30_000,
          cwd: input.codexProbe.cwd,
          input: `${prompt}\n`,
        });
      return codexProviderRequestReadiness(result.stdout, result.stderr, result.exitCode);
    }
    return available();
  } catch (error) {
    consumeKnownError(error);
    // A probe the harness itself terminated (deadline or cancellation signal) never delivered
    // the provider's verdict: an exit during forced shutdown is an infrastructure failure, not
    // an authentication verdict. Only a run the provider completed and rejected itself counts.
    const terminated =
      typeof error === "object" &&
      error !== null &&
      ((error as { readonly killed?: unknown }).killed === true ||
        (error as { readonly signal?: unknown }).signal != null);
    return !terminated &&
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      Number.isInteger((error as { status: unknown }).status)
      ? unavailable("runtime_subscription_required", hint)
      : unavailable(
          "runtime_auth_probe_failed",
          terminated
            ? "Provider authentication probe was terminated before it could report readiness."
            : "Provider authentication probe could not determine readiness.",
        );
  }
}

function codexProviderRequestReadiness(stdout: string, stderr: string, exitCode: number): RuntimeAuthReadiness {
  const frames = `${stdout}\n${stderr}`.split(/\r?\n/u).flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return isPlainRecord(value) ? [value] : [];
      } catch {
        return [];
      }
    }),
    completed = frames.some((frame) => frame.type === "turn.completed");
  if (exitCode === 0 && completed) return available("provider");

  const failures = frames.filter(
      (frame) =>
        frame.type === "turn.failed" ||
        frame.type === "error" ||
        (isPlainRecord(frame.item) && frame.item.type === "error"),
    ),
    records = failures.flatMap(codexDiagnosticRecords),
    codes = records.flatMap((record) =>
      [record.code, record.error_code, record.type]
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase()),
    ),
    statuses = records
      .flatMap((record) => [record.http_status, record.status_code, record.status])
      .filter((value): value is number => typeof value === "number" && Number.isInteger(value)),
    messages = records
      .flatMap((record) => [record.message, record.detail])
      .filter((value): value is string => typeof value === "string"),
    codeText = codes.join(" "),
    messageText = messages.join(" "),
    diagnosticText = `${codeText} ${messageText} ${stdout} ${stderr}`;

  if (/invalid[_ -]?refresh[_ -]?token/iu.test(diagnosticText))
    return unavailable(
      "runtime_refresh_token_invalid",
      "Codex refresh token is invalid. Run ha runtime instance login <instance-id> to sign in again.",
    );
  if (
    statuses.includes(429) ||
    /\b(?:quota|insufficient[_ -]?quota|billing[_ -]?(?:hard[_ -]?)?limit|usage limit|credit balance|resource[_ -]?exhausted)\b/iu.test(
      diagnosticText,
    )
  )
    return unavailable(
      "runtime_quota_unavailable",
      "Codex account quota is unavailable. Check the account quota or billing, or choose another runtime instance.",
    );
  if (
    statuses.includes(401) ||
    /\b(?:unauthorized|unauthenticated|authentication failed|invalid[_ -]?(?:api[_ -]?key|token))\b/iu.test(
      diagnosticText,
    )
  )
    return unavailable(
      "runtime_authentication_failed",
      "Codex rejected the configured credential. Run ha runtime instance login <instance-id> and probe again.",
    );
  return unavailable(
    "runtime_auth_probe_failed",
    "Codex provider request did not complete; check the runtime installation and try the probe again.",
  );
}

function codexDiagnosticRecords(frame: Record<string, unknown>): Record<string, unknown>[] {
  const records = [frame],
    nested = [frame.error, frame.item, frame.payload];
  for (const value of nested) {
    if (!isPlainRecord(value)) continue;
    records.push(value);
    if (isPlainRecord(value.error)) records.push(value.error);
  }
  return records;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

type JsonAuthStateProbe = Extract<
  RuntimeProviderDeclaration["auth"]["subscriptionProbe"],
  { readonly kind: "json-auth-state" }
>;

/**
 * Read the provider's own login-state document. A CLI that exits 0 on `--version`
 * whether or not anyone is signed in cannot answer readiness; its auth-state file
 * records both the status and the expiry, so a stale login is distinguishable from
 * a fresh one and from no login at all. Missing file = never signed in; malformed
 * file = the probe could not determine anything (not a credential verdict).
 */
function jsonAuthStateReadiness(file: string, probe: JsonAuthStateProbe, hint: string): RuntimeAuthReadiness {
  // A missing document is the one state this can decide locally: nobody ever signed in.
  // A read or parse failure (permissions, a half-written file) is left to throw into the
  // caller's existing boundary, which reports it as "the probe could not determine
  // readiness" — a read failure must not masquerade as a credential verdict.
  if (!existsSync(file)) return unavailable("runtime_subscription_required", hint);
  const state: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof state !== "object" || state === null || Array.isArray(state))
    return unavailable("runtime_auth_probe_failed", "Provider authentication state is not an object.");
  const record = state as Record<string, unknown>,
    expiresAt = record[probe.expiresAtField];
  if (record[probe.statusField] !== probe.readyStatus) return unavailable("runtime_subscription_required", hint);
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))
    return unavailable("runtime_auth_probe_failed", "Provider authentication state has no expiry.");
  return expiresAt <= Date.now()
    ? unavailable(
        "runtime_subscription_expired",
        "Provider subscription sign-in has expired; run the instance login to sign in again.",
      )
    : available();
}

export const credentialUnavailableHint = "The configured runtime API credential is unavailable.";

export function credentialHint(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "runtime_credential_unavailable" &&
    error instanceof Error &&
    error.message
    ? error.message
    : credentialUnavailableHint;
}

export function secureRuntimeBaseUrl(value: unknown, options: { readonly allowInsecureHttp?: boolean } = {}): string {
  const text = requiredRuntimeInstanceText(value, "baseUrl");
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw runtimeInstanceError("invalid_base_url", "baseUrl must be an absolute HTTPS URL.");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(parsed.hostname)) &&
      !(parsed.protocol === "http:" && options.allowInsecureHttp === true && isPrivateIpv4(parsed.hostname)))
  )
    throw runtimeInstanceError(
      "invalid_base_url",
      [
        "baseUrl must use HTTPS or loopback HTTP; private HTTP requires explicit ",
        "allowInsecureHttp, and credentials, query, and fragments are forbidden.",
      ].join(""),
    );
  return parsed.toString();
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  return first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31);
}
