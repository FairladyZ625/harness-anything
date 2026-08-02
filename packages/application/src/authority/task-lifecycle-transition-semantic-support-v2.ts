import { Schema } from "effect";
import {
  decodeEntityDeclaration,
  jsonEntityDocumentCodec,
  sha256Text,
  stablePayloadHash
} from "@harness-anything/kernel";
import type {
  CanonicalTaskMutationPlan,
  ExistingTaskLifecycleTransition
} from "../task-lifecycle-transition-service.ts";
import type { TaskCompleteExternalCheckpointRef } from "./daemon-host-contract.ts";
import type { HostedDocumentSnapshotV2 } from "./fact-relation-semantic-compiler-v2.ts";
import type { RegistryEntityRefV2 } from "./semantic-mutation-envelope-v2.ts";
import { semanticAdmissionV2 as admission } from "./semantic-authority-helpers-v2.ts";

export interface TaskLifecycleTransitionAuthorityStateV2 {
  readonly readEntityBase: (entityRef: RegistryEntityRefV2) => Promise<import("./fact-relation-semantic-compiler-v2.ts").SemanticEntityBaseV2 | null>;
  readonly readHostedDocument: (path: string) => Promise<HostedDocumentSnapshotV2 | null>;
}

const NonBlank = Schema.String.pipe(Schema.minLength(1));
const TransitionCheckpointSchema = Schema.Struct({
  schema: Schema.Literal("task-lifecycle-transition-checkpoint/v1"),
  transitionId: NonBlank,
  callerIdempotencyKey: NonBlank,
  taskId: NonBlank,
  case: Schema.Literal("execution-review", "accepted-replay", "commit-anchor"),
  executionId: Schema.NullOr(NonBlank),
  terminalTaskStatus: Schema.Literal("done"),
  terminalExecutionState: Schema.NullOr(Schema.Literal("accepted")),
  externalCheckpointRefs: Schema.Array(Schema.Struct({ kind: NonBlank, ref: NonBlank }))
});

export type TransitionCheckpoint = Schema.Schema.Type<typeof TransitionCheckpointSchema>;

export function decodeTaskLifecycleTransitionCheckpoint(body: string): {
  readonly transition: ExistingTaskLifecycleTransition;
  readonly externalCheckpointRefs: ReadonlyArray<TaskCompleteExternalCheckpointRef>;
} {
  let value: unknown;
  try {
    value = taskLifecycleTransitionCheckpointDeclaration.documentCodec.decode(body);
  } catch {
    throw new Error("TASK_LIFECYCLE_TRANSITION_CHECKPOINT_INVALID");
  }
  const checkpoint = Schema.decodeUnknownSync(TransitionCheckpointSchema)(value);
  const externalCheckpointRefs = checkpoint.externalCheckpointRefs.map((entry) => {
    if (entry.kind !== "document-publication" && entry.kind !== "code-doc-reconciliation") {
      throw new Error("TASK_LIFECYCLE_TRANSITION_CHECKPOINT_WITNESS_KIND_INVALID");
    }
    return entry as TaskCompleteExternalCheckpointRef;
  });
  return {
    transition: {
      transitionId: checkpoint.transitionId,
      callerIdempotencyKey: checkpoint.callerIdempotencyKey,
      taskId: checkpoint.taskId,
      committedCase: checkpoint.case,
      executionId: checkpoint.executionId,
      terminalTaskStatus: checkpoint.terminalTaskStatus,
      terminalExecutionState: checkpoint.terminalExecutionState
    },
    externalCheckpointRefs
  };
}

export const taskLifecycleTransitionCheckpointDeclaration: ReturnType<typeof decodeEntityDeclaration> = decodeEntityDeclaration({
  kind: "task",
  schema: TransitionCheckpointSchema,
  documentCodec: jsonEntityDocumentCodec,
  mutabilityContract: {
    transition: {
      mutability: "immutable",
      read: [{ kind: "show", path: "task.lifecycleTransition" }],
      write: [{ kind: "command", operation: "task.lifecycle-complete" }],
      reason: "one caller idempotency key identifies one immutable lifecycle transition"
    }
  },
  anchors: { entityRef: "task/{taskId}/transition/{transitionId}", anchors: [] },
  dispositionMatrix: {
    entries: {
      retire: unsupported("retire"), supersede: unsupported("supersede"), invalidate: unsupported("invalidate"),
      archive: { level: "D2", action: "archive", supported: false, writeOpKinds: [], reason: "checkpoint follows task" },
      tombstone: { level: "D3", action: "tombstone", supported: false, writeOpKinds: [], reason: "checkpoint is immutable" },
      "hard-delete": { level: "D4", action: "hard-delete", supported: false, writeOpKinds: [], reason: "checkpoint is recovery evidence" }
    }
  },
  storageForm: "hosted-entity",
  rootResolver: {
    pathTemplate: "tasks/{taskId}/transitions/{transitionId}.json",
    identity: ["taskId", "transitionId"],
    host: { entityKind: "task", pathTemplate: "tasks/{taskId}", identity: ["taskId"] }
  },
  projection: {
    table: "task_lifecycle_transition_projection",
    columns: [
      { name: "transition_id", field: "transitionId", type: "text", primaryKey: true },
      { name: "task_id", field: "taskId", type: "text" },
      { name: "case", field: "case", type: "text" },
      { name: "terminal_task_status", field: "terminalTaskStatus", type: "text" }
    ]
  }
});

export function transitionCheckpoint(plan: CanonicalTaskMutationPlan, executionState: "accepted" | null): TransitionCheckpoint {
  return {
    schema: "task-lifecycle-transition-checkpoint/v1",
    transitionId: plan.transitionId,
    callerIdempotencyKey: plan.callerIdempotencyKey,
    taskId: plan.taskId,
    case: plan.kind === "already-committed" ? plan.committedCase : plan.kind,
    executionId: "executionId" in plan ? plan.executionId : null,
    terminalTaskStatus: "done",
    terminalExecutionState: executionState,
    externalCheckpointRefs: plan.verifiedExternalWitnesses.map(({ kind, ref }) => ({ kind, ref }))
  };
}

export function assertSameCheckpoint(body: string, expected: TransitionCheckpoint): void {
  let decoded: unknown;
  try {
    decoded = taskLifecycleTransitionCheckpointDeclaration.documentCodec.decode(body);
  } catch {
    throw admission("TASK_LIFECYCLE_TRANSITION_CHECKPOINT_INVALID");
  }
  const checkpoint = Schema.decodeUnknownSync(TransitionCheckpointSchema)(decoded);
  if (stablePayloadHash(checkpoint) !== stablePayloadHash(expected)) {
    throw admission("TASK_LIFECYCLE_TRANSITION_IDEMPOTENCY_CONFLICT");
  }
}

export function assertVerifiedWitnessBindings(plan: CanonicalTaskMutationPlan): void {
  const document = plan.verifiedExternalWitnesses.filter((entry) => entry.kind === "document-publication");
  if (document.length !== 1) throw admission("TASK_LIFECYCLE_DOCUMENT_PUBLICATION_WITNESS_REQUIRED");
  const codeDoc = plan.verifiedExternalWitnesses.filter((entry) => entry.kind === "code-doc-reconciliation");
  if (codeDoc.length > 1) throw admission("TASK_LIFECYCLE_CODE_DOC_WITNESS_DUPLICATE");
  for (const witness of plan.verifiedExternalWitnesses) {
    if (witness.publicationOperationIds.length === 0) throw admission("TASK_LIFECYCLE_PUBLICATION_OPERATION_REQUIRED");
    if (witness.kind === "code-doc-reconciliation") {
      const approval = plan.command.approval;
      if (witness.taskId !== plan.taskId
        || (plan.kind !== "already-committed" && /^[0-9a-f]{40}$/u.test(plan.command.commitRef ?? "")
          && witness.reconciledCommitRef !== plan.command.commitRef)
        || stablePayloadHash(witness.normalizedPaths) !== stablePayloadHash(normalizedCommandPaths(approval?.paths ?? []))
        || witness.prRef !== (approval?.prRef ?? null)) {
        throw admission("TASK_LIFECYCLE_CODE_DOC_WITNESS_COMMAND_MISMATCH");
      }
    }
  }
}

export async function witnessSnapshots(
  state: TaskLifecycleTransitionAuthorityStateV2,
  plan: CanonicalTaskMutationPlan
): Promise<ReadonlyArray<{ readonly path: string; readonly relativePath: string; readonly snapshot: HostedDocumentSnapshotV2 }>> {
  const paths = new Set<string>();
  for (const witness of plan.verifiedExternalWitnesses) {
    if (witness.kind === "document-publication") witness.coveredTaskRelativePaths.forEach((entry) => paths.add(entry));
    else paths.add("code-doc-anchors.json");
  }
  const result = [];
  for (const relativePath of [...paths].sort()) {
    if (relativePath === "INDEX.md" || relativePath === "task-contract.json"
      || relativePath === `executions/${"executionId" in plan ? plan.executionId : ""}.md`
      || relativePath === `reviews/${"reviewId" in plan ? plan.reviewId : ""}.md`
      || relativePath === `consents/${"consentId" in plan ? plan.consentId : ""}.md`) continue;
    const path = witnessTaskPath(plan.taskId, relativePath);
    const snapshot = await requiredWitnessSnapshot(state, path, "TASK_LIFECYCLE_WITNESS_DOCUMENT_MISSING");
    result.push({ path, relativePath, snapshot });
  }
  return result;
}

export async function contractSnapshot(
  state: TaskLifecycleTransitionAuthorityStateV2,
  plan: CanonicalTaskMutationPlan
): Promise<HostedDocumentSnapshotV2 | null> {
  const snapshot = await state.readHostedDocument(witnessTaskPath(plan.taskId, "task-contract.json"));
  const digest = snapshot ? sha256Text(snapshot.body) : null;
  if (digest !== plan.completionContractBodySha256) throw admission("TASK_LIFECYCLE_COMPLETION_CONTRACT_CHANGED");
  return snapshot;
}

function normalizedCommandPaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(paths.map((entry) => entry.replaceAll("\\", "/")))].sort();
}

function witnessTaskPath(taskId: string, relativePath: string): string {
  return `tasks/${taskId}/${relativePath}`;
}

async function requiredWitnessSnapshot(
  state: TaskLifecycleTransitionAuthorityStateV2,
  path: string,
  code: string
): Promise<HostedDocumentSnapshotV2> {
  const snapshot = await state.readHostedDocument(path);
  if (!snapshot) throw admission(code);
  return snapshot;
}

function unsupported(action: "retire" | "supersede" | "invalidate") {
  return { level: "D1" as const, action, supported: false as const, writeOpKinds: [], reason: "checkpoint is immutable" };
}
