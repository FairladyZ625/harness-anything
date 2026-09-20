import {
  DOC_POLICY_ID,
  isSameExecution,
  type TaskLifecycleSnapshot,
  parseDocWriteIntent,
  sha256Text,
  runtimeSessionIdFromActor,
} from "../../kernel/src/index.ts";
import type { RepoCellActionContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { cellCriterionError } from "./repo-cell-errors.ts";
import { publishDocIntent } from "./doc-sync-publication.ts";
import { readTaskTransitionDocument } from "./transition-document-access.ts";

/** Called only inside the repository's serial queue, under its current parent execution lease. */
export function createSquadChild(
  cell: RepoCellActionContext,
  child: {
    readonly parentTaskId: string;
    readonly key: string;
    readonly workerId: string;
    readonly prompt: string;
    readonly ownedPaths: readonly string[];
  },
  binding: RepoCellBinding,
  authorize: (action: RepoTaskAction, binding: RepoCellBinding, actionId: string) => RepoCellBinding,
): string {
  const action = {
      kind: "task-create",
      title: `Squad assignment for ${child.workerId}`,
      parentTaskId: child.parentTaskId,
      idempotencyKey: child.key,
      surfaces: child.ownedPaths,
    },
    receipt = cell.createTask(action, authorize(action, binding, `${child.key}:create`)),
    taskId = (receipt as typeof receipt & { readonly taskId?: string }).taskId;
  if (receipt.outcome !== "applied" || !taskId)
    throw cell.cellCodedError(receipt.code ?? "squad_child_create_failed", JSON.stringify(receipt));
  const plan = readTaskTransitionDocument({ projection: cell.projection, taskId, slot: "task.plan" });
  if (plan.body !== child.prompt)
    publishSquadChildDocument(
      cell,
      {
        parentTaskId: child.parentTaskId,
        taskId,
        path: plan.path,
        body: child.prompt,
      },
      binding,
      authorize,
    );
  return taskId;
}

export function publishSquadChildDocument(
  cell: RepoCellActionContext,
  document: {
    readonly parentTaskId: string;
    readonly taskId: string;
    readonly path: string;
    readonly body: string;
  },
  binding: RepoCellBinding,
  authorize: (action: RepoTaskAction, binding: RepoCellBinding, actionId: string) => RepoCellBinding,
): void {
  const projected = cell.projection.readDocument(document.path).document;
  if (projected?.body === document.body) return;
  const lease =
      runtimeSessionIdFromActor(binding.actor) === null
        ? null
        : cell.projection.currentLease(document.parentTaskId, cell.now()),
    sha256 = sha256Text(document.body),
    action = { kind: "doc-submit", taskId: document.taskId },
    intent = parseDocWriteIntent(
      {
        schema: "doc-write-intent/v1",
        executionId: lease?.executionId ?? null,
        baseLedgerSha: cell.store.currentCut(),
        changes: [
          {
            path: document.path,
            baseBlobSha256: projected?.blobSha256 ?? null,
            policyId: DOC_POLICY_ID,
            candidate: {
              ref: `doc-sync-claims/${sha256}`,
              sha256,
              size: Buffer.byteLength(document.body),
              mediaType: "text/markdown",
            },
          },
        ],
      },
      cell.input.repoId,
    ),
    receipt = publishDocIntent(
      {
        workspaceId: cell.input.repoId,
        rootDir: cell.rootDir,
        store: cell.store,
        projection: cell.projection,
        now: cell.now,
        action,
        binding: authorize(action, binding, `squad-document:${document.path}:${sha256}`),
      },
      intent,
      [Buffer.from(document.body)],
      lease,
    );
  if (receipt.outcome !== "applied")
    throw cell.cellCodedError(receipt.code ?? "squad_child_document_failed", JSON.stringify(receipt));
}

export async function reacquireSquadTaskLease(input: {
  readonly taskId: string;
  readonly binding: RepoCellBinding;
  readonly snapshot: TaskLifecycleSnapshot;
  readonly start: (executionId?: string) => Promise<{
    readonly outcome: string;
    readonly code?: string;
  }>;
}): Promise<void> {
  const execution = input.snapshot.executions.find(
    (candidate) => candidate.iteration === input.snapshot.task?.iteration && candidate.state === "active",
  );
  if (!execution) {
    const started = await input.start();
    if (started.outcome === "applied") return;
    throw cellCriterionError(
      started.code ?? "runtime_task_lease_required",
      `Task ${input.taskId} could not acquire an execution lease for squad dispatch.`,
      "run",
      "squad/execution-lease-reacquisition",
      [`Run ha task show ${input.taskId}, resolve its execution state, then retry the Squad run.`],
    );
  }
  const lease = input.snapshot.lease;
  if (lease) {
    if (lease.executionId === execution.executionId && isSameExecution(lease.actor, input.binding.actor)) return;
    throw cellCriterionError(
      "lease_conflict",
      `Task ${input.taskId} is leased by another execution or actor; the squad continuation stopped.`,
      "run",
      "squad/execution-lease-holder",
      [`The current holder must run ha task release ${input.taskId}; wait for release before retrying.`],
    );
  }
  const started = await input.start(execution.executionId);
  if (started.outcome !== "applied")
    throw cellCriterionError(
      "runtime_task_lease_required",
      `Squad continuation could not reacquire execution ${execution.executionId} for task ${input.taskId}.`,
      "run",
      "squad/execution-lease-reacquisition",
      [`Inspect task/${input.taskId} and retry after the same actor can reacquire execution ${execution.executionId}.`],
    );
}
