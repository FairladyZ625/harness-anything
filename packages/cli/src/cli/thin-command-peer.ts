import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { nonEmpty, rejected } from "./thin-command-flags.ts";
import { parseProjected } from "./thin-command-projection.ts";
import type { ProtocolCommand, ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

export const channelRouteParsers: readonly (readonly [string, typeof parseChannel])[] = [
  ["channel-deliver", parseChannel],
  ["channel-list", parseChannel],
  ["channel-send", parseChannel],
];

export function parseChannel(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  return parseProjected(route.id, args.slice(2), rootDir, repoId, json, inputs, {}, {}, route.method);
}

export const peerRouteParsers: readonly (readonly [string, typeof parsePeer])[] = [
  ["peer-ask", parsePeer],
  ["peer-delegate", parsePeer],
  ["peer-reply", parsePeer],
  ["peer-watch", parsePeer],
  ["peer-inbox", parsePeer],
  ["peer-promote", parsePeer],
  ["peer-handoff", parsePeer],
  ["peer-accept-handoff", parsePeer],
  ["peer-takeover", parsePeer],
  ["peer-checkpoint", parsePeer],
];

export function parsePeer(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  if (route.id === "peer-delegate") {
    const parsed = parseProjected(
      route.id,
      args.slice(2),
      rootDir,
      repoId,
      json,
      inputs,
      { kind: "peer-ask" },
      { requestKind: "delegate" },
      route.method,
    );
    if (!parsed.ok) return parsed;
    const summary = typeof parsed.command.action.summary === "string" ? parsed.command.action.summary : undefined;
    if (summary === undefined) return parsed;
    return {
      ok: true,
      command: {
        ...parsed.command,
        action: {
          ...parsed.command.action,
          ...(parsed.command.action.claim === undefined ? { claim: summary } : {}),
          ...(parsed.command.action.requestedAction === undefined ? { requestedAction: summary } : {}),
        },
      },
    };
  }
  const hasPositional =
    route.id === "peer-reply" ||
    route.id === "peer-promote" ||
    route.id === "peer-handoff" ||
    route.id === "peer-accept-handoff" ||
    route.id === "peer-takeover" ||
    route.id === "peer-checkpoint";
  const field =
    route.id === "peer-handoff" || route.id === "peer-takeover" || route.id === "peer-checkpoint"
      ? "targetId"
      : "requestId";
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
