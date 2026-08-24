import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import {
  accepted,
  nonEmpty,
  readFlags,
  rejected,
} from "./thin-command-flags.ts";
import type {
  ThinCliInputDirectory,
  ThinParseResult,
} from "./thin-command-types.ts";

export function parseDoc(
  id: string,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  if (id === "doc-materialize")
    return args.length === 2
      ? accepted(rootDir, repoId, json, { kind: id })
      : rejected("unknown_field", "ha doc materialize takes no options.", json);
  if (id.startsWith("doc-conflict-")) {
    const verb = args[2],
      conflictId = args[3];
    return nonEmpty(conflictId) && args.length === 4
      ? accepted(rootDir, repoId, json, { kind: id, conflictId })
      : rejected(
          "missing_field",
          `Run ha doc conflict ${verb ?? "<resolve|discard-local|overwrite-center>"} <conflict-id>.`,
          json,
        );
  }
  const sync = id === "doc-sync-submit" || id === "doc-sync-dry-run",
    f = readFlags(id, args.slice(sync ? 3 : 2), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const paths = f.many.get("--path") ?? [];
  const taskId = f.one.get("--task");
  if (taskId && paths.length)
    return rejected(
      "invalid_field",
      "Use either --task <task-id> or --path for doc sync; task sync discovers its package paths automatically.",
      json,
    );
  if (id === "doc-show")
    return accepted(rootDir, repoId, json, {
      kind: id,
      path: f.one.get("--path"),
    });
  if (id === "doc-retire")
    return accepted(rootDir, repoId, json, {
      kind: id,
      path: f.one.get("--path"),
      reason: f.one.get("--reason"),
    });
  if (id === "doc-status")
    return accepted(rootDir, repoId, json, { kind: id, ...(taskId ? { taskId } : {}), paths });
  if (id === "doc-sync-dry-run")
    return accepted(rootDir, repoId, json, { kind: "doc-dry-run", ...(taskId ? { taskId } : {}), paths });
  return accepted(rootDir, repoId, json, {
    kind: "doc-submit",
    ...(taskId ? { taskId } : {}),
    paths,
  });
}
