import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  consumeKnownError,
  documentPath,
  resolveHarnessLayout,
  type DocSyncReceiptDetail,
  type EventPublicationKillpoint,
  type WriteReceipt,
  type WriteSource,
} from "../../kernel/src/index.ts";
import type { Action, Input } from "./doc-sync-command-actions.ts";
import type { RuntimeDispatchArchive } from "./doc-sync-publication.ts";

export function localProseSource(source: WriteSource): boolean {
  return source === "local";
}

export function runtimeArchiveText(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

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
  input: Pick<Input, "rootDir" | "projection">,
  value: string,
): { readonly absolute: string; readonly relative: string } {
  const root = realpathSync.native(input.rootDir),
    candidate = path.resolve(input.rootDir, value);
  let absolute: string;
  try {
    absolute = realpathSync.native(candidate);
  } catch {
    throw docSyncError("artifact_source_missing", "artifact source must be an existing untracked regular file");
  }
  if (
    !absolute.startsWith(`${root}${path.sep}`) ||
    lstatSync(candidate).isSymbolicLink() ||
    !lstatSync(candidate).isFile()
  )
    throw docSyncError(
      "artifact_source_invalid",
      "artifact source must be a direct regular file inside the repository",
    );
  const relative = path.relative(root, absolute).split(path.sep).join("/"),
    authoredRoot = realpathSync.native(resolveHarnessLayout(input.rootDir).authoredRoot),
    authoredRelative = path.relative(authoredRoot, absolute).split(path.sep).join("/"),
    projected =
      !authoredRelative.startsWith("../") && !path.isAbsolute(authoredRelative)
        ? input.projection.readDocument(authoredRelative).document
        : null;
  if (projected !== null || gitTracked(input.rootDir, relative))
    throw docSyncError(
      "artifact_source_tracked",
      "artifact source must be untracked; use ha doc sync for tracked edits",
    );
  return { absolute, relative };
}

export function gitTracked(rootDir: string, target: string): boolean {
  try {
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
    ) as Error & { opId: string; cause?: unknown };
    error.opId = opId;
    error.cause = cause;
    throw error;
  }
}

export function proof(
  committedRevision: number,
  appliedCut: number,
  canonicalVisible: boolean,
  worktreeVisible: boolean | null,
) {
  return {
    committedRevision,
    appliedCut,
    durable: true,
    canonicalVisible,
    worktreeVisible,
  };
}

export function rejectDocSyncAction(
  opId: string,
  code: string,
  receiptDetail: DocSyncReceiptDetail,
  nextAction: string,
): WriteReceipt {
  return {
    outcome: "op_rejected",
    opId,
    code,
    origin: "doc-sync-contract",
    evidence: `contract-rejection:${code}`,
    nextAction,
    detail: receiptDetail,
  };
}

export function requiredDocSyncText(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw docSyncError("invalid_command", `${name} is required`);
}

export function hasExactDocSyncActionFields(value: Action, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

export function docSyncError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
