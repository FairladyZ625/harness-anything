// `doc sync --submit --path` matches dirty paths reported by `git status` run
// inside the authored root, so the value must be authored-root-relative. The
// `--evidence file:<path>` consumer accepts repo-root-relative paths too, so an
// agent that uses both commands routinely types `harness/tasks/...` here and is
// rejected with a generic "not dirty" error. This module renders the actionable
// suffix that tells them exactly which prefix to drop. See
// task_01KZ92RAJ1HXRSYDY4JP6APRCN for the basis mismatch.

export function renderDocSyncSelectionHint(
  authoredRoot: string,
  missingSelections: ReadonlyArray<string>
): string {
  // `buildDocSyncReport` emits the authored root relative to the repository
  // root (or "." when they coincide); there is nothing to strip in the
  // collapsed case.
  const prefix = authoredRoot && authoredRoot !== "." ? `${authoredRoot}/` : null;
  if (!prefix) return "";
  const rewrites = missingSelections
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length));
  if (rewrites.length === 0) return "";
  const quoted = rewrites.map((path) => `'${path}'`).join(", ");
  return ` Paths are relative to the authored root ('${authoredRoot}/'); drop that prefix and retry with ${quoted}.`;
}
