import { Effect, Schema } from "effect";
import {
  executionDeclaration,
  sha256Text,
  stablePayloadHash,
  writeDeclaredEntityTransaction,
  type ArtifactStore,
  type ExecutionRecord,
  type HarnessLayoutInput,
  type TaskHolderPrincipal,
  type TaskHolderService,
  type WriteCoordinator
} from "@harness-anything/kernel";

export const STALE_EXECUTION_RETIRED_AUDIT_MARKER = "STALE_EXECUTION_RETIRED_AUDIT";

export interface ExecutionRetirementResult {
  readonly taskId: string;
  readonly executionId: string;
  readonly retiredAt: string;
  readonly retiredBy: string;
  readonly reason: string;
  readonly auditPath: "progress.md";
  readonly auditMarker: typeof STALE_EXECUTION_RETIRED_AUDIT_MARKER;
}

export interface ExecutionRetirementService {
  readonly retireStaleExecution: (input: {
    readonly taskId: string;
    readonly executionId: string;
    readonly reason: string;
    readonly retiredAt: string;
    readonly actor: TaskHolderPrincipal;
  }) => Promise<ExecutionRetirementResult>;
}

export function makeExecutionRetirementService(options: {
  readonly rootInput: HarnessLayoutInput;
  readonly coordinator: WriteCoordinator;
  readonly artifactStore: Pick<ArtifactStore, "readTaskPackage">;
  readonly taskHolderService: TaskHolderService;
}): ExecutionRetirementService {
  return {
    retireStaleExecution: async (input) => {
      const reason = input.reason.trim();
      if (!reason) throw new Error("Execution retirement requires a non-empty reason.");
      const initial = await readTargetExecution(options.artifactStore, input.taskId, input.executionId);
      assertRetirable(initial, input.executionId);

      const reservation = await options.taskHolderService.reserveExecution({
        taskId: input.taskId,
        executionId: input.executionId,
        principal: input.actor
      });
      try {
        const task = await Effect.runPromise(options.artifactStore.readTaskPackage(input.taskId));
        const executionDocument = task.documents.find((document) => document.path === `executions/${input.executionId}.md`);
        if (!executionDocument) throw new Error(`execution not found: ${input.executionId}`);
        const execution = decodeRetirableExecution(executionDocument.body);
        assertRetirable(execution, input.executionId);

        const retiredAt = input.retiredAt;
        if (!Number.isFinite(Date.parse(retiredAt))) throw new Error("Execution retirement requires a valid retiredAt timestamp.");
        const retiredBy = renderRetirementActor(input.actor);
        const auditText = renderStaleExecutionRetirementAudit({
          executionId: input.executionId,
          retiredAt,
          retiredBy,
          reason
        });
        const progress = task.documents.find((document) => document.path === "progress.md");
        const progressBody = appendProgress(progress?.body, auditText);
        await Effect.runPromise(writeDeclaredEntityTransaction(
          options.coordinator,
          stablePayloadHash,
          executionDeclaration,
          { taskId: input.taskId, executionId: input.executionId },
          { ...execution, state: "abandoned", closed_at: retiredAt },
          [{ taskId: input.taskId, path: "progress.md", body: progressBody }],
          [
            { taskId: input.taskId, path: `executions/${input.executionId}.md`, bodySha256: sha256Text(executionDocument.body) },
            { taskId: input.taskId, path: "progress.md", bodySha256: progress ? sha256Text(progress.body) : null }
          ]
        ));
        return {
          taskId: input.taskId,
          executionId: input.executionId,
          retiredAt,
          retiredBy,
          reason,
          auditPath: "progress.md",
          auditMarker: STALE_EXECUTION_RETIRED_AUDIT_MARKER
        };
      } finally {
        await options.taskHolderService.releaseExecution({
          taskId: input.taskId,
          executionId: input.executionId,
          leaseToken: reservation.leaseToken,
          principal: input.actor
        });
      }
    }
  };
}

export function renderStaleExecutionRetirementAudit(input: {
  readonly executionId: string;
  readonly retiredAt: string;
  readonly retiredBy: string;
  readonly reason: string;
}): string {
  return `${STALE_EXECUTION_RETIRED_AUDIT_MARKER}: execution=${input.executionId}; retiredBy=${input.retiredBy}; retiredAt=${input.retiredAt}; reason=${input.reason}`;
}

function appendProgress(existing: string | undefined, text: string): string {
  const body = existing ?? "# Progress\n\n## Entries\n\n";
  const separator = body.length > 0 && !body.endsWith("\n") ? "\n" : "";
  return `${body}${separator}${text}\n`;
}

async function readTargetExecution(
  artifactStore: Pick<ArtifactStore, "readTaskPackage">,
  taskId: string,
  executionId: string
): Promise<ExecutionRecord> {
  const task = await Effect.runPromise(artifactStore.readTaskPackage(taskId));
  const document = task.documents.find((candidate) => candidate.path === `executions/${executionId}.md`);
  if (!document) throw new Error(`execution not found: ${executionId}`);
  return decodeRetirableExecution(document.body);
}

function decodeRetirableExecution(body: string): ExecutionRecord {
  return Schema.decodeUnknownSync(executionDeclaration.schema)(
    executionDeclaration.documentCodec.decode(body)
  ) as ExecutionRecord;
}

function assertRetirable(execution: ExecutionRecord, executionId: string): void {
  if (execution.execution_id !== executionId) throw new Error(`execution identity mismatch: ${executionId}`);
  if (execution.state !== "active") {
    throw new Error(`Execution ${executionId} is ${execution.state}; only an active Execution without a live lease can be retired.`);
  }
}

function renderRetirementActor(actor: TaskHolderPrincipal): string {
  const principal = `person:${actor.principal.personId}`;
  return actor.executor ? `${principal}/agent:${actor.executor.id}` : principal;
}
