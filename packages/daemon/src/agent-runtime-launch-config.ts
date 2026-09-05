import path from "node:path";
import { consumeKnownError } from "../../kernel/src/index.ts";
import { type RuntimeIsolationState, type RuntimePermissionMode } from "./runtime-permissions.ts";
import type {
  RuntimeInstanceKind,
  RuntimeInstanceConfig,
  RuntimeInstallationWitness,
  RuntimeAuthReadiness,
} from "./agent-runtime-instance-types.ts";
import { runExecutable } from "./agent-runtime-installation-discovery.ts";
import { providerConfigDirectory, tomlString } from "./agent-runtime-instance-storage.ts";
import {
  requiredRuntimeInstanceText,
  runtimeInstanceError,
  available,
  unavailable,
} from "./agent-runtime-instance-config.ts";
import { runtimeKindForId, type RuntimeProviderDeclaration } from "./runtime-inventory.ts";

// Platform-derived isolation environment. POSIX keeps HOME/TMPDIR/XDG_RUNTIME_DIR
// semantics; Windows derives the same guarantees from USERPROFILE/TEMP/APPDATA and
// must not inject XDG_RUNTIME_DIR. Pass-through stays an explicit allowlist of
// machine/user-neutral variables; host credentials never leak in.
export function isolatedEnvironment(
  source: NodeJS.ProcessEnv,
  stateRoot: string,
  kindId: RuntimeInstanceKind,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const home = path.join(stateRoot, "home"),
    tmp = path.join(stateRoot, "tmp"),
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
): string[] {
  const declaration = runtimeKindForId(config.kindId),
    launch: RuntimeProviderDeclaration["launch"] = declaration.launch,
    permission = permissionMode
      ? ((providerSessionId ? launch.resumePermissionArgs : undefined)?.[permissionMode] ??
        launch.permissionArgs[permissionMode])
      : [];
  return launch.argumentTemplate.flatMap((token) => {
    if (token === "$model") return [model];
    if (token === "$prompt") return [prompt];
    if (token === "$permission") return permission;
    if (token === "$resume-command") return providerSessionId ? [launch.resumeFlag] : [];
    if (token === "$session") return providerSessionId ? [providerSessionId] : [];
    if (token === "$resume") return providerSessionId ? [launch.resumeFlag, providerSessionId] : [];
    if (token === "$effort-flag") return effort ? ["--effort", effort === "minimal" ? "low" : effort] : [];
    if (token === "$effort-config") return effort ? ["--config", `model_reasoning_effort=${tomlString(effort)}`] : [];
    if (token === "$api-auth") return config.auth.mode === "api-key" ? (launch.apiKeyArgs ?? []) : [];
    if (token === "$fast") return fast ? (launch.fastArgs ?? []) : [];
    return [token];
  });
}

export async function providerSubscriptionReadiness(
  input: {
    readonly installation: RuntimeInstallationWitness;
    readonly env: NodeJS.ProcessEnv;
    readonly isolationState: RuntimeIsolationState;
  },
  platform: NodeJS.Platform,
): Promise<RuntimeAuthReadiness> {
  try {
    const declaration = runtimeKindForId(input.installation.kindId);
    await runExecutable(platform, input.installation.executablePath, declaration.auth.subscriptionProbe, {
      env: input.env,
      timeoutMs: declaration.auth.subscriptionProbeTimeoutMs,
      captureOutput: false,
    });
    return available();
  } catch (error) {
    consumeKnownError(error);
    const hint =
      input.isolationState === "operator-environment"
        ? "Provider subscription authentication is unavailable in the operator environment."
        : "Provider subscription authentication is unavailable in this instance state root.";
    return typeof error === "object" &&
      error !== null &&
      "status" in error &&
      Number.isInteger((error as { status: unknown }).status)
      ? unavailable("runtime_subscription_required", hint)
      : unavailable("runtime_auth_probe_failed", "Provider authentication probe could not determine readiness.");
  }
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

export function secureRuntimeBaseUrl(
  value: unknown,
  options: { readonly allowInsecureHttp?: boolean } = {},
): string {
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
      !(
        parsed.protocol === "http:" &&
        options.allowInsecureHttp === true &&
        isPrivateIpv4(parsed.hostname)
      ))
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
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    return false;
  const [first, second] = octets;
  return first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31);
}
