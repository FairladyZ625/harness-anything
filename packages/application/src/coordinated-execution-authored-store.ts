import { Effect, Schema } from "effect";
import {
  executionDeclaration,
  validateOutputEvidence,
  readSessionEntityDocument,
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
    attachSession: async (request) => {
      const task = await Effect.runPromise(input.artifactStore.readTaskPackage(request.taskId));
      const document = task.documents.find((candidate) => candidate.path === executionPath(request.executionId));
      if (!document) throw new Error(`execution not found: ${request.executionId}`);
      const current = Schema.decodeUnknownSync(executionDeclaration.schema)(
        executionDeclaration.documentCodec.decode(document.body)
      ) as ExecutionRecord;
      assertExecutionHost(current, request.taskId, request.executionId);
      if (current.state !== "active") throw new Error(`execution is not active: ${request.executionId}`);
      if (current.session_bindings.some((binding) => bindingId(binding) === request.binding.binding_id)) {
        throw new Error(`execution session binding already exists: ${request.binding.binding_id}`);
      }
      await writeExecutionOnlyTransaction(input, request.taskId, {
        ...current,
        session_bindings: [...current.session_bindings, request.binding]
      });
    },
    submitForReview: async (request) => {
      const task = await Effect.runPromise(input.artifactStore.readTaskPackage(request.taskId));
      const document = task.documents.find((candidate) => candidate.path === executionPath(request.executionId));
      if (!document) throw new Error(`execution not found: ${request.executionId}`);
      const current = Schema.decodeUnknownSync(executionDeclaration.schema)(
        executionDeclaration.documentCodec.decode(document.body)
      ) as ExecutionRecord;
      assertExecutionHost(current, request.taskId, request.executionId);
      if (current.state !== "active") throw new Error(`execution is not active: ${request.executionId}`);
      const finalizedBindings = finalizeSessionBindings(input.rootInput, current.session_bindings, request.submittedAt);
      assertPrimarySession(finalizedBindings);
      assertBindingsFinal(finalizedBindings);
      const allEvidence = [...current.outputs, ...request.submission.evidence];
      validateOutputEvidence({
        rootInput: input.rootInput,
        taskId: request.taskId,
        executionId: request.executionId,
        evidence: allEvidence
      });
      const submitted = submittedExecution(current, finalizedBindings, request.submittedAt, request.submission);
      await writeExecutionTransaction(input, request.taskId, submitted, taskIndex(task.documents, request.taskId, ["active"], "in_review"));
    }
  };
}

function writeExecutionOnlyTransaction(
  input: { readonly rootInput: HarnessLayoutInput; readonly coordinator: WriteCoordinator },
  taskId: string,
  execution: ExecutionRecord
): Promise<void> {
  return Effect.runPromise(writeDeclaredEntityTransaction(
    input.coordinator,
    stablePayloadHash,
    executionDeclaration,
    { taskId, executionId: execution.execution_id },
    execution,
    []
  ));
}

function bindingId(binding: unknown): unknown {
  return binding && typeof binding === "object"
    ? (binding as { readonly binding_id?: unknown }).binding_id
    : undefined;
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

function submittedExecution(
  current: ExecutionRecord,
  sessionBindings: ExecutionRecord["session_bindings"],
  submittedAt: string,
  submission: ExecutionSubmission
): ExecutionRecord {
  return {
    ...current,
    state: "submitted",
    submitted_at: submittedAt,
    session_bindings: sessionBindings,
    outputs: [...current.outputs, ...submission.evidence],
    submission: {
      completion_claim: submission.completionClaim,
      deliverables: submission.deliverables,
      evidence_refs: submission.evidence.map((evidence) => evidence.evidence_id),
      verification_notes: submission.verificationNotes,
      known_gaps: submission.knownGaps,
      residual_risks: submission.residualRisks
    }
  };
}

function finalizeSessionBindings(
  rootInput: HarnessLayoutInput,
  bindings: ExecutionRecord["session_bindings"],
  endedAt: string
): ExecutionRecord["session_bindings"] {
  return bindings.map((binding) => {
    if (typeof binding.session_ref !== "string" || !binding.session_ref.startsWith("session/")) return binding;
    const sessionId = binding.session_ref.slice("session/".length);
    try {
      const session = readSessionEntityDocument(rootInput, sessionId);
      return {
        ...binding,
        archive_status: session.manifest.archiveStatus,
        capture_range: binding.capture_range ? { ...binding.capture_range, end_at: endedAt } : null
      };
    } catch (error) {
      const prefix = binding.role === "primary" ? "primary Session" : "Session";
      throw new Error(`${prefix} ${sessionId} snapshot is not finalized: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function assertExecutionHost(current: ExecutionRecord, taskId: string, executionId: string): void {
  if (current.execution_id !== executionId || current.task_ref !== `task/${taskId}`) {
    throw new Error(`execution identity does not match its host path: ${executionId}`);
  }
}

function assertPrimarySession(bindings: ReadonlyArray<unknown>): void {
  const primary = bindings.find((binding) => binding && typeof binding === "object" &&
    (binding as { readonly role?: unknown }).role === "primary" &&
    typeof (binding as { readonly session_ref?: unknown }).session_ref === "string");
  if (!primary) {
    throw new Error("primary Session binding is required; attach the current session through ExecutionSagaService.attachSession");
  }
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
