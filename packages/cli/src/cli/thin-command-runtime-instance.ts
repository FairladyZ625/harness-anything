import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { accepted, nonEmpty, readFlags, rejected } from "./thin-command-flags.ts";
import { parseRuntimeInstanceCreate } from "./thin-command-runtime-instance-create.ts";
import { parseRuntimeInstanceUpdate } from "./thin-command-runtime-instance-update.ts";
import type { ProtocolCommand, ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

export function parseRuntimeInstance(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const kind = route.id,
    positional = "positional" in route && route.positional === "instanceId",
    auth = ["runtime-instance-login", "runtime-instance-logout"].includes(kind),
    instanceId = positional ? args[route.path.length] : undefined,
    flags = readFlags(kind, args.slice(route.path.length + (positional ? 1 : 0)), inputs);
  if (!flags.ok) return rejected(flags.code, flags.nextAction, json);
  if (positional && !nonEmpty(instanceId)) return rejected("missing_field", "Runtime instance id is required.", json);
  if (kind === "runtime-instance-update")
    return parseRuntimeInstanceUpdate(route, rootDir, instanceId, json, inputs, flags);
  if (kind === "runtime-instance-create") return parseRuntimeInstanceCreate(route, rootDir, json, flags);
  return accepted(
    rootDir,
    auth ? repoId : undefined,
    json,
    {
      kind,
      ...(instanceId ? { instanceId } : {}),
      ...(kind === "runtime-instance-list" && flags.booleans.has("--all") ? { all: true } : {}),
      ...(kind === "runtime-instance-show" && flags.booleans.has("--probe") ? { probe: true } : {}),
      ...(kind === "runtime-instance-github-credential-set" ? { githubCredentialRef: flags.one.get("--ref") } : {}),
      ...(auth && flags.one.get("--idempotency-key") ? { idempotencyKey: flags.one.get("--idempotency-key") } : {}),
    },
    route.method,
  );
}
