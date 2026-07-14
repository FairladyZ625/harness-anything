import type { ExecutionAuthoredStore, ExecutionRecord } from "../src/index.ts";

export function memoryAuthoredStore(options: { readonly failOpen?: boolean } = {}): ExecutionAuthoredStore & {
  readonly executions: Map<string, ExecutionRecord>;
  taskStatus: "planned" | "active" | "blocked" | "in_review";
  failSubmit: boolean;
} {
  const executions = new Map<string, ExecutionRecord>();
  const store = {
    executions,
    taskStatus: "planned" as const satisfies "planned" | "active" | "blocked" | "in_review",
    failSubmit: false,
    readExecution: async (input) => executions.get(input.executionId) ?? null,
    openExecution: async (input) => {
      if (options.failOpen) throw new Error("authored open failed");
      if (executions.has(input.execution.execution_id)) throw new Error("execution already exists");
      executions.set(input.execution.execution_id, input.execution);
    },
    attachSession: async (input) => {
      const current = executions.get(input.executionId);
      if (!current || current.state !== "active") throw new Error("execution is not active");
      executions.set(input.executionId, {
        ...current,
        session_bindings: [...current.session_bindings, input.binding]
      });
    },
    submitForReview: async (input) => {
      if (store.failSubmit) throw new Error("authored submit failed");
      const current = executions.get(input.executionId);
      if (!current || current.state !== "active") throw new Error("execution is not active");
      executions.set(input.executionId, {
        ...current,
        state: "submitted",
        submitted_at: input.submittedAt,
        outputs: input.submission.evidence,
        submission: {
          completion_claim: input.submission.completionClaim,
          deliverables: input.submission.deliverables,
          evidence_refs: input.submission.evidence.map((evidence) => evidence.evidence_id),
          verification_notes: input.submission.verificationNotes,
          known_gaps: input.submission.knownGaps,
          residual_risks: input.submission.residualRisks
        }
      });
      store.taskStatus = "in_review";
    }
  };
  return store;
}

export function taskIndex(taskId: string, status: "planned" | "active" | "blocked" | "in_review"): string {
  return [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    "title: Execution fixture",
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    `  status: ${status}`,
    "  ref:",
    "  titleSnapshot: Execution fixture",
    "  url:",
    "  bindingCreatedAt: 2026-07-11T00:00:00.000Z",
    "  bindingFingerprint: sha256:fixture",
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "provenance:",
    "  - {runtime: \"node-test\", sessionId: \"execution-saga\", boundAt: \"2026-07-11T00:00:00.000Z\"}",
    "---",
    "",
    "# Execution fixture",
    ""
  ].join("\n");
}
