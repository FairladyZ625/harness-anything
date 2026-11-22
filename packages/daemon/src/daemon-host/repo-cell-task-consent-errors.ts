import type { ReceiptDiagnostic, WriteSource } from "@harness-anything/kernel";
import { scrubSecretText } from "../runtime-engine/secret-scrub.ts";
import { isJsonObject } from "./protocol/json-rpc-types.ts";
import type { RepoTaskAction } from "./repo-cell-types.ts";

export function explainEdgeTaskConsentScopeMismatch<
  Receipt extends {
    readonly outcome?: unknown;
    readonly code?: unknown;
    readonly diagnostic?: unknown;
    readonly error?: unknown;
    readonly rejectionExplanation?: unknown;
    readonly summary?: unknown;
    readonly nextActions?: unknown;
  },
>(receipt: Receipt, action: RepoTaskAction, source: WriteSource, cause?: string): Receipt {
  if (
    receipt.outcome !== "op_rejected" ||
    receipt.code !== "execution_scope_mismatch" ||
    action.kind !== "task-review-consent" ||
    typeof source !== "object" ||
    source.kind !== "node"
  )
    return receipt;
  const task = typeof action.taskId === "string" ? action.taskId : "<task-id>",
    execution = typeof action.executionId === "string" ? action.executionId : "<execution-id>",
    review = typeof action.reviewId === "string" ? action.reviewId : "<review-id>",
    retry = `ha task review-consent ${task} --execution-id ${execution} --review-id ${review}`,
    actions = Array.isArray(receipt.nextActions) ? receipt.nextActions : [],
    previousExplanation = typeof receipt.rejectionExplanation === "string" ? receipt.rejectionExplanation : undefined,
    original = receipt.diagnostic,
    originalScope =
      isJsonObject(original) &&
      original.kind === "validation" &&
      typeof original.actual === "string" &&
      typeof original.expectation === "string"
        ? original
        : null;
  if (originalScope && actions.includes(retry) && previousExplanation) return receipt;
  const scope: ReceiptDiagnostic = {
      kind: "validation",
      entity: `task ${task} execution ${execution}`,
      field: "executionScope",
      actual: `source=node:${source.nodeId} (edge node)`,
      expectation: "source=local (center canonical repository writer)",
    },
    diagnostic = originalScope ?? scope,
    reason = cause ?? previousExplanation ?? (isJsonObject(receipt.error) ? receipt.error.message : receipt.summary);
  return {
    ...receipt,
    diagnostic,
    rejectionExplanation: scrubSecretText(
      `Execution scope mismatch for task-review-consent. Expected ${String(diagnostic.expectation)}, received ${String(diagnostic.actual)}. ` +
        `Run ${retry} on the center machine in this repository's canonical checkout with your personal session.` +
        (typeof reason === "string" && reason ? ` Cause: ${reason}` : ""),
    ),
    nextActions: actions.includes(retry) ? actions : [...actions, retry],
  };
}
