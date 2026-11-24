import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
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