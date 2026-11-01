import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
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
  readonly encoding: "utf8" | "base64";
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
  const encoding = verifyAcceptedContent(cell, resolved.blobSha256, resolved.size);
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
    encoding,
    acceptance: resolved.acceptance,
  };
}

const verifiedContent = new Map<string, "utf8" | "base64">();

/** Verify a frozen claim without allocating the complete object when positioned reads exist. */
export function verifyAcceptedContent(
  cell: Pick<RepoCellOperationalContext, "store" | "cellCodedError">,
  blobSha256: string,
  size: number,
): "utf8" | "base64" {
  const key = `${blobSha256}:${size}`;
  const cached = verifiedContent.get(key);
  if (cached) return cached;
  const hash = createHash("sha256");
  let offset = 0;
  let utf8 = true;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const range = cell.store.readContentBlobRange;
  if (range) {
    while (offset < size) {
      const bytes = range(blobSha256, offset, Math.min(64 * 1024, size - offset));
      if (!bytes || bytes.byteLength === 0 || bytes.byteLength > size - offset)
        throw cell.cellCodedError(
          "content_claim_mismatch",
          `Content object ${blobSha256} is shorter than its accepted size.`,
        );
      hash.update(bytes);
      if (utf8) {
        try {
          decoder.decode(bytes, { stream: true });
        } catch {
          utf8 = false;
        }
      }
      offset += bytes.byteLength;
    }
  } else {
    const bytes = cell.store.readContentBlob(blobSha256);
    if (!bytes || bytes.byteLength !== size)
      throw cell.cellCodedError(
        "content_claim_mismatch",
        `Content object ${blobSha256} is unavailable or has the wrong size.`,
      );
    hash.update(bytes);
    utf8 = isUtf8(bytes);
    offset = bytes.byteLength;
  }
  if (utf8) {
    try {
      decoder.decode();
    } catch {
      utf8 = false;
    }
  }
  if (offset !== size || hash.digest("hex") !== blobSha256)
    throw cell.cellCodedError(
      "content_claim_mismatch",
      `Content object ${blobSha256} does not match its accepted digest.`,
    );
  const encoding = utf8 ? "utf8" : "base64";
  verifiedContent.set(key, encoding);
  return encoding;
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
  if (!blobSha256) return invalid("revision did not accept this path");
  if (expectedBlob !== undefined && expectedBlob !== blobSha256)
    return invalid("frozen identity does not match the accepted content");
  if (!Number.isSafeInteger(claim.size) || claim.size < 0) return invalid("accepted content claim has an invalid size");
  return { artifact, blobSha256, size: claim.size, acceptance: event.opId };
}
