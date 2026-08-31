import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { accepted, rejected } from "./thin-command-flags.ts";
import type { ThinParseResult } from "./thin-command-types.ts";

export function parseExplain(
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  method: string,
): ThinParseResult {
  const targets = args.slice(1);
  if (targets.length === 1 && targets[0] === "task")
    return accepted(
      rootDir,
      repoId,
      json,
      { kind: "entity-action-explain", schema: "entity-action-explain-request/v1", mode: "catalog", refs: [] },
      method,
    );
  if (targets.length < 1 || targets.length > 500 || targets.some((target) => !/^task\/.+/u.test(target)))
    return rejected(
      "invalid_field",
      "Use ha explain task for the catalog, or ha explain task/<task-id> [task/<task-id>...] for 1..500 objects.",
      json,
    );
  return accepted(
    rootDir,
    repoId,
    json,
    { kind: "entity-action-explain", schema: "entity-action-explain-request/v1", mode: "object", refs: targets },
    method,
  );
}
