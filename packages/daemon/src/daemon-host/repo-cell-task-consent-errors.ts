import { type ReceiptDiagnostic, type WriteSource } from "@harness-anything/kernel";

export function edgeTaskConsentScopeMismatch(input: {
  readonly actionKind: string;
  readonly code: string;
  readonly source: WriteSource;
  readonly taskId?: string;
  readonly executionId?: string;
  readonly reviewId?: string;
  readonly cause: string;
}): { readonly diagnostic: ReceiptDiagnostic; readonly explanation: string } | null {
  if (
    input.actionKind !== "task-review-consent" ||
    input.code !== "execution_scope_mismatch" ||
    typeof input.source !== "object" ||
    input.source.kind !== "node"
  )
    return null;
  const task = input.taskId ?? "<task-id>",
    execution = input.executionId ?? "<execution-id>",
    review = input.reviewId ?? "<review-id>",
    expected = "source=local (center canonical repository writer)",
    actual = `source=node:${input.source.nodeId} (edge node)`;
  return {
    diagnostic: {
      kind: "validation",
      entity: `task ${task} execution ${execution}`,
      field: "executionScope",
      actual,
      expectation: expected,
    },
    explanation:
      `Execution scope mismatch for task-review-consent: expected ${expected}; actual ${actual}. ` +
      `Run ha task review-consent ${task} --execution-id ${execution} --review-id ${review} ` +
      `on the center machine in this repository's canonical checkout. Cause: ${input.cause}`,
  };
}
