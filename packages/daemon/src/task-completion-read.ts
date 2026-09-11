import type { TaskCompletionRead } from "./protocol/task-completion-contract.ts";
import {
  assessTransitionDocument,
  requireTransitionDocumentKind,
  taskCompletionNext,
  type CompletionReadinessContext,
  type TaskLifecycleSnapshot,
  type TaskProjectionQueries,
} from "../../kernel/src/index.ts";
import { readTaskTransitionDocument } from "./transition-document-access.ts";

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
    eligibleDirtyPaths: [],
    producesFactCount: facts.rows.filter((row) => row.targetRef.startsWith("fact/")).length,
    projectionStatus: facts.status,
  };
}

export function readTaskCompletion(projection: TaskProjectionQueries, taskId: string): TaskCompletionRead {
  const read = projection.read(taskId);
  return {
    ok: true,
    taskId,
    completionNext: taskCompletionNext(
      read.snapshot,
      readCompletionContext(projection, taskId, read.snapshot, read.status),
    ).next,
  };
}
