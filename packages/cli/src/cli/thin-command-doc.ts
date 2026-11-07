import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { accepted, nonEmpty, readFlags, rejected } from "./thin-command-flags.ts";
import type { ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

// The marker tells the daemon doc action entry that these strings are CLI-typed workspace-relative
// paths; daemon-internal callers keep passing authored keys and are never translated.
const workspacePaths = Object.freeze({ pathCoordinate: "workspace" as const });

export function parseDoc(
  id: string,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  if (id === "doc-materialize") {
    const f = readFlags(id, args.slice(2), inputs);
    if (!f.ok) return rejected(f.code, f.nextAction, json);
    const paths = f.many.get("--path") ?? [],
      all = f.booleans.has("--all");
    if (all && paths.length)
      return rejected("invalid_field", "Use either --path or --all for doc materialize, not both.", json);
    return accepted(rootDir, repoId, json, { kind: id, paths, ...(all ? { all: true } : {}), ...workspacePaths });
  }
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
  const taskId = f.one.get("--task"),
    all = f.booleans.has("--all");
  if (taskId && paths.length)
    return rejected(
      "invalid_field",
      "Use either --task <task-id> or --path for doc sync; task sync discovers its package paths automatically.",
      json,
    );
  if (id === "doc-show") {
    const offset = f.one.get("--offset"),
      length = f.one.get("--length"),
      sha256 = f.one.get("--content-sha256"),
      revision = f.one.get("--content-revision");
    const integer = (value: string | undefined) =>
      value !== undefined && /^(?:0|[1-9][0-9]*)$/u.test(value) && Number.isSafeInteger(Number(value));
    if (
      (offset === undefined) !== (length === undefined) ||
      (sha256 === undefined) !== (revision === undefined) ||
      (sha256 !== undefined && offset === undefined) ||
      (offset !== undefined &&
        (!integer(offset) || !integer(length) || Number(length) < 1 || Number(length) > 65536)) ||
      (sha256 !== undefined && (!/^[a-f0-9]{64}$/u.test(sha256) || !integer(revision)))
    )
      return rejected(
        "invalid_field",
        "Use paired --offset/--length and, when pinning, --content-sha256/--content-revision.",
        json,
      );
    return accepted(rootDir, repoId, json, {
      ...workspacePaths,
      kind: id,
      path: f.one.get("--path"),
      ...(f.booleans.has("--raw") ? { raw: true } : {}),
      ...(offset === undefined ? {} : { offset: Number(offset), length: Number(length) }),
      ...(sha256 === undefined ? {} : { contentSha256: sha256, contentRevision: Number(revision) }),
    });
  }
  if (id === "doc-retire")
    return accepted(rootDir, repoId, json, {
      ...workspacePaths,
      kind: id,
      paths: f.many.get("--path") ?? [],
      reason: f.one.get("--reason"),
    });
  if (id === "doc-status")
    return accepted(rootDir, repoId, json, {
      ...workspacePaths,
      kind: id,
      ...(taskId ? { taskId } : { paths }),
    });
  if (id === "doc-sync-dry-run")
    return accepted(rootDir, repoId, json, {
      ...workspacePaths,
      kind: "doc-dry-run",
      ...(taskId ? { taskId } : { paths }),
    });
  return accepted(rootDir, repoId, json, {
    ...workspacePaths,
    kind: "doc-submit",
    ...(taskId ? { taskId } : { paths, ...(all ? { all: true } : {}) }),
  });
}
