import type { DaemonTaskCompletionResult } from "./protocol/daemon-protocol-task-completion.ts";
import {
  assessFactRetirement,
  assessTransitionDocument,
  consumeKnownError,
  requireTransitionDocumentKind,
  taskCompletionNext,
  type CompletionReadinessContext,
  type FactRetirementAssessment,
  type FactStillHoldsAttestation,
  type TaskLifecycleSnapshot,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import { readTaskTransitionDocument } from "./transition-document-access.ts";
import { readEffectiveCloseoutGates } from "./repo-cell-settings-state.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";
import { cellCodedError, cellErrorCode } from "./repo-cell-errors.ts";

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
    assessment = assessTransitionDocument(
      requireTransitionDocumentKind("task.complete"),
      document.body ?? "",
      document.contract ?? undefined,
    ),
    facts = projection.readRelationQuery({ source: `task/${taskId}`, relationType: "produces", state: "active" });
  return {
    closeout: assessment.ready ? "ready" : "placeholder",
    closeoutContract: document.contract,
    closeoutPath: document.path,
    closeoutMissingSections: assessment.missingSections,
    closeoutGates: readEffectiveCloseoutGates(
      projection,
      snapshot.task?.completionGateIds ?? [],
      snapshot.task?.closeoutOverrides,
    ),
    eligibleDirtyPaths: [],
    producesFactCount: facts.rows.filter((row) => row.targetRef.startsWith("fact/")).length,
    projectionStatus: facts.status,
  };
}

export function factRetirementAssessment(
  projection: TaskProjectionQueries,
  taskId: string,
  stillHoldsAttestations: readonly FactStillHoldsAttestation[],
): FactRetirementAssessment {
  const taskRef = `task/${taskId}`,
    taskRelationReads = [
      projection.readRelationQuery({ source: taskRef, state: "active", limit: 500 }),
      projection.readRelationQuery({ target: taskRef, state: "active", limit: 500 }),
    ];
  if (taskRelationReads.some((read) => read.page?.nextCursor))
    throw cellCodedError("content_not_ready", `Task ${taskId} exceeds the 500-edge Fact retirement budget.`);
  const relationRead = {
      ...taskRelationReads[0],
      rows: [
        ...new Map(taskRelationReads.flatMap((read) => read.rows).map((edge) => [edge.relationId, edge])).values(),
      ],
    },
    relationReady = taskRelationReads.every((read) => read.status === "ready");
  if (!relationReady)
    throw cellCodedError(
      "content_not_ready",
      `Relation projection is not ready for Fact retirement assessment on Task ${taskId}.`,
    );
  const decisionIds = [
      ...new Set(
        relationRead.rows.flatMap((edge) => {
          if (
            edge.state !== "active" ||
            edge.relationType !== "derives" ||
            edge.targetRef !== taskRef ||
            typeof edge.sourceRef !== "string"
          )
            return [];
          const source = /^decision\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)?$/u.exec(
            edge.sourceRef,
          );
          return source?.[1] ? [source[1]] : [];
        }),
      ),
    ],
    decisionRead = projection.readDecisions(decisionIds),
    decisionReady = decisionRead.status === "ready";
  if (!decisionReady)
    throw cellCodedError(
      "content_not_ready",
      `Decision projection is not ready for Fact retirement assessment on Task ${taskId}.`,
    );
  const claimRefs = decisionRead.decisions.flatMap((decision) =>
      decision.claims
        .filter((claim) => claim.loadBearing)
        .map((claim) => `decision/${decision.decisionId}/${claim.id}`),
    ),
    producedFactRefs = relationRead.rows
      .filter((edge) => edge.relationType === "produces" && edge.sourceRef === taskRef)
      .map((edge) => edge.targetRef),
    narrowReads = [...claimRefs, ...producedFactRefs].map((source) =>
      projection.readRelationQuery({ source, state: "active", limit: 500 }),
    );
  if (narrowReads.some((read) => read.status !== "ready" || read.page?.nextCursor))
    throw cellCodedError(
      "content_not_ready",
      `Task ${taskId} Fact retirement neighborhood is not ready or exceeds budget.`,
    );
  const upstreamFactRefs = narrowReads
      .flatMap((read) => read.rows)
      .filter((edge) => edge.relationType === "evidenced-by")
      .map((edge) => edge.targetRef),
    livenessReads = upstreamFactRefs.map((target) =>
      projection.readRelationQuery({ target, relationType: "supersedes-fact", state: "active", limit: 500 }),
    );
  if (livenessReads.some((read) => read.status !== "ready" || read.page?.nextCursor))
    throw cellCodedError(
      "content_not_ready",
      `Task ${taskId} Fact liveness neighborhood is not ready or exceeds budget.`,
    );
  return assessFactRetirement({
    taskId,
    decisions: decisionRead.decisions,
    relations: [
      ...relationRead.rows,
      ...narrowReads.flatMap((read) => read.rows),
      ...livenessReads.flatMap((read) => read.rows),
    ],
    stillHoldsAttestations,
  });
}

export function readTaskCompletion(projection: TaskProjectionQueries, taskId: string): DaemonTaskCompletionResult {
  // The same judgment task show, task dispatches, task read-set, task review and the task document
  // reads consult: a lagging cut is not an answer about this task, and a current cut without it is a
  // not-found naming the id — never an ok-shaped completion for a task that does not exist.
  const read = requireCurrentTaskProjection(projection, taskId, "task completion read"),
    context = readCompletionContext(projection, taskId, read.snapshot, read.status),
    { next, blocker } = taskCompletionNext(read.snapshot, context);
  // Surface the upstream Facts that still need an explicit disposition before the agent runs
  // complete, so fact_retirement_undeclared never arrives as a surprise. The assessment needs
  // relation/decision projections that can lag the task read; a lagging neighborhood is reported
  // as null rather than blocking the whole completion read.
  let factRetirement: DaemonTaskCompletionResult["factRetirement"] = null;
  const producesReady = context.projectionStatus === "ready";
  if (read.snapshot.task && context.closeoutGates?.factDisposition && producesReady)
    try {
      const assessment = factRetirementAssessment(projection, taskId, []);
      if (assessment.undischarged.length) factRetirement = { undischarged: assessment.undischarged };
    } catch (error) {
      if (cellErrorCode(error) !== "content_not_ready") throw error;
      consumeKnownError(error);
    }
  return {
    ok: true,
    taskId,
    completionNext: next,
    completionBlocker: blocker === null ? null : { code: blocker.code, gate: blocker.gate },
    factRetirement,
  };
}
