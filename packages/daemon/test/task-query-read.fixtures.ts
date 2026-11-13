import { lifecycleReadForSync } from "./dispatch-lifecycle-read.fixtures.ts";
import {
  INITIAL_SETTINGS_V1,
  type TaskProjection,
  type TaskProjectionListQuery,
  type TaskRelationProjectionRead,
  type TaskRelationQuery,
} from "@harness-anything/kernel";

export type ProjectionCut = {
  readonly status: "ready" | "pending";
  readonly watermark: number;
  readonly sourceRevision: number;
};

export const readyCut: ProjectionCut = { status: "ready", watermark: 7, sourceRevision: 7 };
/** Minimal task contract that declares a closeout, so completion can resolve the same next as task show. */
export const taskContractProjection = (documentPath: string) => ({
  ...readyCut,
  document: {
    body: documentPath.endsWith("task-contract.json")
      ? JSON.stringify({ documents: [{ slot: "task.closeout", path: "closeout.md" }] })
      : "# Closeout\n",
  },
});
export const eventEdge = {
  relationId: "rel_event_truth",
  workspaceRevision: 7,
  sourceRef: "decision/dec_event/CH1",
  targetRef: "task/task_event",
  relationType: "derives" as const,
  direction: "directed" as const,
  strength: "strong" as const,
  origin: "declared" as const,
  state: "active" as const,
  targetObservedVersion: 7,
  currentTargetVersion: 7,
  freshness: "current" as const,
  rationale: "Event truth",
  ownerRef: "decision/dec_event",
  sourcePath: "events/decision.json",
  recordIndex: 0,
};

export function protocolTaskRow(
  taskId: string,
  gateWitnesses: readonly unknown[] = [],
  patch: {
    readonly status?: "planned" | "active" | "blocked" | "submitted" | "in_review" | "done" | "cancelled";
    readonly taskClass?: "standard" | "work";
  } = {},
) {
  return {
    taskId,
    packagePath: null,
    generation: "v1",
    workspaceRevision: 7,
    createdAt: null,
    completedAt: null,
    updatedAt: "2026-08-30T00:00:00.000Z",
    snapshot: {
      revision: 7,
      task: {
        schema: "task/v2",
        taskId,
        title: taskId,
        taskClass: patch.taskClass ?? "standard",
        status: patch.status ?? "planned",
        graph: {},
        currentNode: "implementation",
        iteration: 0,
        createdBy: { principal: { personId: "person-owner" }, executor: null },
        completionGateIds: [],
        presetSnapshotDigest: null,
        pinned: false,
        packageDisposition: "active",
      },
      executions: [],
      reviews: [],
      edgesTaken: [],
      lease: null,
      decisionRelations: [],
      consents: [],
      gateWitnesses,
    },
  };
}

export function executionRow(executionId: string, iteration: number, state: string, taskId = "task") {
  return {
    schema: "execution/v1",
    executionId,
    taskId,
    nodeId: "implementation",
    iteration,
    state,
    claimedAt: "2026-08-30T00:00:00.000Z",
    submittedAt: "2026-08-30T01:00:00.000Z",
    closedAt: "2026-08-30T02:00:00.000Z",
    submission: null,
  };
}

export function projectionStub(
  options: {
    readonly cut?: ProjectionCut;
    readonly decisionCut?: ProjectionCut;
    readonly edges?: TaskRelationProjectionRead["rows"];
    readonly calls?: TaskRelationQuery[];
    readonly taskRows?: readonly unknown[];
    readonly listCalls?: TaskProjectionListQuery[];
    readonly dependencyCalls?: string[][];
    readonly targetCalls?: { targetRefs: readonly string[]; relationType: string }[];
    readonly statusCalls?: string[][];
    readonly decisionCalls?: string[][];
    readonly childCounts?: Readonly<Record<string, number>>;
    readonly decisionAgenda?: readonly unknown[];
    readonly decisions?: Readonly<Record<string, { readonly state: string; readonly proposerPersonId: string }>>;
  } = {},
): TaskProjection {
  const cut = options.cut ?? readyCut,
    decisionCut = options.decisionCut ?? cut,
    edges = options.edges ?? [eventEdge],
    taskRows = options.taskRows ?? [],
    decisionAgendaRows = options.decisionAgenda ?? [],
    decisions = options.decisions ?? {};
  return {
    readDispatchLifecycle: lifecycleReadForSync([]),
    listEntities: () => [],
    readTaskIndex: (query: TaskProjectionListQuery = {}) => {
      const allRows = taskRows as ReturnType<typeof protocolTaskRow>[],
        scopeIds = (() => {
          if (query.scopeRootTaskId === undefined) return null;
          const ids = new Set([query.scopeRootTaskId]);
          let changed = true;
          while (changed) {
            changed = false;
            for (const row of allRows) {
              const parent = row.snapshot.task?.metadata?.parentTaskId;
              if (parent !== null && parent !== undefined && ids.has(parent) && !ids.has(row.taskId)) {
                ids.add(row.taskId);
                changed = true;
              }
            }
          }
          let parent = allRows.find((row) => row.taskId === query.scopeRootTaskId)?.snapshot.task?.metadata
            ?.parentTaskId;
          while (parent) {
            ids.add(parent);
            parent = allRows.find((row) => row.taskId === parent)?.snapshot.task?.metadata?.parentTaskId;
          }
          return ids;
        })(),
        sourceRows = allRows.filter(
          (row) =>
            (scopeIds === null || scopeIds.has(row.taskId)) &&
            (query.taskIds === undefined || query.taskIds.includes(row.taskId)) &&
            (query.status === undefined || row.snapshot.task?.status === query.status) &&
            (query.activePackagesOnly !== true || row.snapshot.task?.packageDisposition === "active") &&
            (query.parentTaskId === undefined ||
              (row.snapshot.task?.metadata?.parentTaskId ?? null) === query.parentTaskId),
        );
      const rows = sourceRows.flatMap((row) =>
        row.snapshot.task
          ? [
              {
                taskId: row.taskId,
                title: row.snapshot.task.title,
                status: row.snapshot.task.status,
                taskClass: row.snapshot.task.taskClass,
                parentTaskId: row.snapshot.task.metadata?.parentTaskId ?? null,
                pinned: row.snapshot.task.pinned,
                packageDisposition: row.snapshot.task.packageDisposition,
                packagePath: row.packagePath,
                updatedAt: row.updatedAt,
                workKind: null,
                riskTier: null,
                urgency: null,
              },
            ]
          : [],
      );
      const limit = query.limit;
      return {
        ...cut,
        page:
          limit === undefined
            ? null
            : {
                limit,
                cursor: query.cursor ?? null,
                nextCursor: rows.length > limit ? (rows[limit - 1]?.taskId ?? null) : null,
              },
        warnings: [],
        rows: limit === undefined ? rows : rows.slice(0, limit),
      };
    },
    list: (query: TaskProjectionListQuery = {}) => {
      options.listCalls?.push(query);
      const selected = (
        query.taskIds === undefined
          ? (taskRows as ReturnType<typeof protocolTaskRow>[])
          : (taskRows as ReturnType<typeof protocolTaskRow>[]).filter((row) => query.taskIds!.includes(row.taskId))
      ).filter((row) => (query.status === undefined ? true : row.snapshot.task.status === query.status));
      if (query.limit === undefined && query.cursor === undefined) return { ...cut, rows: selected, warnings: [] };
      const limit = query.limit ?? 100,
        visible = selected.slice(0, limit),
        last = visible.at(-1) as { readonly taskId: string } | undefined;
      return {
        ...cut,
        rows: visible,
        warnings: [],
        page: {
          limit,
          cursor: query.cursor ?? null,
          nextCursor: selected.length > limit && last ? last.taskId : null,
        },
      };
    },
    read: (taskId: string) => {
      const row = (taskRows as ReturnType<typeof protocolTaskRow>[]).find((candidate) => candidate.taskId === taskId);
      return {
        ...cut,
        packagePath: (row as { readonly packagePath?: string | null } | undefined)?.packagePath ?? null,
        snapshot: row?.snapshot ?? { task: null },
      };
    },
    readDocument: () => ({ ...cut, document: null }),
    readDocuments: () => ({ documents: [] }),
    getEntity: (kind: string, id: string) =>
      kind === "settings" && id === "repository" ? { value: INITIAL_SETTINGS_V1 } : null,
    readRelationEdge: (relationId: string) => {
      const edge = edges.find((candidate) => candidate.relationId === relationId);
      return edge
        ? {
            ...edge,
            workspaceRevision: 5,
            entity: {
              createdAt: "2026-09-28T00:00:00.000Z",
              updatedAt: "2026-09-28T01:00:00.000Z",
              provenance: { actor: { principal: { personId: "owner" }, executor: { kind: "agent", id: "codex-sol" } } },
              ...(edge.state === "retired" ? { retirementReason: "同意" } : {}),
            },
          }
        : null;
    },
    // 源实体的版本:task_free 在答复(revision 5)之后被写过,其余停在答复所在 revision。
    readEntityVersionWitness: (entityRef: string) => ({
      entityRef,
      freshness: "current",
      currentVersion: entityRef === "task/task_moved" ? 6 : 5,
    }),
    readPresetSnapshot: () => ({ snapshot: null, status: "ready" }),
    readTaskChildCounts: () => options.childCounts ?? {},
    readTaskRelations: () => ({ ...cut, rows: edges }),
    readTaskRelationNeighborhood: () => ({ ...cut, rows: edges }),
    readTaskDependencyClosure: (sourceRefs: readonly string[]) => {
      options.dependencyCalls?.push([...sourceRefs]);
      return {
        ...cut,
        rows: edges.filter((edge) => edge.relationType === "depends-on" && sourceRefs.includes(edge.sourceRef)),
      };
    },
    readTaskRelationsByTargets: (targetRefs: readonly string[], relationType: string) => {
      options.targetCalls?.push({ targetRefs: [...targetRefs], relationType });
      return {
        ...cut,
        rows: edges.filter((edge) => edge.relationType === relationType && targetRefs.includes(edge.targetRef)),
      };
    },
    readTaskRelationsBySources: (sourceRefs: readonly string[], relationType: string) => ({
      ...cut,
      rows: edges.filter((edge) => edge.relationType === relationType && sourceRefs.includes(edge.sourceRef)),
    }),
    readRelationQuery: (query: TaskRelationQuery = {}) => {
      options.calls?.push(query);
      let rows = edges.filter(
        (edge) =>
          (query.entity === undefined || edge.sourceRef === query.entity || edge.targetRef === query.entity) &&
          (query.source === undefined || edge.sourceRef === query.source) &&
          (query.target === undefined || edge.targetRef === query.target) &&
          (query.relationType === undefined || edge.relationType === query.relationType) &&
          (query.state === undefined || edge.state === query.state),
      );
      if (query.cursor !== undefined) rows = rows.slice(1);
      const page =
        query.limit === undefined
          ? {}
          : {
              page: {
                limit: query.limit,
                cursor: query.cursor ?? null,
                nextCursor: query.cursor === undefined && rows.length > query.limit ? "page-2" : null,
              },
            };
      return { ...cut, rows: query.limit === undefined ? rows : rows.slice(0, query.limit), ...page };
    },
    readDecisionGraph: () => ({ ...decisionCut, decisions: [], edges: [], coverageRows: [] }),
    readDecisionCoverage: () => ({ ...decisionCut, coverageRows: [] }),
    readFactGraph: () => ({ ...cut, facts: [], edges: [], factAnchors: [] }),
    searchFacts: () => ({ ...cut, facts: [] }),
    readFactAnchors: () => ({ ...cut, rows: [] }),
    readTaskStatuses: (taskIds: readonly string[]) => {
      options.statusCalls?.push([...taskIds]);
      return { ...cut, rows: [] };
    },
    readDecisions: (decisionIds: readonly string[]) => {
      options.decisionCalls?.push([...decisionIds]);
      return {
        ...decisionCut,
        decisions: decisionIds.includes("dec_event")
          ? [{ decisionId: "dec_event", appliesTo: { modules: [], productLines: [] } }]
          : [],
      };
    },
    listDecisions: () => ({ ...decisionCut, decisions: [] }),
    readDecision: (decisionId: string) => ({
      ...decisionCut,
      decision: decisions[decisionId]
        ? {
            decisionId,
            state: decisions[decisionId]!.state,
            proposer: { principal: { personId: decisions[decisionId]!.proposerPersonId } },
          }
        : null,
    }),
    readRuntimeSession: () => null,
    readRuntimeDispatchesByTaskExecution: () => [],
    readRuntimeDispatchByResumeSource: () => null,
    readRuntimeSessionEvents: () => [],
    readRuntimeSessionEventsByType: () => [],
    listDecisionAgendaPage: (query) => ({
      ...decisionCut,
      decisions: decisionAgendaRows,
      page: { limit: query.limit, cursor: query.cursor ?? null, nextCursor: null },
    }),
  } as unknown as TaskProjection;
}
