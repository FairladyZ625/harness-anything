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

type SubmissionArtifact = {
  readonly anchor: ArtifactDelivery;
  readonly body: string;
  readonly encoding: "utf8" | "base64";
  readonly acceptance: string;
};
/** One read operation owns its acceptance indexes; nothing survives the operation. */
export function createSubmissionArtifactReader(cell: Pick<RepoCellOperationalContext, "store" | "cellCodedError">) {
  const acceptances = new Map<
    number,
    { readonly opId: string; readonly blobs: ReadonlyMap<string, string | undefined> } | null
  >();
  const acceptanceAt = (revision: number) => {
    if (!acceptances.has(revision)) {
      const event = cell.store.readEventAtRevision?.(revision);
      if (!event || event.workspaceRevision !== revision) acceptances.set(revision, null);
      else {
        const blobs = new Map<string, string | undefined>(),
          claims = isDocEvent(event)
            ? event.payload.changes
            : isTaskEvent(event) || isTaskProgressEvent(event)
              ? (event.payload.carriedDocumentClaims ?? [])
              : [];
        if (isTaskBootstrapEvent(event)) {
          for (const claim of event.payload.initialDocumentClaims)
            if (!blobs.has(claim.path)) blobs.set(claim.path, claim.sha256);
        } else {
          for (const claim of claims) if (!blobs.has(claim.path)) blobs.set(claim.path, claim.candidate?.sha256);
        }
        acceptances.set(revision, { opId: event.opId, blobs });
      }
    }
    return acceptances.get(revision);
  };
  // Resolve only center-accepted bytes; current workspace files never prove a historical cut.
  return (packagePath: string, path: string, revision: number, expectedBlob?: string): SubmissionArtifact => {
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
    const acceptance = acceptanceAt(revision);
    if (!acceptance) return invalid("revision is not a document acceptance");
    const blobSha256 = acceptance.blobs.get(artifact);
    if (!blobSha256) return invalid("revision did not accept this path");
    const bytes = cell.store.readContentBlob(blobSha256);
    if (!bytes || sha256Bytes(bytes) !== blobSha256 || (expectedBlob !== undefined && expectedBlob !== blobSha256))
      return invalid("accepted content is unavailable or does not match its frozen identity");
    const encoding = isUtf8(bytes) ? "utf8" : "base64",
      body = Buffer.from(bytes).toString(encoding);
    return { anchor: { path: artifact, revision, blobSha256 }, body, encoding, acceptance: acceptance.opId };
  };
}

/** A single-artifact read uses the same identity checks without retaining an index. */
export function readSubmissionArtifact(
  cell: Pick<RepoCellOperationalContext, "store" | "cellCodedError">,
  ...args: Parameters<ReturnType<typeof createSubmissionArtifactReader>>
): SubmissionArtifact {
  return createSubmissionArtifactReader(cell)(...args);
}
