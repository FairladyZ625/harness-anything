import { existsSync } from "node:fs";
import path from "node:path";
import {
  classifyTextualArtifactPath,
  documentPath,
  resolveHarnessLayout,
  runtimeSessionIdFromActor,
  sha256Text,
  type DocEventChange,
} from "../../kernel/src/index.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import { readWorkspaceText } from "./workspace-text-port.ts";

export function reviewerArtifactsForReview(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): {
  readonly changes: readonly DocEventChange[];
  readonly blobs: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly body: string;
  }[];
} | null {
  const runtimeSessionId = runtimeSessionIdFromActor(binding.actor);
  if (runtimeSessionId === null) return null;
  const session = cell.projection.readRuntimeSession(runtimeSessionId),
    dispatch = session && cell.projection.readRuntimeDispatch(runtimeSessionId, session.definitionSnapshotRef);
  if (!dispatch) return null;
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    task = cell.projection.read(taskId),
    dispatchId = dispatch.payload.dispatchId;
  if (!task.packagePath) return null;
  const packet = `${task.packagePath}/artifacts/reports/${dispatchId}.json`,
    report = `${task.packagePath}/artifacts/reports/${dispatchId}.md`,
    requestedPacket = String(action.fromFile ?? "").replace(/^harness\//u, "");
  if (action.reviewId !== `review-${dispatchId}` || requestedPacket !== packet) return null;
  const authoredRoot = resolveHarnessLayout(cell.rootDir).authoredRoot;
  for (const candidate of [packet, report])
    if (!existsSync(path.join(authoredRoot, ...candidate.split("/"))))
      throw cell.cellCodedError(
        "invalid_command",
        `Reviewer dispatch ${dispatchId} must write both declared artifacts before recording its review: ` +
          `${packet}, ${report}.`,
      );
  const rows = [packet, report].map((candidate) => {
    const classification = classifyTextualArtifactPath(candidate);
    if (!classification)
      throw cell.cellCodedError("invalid_command", `Reviewer artifact is not textual: ${candidate}.`);
    const body = readWorkspaceText(cell.rootDir, `harness/${candidate}`, "reviewArtifact"),
      sha256 = sha256Text(body),
      size = Buffer.byteLength(body) as DocEventChange["candidate"]["size"];
    return {
      change: {
        path: documentPath(candidate),
        baseBlobSha256: cell.projection.readDocument(candidate).document?.blobSha256 ?? null,
        candidate: { sha256, size, mediaType: classification.mediaType },
        policyId: classification.policyId,
        regionProofs: [],
      } satisfies DocEventChange,
      blob: { sha256, size, mediaType: classification.mediaType, body },
    };
  });
  return { changes: rows.map(({ change }) => change), blobs: rows.map(({ blob }) => blob) };
}
