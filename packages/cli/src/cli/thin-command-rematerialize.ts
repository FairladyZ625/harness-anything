import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { accepted, readFlags, rejected, rejectInput } from "./thin-command-flags.ts";
import type { ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

/** Shared parser for `ha <decision|fact|task> rematerialize --all|--id <id> [--dry-run]`. */
export function parseRematerialize(
  id: string,
  idField: "decisionId" | "factId" | "taskId",
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const f = readFlags(id, args.slice(2), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const entityId = f.one.get("--id");
  if (Boolean(entityId) === f.booleans.has("--all")) return rejectInput(inputs, id, "--all", json);
  return accepted(rootDir, repoId, json, {
    kind: id,
    ...(entityId ? { [idField]: entityId } : { all: true }),
    dryRun: f.booleans.has("--dry-run"),
  });
}
