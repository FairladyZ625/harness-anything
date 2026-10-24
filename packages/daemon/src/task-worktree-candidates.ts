import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout, sha256Bytes, type TaskProjection } from "@harness-anything/kernel";
import { makeGitReadinessSource } from "./process-port.ts";
import { presetSnapshotReader, taskWorktreeBinding } from "./task-worktree.ts";
import type { AuthoredCandidateInventoryV1 } from "./doc-sync-candidate-scanner.ts";
import type { Snapshot } from "./repo-cell-types.ts";

/**
 * One reader for the task worktree's package bytes: `task submit` and `doc sync` both carry the
 * worker's authored files to the center from here. A dispatch worktree mirrors its own task package
 * with hard links, so an editor that replaces a file atomically leaves the canonical copy stale and
 * only the worktree holds the authored bytes. Duplicating this walk per entry point is how the two
 * channels drift apart.
 */
export function taskWorktreeRoot(
  cell: { readonly rootDir: string; readonly projection: TaskProjection },
  snapshot: Snapshot,
): string | null {
  const binding = taskWorktreeBinding(snapshot.task, presetSnapshotReader(cell.projection));
  if (binding === null) return null;
  const taskRoot = path.join(cell.rootDir, binding.path),
    directory = lstatSync(taskRoot, { throwIfNoEntry: false }),
    top =
      directory?.isDirectory() && !directory.isSymbolicLink()
        ? makeGitReadinessSource().run(taskRoot, ["rev-parse", "--show-toplevel"])
        : null;
  return top?.ok && realpathSync(top.stdout.trim()) === realpathSync(taskRoot) ? taskRoot : null;
}

export function taskWorktreeCandidateInventory(
  rootDir: string,
  taskRoot: string,
  packagePath: string | null,
  baseLedgerSha: AuthoredCandidateInventoryV1["baseLedgerSha"],
  projection: TaskProjection,
): AuthoredCandidateInventoryV1 | undefined {
  if (packagePath === null) return undefined;
  const layout = resolveHarnessLayout(rootDir),
    authoredRelative = path.relative(layout.rootDir, layout.authoredRoot),
    authoredOutsideCheckout =
      authoredRelative === ".." || authoredRelative.startsWith(`..${path.sep}`) || path.isAbsolute(authoredRelative),
    packageRoot = authoredOutsideCheckout ? null : path.resolve(taskRoot, authoredRelative, ...packagePath.split("/")),
    taskRootResolved = path.resolve(taskRoot);
  if (packageRoot === null) return undefined;
  if (packageRoot !== taskRootResolved && !packageRoot.startsWith(`${taskRootResolved}${path.sep}`))
    throw new Error(`Task package ${packagePath} escapes its bound worktree.`);
  const rows: Array<AuthoredCandidateInventoryV1["rows"][number]> = [];
  collectTaskPackageCandidates(packageRoot, packagePath, rows);
  return {
    schema: "harness-authored-candidate-inventory/v1",
    baseLedgerSha,
    rows: rows.filter((row) => {
      const closeoutPath = `${packagePath}/closeout.md`,
        isCloseout = row.path === closeoutPath,
        isArtifact = row.path.startsWith(`${packagePath}/artifacts/`) && !row.path.endsWith("/.gitkeep");
      if (!isCloseout && !isArtifact) return false;
      const current = projection.readDocument(row.path).document;
      return row.safe && row.bytes !== null && (!current || sha256Bytes(row.bytes) !== current.blobSha256);
    }),
  };
}

function collectTaskPackageCandidates(
  directory: string,
  logicalDirectory: string,
  rows: Array<AuthoredCandidateInventoryV1["rows"][number]>,
): void {
  const directoryStat = lstatSync(directory, { throwIfNoEntry: false });
  if (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name),
      logical = `${logicalDirectory}/${entry.name}`,
      stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      collectTaskPackageCandidates(absolute, logical, rows);
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      rows.push({ path: logical, safe: false, size: null, bytes: null, conflicts: [] });
      continue;
    }
    const bytes = readFileSync(absolute);
    rows.push({ path: logical, safe: true, size: bytes.byteLength, bytes, conflicts: [] });
  }
}
