import { isUtf8 } from "node:buffer";
import {
  isDocEvent,
  isTaskBootstrapEvent,
  isTaskEvent,
  isTaskProgressEvent,
  normalizeRelativeDocumentPath,
  sha256Bytes,
  type ArtifactDelivery,
} from "@harness-anything/kernel";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";

/** Anchors name this task's artifacts package-relative; the frozen cut stores the full task-package path. */
export function submissionArtifactPath(packagePath: string, path: string): string {
  return path.startsWith("artifacts/") ? `${packagePath}/${path}` : path;
}

/** Resolve only center-accepted bytes; current workspace files are never evidence for a historical cut. */
export function readSubmissionArtifact(
  cell: Pick<RepoCellOperationalContext, "store" | "cellCodedError">,
  packagePath: string,
  path: string,
  revision: number,
  expectedBlob?: string,
): {
  readonly anchor: ArtifactDelivery;
  readonly body: string;
  readonly encoding: "utf8" | "base64";
  readonly acceptance: string;
} {
  const resolved = resolveSubmissionArtifact(cell, packagePath, path, revision, expectedBlob);
  const bytes = cell.store.readContentBlob(resolved.blobSha256);
  if (!bytes || sha256Bytes(bytes) !== resolved.blobSha256)
    throw cell.cellCodedError(
      "invalid_submission",
      `Artifact ${path}@${revision}: accepted content is unavailable or does not match its frozen identity. ` +
        "Sync deliverables with ha doc sync --submit --task <task-id> before submitting.",
    );
  const encoding = isUtf8(bytes) ? "utf8" : "base64",
    body = Buffer.from(bytes).toString(encoding);
  return {
    anchor: { path: resolved.artifact, revision, blobSha256: resolved.blobSha256 },
    body,
    encoding,
    acceptance: resolved.acceptance,
  };
}

export function readSubmissionArtifactRange(
  cell: Pick<RepoCellOperationalContext, "store" | "cellCodedError">,
  packagePath: string,
  path: string,
  revision: number,
  expectedBlob: string | undefined,
  offset: number,
  maxBytes: number,
): {
  readonly anchor: ArtifactDelivery;
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly acceptance: string;
} {
  const resolved = resolveSubmissionArtifact(cell, packagePath, path, revision, expectedBlob);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > 64 * 1024
  )
    throw cell.cellCodedError("invalid_submission", `Artifact ${path}@${revision}: invalid range.`);
  const bytes = cell.store.readContentBlobRange?.(resolved.blobSha256, offset, maxBytes);
  if (!bytes)
    throw cell.cellCodedError(
      "invalid_submission",
      `Artifact ${path}@${revision}: accepted content is unavailable. ` +
        "Sync deliverables with ha doc sync --submit --task <task-id> before submitting.",
    );
  return {
    anchor: { path: resolved.artifact, revision, blobSha256: resolved.blobSha256 },
    bytes,
    size: resolved.size,
    acceptance: resolved.acceptance,
  };
}

function resolveSubmissionArtifact(
  cell: Pick<RepoCellOperationalContext, "store" | "cellCodedError">,
  packagePath: string,
  path: string,
  revision: number,
  expectedBlob: string | undefined,
): { readonly artifact: string; readonly blobSha256: string; readonly size: number; readonly acceptance: string } {
  const invalid = (reason: string): never => {
    throw cell.cellCodedError(
      "invalid_submission",
      `Artifact ${path}@${revision}: ${reason}. Sync deliverables with ha doc sync --submit --task <task-id> before submitting.`,
    );
  };
  let normalized: string;
  try {
    normalized = normalizeRelativeDocumentPath(path);
  } catch (cause) {
    throw Object.assign(
      new Error(
        `Artifact path is invalid: ${path}. Sync deliverables with ha doc sync --submit --task <task-id> before submitting.`,
        { cause },
      ),
      {
        code: "invalid_submission",
      },
    );
  }
  const artifact = submissionArtifactPath(packagePath, normalized);
  if (normalized !== path || !artifact.startsWith(`${packagePath}/artifacts/`))
    return invalid("path must belong to this task's artifacts");
  if (!Number.isSafeInteger(revision) || revision < 1) invalid("revision must be a positive safe integer");
  const event = cell.store.readEventAtRevision?.(revision);
  if (!event || event.workspaceRevision !== revision) return invalid("revision is not a document acceptance");
  const claims = isDocEvent(event)
    ? event.payload.changes
    : isTaskEvent(event) || isTaskProgressEvent(event)
      ? (event.payload.carriedDocumentClaims ?? [])
      : [];
  const claim = isTaskBootstrapEvent(event)
    ? event.payload.initialDocumentClaims.find((candidate) => candidate.path === artifact)
    : claims.find((candidate) => candidate.path === artifact)?.candidate;
  const blobSha256 = claim?.sha256;
  if (!blobSha256 || (expectedBlob !== undefined && expectedBlob !== blobSha256))
    return invalid("revision did not accept this path");
  return { artifact, blobSha256, size: claim.size, acceptance: event.opId };
}
