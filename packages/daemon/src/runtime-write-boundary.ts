import path from "node:path";

/** The three roots a dispatch write must be judged against, all resolved on the node that runs it. */
export interface WorkerWriteBoundary {
  /** The checkout workers must not edit: the canonical repository root on this node. */
  readonly rootDir: string;
  /** This dispatch's own checkout (a task worktree, a package directory, or the root itself). */
  readonly workerRoot: string;
  /** The private ledger subrepository, which workers legitimately write through `ha doc`/rulings. */
  readonly ledgerRoot: string;
}

/**
 * Whether a provider-reported file path leaves the dispatch's own checkout and lands in the
 * canonical checkout. Relative paths are resolved by the provider against its cwd, so they are
 * never reported here as escapes; only an absolute path can bypass that boundary.
 *
 * The comparison is lexical: it answers "which checkout would this path open", not "where does a
 * symlink inside it point". A provider that writes through an absolute symlink outside the root
 * is out of scope for this observation and remains a permission-boundary decision.
 */
export function escapesWorkerWorktree(filePath: string, boundary: WorkerWriteBoundary): boolean {
  if (!path.isAbsolute(filePath)) return false;
  const target = path.resolve(filePath),
    root = path.resolve(boundary.rootDir),
    worker = path.resolve(boundary.workerRoot),
    ledger = path.resolve(boundary.ledgerRoot);
  if (target === root || contains(worker, target) || !contains(root, target)) return false;
  // The private ledger is a separate subrepository with its own write port, and the runtime's own
  // `.harness` bookkeeping is not source. Both sit under the canonical root but are not escapes.
  return (
    !contains(ledger, target) &&
    !contains(path.join(root, ".harness"), target) &&
    !contains(path.join(root, ".git"), target)
  );
}

/** The one wording for the live activity and the settlement conclusion; bounded so a path list
 * never turns a receipt into a transcript. */
export function strayWriteWarning(
  paths: readonly string[],
  boundary: Pick<WorkerWriteBoundary, "rootDir" | "workerRoot">,
): string {
  const shown = paths.slice(0, 5).map((value) => (value.length > 240 ? `${value.slice(0, 237)}...` : value)),
    more = paths.length > shown.length ? ` (and ${String(paths.length - shown.length)} more)` : "";
  return (
    `Stray write outside the worker worktree: ${shown.join(", ")}${more}. ` +
    `Edits must stay under ${boundary.workerRoot}; ${boundary.rootDir} is the canonical checkout and is ` +
    "read-only for this dispatch. Restore the stray files before delivery."
  );
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
