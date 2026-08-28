import path from "node:path";
import { consumeKnownError } from "../../kernel/src/index.ts";
import { permissionLaunchArgs, type RuntimeIsolationState, type RuntimePermissionMode } from "./runtime-permissions.ts";
import type {
  RuntimeInstanceKind,
  RuntimeInstanceConfig,
  RuntimeInstallationWitness,
  RuntimeAuthReadiness,
} from "./agent-runtime-instance-types.ts";
import { runExecutableSync } from "./agent-runtime-installation-discovery.ts";
import { providerConfigDirectory, tomlString } from "./agent-runtime-instance-storage.ts";
import {
  requiredRuntimeInstanceText,
  runtimeInstanceError,
  available,
  unavailable,
} from "./agent-runtime-instance-config.ts";

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
    kind =
      kindId === "codex"
        ? { CODEX_HOME: providerConfigDirectory(home, kindId) }
        : { CLAUDE_CONFIG_DIR: providerConfigDirectory(home, kindId) };
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
): string[] {
  if (config.kindId === "claude")
    return [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      ...(permissionMode ? permissionLaunchArgs("claude", permissionMode) : []),
      "--model",
      model,
      ...(config.auth.mode === "api-key" ? ["--bare"] : []),
      ...(providerSessionId ? ["--resume", providerSessionId] : []),
    ];
  if (config.kindId === "agy")
    return [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--model",
      model,
      ...(permissionMode === "bypass" ? ["--dangerously-skip-permissions"] : []),
      ...(effort ? ["--effort", effort] : []),
      ...(providerSessionId ? ["--conversation", providerSessionId] : []),
    ];
  return [
    "exec",
    ...(providerSessionId ? ["resume"] : []),
    "--json",
    ...(permissionMode ? permissionLaunchArgs("codex", permissionMode, providerSessionId ? "resume" : "start") : []),
    "--model",
    model,
    ...(effort ? ["--config", `model_reasoning_effort=${tomlString(effort)}`] : []),
    ...(providerSessionId ? [providerSessionId] : []),
    "-",
  ];
}

export function providerSubscriptionReadiness(
  input: {
    readonly installation: RuntimeInstallationWitness;
    readonly env: NodeJS.ProcessEnv;
    readonly isolationState: RuntimeIsolationState;
  },
  platform: NodeJS.Platform,
): RuntimeAuthReadiness {
  try {
    runExecutableSync(
      platform,
      input.installation.executablePath,
      input.installation.kindId === "codex"
        ? ["login", "status"]
        : input.installation.kindId === "agy"
          ? ["models"]
          : ["auth", "status", "--json"],
      {
        env: input.env,
        timeoutMs: input.installation.kindId === "agy" ? 15_000 : 5_000,
        captureOutput: false,
      },
    );
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

export function secureRuntimeBaseUrl(value: unknown): string {
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
      !(parsed.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(parsed.hostname)))
  )
    throw runtimeInstanceError(
      "invalid_base_url",
      "baseUrl must use HTTPS or loopback HTTP and cannot contain credentials, query, or fragment.",
    );
  return parsed.toString();
}
