import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ArtifactEntityServiceError } from "@harness-anything/application/internal/artifact-entity-service";
import {
  VcsCommandError,
  attributeEntityActionCriterion,
  entityActionCriterionFailure,
  normalizeDomainError,
  type EntityActionCriterionFailure,
  type ReceiptDiagnostic,
} from "@harness-anything/kernel";
import { scrubSecretText } from "./secret-scrub.ts";

export type CellActionCriterionFailure = EntityActionCriterionFailure;

export function cellCodedError(code: string, text: string, diagnostic?: ReceiptDiagnostic): Error {
  const error = new Error(text) as Error & { code: string; diagnostic?: ReceiptDiagnostic };
  error.code = code;
  if (diagnostic) error.diagnostic = diagnostic;
  return error;
}

export function migrationError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function cellCriterionError(
  code: string,
  text: string,
  actionId: string,
  criterionRef: string,
  nextActions: readonly string[] = [],
  diagnostic?: ReceiptDiagnostic,
): Error {
  return attributeCellCriterion(cellCodedError(code, text, diagnostic), actionId, criterionRef, nextActions);
}

export function attributeCellCriterion(
  error: unknown,
  actionId: string,
  criterionRef: string,
  nextActions: readonly string[] = [],
): Error {
  const attributed = error instanceof Error ? error : cellCodedError(cellErrorCode(error), cellErrorMessage(error));
  return attributeEntityActionCriterion(attributed, actionId, criterionRef, nextActions);
}

export function actionCriterionFailure(error: unknown): CellActionCriterionFailure | null {
  return entityActionCriterionFailure(error);
}

export function unavailableRuntimeInstanceStore(): never {
  throw cellCodedError("runtime_instance_store_unavailable", "The machine runtime instance store is unavailable.");
}

export function errorOperationId(error: unknown): string | null {
  return typeof error === "object" && error !== null && "opId" in error && typeof error.opId === "string"
    ? error.opId
    : null;
}

export function cellErrorCode(error: unknown): string {
  if (error instanceof ArtifactEntityServiceError) return error.code;
  const normalized = normalizeDomainError(error);
  switch (normalized._tag) {
    case "LeaseConflictError":
    case "TaskNotFoundError":
    case "InvalidWritePlanError":
    case "ProtocolVersionMismatchError":
    case "OtherCodedError":
      return normalized.code;
    case "UnclassifiedError":
      return "service_rejected";
  }
}

export function cellErrorMessage(error: unknown): string {
  return normalizeDomainError(error).message;
}

// A rejected action is self-describing: the sentence its own guard threw is the explanation, and
// that is only safe because every producer of a *relayed* payload authors or redacts its own
// sentence before throwing. The audit behind this boundary (478 `cellCodedError` /
// `cellCriterionError` call sites across `packages/*/src`) found no code whose message is only
// foreign text: the codes that were once denied now either name the stable code and the actionable
// field (`childRefusal`, `publishExecutedVerticalScript`, `fleet-squad-coordinator`) or redact the
// remote detail where it is produced (`runtime-worker-push.ts`'s `errorDetail`).
//
// So this boundary no longer denies codes: denying a whole code also discarded the authored half of
// a mixed message, which replaced an operator's only clue with a sentence that could be factually
// wrong. What no producer may bypass is the credential scrubber — it runs here, in
// `withAuthorizationDecision`, and in `rejectHostAction`. A new code whose message really is only a
// remote's bytes must redact at its producer, and this comment is where that exception is recorded.

/**
 * The sentence a rejected receipt carries. Every code keeps its own sentence; credentials are
 * removed here because this is the last boundary before the CLI, the GUI and an agent's prompt.
 */
export function rejectionExplanation(error: unknown): string {
  return scrubSecretText(cellErrorMessage(error));
}

export function publishGeneratedArtifact(input: {
  readonly outputPath: string;
  readonly relativePath: string;
  readonly body: string;
}): void {
  mkdirSync(path.dirname(input.outputPath), { recursive: true });
  if (existsSync(input.outputPath)) {
    if (readFileSync(input.outputPath, "utf8") !== input.body)
      throw cellCodedError(
        "op_conflict",
        `Generated artifact ${input.relativePath} conflicts with the existing operation output.`,
      );
    return;
  }
  writeFileSync(input.outputPath, input.body, { encoding: "utf8", flag: "wx" });
}

export function fatalCellError(error: unknown): boolean {
  // Rejected entity CAS is an expected domain outcome. Store revision/writer divergence still latches below.
  if (error instanceof ArtifactEntityServiceError && error.code === "revision_conflict") return false;
  if (error instanceof VcsCommandError) return true;
  const normalized = normalizeDomainError(error);
  switch (normalized._tag) {
    case "UnclassifiedError":
      return true;
    case "LeaseConflictError":
    case "TaskNotFoundError":
    case "InvalidWritePlanError":
    case "ProtocolVersionMismatchError":
    case "OtherCodedError":
      return [
        "invalid_store",
        "legacy_shape",
        "op_conflict",
        "revision_conflict",
        "version_conflict",
        "publication_indeterminate",
        "writer_rejected",
      ].includes(normalized.code);
  }
}
