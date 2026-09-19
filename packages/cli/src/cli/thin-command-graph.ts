import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { accepted, nonEmpty, readFlags, rejected } from "./thin-command-flags.ts";
import type { ProtocolCommand, ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

export function parseGraph(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const ref = args[1];
  if (!nonEmpty(ref) || ref.startsWith("--"))
    return rejected("missing_field", "Use ha graph <task-id|dec-id|fact-id|slug>.", json);
  const flags = readFlags(route.id, args.slice(2), inputs);
  if (!flags.ok) return rejected(flags.code, flags.nextAction, json);
  const depth = flags.one.get("--depth");
  return accepted(
    rootDir,
    repoId,
    json,
    {
      kind: "graph",
      ref,
      ...(depth === undefined ? {} : { depth: Number(depth) }),
      ...(flags.booleans.has("--include-archived") ? { includeArchived: true } : {}),
    },
    route.method,
  );
}
