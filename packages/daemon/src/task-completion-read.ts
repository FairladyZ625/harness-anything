import type { DaemonTaskCompletionResult } from "./protocol/daemon-protocol-gui-types.ts";
import {
  assessTransitionDocument,
  completionBlockers,
  requireTransitionDocumentKind,
  taskCompletionNext,
  type CompletionReadinessContext,
  type TaskLifecycleSnapshot,
  type TaskProjectionQueries,
} from "../../kernel/src/index.ts";
import { readTaskTransitionDocument } from "./transition-document-access.ts";
import { readEffectiveCloseoutGates } from "./repo-cell-settings-state.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";

/** Explicit --consent is recorded under every profile; the profile only decides whether absence blocks. */
export function completionBlockersForAction(
  snapshot: TaskLifecycleSnapshot,
  executionId: string,
  context: CompletionReadinessContext,
  consent: unknown,
): readonly ReturnType<typeof completionBlockers>[number][] {
  return completionBlockers(snapshot, executionId, consent === true ? consentArmed(context) : context);
}

function consentArmed(context: CompletionReadinessContext): CompletionReadinessContext {
  return { ...context, closeoutGates: { ...context.closeoutGates!, consent: true } };
}

/** Canonical completion inputs shared by command and GUI projection consumers. */
export function readCompletionContext(
  projection: TaskProjectionQueries,
  taskId: string,
  snapshot: TaskLifecycleSnapshot,
  status: "ready" | "pending",
): CompletionReadinessContext {
  const taskRead = projection.read(taskId),
    unavailable: CompletionReadinessContext = {
      closeout: "missing",
      closeoutPath: "",
      eligibleDirtyPaths: [],
      producesFactCount: 0,
      projectionStatus: status,
    },
    availability = taskCompletionNext(snapshot, unavailable);
  if (
    availability.blocker?.code === "projection_unknown" ||
    !snapshot.task ||
    !taskRead.packagePath ||
    !projection.readDocument(`${taskRead.packagePath}/task-contract.json`).document
  )
    return {
      closeout: "missing",
      closeoutPath: "",
      eligibleDirtyPaths: [],
      producesFactCount: 0,
      projectionStatus: "pending",
    };
  const document = readTaskTransitionDocument({ projection, taskId, slot: "task.closeout" }),
    assessment = assessTransitionDocument(requireTransitionDocumentKind("task.complete"), document.body ?? ""),
    facts = projection.readRelationQuery({ source: `task/${taskId}`, relationType: "produces", state: "active" });
  return {
    closeout: assessment.ready ? "ready" : "placeholder",
    closeoutPath: document.path,
    closeoutMissingSections: assessment.missingSections,
    closeoutGates: readEffectiveCloseoutGates(projection, snapshot.task?.completionGateIds ?? []),
    eligibleDirtyPaths: [],
    producesFactCount: facts.rows.filter((row) => row.targetRef.startsWith("fact/")).length,
    projectionStatus: facts.status,
  };
}

export function readTaskCompletion(projection: TaskProjectionQueries, taskId: string): DaemonTaskCompletionResult {
  // The same judgment task show, task dispatches, task read-set, task review and the task document
  // reads consult: a lagging cut is not an answer about this task, and a current cut without it is a
  // not-found naming the id — never an ok-shaped completion for a task that does not exist.
  const read = requireCurrentTaskProjection(projection, taskId, "task completion read");
  return {
    ok: true,
    taskId,
    completionNext: taskCompletionNext(
      read.snapshot,
      readCompletionContext(projection, taskId, read.snapshot, read.status),
    ).next,
  };
}
