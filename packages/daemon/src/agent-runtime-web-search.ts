import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
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
 *  OpenAI-compatible endpoint may reject or ignore it, so an opt-in tier there is admitted
 *  only by the write boundary that performed one real gateway verification. This launch-time
 *  check therefore rejects only a provider with no endpoint at all: the persisted tier is
 *  the record of that verification, and launch is not allowed to probe the network again. */
export function assertRuntimeWebSearchSupported(config: RuntimeInstanceConfig): void {
  const declaration = declaredSearch(config);
  if (declaration === undefined) return;
  const mode = runtimeWebSearchForConfig(config);
  if (mode === null || mode === declaration.defaultMode) return;
  const provider = runtimeProviderConfig(config);
  if (!declaration.providers.includes(config.providerId) && provider.baseUrl === undefined)
    throw runtimeInstanceError(
      "runtime_web_search_provider_unsupported",
      [
        `${runtimeKindForId(config.kindId).displayName} native web search is only supported on `,
        `${declaration.providers.join(", ")} via its built-in endpoint; provider ${config.providerId} `,
        `declares no custom base URL, so webSearch=${mode} has no endpoint that could honor the tool. `,
        "Set webSearch=disabled, use the built-in endpoint provider, or give this provider a base URL.",
      ].join(""),
    );
}

/** An opt-in tier on a custom base URL is the one configuration whose support cannot be
 *  settled by the declaration alone: the gateway must answer a real request with a
 *  web_search_call item. The instance write paths call this predicate before persisting. */
export function runtimeWebSearchGatewayProbeRequired(config: RuntimeInstanceConfig): boolean {
  const declaration = declaredSearch(config);
  if (declaration === undefined) return false;
  const mode = runtimeWebSearchForConfig(config);
  return mode !== null && mode !== declaration.defaultMode && runtimeProviderConfig(config).baseUrl !== undefined;
}

/** What the gateway probe needs from the instance. It deliberately carries no `config`
 *  object: the probe runs the same credential, header and wire-API policy the launch writes,
 *  without importing the instance store or its launch path. */
export interface RuntimeWebSearchGatewayProbe {
  readonly baseUrl: string;
  readonly model: string;
  readonly credentialRef: string;
  readonly credentialHeader?: string;
  readonly httpHeaders?: Readonly<Record<string, string>>;
  readonly wireApi?: string;
}

/** The one real verification: a Responses API request carrying the same hosted tool the
 *  launch will enable, accepted only when the gateway reports a web_search_call item.
 *  A refused request, an unreachable gateway and a response without that item are all
 *  named refusals; none of them becomes a silently disabled tier. */
export async function verifyRuntimeWebSearchGateway(
  gateway: RuntimeWebSearchGatewayProbe,
  resolveCredential: (reference: string) => Promise<string>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (gateway.wireApi !== undefined && gateway.wireApi !== "responses")
    throw gatewayUnverified(
      [
        `Native web search requires the Responses API, but ${gateway.baseUrl} declares `,
        `wireApi=${gateway.wireApi}. Set wireApi=responses or webSearch=disabled.`,
      ].join(""),
    );
  const secret = await gatewayCredential(gateway.credentialRef, resolveCredential),
    endpoint = new URL("responses", gateway.baseUrl.endsWith("/") ? gateway.baseUrl : `${gateway.baseUrl}/`),
    headers: Record<string, string> = { "content-type": "application/json", ...gateway.httpHeaders };
  if (gateway.credentialHeader) headers[gateway.credentialHeader] = secret;
  else headers.authorization = `Bearer ${secret}`;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: gateway.model,
        input: "Use the web_search tool to look up the official Node.js website, then answer with its URL.",
        tools: [{ type: "web_search" }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    consumeKnownError(error);
    throw gatewayUnverified(
      `Native web search could not be verified against ${gateway.baseUrl}: ${errorMessage(error)}.`,
    );
  }
  if (!response.ok)
    throw gatewayUnverified(
      [
        `${gateway.baseUrl} returned HTTP ${response.status} while verifying native web search. `,
        `The gateway must accept POST /responses with tools:[{"type":"web_search"}].`,
      ].join(""),
    );
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    consumeKnownError(error);
    throw gatewayUnverified(
      `Native web search could not be verified: ${gateway.baseUrl} did not return a JSON Responses payload.`,
    );
  }
  if (!containsWebSearchCall(body))
    throw gatewayUnverified(
      [
        `${gateway.baseUrl} answered without a web_search_call item for model ${gateway.model}; `,
        "the gateway does not perform native hosted search. Set webSearch=disabled or use a gateway that honors ",
        'tools:[{"type":"web_search"}].',
      ].join(""),
    );
}

async function gatewayCredential(
  reference: string,
  resolveCredential: (reference: string) => Promise<string>,
): Promise<string> {
  let secret: string;
  try {
    secret = await resolveCredential(reference);
  } catch (error) {
    consumeKnownError(error);
    throw gatewayUnverified(
      `Native web search could not be verified because the gateway credential could not be resolved: ${errorMessage(error)}.`,
    );
  }
  if (!secret)
    throw gatewayUnverified("Native web search could not be verified because the gateway credential is unavailable.");
  return secret;
}

function gatewayUnverified(hint: string): Error {
  return runtimeInstanceError("runtime_web_search_gateway_unverified", hint);
}

function containsWebSearchCall(body: unknown): boolean {
  if (body === null || typeof body !== "object" || !("output" in body)) return false;
  const output = (body as { readonly output?: unknown }).output;
  return (
    Array.isArray(output) &&
    output.some(
      (item) =>
        item !== null && typeof item === "object" && (item as { readonly type?: unknown }).type === "web_search_call",
    )
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** Reads the top-level managed key through a TOML parser, so quoted keys, comments and
 *  table scoping follow the TOML document model Codex itself uses. A document that does not
 *  parse, or a key that is present but not a string array, is a refusal, not "no policy":
 *  guessing would let an administrator's restriction be ignored. */
export function allowedWebSearchModesInPolicy(text: string): readonly string[] | null {
  let document: Record<string, unknown>;
  try {
    document = parseToml(text) as Record<string, unknown>;
  } catch {
    throw invalidPolicyShape();
  }
  const value = document.allowed_web_search_modes;
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string"))
    throw invalidPolicyShape();
  return value;
}

function invalidPolicyShape(): Error {
  return runtimeInstanceError(
    "runtime_web_search_policy_invalid",
    "Codex managed requirements are not valid TOML or allowed_web_search_modes is not a string array.",
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
      if (encoded) texts.push(decodeCodexManagedPolicyPreference(encoded));
    } else if (!/Could not find key|does not exist/iu.test(result.stderr)) {
      throw runtimeInstanceError(
        "runtime_web_search_policy_unreadable",
        `macOS managed Codex requirements could not be read: ${result.stderr.trim() || `exit ${result.exitCode}`}.`,
      );
    }
  }
  return texts;
}

/** A managed-preference key that exists but is not a valid UTF-8 base64 TOML payload is
 *  unreadable policy, not an unmanaged host. */
export function decodeCodexManagedPolicyPreference(encoded: string): string {
  const compact = encoded.replace(/\s/gu, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || compact.length % 4 !== 0)
    throw runtimeInstanceError(
      "runtime_web_search_policy_unreadable",
      "macOS managed Codex requirements are not valid base64 and cannot be read.",
    );
  const decoded = Buffer.from(compact, "base64").toString("utf8");
  if (decoded.includes("\uFFFD"))
    throw runtimeInstanceError(
      "runtime_web_search_policy_unreadable",
      "macOS managed Codex requirements are not valid UTF-8 and cannot be read.",
    );
  return decoded;
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
