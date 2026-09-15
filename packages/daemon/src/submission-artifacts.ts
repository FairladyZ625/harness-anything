import { isUtf8 } from "node:buffer";
import {
  isDocEvent,
  normalizeRelativeDocumentPath,
  sha256Bytes,
  type ArtifactDelivery,
} from "../../kernel/src/index.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";

export const artifactAnchorGuidance =
  "Use artifact:artifacts/report.md; submit pins the current center-accepted revision.";

const artifactAnchorPattern = /artifact:([^\s`<>@]+?)(?:@([1-9][0-9]*))?(?=$|[\s`<>,)，。]|[.](?=$|[\s`<>,)，。]))/gu;

type ArtifactAnchorMatch = {
  readonly path: string;
  readonly revision?: number;
  readonly start: number;
  readonly end: number;
};

function artifactAnchorMatches(summary: string): readonly ArtifactAnchorMatch[] {
  return [...summary.matchAll(artifactAnchorPattern)].map((match) => ({
    path: match[1]!,
    ...(match[2] === undefined ? {} : { revision: Number(match[2]) }),
    start: match.index!,
    end: match.index! + match[0]!.length,
  }));
}

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
): { readonly anchor: ArtifactDelivery; readonly body: string; readonly acceptance: string } {
  const invalid = (reason: string): never => {
    throw cell.cellCodedError(
      "invalid_submission",
      `Artifact ${path}@${revision}: ${reason}. ${artifactAnchorGuidance}`,
    );
  };
  let normalized: string;
  try {
    normalized = normalizeRelativeDocumentPath(path);
  } catch (cause) {
    throw Object.assign(new Error(`Artifact path is invalid: ${path}. ${artifactAnchorGuidance}`, { cause }), {
      code: "invalid_submission",
    });
  }
  const artifact = submissionArtifactPath(packagePath, normalized);
  if (normalized !== path || !artifact.startsWith(`${packagePath}/artifacts/`))
    return invalid("path must belong to this task's artifacts");
  if (!Number.isSafeInteger(revision) || revision < 1) invalid("revision must be a positive safe integer");
  const event = cell.store.readBatch(String(revision - 1), 1).events[0];
  if (!event || event.workspaceRevision !== revision || !isDocEvent(event))
    return invalid("revision is not a document acceptance");
  const change = event.payload.changes.find((candidate) => candidate.path === artifact);
  if (!change?.candidate) return invalid("revision did not accept this path");
  const blobSha256 = change.candidate.sha256,
    bytes = cell.store.readContentBlob(blobSha256);
  if (!bytes || sha256Bytes(bytes) !== blobSha256 || (expectedBlob !== undefined && expectedBlob !== blobSha256))
    return invalid("accepted content is unavailable or does not match its frozen identity");
  if (!isUtf8(bytes)) return invalid("review delivery must be UTF-8 text");
  const body = new TextDecoder().decode(bytes);
  return { anchor: { path: artifact, revision, blobSha256 }, body, acceptance: event.opId };
}

export function artifactAnchors(summary: string): readonly { readonly path: string; readonly revision?: number }[] {
  return artifactAnchorMatches(summary).map(({ path, revision }) => ({
    path,
    ...(revision === undefined ? {} : { revision }),
  }));
}

export function removeArtifactAnchors(summary: string): string {
  let cursor = 0,
    result = "";
  for (const { start, end } of artifactAnchorMatches(summary)) {
    result += summary.slice(cursor, start);
    cursor = end;
  }
  return result + summary.slice(cursor);
}
