import { readFileSync } from "node:fs";
import { consumeKnownError } from "@harness-anything/kernel";
import { runProcessExitAsync } from "./process-port.ts";
import type {
  RuntimeInstallationWitness,
  RuntimeProviderInstanceConfig,
  RuntimeInstanceConfig,
} from "./agent-runtime-instance-types.ts";
import { runtimeProviderConfig } from "./agent-runtime-instance-types.ts";
import { runtimeInstanceError } from "./agent-runtime-instance-values.ts";
import { runtimeKindForId, runtimeWebSearchModes, type RuntimeWebSearchMode } from "./runtime-inventory.ts";

/** Reads the kind's declared default without inventing one at the call site. */
function declaredSearch(config: RuntimeInstanceConfig) {
  return runtimeKindForId(config.kindId).configuration.webSearch;
}

function providerWebSearch(config: RuntimeInstanceConfig): unknown {
  return (runtimeProviderConfig(config) as RuntimeProviderInstanceConfig).webSearch;
}

/** The only parser for the persisted tier. An unknown value fails closed instead of being
 *  forwarded to Codex, where an old build could silently ignore it. */
export function runtimeWebSearchMode(
  value: unknown,
  fallback: RuntimeWebSearchMode = "disabled",
): RuntimeWebSearchMode {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (runtimeWebSearchModes as readonly string[]).includes(value))
    return value as RuntimeWebSearchMode;
  throw runtimeInstanceError(
    "invalid_runtime_web_search",
    `webSearch must be one of ${runtimeWebSearchModes.join(", ")}.`,
  );
}

/** The effective tier for a launch, or null on a kind that declares no native search.
 *  Absent configuration means the declaration's default, which for Codex is `disabled`. */
export function runtimeWebSearchForConfig(config: RuntimeInstanceConfig): RuntimeWebSearchMode | null {
  const declaration = declaredSearch(config);
  if (declaration === undefined) return null;
  const mode = runtimeWebSearchMode(providerWebSearch(config), declaration.defaultMode);
  if (!declaration.modes.includes(mode))
    throw runtimeInstanceError(
      "invalid_runtime_web_search",
      `${runtimeKindForId(config.kindId).displayName} does not support webSearch=${mode}; use ${declaration.modes.join(", ")}.`,
    );
  return mode;
}

/** Native hosted search only exists on providers that actually honor the tool. A custom
 *  OpenAI-compatible endpoint may reject or ignore it, so enabling a non-default tier is a
 *  named configuration error rather than a launch that silently under-delivers. */
export function assertRuntimeWebSearchSupported(config: RuntimeInstanceConfig): void {
  const declaration = declaredSearch(config);
  if (declaration === undefined) return;
  const mode = runtimeWebSearchForConfig(config);
  if (mode === null || mode === declaration.defaultMode) return;
  const provider = runtimeProviderConfig(config);
  // A custom base URL is a routing policy the configured provider owns; HA cannot prove the
  // gateway honors the native hosted tool, so an opt-in tier must fail closed there too.
  if (!declaration.providers.includes(config.providerId) || provider.baseUrl !== undefined)
    throw runtimeInstanceError(
      "runtime_web_search_provider_unsupported",
      [
        `${runtimeKindForId(config.kindId).displayName} native web search is only supported on `,
        `${declaration.providers.join(", ")} via its built-in endpoint; `,
        `provider ${config.providerId}${provider.baseUrl === undefined ? "" : " with a custom base URL"} `,
        `cannot use webSearch=${mode}. Set webSearch=disabled or use the built-in endpoint provider.`,
      ].join(""),
    );
}

/** Codex reports `supports_search_tool` in its bundled model catalog. The witness carries
 *  the capable subset, so an opt-in tier is refused for a model whose capability is absent
 *  or unknown rather than launched and silently failing at the provider. */
export function runtimeWebSearchModelGate(
  config: RuntimeInstanceConfig,
  model: string,
  installation: Pick<RuntimeInstallationWitness, "searchCapableModels">,
): { readonly code: "runtime_web_search_model_unsupported"; readonly hint: string } | null {
  const declaration = declaredSearch(config);
  if (declaration === undefined) return null;
  const mode = runtimeWebSearchForConfig(config);
  if (mode === null || mode === declaration.defaultMode) return null;
  if (installation.searchCapableModels === undefined)
    return {
      code: "runtime_web_search_model_unsupported",
      hint:
        `Codex model ${model} has no witnessed web-search capability; re-run ` +
        "`ha runtime instance show <instance-id> --probe` after updating Codex, or set webSearch=disabled.",
    };
  if (!installation.searchCapableModels.includes(model))
    return {
      code: "runtime_web_search_model_unsupported",
      hint:
        `Codex model ${model} does not advertise native web search; the witnessed capable models are ` +
        `${installation.searchCapableModels.join(", ") || "(none)"}. Choose one of them or set webSearch=disabled.`,
    };
  return null;
}

/** The local files Codex itself loads as enterprise-managed requirements. The legacy
 *  managed_config.toml path is included because Codex still reads it as a fallback. */
export const codexManagedPolicyPaths = ["/etc/codex/requirements.toml", "/etc/codex/managed_config.toml"] as const;

/** Parses the one managed key this product acts on. A key that is present but not a
 *  string array is a refusal, not "no policy": guessing would let an administrator's
 *  restriction be ignored. */
export function allowedWebSearchModesInPolicy(text: string): readonly string[] | null {
  const key = /^[ \t]*allowed_web_search_modes[ \t]*=/mu.exec(text);
  if (!key) return null;
  const valueStart = key.index + key[0].length + /^[ \t]*/u.exec(text.slice(key.index + key[0].length))![0].length;
  if (text[valueStart] !== "[") throw invalidPolicyShape();
  const close = text.indexOf("]", valueStart + 1);
  if (close < 0) throw invalidPolicyShape();
  const trailing = text
    .slice(close + 1)
    .split(/\r?\n/u)[0]!
    .replace(/#.*/u, "")
    .trim();
  if (trailing.length > 0) throw invalidPolicyShape();
  const body = text.slice(valueStart + 1, close).replace(/#[^\n]*/gu, ""),
    values = [...body.matchAll(/["']([^"']+)["']/gu)].map((entry) => entry[1]!),
    residue = body.replace(/["'][^"']+["']/gu, "").replace(/[,\s]/gu, "");
  if (residue.length > 0) throw invalidPolicyShape();
  return values;
}

function invalidPolicyShape(): Error {
  return runtimeInstanceError(
    "runtime_web_search_policy_invalid",
    "Codex managed requirements allowed_web_search_modes is not a string array.",
  );
}

/** Reads the two file-based managed-policy sources Codex loads. ENOENT is the only
 *  absence; any other read failure is a refusal because it leaves the policy unknown. */
export function readCodexManagedPolicyFiles(paths: readonly string[] = codexManagedPolicyPaths): readonly string[] {
  const texts: string[] = [];
  for (const path of paths) {
    try {
      texts.push(readFileSync(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw runtimeInstanceError(
        "runtime_web_search_policy_unreadable",
        `Codex managed requirements ${path} could not be read: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }
  return texts;
}

/** Reads local administrator policy on every platform Codex supports here. macOS MDM is
 *  read through the same `com.openai.codex` preference Codex uses. Only the explicit
 *  "key not found" verdict means no managed policy; every other failure is unreadable. */
export async function readCodexManagedPolicyTexts(
  platform: NodeJS.Platform = process.platform,
): Promise<readonly string[]> {
  const texts: string[] = [...readCodexManagedPolicyFiles()];
  if (platform === "darwin") {
    let result: Awaited<ReturnType<typeof runProcessExitAsync>>;
    try {
      result = await runProcessExitAsync(
        "/usr/bin/defaults",
        ["read", "com.openai.codex", "requirements_toml_base64"],
        undefined,
        process.env,
        undefined,
        undefined,
        { timeoutMs: 2_000 },
      );
    } catch (error) {
      consumeKnownError(error);
      throw runtimeInstanceError(
        "runtime_web_search_policy_unreadable",
        `macOS managed Codex requirements could not be read: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
    if (result.exitCode === 0) {
      const encoded = result.stdout.trim();
      if (encoded) texts.push(Buffer.from(encoded, "base64").toString("utf8"));
    } else if (!/Could not find key|does not exist/iu.test(result.stderr)) {
      throw runtimeInstanceError(
        "runtime_web_search_policy_unreadable",
        `macOS managed Codex requirements could not be read: ${result.stderr.trim() || `exit ${result.exitCode}`}.`,
      );
    }
  }
  return texts;
}

/** Refuses an opt-in tier that local administrator policy does not allow. The policy is
 *  checked at launch, not only at configuration time, because a managed profile can change
 *  between the two. */
export async function runtimeWebSearchPolicyConflict(
  config: RuntimeInstanceConfig,
  policyTexts: readonly string[] | (() => readonly string[] | Promise<readonly string[]>) = readCodexManagedPolicyTexts,
): Promise<{ readonly code: "runtime_web_search_policy_conflict"; readonly hint: string } | null> {
  const mode = runtimeWebSearchForConfig(config);
  if (mode === null || mode === declaredSearch(config)?.defaultMode) return null;
  const texts = typeof policyTexts === "function" ? await policyTexts() : policyTexts;
  for (const text of texts) {
    const allowed = allowedWebSearchModesInPolicy(text);
    if (allowed !== null && !allowed.includes(mode))
      return {
        code: "runtime_web_search_policy_conflict",
        hint:
          `Administrator Codex policy allows web search modes [${allowed.join(", ")}], ` +
          `so webSearch=${mode} is refused. Set webSearch=disabled or choose an allowed mode.`,
      };
  }
  return null;
}
