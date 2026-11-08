import type { RuntimeProviderInstanceConfig, RuntimeInstanceConfig } from "./agent-runtime-instance-types.ts";
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
