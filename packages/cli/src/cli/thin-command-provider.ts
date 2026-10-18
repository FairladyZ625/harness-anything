import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { accepted, nonEmpty, readFlags, rejected } from "./thin-command-flags.ts";
import type { ProtocolCommand, ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

export function parseProvider(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const positional = "positional" in route && route.positional === "providerId",
    providerId = positional ? args[route.path.length] : undefined,
    flags = readFlags(route.id, args.slice(route.path.length + (positional ? 1 : 0)), inputs);
  if (!flags.ok) return rejected(flags.code, flags.nextAction, json);
  if (positional && !nonEmpty(providerId)) return rejected("missing_field", "A provider id is required.", json);
  if (route.id === "provider-create" && !flags.one.has("--api-key-file") && !flags.one.has("--credential-ref"))
    return rejected("missing_field", "Use --api-key-file <protected-file> or --credential-ref <opaque-ref>.", json);
  if (
    route.id === "provider-update" &&
    ![
      "--name",
      "--model",
      "--base-url",
      "--clear-base-url",
      "--api-key-file",
      "--credential-ref",
      "--enable",
      "--disable",
    ].some((flag) => flags.one.has(flag) || flags.booleans.has(flag))
  )
    return rejected("invalid_field", "Specify at least one provider field to update.", json);
  const action = {
    kind: route.id,
    ...(providerId ? { providerId } : {}),
    ...(route.id === "provider-create"
      ? {
          type: flags.one.get("--type"),
          providerId: flags.one.get("--id"),
          name: flags.one.get("--name"),
          vendor: flags.one.get("--vendor") ?? "openrouter",
          model: flags.one.get("--model"),
          ...(flags.one.has("--base-url") ? { baseUrl: flags.one.get("--base-url") } : {}),
          ...(flags.one.has("--api-key-file") ? { apiKeyFile: flags.one.get("--api-key-file") } : {}),
          ...(flags.one.has("--credential-ref") ? { credentialRef: flags.one.get("--credential-ref") } : {}),
          ...(!flags.booleans.has("--disabled") ? { enabled: true } : { enabled: false }),
        }
      : {}),
    ...(route.id === "provider-update"
      ? {
          ...(flags.one.has("--name") ? { name: flags.one.get("--name") } : {}),
          ...(flags.one.has("--model") ? { model: flags.one.get("--model") } : {}),
          ...(flags.one.has("--base-url") ? { baseUrl: flags.one.get("--base-url") } : {}),
          ...(flags.booleans.has("--clear-base-url") ? { baseUrl: "" } : {}),
          ...(flags.one.has("--api-key-file") ? { apiKeyFile: flags.one.get("--api-key-file") } : {}),
          ...(flags.one.has("--credential-ref") ? { credentialRef: flags.one.get("--credential-ref") } : {}),
          ...(flags.booleans.has("--enable") ? { enabled: true } : {}),
          ...(flags.booleans.has("--disable") ? { enabled: false } : {}),
        }
      : {}),
  };
  return accepted(rootDir, undefined, json, action, route.method);
}
