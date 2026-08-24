import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import {
  accepted,
  readFlags,
  rejectInput,
  rejected,
} from "./thin-command-flags.ts";
import type {
  ProtocolCommand,
  ThinCliInputDirectory,
  ThinParseResult,
} from "./thin-command-types.ts";

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
    !flags.one.has("--name") &&
    !flags.one.has("--installation") &&
    models.length === 0 &&
    !flags.one.has("--default-model") &&
    !flags.one.has("--permission-mode") &&
    !flags.one.has("--isolation") &&
    !enable &&
    !disable
  )
    return rejected(
      "invalid_field",
      "Runtime instance update requires --name, --installation, --model, --default-model, " +
        "--permission-mode, --isolation, --enable, or --disable.",
      json,
    );
  return accepted(
    rootDir,
    undefined,
    json,
    {
      kind: route.id,
      instanceId,
      ...(flags.one.get("--name") ? { name: flags.one.get("--name") } : {}),
      ...(flags.one.get("--installation")
        ? { installationId: flags.one.get("--installation") }
        : {}),
      ...(models.length ? { models } : {}),
      ...(flags.one.get("--default-model")
        ? { defaultModel: flags.one.get("--default-model") }
        : {}),
      ...(flags.one.get("--permission-mode")
        ? { permissionMode: flags.one.get("--permission-mode") }
        : {}),
      ...(flags.one.get("--isolation")
        ? { isolationState: flags.one.get("--isolation") }
        : {}),
      ...(enable || disable ? { enabled: enable } : {}),
    },
    route.method,
  );
}
