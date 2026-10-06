import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  classifyTextualArtifactPath,
  compileDecisionWrite,
  documentPath,
  resolveHarnessLayout,
  runtimeSessionIdFromActor,
  sha256Text,
  type DocEventChange,
  type DocWriteIntent,
} from "@harness-anything/kernel";
import { claimBytes } from "./doc-sync-details.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import { readWorkspaceText } from "./workspace-text-port.ts";
import { readDispatchStream } from "./dispatch-stream.ts";
import { decisionWritePlan } from "@harness-anything/kernel/internal/domain/decision-event";

/**
 * The reviewer-authored Markdown report is the physical credential behind every recorded Review.
 * A dispatched review (`review-<dispatchId>`) reports at `artifacts/reports/<dispatchId>.md`; any
 * other review reports at `artifacts/reports/<reviewId>.md`. Recording requires substantive report
 * bytes, either already on disk or carried in the same atomic publication. Consent requires the
 * landed report; a Review packet alone is never sufficient.
 */
export function reviewReportRelativePath(packagePath: string, reviewId: string): string | null {
  const stem = reviewId.startsWith("review-") ? reviewId.slice("review-".length) : reviewId;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(stem) ? `${packagePath}/artifacts/reports/${stem}.md` : null;
}

export function assertPhysicalReviewReport(input: {
  readonly rootDir: string;
  readonly packagePath: string | null;
  readonly reviewId: string;
  readonly subject: string;
  readonly retry: string;
  readonly carriedReport?: { readonly path: string; readonly body: string };
}): {
  readonly path: string;
  readonly sha256: string;
  readonly size: DocEventChange["candidate"]["size"];
  readonly mediaType: "text/markdown";
  readonly body: string;
} {
  const retry = input.retry,
    report = input.packagePath === null ? null : reviewReportRelativePath(input.packagePath, input.reviewId);
  if (report === null)
    throw cellCodedError(
      "review_report_missing",
      `Review ${input.reviewId} has no resolvable physical report path; write the reviewer-authored Markdown ` +
        `report under the ${input.subject} package's ` +
        `artifacts/reports/ directory, then retry ${retry}.`,
    );
  const absolute = path.join(resolveHarnessLayout(input.rootDir).authoredRoot, ...report.split("/"));
  if (input.carriedReport && input.carriedReport.path !== report)
    throw cellCodedError("review_report_invalid", `Review report must be ${report}.`);
  if (!input.carriedReport && (!existsSync(absolute) || !statSync(absolute).isFile()))
    throw cellCodedError(
      "review_report_missing",
      `Review ${input.reviewId} has no physical report on disk: expected harness/${report}. ` +
        `Write the reviewer-authored Markdown report there, then retry ${retry}. ` +
        "A Review recorded without its landed report cannot be consented.",
    );
  let body: string;
  try {
    body = input.carriedReport?.body ?? new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(absolute));
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
  return {
    path: report,
    sha256: sha256Text(body),
    size: Buffer.byteLength(body) as DocEventChange["candidate"]["size"],
    mediaType: "text/markdown",
    body,
  };
}

export function reviewerArtifactsForReview(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  intent?: DocWriteIntent,
): {
  readonly changes: readonly DocEventChange[];
  readonly blobs: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly body: string;
  }[];
} | null {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    task = cell.projection.read(taskId),
    reviewId = cell.requiredCellText(action.reviewId, "reviewId"),
    reportPath = task.packagePath && reviewReportRelativePath(task.packagePath, reviewId),
    runtimeSessionId = runtimeSessionIdFromActor(binding.actor);
  const session = runtimeSessionId === null ? null : cell.projection.readRuntimeSession(runtimeSessionId),
    dispatch = session && cell.projection.readRuntimeDispatch(runtimeSessionId!, session.definitionSnapshotRef);
  if (intent) {
    if (runtimeSessionId !== null && (!dispatch || reviewId !== `review-${dispatch.payload.dispatchId}`))
      throw cell.cellCodedError("actor_unauthorized", "Review report must belong to the bound reviewer dispatch.");
    if (runtimeSessionId === null && binding.actor.executor !== null)
      throw cell.cellCodedError("actor_unauthorized", "Review report requires a human or bound reviewer runtime.");
    if (intent.changes.length !== 1 || intent.changes[0]?.path !== reportPath)
      throw cell.cellCodedError("review_report_invalid", `Review must carry only its declared report: ${reportPath}.`);
    const change = intent.changes[0]!,
      candidate = change.candidate,
      classification = classifyTextualArtifactPath(change.path);
    if (
      !candidate ||
      !classification ||
      change.policyId !== classification.policyId ||
      candidate.mediaType !== classification.mediaType
    )
      throw cell.cellCodedError("review_report_invalid", "Review report requires its declared textual policy.");
    if ((cell.projection.readDocument(change.path).document?.blobSha256 ?? null) !== change.baseBlobSha256)
      throw cell.cellCodedError("base_blob_changed", "Review report base has changed at the center.");
    const bytes = claimBytes(cell.rootDir, candidate.ref);
    if (!bytes || bytes.byteLength !== candidate.size)
      throw cell.cellCodedError("content_claim_mismatch", "Review report bytes do not match the carried claim.");
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw cell.cellCodedError("review_report_invalid", "Review report must be UTF-8 text.");
    }
    if (sha256Text(body) !== candidate.sha256)
      throw cell.cellCodedError("content_claim_mismatch", "Review report digest does not match the carried claim.");
    return {
      changes: [
        {
          ...change,
          candidate: { sha256: candidate.sha256, size: candidate.size, mediaType: candidate.mediaType },
          regionProofs: [],
        },
      ],
      blobs: [{ sha256: candidate.sha256, size: candidate.size, mediaType: candidate.mediaType, body }],
    };
  }
  if (runtimeSessionId === null) return null;
  if (!dispatch) return null;
  const dispatchId = dispatch.payload.dispatchId;
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

export function decisionReviewerArtifact(input: {
  readonly rootDir: string;
  readonly projection: RepoCellOperationalContext["projection"];
  readonly action: RepoTaskAction;
  readonly binding: RepoCellBinding;
}): {
  readonly changes: readonly DocEventChange[];
  readonly blobs: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly body: string;
  }[];
} | null {
  const decisionId = String(input.action.decisionId ?? ""),
    reviewId = String(input.action.reviewId ?? ""),
    digest = String(input.action.reviewContentDigest ?? ""),
    reportRef = typeof input.action.reportRef === "string" ? input.action.reportRef.replace(/^harness\//u, "") : null,
    runtimeSessionId = runtimeSessionIdFromActor(input.binding.actor);
  if (runtimeSessionId === null) {
    if (input.binding.actor.executor !== null)
      throw cellCodedError(
        "actor_unauthorized",
        "Decision reviews require a bound reviewer dispatch or a direct human actor.",
      );
    const packagePath = `decisions/decision-${decisionId}`,
      artifact = assertPhysicalReviewReport({
        rootDir: input.rootDir,
        packagePath,
        reviewId,
        subject: `Decision ${decisionId}`,
        retry: `ha decision review ${decisionId} --review-id ${reviewId}`,
      });
    if (reportRef !== artifact.path)
      throw cellCodedError("review_report_invalid", `Decision review reportRef must be ${artifact.path}.`);
    const { path: artifactPath, ...blob } = artifact;
    return {
      changes: [
        {
          path: documentPath(artifactPath),
          baseBlobSha256: input.projection.readDocument(artifactPath).document?.blobSha256 ?? null,
          candidate: { sha256: artifact.sha256, size: artifact.size, mediaType: artifact.mediaType },
          policyId: classifyTextualArtifactPath(artifactPath)!.policyId,
          regionProofs: [],
        },
      ],
      blobs: [blob],
    };
  }
  const session = input.projection.readRuntimeSession(runtimeSessionId),
    dispatch = session && input.projection.readRuntimeDispatch(runtimeSessionId, session.definitionSnapshotRef),
    dispatchId = dispatch?.payload.dispatchId ?? "",
    stream = dispatchId ? readDispatchStream(input.rootDir, dispatchId) : null,
    target = stream?.header.reviewTarget;
  if (
    target?.kind !== "decision" ||
    target.decisionId !== decisionId ||
    target.digest !== digest ||
    reviewId !== `review-${dispatchId}`
  )
    throw cellCodedError(
      "actor_unauthorized",
      "Decision review does not match the dispatch's persisted review target.",
    );
  const packagePath = `decisions/decision-${decisionId}`,
    expected = reviewReportRelativePath(packagePath, reviewId),
    packetRef = `${packagePath}/artifacts/reports/${dispatchId}.json`,
    requestedPacket =
      typeof input.action.fromFile === "string" ? input.action.fromFile.replace(/^harness\//u, "") : null;
  if (reportRef !== expected)
    throw cellCodedError("review_report_invalid", `Decision review reportRef must be ${expected}.`);
  const artifact = assertPhysicalReviewReport({
      rootDir: input.rootDir,
      packagePath,
      reviewId,
      subject: `Decision ${decisionId}`,
      retry: `ha decision review ${decisionId} --review-id ${reviewId}`,
    }),
    reportClassification = classifyTextualArtifactPath(artifact.path);
  if (!reportClassification)
    throw cellCodedError("review_report_invalid", `Decision review report is not textual: ${artifact.path}.`);
  const { path: artifactPath, ...reportBlob } = artifact,
    // A reviewer that registered through the dispatch-assigned packet path published that packet
    // with the review; one that used inline JSON authored no packet file, so nothing is carried.
    packet =
      requestedPacket === packetRef
        ? {
            path: documentPath(packetRef),
            body: readWorkspaceText(input.rootDir, `harness/${packetRef}`, "reviewPacket"),
          }
        : null,
    packetClassification = packet === null ? null : classifyTextualArtifactPath(packetRef);
  if (packet !== null && !packetClassification)
    throw cellCodedError("review_report_invalid", `Decision review packet is not textual: ${packetRef}.`);
  const packetChange =
    packet === null || packetClassification === null
      ? null
      : ({
          path: packet.path,
          baseBlobSha256: input.projection.readDocument(packetRef).document?.blobSha256 ?? null,
          candidate: {
            sha256: sha256Text(packet.body),
            size: Buffer.byteLength(packet.body) as DocEventChange["candidate"]["size"],
            mediaType: packetClassification.mediaType,
          },
          policyId: packetClassification.policyId,
          regionProofs: [],
        } satisfies DocEventChange);
  return {
    changes: [
      {
        path: documentPath(artifactPath),
        baseBlobSha256: input.projection.readDocument(artifactPath).document?.blobSha256 ?? null,
        candidate: { sha256: artifact.sha256, size: artifact.size, mediaType: reportClassification.mediaType },
        policyId: reportClassification.policyId,
        regionProofs: [],
      },
      ...(packetChange === null ? [] : [packetChange]),
    ],
    blobs: [
      reportBlob,
      ...(packetChange === null
        ? []
        : [
            {
              sha256: packetChange.candidate.sha256,
              size: packetChange.candidate.size,
              mediaType: packetChange.candidate.mediaType,
              body: packet!.body,
            },
          ]),
    ],
  };
}

export function attachDecisionReviewerArtifact(
  bundle: ReturnType<typeof compileDecisionWrite>,
  input: Parameters<typeof decisionReviewerArtifact>[0],
): ReturnType<typeof compileDecisionWrite> {
  const artifact = decisionReviewerArtifact(input);
  if (!artifact || bundle.event.type !== "decision_review_recorded") return bundle;
  const event = {
    ...bundle.event,
    payload: { ...bundle.event.payload, carriedDocumentClaims: artifact.changes },
  };
  return {
    ...bundle,
    event,
    plan: decisionWritePlan(event),
    blobs: [...bundle.blobs, ...artifact.blobs],
  };
}
