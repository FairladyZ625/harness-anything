import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  documentPath,
  isDocEvent,
  resolveDocRoute,
  resolveHarnessLayout,
  type CanonicalEventV1,
  type TaskProjection,
} from "@harness-anything/kernel";
import { makeGitReadinessSource } from "./process-port.ts";
import { presetSnapshotReader, taskWorktreeBinding } from "./task-worktree.ts";
import type { AuthoredCandidateInventoryV1 } from "./doc-sync-candidate-scanner.ts";
import {
  acceptTaskWorktreeDocumentBase,
  recoverTaskWorktreeDocumentBases,
  taskWorktreeDocumentBase,
} from "./worktree-setup.ts";
import { readAuthoredDocumentBytes } from "./authored-document-read-port.ts";
import type { CanonicalEventStore } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import type { Snapshot } from "./repo-cell-types.ts";

/**
 * One reader for the task worktree's package bytes: `task submit` and `doc sync` both carry the
 * worker's authored files to the center from here. A dispatch worktree mirrors its own task package
 * with independent copies and projection bases. Only changes relative to those bases are authored inputs.
 * Duplicating this walk per entry point is how the two channels drift apart.
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
  history?: {
    readonly store: CanonicalEventStore;
    readonly executionIds?: readonly string[];
    readonly projection?: Pick<TaskProjection, "readDocument">;
  },
): AuthoredCandidateInventoryV1 | undefined {
  if (packagePath === null) return undefined;
  const layout = resolveHarnessLayout(rootDir),
    baseRoot = taskWorktreeDocumentBase(taskRoot, packagePath),
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
  if (history !== undefined) {
    const missing = rows.filter(
      (row) =>
        row.safe &&
        resolveDocRoute(documentPath(row.path)).allowed &&
        !lstatSync(path.join(baseRoot, ...row.path.slice(packagePath.length + 1).split("/")), {
          throwIfNoEntry: false,
        }),
    );
    recoverTaskWorktreeDocumentBases(taskRoot, missing, history.store, history.executionIds);
  }
  const executions = new Set(history?.executionIds),
    accepted = new Map<number, CanonicalEventV1 | undefined>();
  return {
    schema: "harness-authored-candidate-inventory/v1",
    baseLedgerSha,
    rows: rows.flatMap((row) => {
      if (row.path.endsWith("/.gitkeep") || !resolveDocRoute(documentPath(row.path)).allowed) return [];
      const basePath = path.join(baseRoot, ...row.path.slice(packagePath.length + 1).split("/")),
        baseStat = lstatSync(basePath, { throwIfNoEntry: false });
      const baseRelative = row.path
        .slice(packagePath.length + 1)
        .split("/")
        .join(path.sep);
      let baseBytes =
        baseStat?.isFile() && !baseStat.isSymbolicLink() ? readAuthoredDocumentBytes(baseRoot, baseRelative) : null;
      if (row.safe && row.bytes !== null && baseBytes !== null && Buffer.from(row.bytes).equals(baseBytes)) return [];
      // A task execution can also author through the canonical checkout. Its accepted current write
      // acknowledges that version, but does not make an untouched stale mirror a new candidate.
      const current = baseBytes === null ? null : history?.projection?.readDocument(row.path).document;
      if (current && history?.store.queryEvents) {
        const currentBytes = history.store.readContentBlob(current.blobSha256);
        if (currentBytes === null)
          throw new Error(`Missing accepted worktree document blob ${current.blobSha256} for ${row.path}.`);
        // An already accepted copy is unchanged too. Leaving it in the overlay would hide a
        // real canonical edit before the scanner can apply its CAS and lease checks.
        if (row.safe && row.bytes !== null && Buffer.from(row.bytes).equals(currentBytes)) {
          acceptTaskWorktreeDocumentBase(taskRoot, row.path, row.bytes);
          return [];
        }
        if (!accepted.has(current.workspaceRevision))
          accepted.set(
            current.workspaceRevision,
            history.store.queryEvents({ revisionBound: current.workspaceRevision + 1, limit: 1 })[0],
          );
        const event = accepted.get(current.workspaceRevision);
        if (
          event &&
          isDocEvent(event) &&
          event.payload.executionId !== null &&
          executions.has(event.payload.executionId)
        ) {
          baseBytes = Buffer.from(currentBytes);
        }
      }
      return [{ ...row, baseBytes }];
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
    const bytes = readAuthoredDocumentBytes(directory, entry.name);
    rows.push({ path: logical, safe: true, size: bytes.byteLength, bytes, conflicts: [] });
  }
}
