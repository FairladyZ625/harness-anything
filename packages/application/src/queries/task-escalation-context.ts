import type { TaskProjection } from "@harness-anything/kernel";
import {
  currentWorkerEscalations,
  type WorkerEscalationContext,
} from "@harness-anything/kernel/internal/domain/worker-escalation-context.ts";
import { readFrontmatter, readScalar } from "@harness-anything/kernel";
import { decodeEvidencePayload } from "./evidence-payload.ts";

type EscalationProjection = Pick<
  TaskProjection,
  "readTaskIndex" | "readDocuments" | "readDocument" | "readEventWitness"
>;

/** Decode the existing immutable resolution format; original questions live beside it. */
export function readEscalationResolution(body: string, dispatchId: string, taskId: string) {
  const value = decodeEvidencePayload(body);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return row.schema === "worker-escalation-resolution/v1" &&
    row.dispatchId === dispatchId &&
    row.taskId === taskId &&
    typeof row.answer === "string" &&
    row.answer.trim() !== "" &&
    typeof row.answeredAt === "string" &&
    Number.isFinite(Date.parse(row.answeredAt))
    ? { answer: row.answer, answeredAt: row.answeredAt }
    : null;
}

/** One task-scoped indexed listing; no package filesystem, global event scan, or persisted copy.
 * Original records remain the truth. The document's event witness supplies the resolving actor. */
export function readTaskEscalations(
  projection: EscalationProjection,
  taskId: string,
  packagePath = projection.readTaskIndex({ taskIds: [taskId] }).rows.find((row) => row.taskId === taskId)?.packagePath,
): readonly WorkerEscalationContext[] {
  if (!packagePath) return [];
  const documents = projection.readDocuments(`${packagePath}/artifacts/rulings/`),
    records: WorkerEscalationContext[] = [];
  for (const document of documents.documents) {
    const match = /\/(dispatch_[a-f0-9]{24})\.resolution\.md$/u.exec(document.path);
    if (!match) continue;
    const dispatchId = match[1]!,
      resolutionRead = projection.readDocument(document.path),
      resolution = resolutionRead.document,
      parsed = readEscalationResolution(resolution?.body ?? "", dispatchId, taskId);
    if (!resolution || !parsed) continue;
    const questionPath = `${packagePath}/artifacts/rulings/${dispatchId}.md`,
      request = projection.readDocument(questionPath).document;
    const value = decodeEvidencePayload(request?.body ?? ""),
      row =
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null,
      frontmatter = row === null ? readFrontmatter(request?.body ?? "") : null;
    let question: unknown =
        row?.schema === "worker-escalation/v1" && row.taskId === taskId && row.dispatchId === dispatchId
          ? row.question
          : frontmatter && readScalar(frontmatter, "ruling") === "awaiting"
            ? readScalar(frontmatter, "question")
            : null,
      questionSourcePath = questionPath;
    if (typeof question !== "string" || !question.trim()) {
      // The immutable dispatch archive preserves the original ask as the awaiting-ruling
      // reason even when an owner clears the working request document before resolving it.
      const archivePath = `${packagePath}/artifacts/dispatches/${dispatchId}.json`,
        archive = decodeEvidencePayload(projection.readDocument(archivePath).document?.body ?? "") as
          | Record<string, unknown>
          | undefined;
      if (
        archive?.schema === "runtime-dispatch/v1" &&
        archive.taskId === taskId &&
        archive.dispatchId === dispatchId &&
        archive.classification === "awaiting_ruling"
      ) {
        question = archive.reason;
        questionSourcePath = archivePath;
      }
    }
    if (typeof question !== "string" || question.trim() === "") continue;
    records.push({
      dispatchId,
      question: question.trim(),
      ...parsed,
      actor: projection.readEventWitness(resolution.workspaceRevision)?.actor ?? null,
      revision: resolution.workspaceRevision,
      questionPath: questionSourcePath,
      resolutionPath: document.path,
    });
  }
  return currentWorkerEscalations(records);
}

/** The same human-readable context for mission assembly and the CLI read set. */
export function renderTaskEscalations(records: readonly WorkerEscalationContext[]): string | null {
  return (
    records
      .map((record) =>
        [
          `Owner answer to worker escalation ${record.dispatchId}: ${record.answer}`,
          `Question: ${record.question}`,
          `Answered by: ${record.actor?.principal.personId ?? "unknown"}${record.actor?.executor ? ` (${record.actor.executor.kind}:${record.actor.executor.id})` : ""}`,
          `Answered at: ${record.answeredAt}`,
          `Sources: ${record.questionPath}; ${record.resolutionPath}`,
        ].join("\n"),
      )
      .join("\n\n") || null
  );
}
