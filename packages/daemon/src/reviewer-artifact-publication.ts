import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  classifyTextualArtifactPath,
  documentPath,
  resolveHarnessLayout,
  runtimeSessionIdFromActor,
  sha256Text,
  type DocEventChange,
} from "@harness-anything/kernel";
import { cellCodedError } from "./repo-cell-errors.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import { readWorkspaceText } from "./workspace-text-port.ts";

/**
 * The reviewer-authored Markdown report is the physical credential behind every recorded Review.
 * A dispatched review (`review-<dispatchId>`) reports at `artifacts/reports/<dispatchId>.md`; any
 * other review reports at `artifacts/reports/<reviewId>.md`. Recording and consent both require
 * the file to exist on disk with substantive content, so a Review can never be injected from
 * in-memory JSON alone.
 */
export function reviewReportRelativePath(packagePath: string, reviewId: string): string | null {
  const stem = reviewId.startsWith("review-") ? reviewId.slice("review-".length) : reviewId;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(stem) ? `${packagePath}/artifacts/reports/${stem}.md` : null;
}

export function assertPhysicalReviewReport(input: {
  readonly rootDir: string;
  readonly packagePath: string | null;
  readonly reviewId: string;
  readonly taskId: string;
  readonly verb: "review-execution" | "review-consent";
}): void {
  const retry = `ha task ${input.verb} ${input.taskId} --review-id ${input.reviewId}`,
    report = input.packagePath === null ? null : reviewReportRelativePath(input.packagePath, input.reviewId);
  if (report === null)
    throw cellCodedError(
      "review_report_missing",
      `Review ${input.reviewId} has no resolvable physical report path; run ha task dispatch-review ` +
        `${input.taskId} or write the reviewer-authored Markdown report under the task package's ` +
        `artifacts/reports/ directory, then retry ${retry}.`,
    );
  const absolute = path.join(resolveHarnessLayout(input.rootDir).authoredRoot, ...report.split("/"));
  if (!existsSync(absolute) || !statSync(absolute).isFile())
    throw cellCodedError(
      "review_report_missing",
      `Review ${input.reviewId} has no physical report on disk: expected harness/${report}. ` +
        `Write the reviewer-authored Markdown report there, then retry ${retry}. ` +
        "A Review recorded without its landed report cannot be consented.",
    );
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(absolute));
  } catch {
    throw cellCodedError(
      "review_report_invalid",
      `Review report harness/${report} is not readable UTF-8 text; rewrite it as the reviewer-authored ` +
        `Markdown report, then retry ${retry}.`,
    );
  }
  if (!body.trim())
    throw cellCodedError(
      "review_report_invalid",
      `Review report harness/${report} is empty; write the substantive Markdown review findings there, ` +
        `then retry ${retry}.`,
    );
  if (!/^ {0,3}#{1,6}\s+\S/mu.test(body))
    throw cellCodedError(
      "review_report_invalid",
      `Review report harness/${report} is not a substantive review document (it must carry at least one ` +
        "Markdown heading and real findings); provider error output or a placeholder does not qualify. " +
        `Rewrite it, then retry ${retry}.`,
    );
}

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
