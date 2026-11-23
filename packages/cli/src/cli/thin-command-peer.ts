import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { nonEmpty, rejected } from "./thin-command-flags.ts";
import { parseProjected } from "./thin-command-projection.ts";
import type { ProtocolCommand, ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

export const peerRouteParsers: readonly (readonly [string, typeof parsePeer])[] = [
  ["peer-ask", parsePeer],
  ["peer-reply", parsePeer],
  ["peer-watch", parsePeer],
  ["peer-inbox", parsePeer],
  ["peer-promote", parsePeer],
  ["peer-handoff", parsePeer],
];

export function parsePeer(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const hasPositional = route.id === "peer-reply" || route.id === "peer-promote" || route.id === "peer-handoff";
  const field = route.id === "peer-handoff" ? "targetId" : "requestId";
  const positional = hasPositional ? { [field]: args[2] } : {};
  if (hasPositional && !nonEmpty(args[2])) return rejected("missing_field", `Use ${route.usage}.`, json);
  return parseProjected(
    route.id,
    args.slice(hasPositional ? 3 : 2),
    rootDir,
    repoId,
    json,
    inputs,
    positional,
    {},
    route.method,
  );
}
