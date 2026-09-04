import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { accepted, readFlags, rejected } from "./thin-command-flags.ts";
import type { ProtocolCommand, ThinParseResult } from "./thin-command-types.ts";
import { isRuntimeKindId, runtimeKindForId } from "../../../daemon/src/runtime-inventory.ts";

type ParsedFlags = Extract<ReturnType<typeof readFlags>, { readonly ok: true }>;

export function parseRuntimeInstanceCreate(
  route: ProtocolCommand,
  rootDir: SafePath,
  json: boolean,
  flags: ParsedFlags,
): ThinParseResult {
  const authMode = flags.one.get("--auth"),
    credentialRef = flags.one.get("--credential-ref"),
    kindId = flags.one.get("--kind"),
    header = runtimeHttpHeaderFlags(flags.many.get("--http-header") ?? []);
  if (!isRuntimeKindId(kindId)) return rejected("invalid_field", `Unknown runtime kind: ${String(kindId)}.`, json);
  if (authMode === "api-key" && !credentialRef)
    return rejected("missing_field", "API-key instances require --credential-ref <opaque-ref>.", json);
  if (authMode === "subscription" && credentialRef)
    return rejected("invalid_field", "Subscription instances cannot accept a credential reference.", json);
  const declaration = runtimeKindForId(kindId);
  if (!declaration.auth.modes.some((mode) => mode === authMode))
    return rejected("invalid_field", `${kindId} runtime instances do not support ${String(authMode)} auth.`, json);
  if (!("fast" in declaration.configuration.fields) && flags.booleans.has("--fast"))
    return rejected("invalid_runtime_fast", `Fast mode is not supported by ${kindId} runtime instances.`, json);
  if (!header.ok) return rejected("invalid_field", header.hint, json);
  if (hasForeignAdapterOptions(kindId, flags, header.value))
    return rejected("invalid_field", "This runtime kind does not accept options for another adapter.", json);
  const baseUrl = flags.one.get("--base-url"),
    kindConfig = runtimeInstanceKindConfig(kindId, flags.one, flags.booleans, baseUrl, header.value);
  return accepted(
    rootDir,
    undefined,
    json,
    {
      kind: route.id,
      instanceId: flags.one.get("--id"),
      name: flags.one.get("--name"),
      kindId,
      ...(flags.one.get("--installation") ? { installationId: flags.one.get("--installation") } : {}),
      providerId: flags.one.get("--provider"),
      models: flags.many.get("--model") ?? [],
      ...(flags.one.get("--default-model") ? { defaultModel: flags.one.get("--default-model") } : {}),
      ...(flags.one.get("--permission-mode") ? { permissionMode: flags.one.get("--permission-mode") } : {}),
      ...(flags.one.get("--isolation") ? { isolationState: flags.one.get("--isolation") } : {}),
      ...kindConfig,
      authMode,
      ...(credentialRef ? { credentialRef } : {}),
    },
    route.method,
  );
}

function hasForeignAdapterOptions(
  kindId: string | undefined,
  flags: ParsedFlags,
  headers: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!isRuntimeKindId(kindId)) return true;
  const fields = runtimeKindForId(kindId).configuration.fields;
  return (
    (flags.one.has("--base-url") && !("baseUrl" in fields)) ||
    (flags.one.has("--wire-api") && !("wireApi" in fields)) ||
    (flags.booleans.has("--requires-openai-auth") && !("requiresOpenAiAuth" in fields)) ||
    (headers !== undefined && !("httpHeaders" in fields))
  );
}

function runtimeInstanceKindConfig(
  kindId: string | undefined,
  one: Map<string, string>,
  booleans: Set<string>,
  baseUrl: string | undefined,
  headers: Readonly<Record<string, string>> | undefined,
) {
  if (!isRuntimeKindId(kindId)) return {};
  const fields = runtimeKindForId(kindId).configuration.fields,
    effortField = "reasoningEffort" in fields ? "reasoningEffort" : "effort",
    configuration = {
      ...(one.get("--effort") && effortField in fields ? { [effortField]: one.get("--effort") } : {}),
      ...(booleans.has("--fast") && "fast" in fields ? { fast: true } : {}),
      ...(baseUrl && "baseUrl" in fields ? { baseUrl } : {}),
      ...(one.get("--wire-api") && "wireApi" in fields ? { wireApi: one.get("--wire-api") } : {}),
      ...(booleans.has("--requires-openai-auth") && "requiresOpenAiAuth" in fields ? { requiresOpenAiAuth: true } : {}),
      ...(headers && "httpHeaders" in fields ? { httpHeaders: headers } : {}),
    };
  return { [kindId]: configuration };
}

function runtimeHttpHeaderFlags(
  values: readonly string[],
):
  | { readonly ok: true; readonly value?: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly hint: string } {
  if (values.length === 0) return { ok: true };
  const headers: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator < 1 || separator === value.length - 1)
      return {
        ok: false,
        hint: "Use --http-header Name=Value with a non-secret static header.",
      };
    const name = value.slice(0, separator),
      item = value.slice(separator + 1);
    if (Object.hasOwn(headers, name))
      return {
        ok: false,
        hint: `HTTP header ${name} was provided more than once.`,
      };
    headers[name] = item;
  }
  return { ok: true, value: headers };
}
