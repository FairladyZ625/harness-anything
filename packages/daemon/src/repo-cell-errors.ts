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

// A rejected action is self-describing by default: the sentence its own guard threw is the
// explanation. That default is only safe where the daemon authored the sentence. These codes are
// the measured exceptions — their message is a foreign payload it merely relayed (a remote's
// stderr, a child process's JSON dump), so forwarding it would hand whatever the far end printed
// to the CLI, the GUI and an agent's prompt. They answer with a sentence this module owns instead.
// Adding a code here is the deliberate act; the default stays open so ordinary refusals keep
// explaining themselves.
//
// The bar is "the message is only relayed text", not "the topic sounds sensitive". A code whose
// message is an authored diagnostic stays out even when it mentions a credential: `repo_unavailable`
// names the latch's real failure and `review_dispatch_failed` carries the recovery command, and
// tests on both assert that text — dropping it would trade an operator's only clue for safety it
// does not need, since the scrubber below already removes any credential from what is kept.
const foreignMessageCodes: ReadonlyMap<string, string> = new Map([
  [
    "delivery_publish_failed",
    "The delivery could not be published to the remote. Check the GitHub credential and push access, then retry.",
  ],
  ["script_reported_failure", "The vertical script reported a failure. Read the script's own report, then retry."],
  ["squad_control_failed", "The squad control action did not complete. Check the squad run's own log, then retry."],
  ["squad_child_create_failed", "The squad child task was not created. Check the child action's own code, then retry."],
  ["squad_child_document_failed", "The squad child document was not published. Check the child action's own code."],
  ["squad_child_release_failed", "The squad child lease was not released. Check the child action's own code."],
  ["squad_child_closeout_failed", "The squad child task was not closed out. Check the child action's own code."],
]);

/**
 * The sentence a rejected receipt carries. Secrets are scrubbed for every code, and a code that
 * only relays foreign text is answered by its own sentence instead of that text.
 */
export function rejectionExplanation(error: unknown): string {
  const code = cellErrorCode(error),
    denied = foreignMessageCodes.get(code);
  return denied ?? scrubSecretText(cellErrorMessage(error));
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
