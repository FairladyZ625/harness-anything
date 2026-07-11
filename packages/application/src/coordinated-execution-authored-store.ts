import { Effect, Schema } from "effect";
import {
  executionDeclaration,
  stablePayloadHash,
  writeDeclaredEntityTransaction,
  type ArtifactStore,
  type HarnessLayoutInput,
  type WriteCoordinator
} from "../../kernel/src/index.ts";
import type { ExecutionRecord } from "../../kernel/src/index.ts";
import type { ExecutionAuthoredStore, ExecutionSubmission } from "./execution-saga-service.ts";

export function makeCoordinatedExecutionAuthoredStore(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly coordinator: WriteCoordinator;
  readonly artifactStore: Pick<ArtifactStore, "readTaskPackage">;
}): ExecutionAuthoredStore {
  return {
    readExecution: async (request) => {
      const task = await Effect.runPromise(input.artifactStore.readTaskPackage(request.taskId));
      const document = task.documents.find((candidate) => candidate.path === executionPath(request.executionId));
      return document
        ? Schema.decodeUnknownSync(executionDeclaration.schema)(executionDeclaration.documentCodec.decode(document.body)) as ExecutionRecord
        : null;
    },
    openExecution: async (request) => {
      const task = await Effect.runPromise(input.artifactStore.readTaskPackage(request.taskId));
      if (task.documents.some((document) => document.path === executionPath(request.execution.execution_id))) {
        throw new Error(`execution already exists: ${request.execution.execution_id}`);
      }
      await writeExecutionTransaction(input, request.taskId, request.execution, taskIndex(task.documents, request.taskId, ["planned", "active"], "active"));
    },
    submitForReview: async (request) => {
      const task = await Effect.runPromise(input.artifactStore.readTaskPackage(request.taskId));
      const document = task.documents.find((candidate) => candidate.path === executionPath(request.executionId));
      if (!document) throw new Error(`execution not found: ${request.executionId}`);
      const current = Schema.decodeUnknownSync(executionDeclaration.schema)(
        executionDeclaration.documentCodec.decode(document.body)
      ) as ExecutionRecord;
      if (current.state !== "active") throw new Error(`execution is not active: ${request.executionId}`);
      assertBindingsFinal(current.session_bindings);
      const submitted = submittedExecution(current, request.submittedAt, request.submission);
      await writeExecutionTransaction(input, request.taskId, submitted, taskIndex(task.documents, request.taskId, ["active"], "in_review"));
    }
  };
}

function writeExecutionTransaction(
  input: { readonly rootInput: HarnessLayoutInput; readonly coordinator: WriteCoordinator },
  taskId: string,
  execution: ExecutionRecord,
  indexBody: string
): Promise<void> {
  return Effect.runPromise(writeDeclaredEntityTransaction(
    input.coordinator,
    stablePayloadHash,
    executionDeclaration,
    { taskId, executionId: execution.execution_id },
    execution,
    [{ taskId, path: "INDEX.md", body: indexBody }]
  ));
}

function taskIndex(
  documents: ReadonlyArray<{ readonly path: string; readonly body: string }>,
  taskId: string,
  allowed: ReadonlyArray<string>,
  next: "active" | "in_review"
): string {
  const body = documents.find((document) => document.path === "INDEX.md")?.body;
  if (!body) throw new Error(`task INDEX.md missing: ${taskId}`);
  const status = body.match(/^  status:\s*(.+)$/mu)?.[1]?.trim();
  if (!status || !allowed.includes(status)) throw new Error(`task status ${status ?? "unknown"} cannot enter ${next}`);
  if (!/^  engine:\s*local$/mu.test(body)) throw new Error(`task is not local: ${taskId}`);
  return body.replace(/^(  status:\s*).+$/mu, `$1${next}`);
}

function submittedExecution(current: ExecutionRecord, submittedAt: string, submission: ExecutionSubmission): ExecutionRecord {
  return {
    ...current,
    state: "submitted",
    submitted_at: submittedAt,
    outputs: [...current.outputs, ...submission.outputs],
    submission: {
      summary: submission.summary,
      verification: submission.verification,
      residual_risks: submission.residualRisks
    }
  };
}

function assertBindingsFinal(bindings: ReadonlyArray<unknown>): void {
  for (const binding of bindings) {
    const status = binding && typeof binding === "object"
      ? (binding as { readonly archive_status?: unknown }).archive_status
      : undefined;
    if (status !== "complete" && status !== "partial" && status !== "unavailable") {
      throw new Error("all execution session bindings require a final archive_status");
    }
  }
}

function executionPath(executionId: string): string {
  return `executions/${executionId}.md`;
}
