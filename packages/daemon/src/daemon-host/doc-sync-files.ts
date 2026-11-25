import {
  /* @gate-identity check-sync-subprocess/sync-subprocess-003 */
  execFileSync,
} from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  consumeKnownError,
  documentPath,
  documentWorkspacePath,
  resolveHarnessLayout,
  runtimeArchiveText,
  type EventPublicationKillpoint,
} from "@harness-anything/kernel";
import {
  docSyncError,
  hasExactDocSyncActionFields,
  localProseSource,
  proof,
  rejectDocSyncAction,
  requiredDocSyncText,
} from "@harness-anything/application/internal/queries/doc-sync-details.ts";
import type { Input } from "./doc-sync-command-actions.ts";
import type { RuntimeDispatchArchive } from "./doc-sync-publication.ts";

export {
  docSyncError,
  hasExactDocSyncActionFields,
  localProseSource,
  proof,
  rejectDocSyncAction,
  requiredDocSyncText,
  runtimeArchiveText,
};

export function runtimeArchiveMissionRef(
  input: Omit<Input, "action">,
  packagePath: string,
  archive: RuntimeDispatchArchive,
): string | null {
  if (!archive.promptSource) return null;
  const authored = resolveHarnessLayout(input.rootDir).authoredRoot,
    absolute = path.resolve(input.rootDir, archive.promptSource),
    relative = path.relative(authored, absolute).split(path.sep).join("/");
  if (!relative.startsWith(`${packagePath}/artifacts/`)) return null;
  let candidate;
  try {
    candidate = documentPath(relative);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
  const read = input.projection.readDocument(candidate);
  return read.status === "ready" && read.document?.body === runtimeArchiveText(archive.prompt) ? candidate : null;
}

export function artifactSource(
  input: Pick<Input, "rootDir" | "projection" | "workspaceCoordinate">,
  value: string,
): { readonly absolute: string; readonly relative: string } {
  const root = realpathSync.native(input.rootDir),
    candidate = path.resolve(input.rootDir, value);
  let absolute: string;
  try {
    absolute = realpathSync.native(candidate);
  } catch {
    throw docSyncError(
      "artifact_source_missing",
      `artifact source must be an existing untracked regular file: ${value}; ` +
        "the ha CLI sends a UTF-8 file outside the repository as inline content",
    );
  }
  if (
    !absolute.startsWith(`${root}${path.sep}`) ||
    lstatSync(candidate).isSymbolicLink() ||
    !lstatSync(candidate).isFile()
  )
    throw docSyncError(
      "artifact_source_invalid",
      "artifact source must be a direct regular file inside the repository; " +
        "the ha CLI sends a UTF-8 file outside it as inline content",
    );
  const relative = path.relative(root, absolute).split(path.sep).join("/"),
    authoredRoot = realpathSync.native(resolveHarnessLayout(input.rootDir).authoredRoot),
    authoredRelative = path.relative(authoredRoot, absolute).split(path.sep).join("/"),
    insideAuthoredRoot = !authoredRelative.startsWith("..") && !path.isAbsolute(authoredRelative);
  if (
    (insideAuthoredRoot && input.projection.readDocument(authoredRelative).document !== null) ||
    gitTracked(input.rootDir, relative)
  )
    throw docSyncError(
      "artifact_source_tracked",
      "artifact source must be untracked; use ha doc sync for tracked edits",
    );
  // A file already inside a task package has its one entry, doc sync. Its untracked copy cannot be
  // re-registered under a second command and a second name.
  if (insideAuthoredRoot && authoredRelative.startsWith("tasks/"))
    throw docSyncError(
      "artifact_source_in_task_package",
      `source is inside a task package; use ha doc sync --submit --path ${
        input.workspaceCoordinate === true ? documentWorkspacePath(input.rootDir, authoredRelative) : authoredRelative
      }`,
    );
  return { absolute, relative };
}

export function gitTracked(rootDir: string, target: string): boolean {
  try {
    /* @gate-identity check-sync-subprocess/sync-subprocess-004 */
    execFileSync("git", ["-C", rootDir, "ls-files", "--error-unmatch", "--", target], {
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export function gitModified(rootDir: string, target: string): boolean {
  try {
    /* @gate-identity check-sync-subprocess/sync-subprocess-005 */
    execFileSync("git", ["-C", rootDir, "diff", "--quiet", "HEAD", "--", target], {
      stdio: "ignore",
      windowsHide: true,
    });
    return false;
  } catch (error) {
    consumeKnownError(error);
    return true;
  }
}

export function postCommit(input: Pick<Input, "killpoint">, point: EventPublicationKillpoint, opId: string): void {
  try {
    input.killpoint?.(point);
  } catch (cause) {
    const error = docSyncError(
      "publication_indeterminate",
      `publication result is unknown; run ha receipt show ${opId} before retrying`,
    ) as Error & { code: string; opId?: string; cause?: unknown };
    error.opId = opId;
    error.cause = cause;
    throw error;
  }
}
