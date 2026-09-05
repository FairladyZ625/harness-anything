import {
  builtInRuntimeProviderInputDeclaration,
  type SafePath,
} from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { accepted, readFlags, rejected } from "./thin-command-flags.ts";
import type { ProtocolCommand, ThinParseResult } from "./thin-command-types.ts";

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
    credentialHeader = flags.one.get("--credential-header"),
    header = runtimeHttpHeaderFlags(flags.many.get("--http-header") ?? []);
  if (!kindId) return rejected("missing_field", "Runtime instances require --kind <runtime-kind>.", json);
  if (authMode === "api-key" && !credentialRef)
    return rejected("missing_field", "API-key instances require --credential-ref <opaque-ref>.", json);
  if (authMode === "subscription" && credentialRef)
    return rejected("invalid_field", "Subscription instances cannot accept a credential reference.", json);
  const declaration =
    builtInRuntimeProviderInputDeclaration[kindId as keyof typeof builtInRuntimeProviderInputDeclaration];
  if (declaration && !declaration.authModes.some((mode) => mode === authMode))
    return rejected("invalid_field", `${kindId} runtime instances do not support ${String(authMode)} auth.`, json);
  if (declaration && !declaration.fast && flags.booleans.has("--fast"))
    return rejected("invalid_runtime_fast", `Fast mode is not supported by ${kindId} runtime instances.`, json);
  if (!header.ok) return rejected("invalid_field", header.hint, json);
  if (declaration && hasForeignAdapterOptions(declaration.fields, flags, header.value))
    return rejected("invalid_field", "This runtime kind does not accept options for another adapter.", json);
  const baseUrl = flags.one.get("--base-url"),
    kindConfig = runtimeInstanceKindConfig(
      kindId,
      flags.one,
      flags.booleans,
      baseUrl,
      header.value,
      credentialHeader,
    );
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
  fields: readonly string[],
  flags: ParsedFlags,
  headers: Readonly<Record<string, string>> | undefined,
): boolean {
  return (
    (flags.one.has("--base-url") && !fields.includes("baseUrl")) ||
    (flags.booleans.has("--allow-insecure-http") && !fields.includes("allowInsecureHttp")) ||
    (flags.one.has("--wire-api") && !fields.includes("wireApi")) ||
    (flags.booleans.has("--requires-openai-auth") && !fields.includes("requiresOpenAiAuth")) ||
    (headers !== undefined && !fields.includes("httpHeaders")) ||
    (flags.one.has("--credential-header") && !fields.includes("credentialHeader"))
  );
}

function runtimeInstanceKindConfig(
  kindId: string | undefined,
  one: Map<string, string>,
  booleans: Set<string>,
  baseUrl: string | undefined,
  headers: Readonly<Record<string, string>> | undefined,
  credentialHeader: string | undefined,
) {
  if (!kindId) return {};
  const declaration =
      builtInRuntimeProviderInputDeclaration[kindId as keyof typeof builtInRuntimeProviderInputDeclaration],
    effortField = declaration?.effortField ?? "effort",
    configuration = {
      ...(one.get("--effort") ? { [effortField]: one.get("--effort") } : {}),
      ...(booleans.has("--fast") ? { fast: true } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(booleans.has("--allow-insecure-http") ? { allowInsecureHttp: true } : {}),
      ...(one.get("--wire-api") ? { wireApi: one.get("--wire-api") } : {}),
      ...(booleans.has("--requires-openai-auth") ? { requiresOpenAiAuth: true } : {}),
      ...(headers ? { httpHeaders: headers } : {}),
      ...(credentialHeader ? { credentialHeader } : {}),
    };
  return { [kindId]: configuration };
}

function runtimeHttpHeaderFlags(
  values: readonly string[],
):
  | { readonly ok: true; readonly value?: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly hint: string } {
  if (values.length === 0) return { ok: true };
  const headers: Record<string, string> = {}, normalizedNames = new Set<string>();
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator < 1 || separator === value.length - 1)
      return {
        ok: false,
        hint: "Use --http-header Name=Value with a non-secret static header.",
      };
    const name = value.slice(0, separator),
      item = value.slice(separator + 1),
      normalizedName = name.toLowerCase();
    if (normalizedNames.has(normalizedName))
      return {
        ok: false,
        hint: `HTTP header ${name} was provided more than once.`,
      };
    normalizedNames.add(normalizedName);
    headers[name] = item;
  }
  return { ok: true, value: headers };
}
