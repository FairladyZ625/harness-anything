import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { accepted, readFlags, rejectInput, rejected } from "./thin-command-flags.ts";
import type { ProtocolCommand, ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

type ParsedFlags = Extract<ReturnType<typeof readFlags>, { readonly ok: true }>;

export function parseRuntimeInstanceUpdate(
  route: ProtocolCommand,
  rootDir: SafePath,
  instanceId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
  flags: ParsedFlags,
): ThinParseResult {
  const enable = flags.booleans.has("--enable"),
    disable = flags.booleans.has("--disable"),
    models = flags.many.get("--model") ?? [];
  if (enable && disable) return rejectInput(inputs, route.id, "--enable", json);
  if (
    !flags.booleans.has("--api-key-stdin") &&
    !flags.one.has("--api-key-file") &&
    !flags.one.has("--name") &&
    !flags.one.has("--installation") &&
    models.length === 0 &&
    !flags.one.has("--default-model") &&
    !flags.one.has("--base-url") &&
    !flags.one.has("--effort") &&
    !flags.one.has("--permission-mode") &&
    !flags.one.has("--isolation") &&
    !flags.booleans.has("--fast") &&
    !enable &&
    !disable
  )
    return rejected(
      "invalid_field",
      "Runtime instance update requires --name, --installation, --model, --default-model, " +
        "--base-url, --effort, --permission-mode, --isolation, --fast, --enable, --disable, --api-key-stdin, or --api-key-file.",
      json,
    );
  return accepted(
    rootDir,
    undefined,
    json,
    {
      kind: route.id,
      instanceId,
      ...(flags.booleans.has("--api-key-stdin") ? { apiKeyStdin: true } : {}),
      ...(flags.one.has("--api-key-file") ? { apiKeyFile: flags.one.get("--api-key-file") } : {}),
      ...(flags.one.get("--name") ? { name: flags.one.get("--name") } : {}),
      ...(flags.one.get("--installation") ? { installationId: flags.one.get("--installation") } : {}),
      ...(models.length ? { models } : {}),
      ...(flags.one.get("--default-model") ? { defaultModel: flags.one.get("--default-model") } : {}),
      ...(flags.one.has("--base-url") ? { baseUrl: flags.one.get("--base-url") } : {}),
      ...(flags.one.has("--effort") ? { effort: flags.one.get("--effort") } : {}),
      ...(flags.one.get("--permission-mode") ? { permissionMode: flags.one.get("--permission-mode") } : {}),
      ...(flags.one.get("--isolation") ? { isolationState: flags.one.get("--isolation") } : {}),
      ...(flags.booleans.has("--fast") ? { fast: true } : {}),
      ...(enable || disable ? { enabled: enable } : {}),
    },
    route.method,
  );
}
