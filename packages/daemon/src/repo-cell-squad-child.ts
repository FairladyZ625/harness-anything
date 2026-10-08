import {
  requireSquadRuntimeAdmission,
  requireSquadRuntimeOwner,
  squadParentExecutionCurrent,
} from "./squad-runtime-ingress.ts";
import {
  DOC_POLICY_ID,
  isTerminalStatus,
  type SquadRunObservation,
  isSameExecution,
  type TaskLifecycleSnapshot,
  parseDocWriteIntent,
  sha256Text,
  runtimeSessionIdFromActor,
} from "@harness-anything/kernel";
import type { RepoCellActionContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction, RuntimeIngressAction } from "./repo-cell-types.ts";
import { cellCriterionError } from "./repo-cell-errors.ts";
import { evaluateRepoCellAction } from "./repo-cell-authorization.ts";
import { appendAuxiliaryRuntimeIngress } from "./repo-cell-runtime-ingress.ts";
import { publishDocIntent } from "./doc-sync-publication.ts";

/**
 * Keep the parent's readiness contract while applying the commander's authored assignment.
 * Missing parent sections stay missing; an assignment cannot make an incomplete parent plan ready.
 */
export function deriveSquadChildPlan(parentInput: string | null, assignment: string): string {
  if (parentInput === null || parentInput.trim() === "") return assignment;
  let parentPlan = parentInput;
  // The child is the assignment's task: its H1 title names the child, never the parent's.
  const assignmentTitle = /^#[ \t]+(.+?)[ \t]*$/mu.exec(assignment)?.[0];
  if (assignmentTitle !== undefined)
    parentPlan = /^#[ \t]+.+$/mu.test(parentPlan)
      ? parentPlan.replace(/^#[ \t]+.+$/mu, assignmentTitle)
      : `${assignmentTitle}\n\n${parentPlan}`;
  const assignmentSections = markdownH2Sections(assignment),
    parentSections = markdownH2Sections(parentPlan),
    covered = new Set<string>(),
    merged = parentPlan.replace(/(^##[ \t]+.+?(?:\r?\n|$))[\s\S]*?(?=^##[ \t]+|(?![\s\S]))/gmu, (section) => {
      const heading = /^##[ \t]+(.+?)[ \t]*$/mu.exec(section)?.[1]?.trim();
      if (!heading) return section;
      const replacement = assignmentSections.get(heading);
      if (replacement === undefined) return section;
      covered.add(heading);
      return replacement;
    });
  const unmatched = [...assignmentSections.entries()].filter(
    ([heading]) => !covered.has(heading) && !parentSections.has(heading),
  );
  if (unmatched.length === 0 && assignmentSections.size > 0) return merged;
  const assignmentBody =
    assignmentSections.size === 0
      ? assignment.trim()
      : unmatched
          .map(([, section]) => section.replace(/^##[ \t]+.+?(?:\r?\n|$)/u, "").trim())
          .filter(Boolean)
          .join("\n\n");
  return `${merged.trimEnd()}\n\n## Worker Assignment\n\n${assignmentBody}\n`;
}

function markdownH2Sections(body: string): Map<string, string> {
  const matches = [...body.matchAll(/^##[ \t]+(.+?)[ \t]*$/gmu)],
    sections = new Map<string, string>();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    sections.set(match[1]!.trim(), body.slice(match.index!, matches[index + 1]?.index ?? body.length));
  }
  return sections;
}

/** Called only inside the repository's serial queue, under its current parent execution lease. */
export async function createSquadChild(
  cell: RepoCellActionContext,
  child: {
    readonly parentTaskId: string;
    readonly squadRunId: string;
    readonly key: string;
    readonly workerId: string;
    readonly prompt: string;
    readonly ownedPaths: readonly string[];
  },
  binding: RepoCellBinding,
  authorize: (action: RepoTaskAction, binding: RepoCellBinding, actionId: string) => Promise<RepoCellBinding>,
): Promise<string> {
  const parent = cell.projection.read(child.parentTaskId),
    parentPlan = parent.packagePath
      ? (cell.projection.readDocument(`${parent.packagePath}/task_plan.md`).document?.body ?? null)
      : null;
  const action = {
      kind: "task-create",
      squadRunId: child.squadRunId,
      title: `Squad assignment for ${child.workerId}`,
      parentTaskId: child.parentTaskId,
      idempotencyKey: child.key,
      surfaces: child.ownedPaths,
      plan: deriveSquadChildPlan(parentPlan, child.prompt),
    },
    receipt = cell.createTask(action, await authorize(action, binding, `${child.key}:create`)),
    taskId = (receipt as typeof receipt & { readonly taskId?: string }).taskId;
  // A retried assignment reuses its child task through the idempotency key and writes nothing.
  if ((receipt.outcome !== "applied" && receipt.outcome !== "no_changes") || !taskId)
    throw cell.cellCodedError(receipt.code ?? "squad_child_create_failed", JSON.stringify(receipt));
  return taskId;
}

export async function publishSquadChildDocument(
  cell: RepoCellActionContext,
  document: {
    readonly parentTaskId: string;
    readonly squadRunId: string;
    readonly taskId: string;
    readonly path: string;
    readonly body: string;
  },
  binding: RepoCellBinding,
  authorize: (action: RepoTaskAction, binding: RepoCellBinding, actionId: string) => Promise<RepoCellBinding>,
): Promise<void> {
  const projected = cell.projection.readDocument(document.path).document;
  if (projected?.body === document.body) return;
  const lease =
      runtimeSessionIdFromActor(binding.actor) === null
        ? null
        : cell.projection.currentLease(document.parentTaskId, cell.now()),
    sha256 = sha256Text(document.body),
    action = { kind: "doc-submit", taskId: document.taskId, squadRunId: document.squadRunId },
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
        binding: await authorize(action, binding, `squad-document:${document.path}:${sha256}`),
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
  readonly executionId?: string;
  readonly snapshot: TaskLifecycleSnapshot;
  readonly start: (executionId?: string) => Promise<{
    readonly outcome: string;
    readonly code?: string;
  }>;
}): Promise<void> {
  if (input.executionId !== undefined && !squadParentExecutionCurrent(input.snapshot, input.executionId))
    throw Object.assign(new Error("Squad cannot reacquire a different parent execution."), {
      code: "execution_scope_mismatch",
    });
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

/** Both local and fleet observations settle here, inside the center's existing serial queue. */
export async function appendSquadRunObservation(
  cell: RepoCellActionContext,
  action: Extract<RuntimeIngressAction, { kind: "event" }>,
  binding: RepoCellBinding,
) {
  if (action.type !== "runtime_squad_run_observed")
    throw cell.cellCodedError("invalid_runtime_event", "Expected a valid Squad run observation.");
  const run = action.payload as unknown as SquadRunObservation;
  if (!["converged", "cancelled", "failed"].includes(run.phase))
    return appendAuxiliaryRuntimeIngress(cell, action, binding);
  // Validate before task writes. Publish the terminal observation last, so its visible cut
  // cannot announce settlement while assignments still occupy WIP. Partial writes replay by status.
  requireSquadRuntimeOwner(cell, action, binding);
  if (cell.store.readEvent(action.opId)) return appendAuxiliaryRuntimeIngress(cell, action, binding);
  requireSquadRuntimeAdmission(cell, action, binding);
  const reason = `Squad ${run.squadRunId} ended (${run.phase}); assignment lifecycle belongs to this run.`;
  const authorize = async (command: RepoTaskAction): Promise<RepoCellBinding> => {
    const authorizationDecision = await evaluateRepoCellAction({
      repoId: cell.input.repoId,
      action: command,
      binding,
      actionId: `squad-closeout:${run.squadRunId}:${String(command.taskId)}:${command.kind}`,
      revision: cell.store.readHead()?.revision ?? 0,
      now: cell.now(),
    });
    if (authorizationDecision.outcome !== "allowed")
      throw cell.cellCodedError("authorization_denied", "Squad assignment closeout requires task write authority.");
    return { ...binding, authorizationDecision };
  };
  for (const attempt of run.workerAttempts) {
    // The accepted create key also finds a child created just before dispatch failed to save its task id.
    const child = cell.projection.readTaskByIdempotencyKey(
      `${run.squadRunId}:${attempt.leaderTurnId}:${attempt.attemptId}`,
    );
    if (!child) continue;
    if (attempt.taskId !== null && attempt.taskId !== child.taskId)
      throw cell.cellCodedError("execution_scope_mismatch", "Squad child must match its accepted assignment key.");
    const snapshot = cell.projection.read(child.taskId).snapshot;
    if (isTerminalStatus(snapshot.task!.status)) continue;
    if (snapshot.lease) {
      const release = {
        kind: "task-release",
        taskId: child.taskId,
        reason,
        ...(attempt.runtimeSessionId
          ? {
              terminalExecutionId: snapshot.lease.executionId,
              terminalRuntimeSessionId: attempt.runtimeSessionId,
            }
          : {}),
      };
      const released = cell.taskSurfaceWrite(release, await authorize(release));
      if (released.outcome !== "applied")
        throw cell.cellCodedError(released.code ?? "squad_child_release_failed", JSON.stringify(released));
    }
    const cancel = { kind: "task-transition", taskId: child.taskId, status: "cancelled", force: true, reason };
    const cancelled = await cell.lifecycleAction(cancel, await authorize(cancel));
    if (cancelled.outcome !== "applied")
      throw cell.cellCodedError(cancelled.code ?? "squad_child_closeout_failed", JSON.stringify(cancelled));
  }
  return appendAuxiliaryRuntimeIngress(cell, action, binding);
}

/** The local coordinator uses the same admitted observation path as fleet owners. */
export async function publishLocalSquadRunObservation(
  cell: RepoCellActionContext,
  observation: SquadRunObservation,
  binding: RepoCellBinding,
  authorize: (action: RepoTaskAction, binding: RepoCellBinding, actionId: string) => Promise<RepoCellBinding>,
): Promise<void> {
  const action = {
    kind: "event" as const,
    type: "runtime_squad_run_observed" as const,
    opId: `squad-observed-${observation.squadRunId}-${observation.runRevision}`,
    payload: { ...observation },
  };
  const authorized = await authorize({ kind: "runtime-run", executionRuntimeIngress: action }, binding, action.opId);
  await appendSquadRunObservation(cell, action, authorized);
}
