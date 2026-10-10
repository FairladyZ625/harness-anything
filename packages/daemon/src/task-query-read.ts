import { principalId, type ActorIdentity } from "@harness-anything/kernel";
import { taskPresentationReads } from "./task-presentation-read.ts";
import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  blockingOf,
  closeoutReadiness,
  deriveRelationId,
  freshnessReasonOf,
  parseAwaitsRequest,
  relationIsCurrent,
  taskBoardPlacement,
  taskCapabilities,
  taskPhase,
  taskRisk,
  taskVisibility,
  workspaceTaskStatus,
  resolveHarnessLayout,
  settledApprovedReviewsForExecution,
  type FreshnessReason,
  type FreshnessReasonInput,
  type ProjectionPage,
  type ProjectedExecution,
  type RelationGraphEdgeRow,
  type TaskProjection,
  type TaskProjectionListQuery,
  type TaskRelationProjectionRead,
  type TaskRelationNeighborhoodQuery,
  type TaskRelationQuery,
} from "@harness-anything/kernel";
import {
  decisionReviewAwaitRationale,
  decisionReviewState,
  readDecisionReviewDispatches,
} from "./decision-review-read.ts";
import type { DispatchStreamHeader } from "./dispatch-stream.ts";
import { readRepositorySettings } from "./repo-cell-settings-state.ts";
import { presetSnapshotReader, taskWorkspaceView } from "./task-worktree.ts";
import {
  isolateDaemonTaskSnapshotRows,
  type AgendaAnsweredRow,
  type AgendaAwaitsRow,
  type AgendaDecisionRow,
  type AgendaExecutionRow,
  type AgendaPinnedEntityRow,
  type AgendaTaskRow,
  type AgendaWorkRef,
  type CanonicalRoot,
  type DaemonAgendaResult,
  type DaemonRelationGraphFacetPayload,
  type DaemonRelationGraphFacetResult,
  type DaemonRelationGraphEdgeRow,
  type DaemonRelationGraphFullResult,
  type DaemonTaskSnapshotListResult,
  type ExecutionEvidenceProjection,
  type TaskPlacementSupplement,
} from "./protocol/daemon-protocol.contract.ts";
import { workRootOf, workspaceStructureFromProjection } from "./workspace-scope-read.ts";
import { attentionRegionWeights } from "./agenda-attention.ts";
import { buildAttentionItems } from "./agenda-attention-projection.ts";
import {
  decodeAgendaCursor,
  encodeAgendaCursor,
  renderAgendaSummary,
  type AgendaCursor,
  type AgendaCursorKey,
} from "./agenda-summary.ts";

/**
 * The daemon's task query read model. Extracted verbatim from repo-cell so the
 * wide queries (task snapshot list, triadic relation graph) have one importable
 * real implementation — the daemon serves it, and scale measurement exercises
 * the same functions instead of a fixture proxy. The closeout/blocking domain
 * judgments stay injected by repo-cell so the serving surface keeps consuming
 * the canonical kernel definitions directly.
 */
export interface TaskQueryReadModel {
  readonly agenda: (query?: AgendaQuery) => DaemonAgendaResult;
  readonly relationGraphNeighborhood: (query: TaskRelationNeighborhoodQuery) => DaemonRelationGraphFullResult;
  readonly relationGraphFacet: (query: DaemonRelationGraphFacetPayload) => DaemonRelationGraphFacetResult;
  readonly relationGraphPage: (query: TaskRelationQuery) => DaemonRelationGraphFullResult;
  readonly guiTasks: (query?: TaskProjectionListQuery) => DaemonTaskSnapshotListResult;
}
/** `principalId` is the reader's person; the daemon fills it from the read binding, never from the payload. */
export interface AgendaQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly principalId?: string;
  /** A work root task id; keeps that root and its subtree. */
  readonly work?: string;
}
export interface TaskQueryJudgments {
  readonly closeout: typeof closeoutReadiness;
  readonly blocking: typeof blockingOf;
}
export function makeTaskQueryReadModel(input: {
  readonly rootDir: CanonicalRoot;
  readonly projection: TaskProjection;
  readonly readPinnedEntities: TaskProjection["listPinnedEntities"];
  readonly judgments: TaskQueryJudgments;
  readonly now?: () => Date;
}): TaskQueryReadModel {
  const { rootDir, projection, readPinnedEntities, judgments } = input,
    closeout = judgments.closeout,
    blocking = judgments.blocking,
    now = input.now ?? (() => new Date());
  function relationGraphNeighborhood(query: TaskRelationNeighborhoodQuery): DaemonRelationGraphFullResult {
    return relationGraphFromRead(projection.readTaskRelationNeighborhood(query), "relation graph neighborhood");
  }
  function relationGraphFacet(query: DaemonRelationGraphFacetPayload): DaemonRelationGraphFacetResult {
    const emptyRows = { edges: [], coverageRows: [], factAnchors: [], facts: [], domainTypes: [] } as const;
    if (query.facet === "runtimeEdges") {
      return {
        ok: true,
        facet: "runtimeEdges",
        ...emptyRows,
        edges: runtimeDispatchEdges(projectedRuntimeHeaders(projection)),
        warnings: [],
      };
    }
    if (query.facet === "edges") {
      const read = projection.readRelationQuery({
          ...(query.direction === undefined ? {} : { direction: query.direction }),
          limit: query.limit ?? 500,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.relationType === undefined ? {} : { relationType: query.relationType }),
          ...(query.state === undefined ? {} : { state: query.state }),
        }),
        edges = read.rows.map(withRelationCurrent);
      return {
        ok: true,
        facet: "edges",
        ...emptyRows,
        edges,
        page: read.page!,
        warnings: relationFacetWarnings(read.status),
        ...projectionCut(read),
      };
    }
    if (query.facet === "facts") {
      const read = projection.searchFacts({
          limit: query.limit ?? 500,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        }),
        domainTypes = projection.listFactDomainTypes();
      return {
        ok: true,
        facet: "facts",
        page: read.page!,
        ...emptyRows,
        facts: read.facts.map((row) => ({
          anchor: row.ref,
          text: row.statement,
          category:
            row.memoryClass === "semantic"
              ? ("lesson" as const)
              : row.memoryClass === "procedural"
                ? ("progress" as const)
                : ("finding" as const),
          ...(row.taskId === undefined ? {} : { taskId: row.taskId }),
          // 归档态随行送达(dec_62CAE6CA):GUI 默认隐藏已归档 Fact,开关打开时
          // 也要能带标记显示 —— 过滤在消费端做,读面只负责如实携带。
          archived: row.archived === true,
        })),
        domainTypes: domainTypes.domainTypes,
        warnings: relationFacetWarnings(read.status === "ready" ? domainTypes.status : read.status),
        ...projectionCut(read),
      };
    }
    const read = projection.readDecisionGraph();
    return {
      ok: true,
      facet: "coverageRows",
      ...emptyRows,
      coverageRows: read.coverageRows.map((row) => {
        const fulfillment = row.fulfillment === "standing_policy" ? ("standing-policy" as const) : row.fulfillment;
        return withFreshnessReason({ ...row, fulfillment });
      }),
      warnings: relationFacetWarnings(read.status),
      ...projectionCut(read),
    };
  }
  /**
   * Blocking judgments for one lifecycle page: the graph reads (dependency
   * closure plus derives edges plus the statuses of every task those edges
   * touch) and the kernel blocking verdict over them. The wide guiTasks
   * assembly and the narrow agenda page read share this one implementation, so
   * agenda no longer pays for placement, decision scopes, or execution
   * evidence projection it never serves.
   */
  function readBlockingAssessments(taskIds: readonly string[]) {
    const taskRefs = taskIds.map((taskId) => `task/${taskId}`),
      dependencies = projection.readTaskDependencyClosure(taskRefs),
      downstream = projection.readTaskRelationsByTargets(taskRefs, "depends-on"),
      derives = projection.readTaskRelationsByTargets(taskRefs, "derives"),
      awaits = projection.readTaskRelationsBySources(taskRefs, "awaits"),
      edges = [...dependencies.rows, ...derives.rows, ...awaits.rows],
      downstreamByTaskId = new Map<string, number>(),
      relatedTaskIds = [
        ...new Set([
          ...taskIds,
          ...dependencies.rows.flatMap(({ sourceRef, targetRef }) =>
            [sourceRef, targetRef].flatMap((ref) => /^task\/([^/]+)$/u.exec(ref)?.[1] ?? []),
          ),
        ]),
      ],
      taskStatuses = projection.readTaskStatuses(relatedTaskIds),
      hardWarnings = [dependencies, derives, awaits]
        .flatMap(({ status }) => relationFacetWarnings(status))
        .filter(({ severity }) => severity === "hard-fail")
        .map(({ message }) => message),
      blockingTasks = taskStatuses.rows.flatMap((row) =>
        row.status === null ? [] : [{ taskId: row.taskId, status: row.status }],
      );
    for (const edge of downstream.rows)
      if (relationIsCurrent(edge) && edge.state === "active") {
        const taskId = /^task\/(.+)$/u.exec(edge.targetRef)?.[1];
        if (taskId) downstreamByTaskId.set(taskId, (downstreamByTaskId.get(taskId) ?? 0) + 1);
      }
    return {
      dependencies,
      downstream,
      derives,
      awaits,
      taskStatuses,
      edges,
      downstreamByTaskId,
      blockingByTaskId: new Map(
        blocking(blockingTasks, edges, {
          state: hardWarnings.length ? "error" : "ready",
          hardFailWarnings: hardWarnings,
        }).map((row) => [row.taskId, row]),
      ),
    };
  }
  function guiTasks(query: TaskProjectionListQuery = {}): DaemonTaskSnapshotListResult {
    const lifecycle = taskPresentationReads(projection).list({ ...query, limit: query.limit ?? 500 }),
      readPresetSnapshot = presetSnapshotReader(projection),
      { authoredRoot } = resolveHarnessLayout(rootDir),
      { dependencies, downstream, derives, awaits, taskStatuses, blockingByTaskId } = readBlockingAssessments(
        lifecycle.rows.map(({ taskId }) => taskId),
      ),
      decisionIds = [
        ...new Set(derives.rows.flatMap(({ sourceRef }) => /^decision\/([^/]+)/u.exec(sourceRef)?.[1] ?? [])),
      ],
      decisionRead = projection.readDecisions(decisionIds),
      cut = requireSameProjectionCut("task control surface", [
        lifecycle,
        dependencies,
        downstream,
        derives,
        awaits,
        taskStatuses,
        decisionRead,
      ]),
      activeDerives = new Map<string, typeof derives.rows>();
    for (const edge of derives.rows)
      if (edge.state === "active" && edge.direction === "directed" && edge.relationType === "derives")
        activeDerives.set(edge.targetRef, [...(activeDerives.get(edge.targetRef) ?? []), edge]);
    const decisions = new Map(decisionRead.decisions.map((row) => [row.decisionId, row]));
    const result: Omit<DaemonTaskSnapshotListResult, "invalidRows"> = {
      ok: true,
      ...lifecycle,
      rows: lifecycle.rows.map((row) => {
        const task = row.snapshot.task,
          metadata = task?.metadata,
          disposition = requiredPackageDisposition(row.taskId, task?.packageDisposition),
          derived = activeDerives.get(`task/${row.taskId}`) ?? [],
          scopes = derived
            .flatMap((edge) => {
              const id = /^decision\/([^/]+)/u.exec(edge.sourceRef)?.[1];
              return id ? [decisions.get(id)] : [];
            })
            .filter((value) => value !== undefined),
          origin: TaskPlacementSupplement["origin"] = disposition !== "active" ? "archival" : "native",
          placement: TaskPlacementSupplement = {
            productLines: [...new Set(scopes.flatMap((scope) => scope.appliesTo.productLines))].sort(),
            spawningDecisionIds: [
              ...new Set(
                derived.flatMap((edge) => {
                  const decisionId = /^decision\/([^/]+)/u.exec(edge.sourceRef)?.[1];
                  return decisionId === undefined ? [] : [decisionId];
                }),
              ),
            ].sort(),
            parentTaskId: metadata?.parentTaskId ?? null,
            origin,
            engine: "kernel/task-lifecycle/v1",
            packageDisposition: disposition,
            provenance: [
              { kind: "canonical-event" as const, ref: `task/${row.taskId}` },
              ...derived.map((edge) => ({ kind: "decision-relation" as const, ref: edge.relationId })),
            ],
          },
          snapshotAvailability = {
            consents: "known" as const,
            codeDocWitnesses: "known" as const,
            gateWitnesses: "known" as const,
          },
          blockingAssessment = blockingByTaskId.get(row.taskId) ?? {
            taskId: row.taskId,
            state: "unknown" as const,
            label: "unresolved" as const,
            blockers: [],
            warnings: ["task snapshot missing from blocking judgment"],
          },
          coordinationStatus = task
            ? workspaceTaskStatus({ status: task.status, blockingState: blockingAssessment.state })
            : ("unknown" as const),
          closeoutAssessment = closeout(row.snapshot, snapshotAvailability),
          // dec_5B135F46 CH4: the board / visibility / capability judgments are the kernel's. This
          // read passes the row and the assessments it already has and returns what comes back.
          boardRow = {
            snapshot: row.snapshot,
            blockingState: blockingAssessment.state,
            packageDisposition: disposition,
            origin,
            closeoutReadiness: closeoutAssessment.readiness,
          };
        return {
          ...row,
          coordinationStatus,
          snapshotAvailability,
          closeoutAssessment,
          blockingAssessment,
          placement,
          executionEvidence: row.snapshot.executions.map((execution) =>
            projectExecutionEvidence(row.taskId, execution, origin),
          ),
          board: taskBoardPlacement(boardRow),
          visibility: taskVisibility(boardRow),
          capabilities: taskCapabilities(boardRow),
          phase: taskPhase(boardRow),
          risk: taskRisk(boardRow),
          workspace: taskWorkspaceView(rootDir, row.snapshot.task, row.packagePath, readPresetSnapshot, authoredRoot),
        };
      }),
      ...cut,
    };
    return { ...result, ...isolateDaemonTaskSnapshotRows(result.rows) };
  }
  /**
   * Narrow agenda page read: the lifecycle page plus only the blocking
   * judgment each row needs. Deliberately skips everything the wide guiTasks
   * assembly builds and the agenda never serves (placement scopes and their
   * decision read, execution evidence ids, board/visibility/closeout) — the
   * agenda consumes snapshots and blocking assessments directly.
   */
  function readAgendaTaskPage(
    status: "active" | "submitted" | "blocked" | "planned" | "in_review",
    sourceLimit: number,
    pageCursor: string | undefined,
    scope: AgendaWorkScope,
  ): AgendaSourcePage {
    const lifecycle = taskPresentationReads(projection).list({
        status,
        activePackagesOnly: true,
        limit: sourceLimit,
        pinnedFirst: true,
        ...(pageCursor ? { cursor: pageCursor } : {}),
        // --work narrows the page query itself, so a small limit returns that work's rows
        // instead of the repository's first page with the work's rows filtered away.
        ...(scope.members === null ? {} : { taskIds: [...scope.members] }),
      }),
      rows = lifecycle.rows,
      graph = readBlockingAssessments(rows.map(({ taskId }) => taskId)),
      readPresetSnapshot = presetSnapshotReader(projection);
    return {
      page: lifecycle.page ?? null,
      rows: rows.map((row) => ({
        ...row,
        workspace: taskWorkspaceView(rootDir, row.snapshot.task, row.packagePath, readPresetSnapshot, null),
        work: scope.workOf(row.snapshot.task?.metadata?.parentTaskId ?? null),
        blockingAssessment: graph.blockingByTaskId.get(row.taskId) ?? {
          taskId: row.taskId,
          state: "unknown" as const,
          label: "unresolved" as const,
          blockers: [],
          warnings: ["task snapshot missing from blocking judgment"],
        },
        downstreamBlocked: graph.downstreamByTaskId.get(row.taskId) ?? 0,
      })),
      warnings: lifecycle.warnings,
      reads: [
        lifecycle,
        graph.dependencies,
        graph.downstream,
        graph.derives,
        graph.awaits,
        graph.taskStatuses,
        ...scope.reads,
      ],
    };
  }
  /**
   * A row's work is its nearest declared work ancestor, else its topmost ancestor — the dispatch causal
   * context's rule. --work keeps one root and its subtree.
   */
  function agendaWorkScope(workId: string | undefined): AgendaWorkScope {
    const works = new Map<string, AgendaWorkRef | null>(),
      subtree = workId === undefined ? null : workspaceStructureFromProjection(projection, { rootTaskId: workId });
    return {
      members: subtree === null ? null : new Set([subtree.root.taskId, ...subtree.memberTaskIds]),
      reads: subtree === null ? [] : [subtree],
      workOf: (parentTaskId) => {
        if (parentTaskId === null) return null;
        if (!works.has(parentTaskId)) works.set(parentTaskId, workRootOf(projection, parentTaskId));
        return works.get(parentTaskId)!;
      },
    };
  }
  function agenda(query: AgendaQuery = {}): DaemonAgendaResult {
    const sourceLimit = query.limit ?? 100,
      cursor = query.cursor === undefined ? null : decodeAgendaCursor(query.cursor),
      scope = agendaWorkScope(query.work),
      readTaskPage = (status: "active" | "submitted" | "blocked" | "planned" | "in_review", key: AgendaCursorKey) =>
        cursor?.[key] === null ? null : readAgendaTaskPage(status, sourceLimit, cursor?.[key] ?? undefined, scope),
      active = readTaskPage("active", "active"),
      blocked = readTaskPage("blocked", "blocked"),
      planned = readTaskPage("planned", "planned"),
      submitted = readTaskPage("submitted", "submitted"),
      inReview = readTaskPage("in_review", "inReview"),
      decisions =
        cursor?.decisions === null
          ? null
          : projection.listDecisionAgendaPage({
              state: "proposed",
              limit: sourceLimit,
              ...(cursor?.decisions ? { cursor: cursor.decisions } : {}),
            }),
      // Settings affect only proposed Decisions. Avoid requiring a settings row when this page has none,
      // which keeps historical event-only projections readable without inventing a policy fallback.
      decisionReviewRequirement = decisions?.decisions.length
        ? readRepositorySettings(projection).decisionReviewRequirement
        : null,
      // 「等你处理」只收指向读者本人的 active awaits 边(dec_DF67F23066BAFE444190A191B5/CH2)。
      awaits =
        cursor?.awaitingYou === null || query.principalId === undefined
          ? null
          : projection.readRelationQuery({
              target: `person/${query.principalId}`,
              relationType: "awaits",
              state: "active",
              limit: sourceLimit,
              ...(cursor?.awaitingYou ? { cursor: cursor.awaitingYou } : {}),
            }),
      // 「已答复,待你跟进」候选:全部已退役的 awaits 边,再按源实体归属读者、答复后源实体未再写入收窄。
      answered =
        cursor?.answeredForYou === null || query.principalId === undefined
          ? null
          : projection.readRelationQuery({
              relationType: "awaits",
              state: "retired",
              limit: sourceLimit,
              ...(cursor?.answeredForYou ? { cursor: cursor.answeredForYou } : {}),
            }),
      reads = [
        ...(active?.reads ?? []),
        ...(blocked?.reads ?? []),
        ...(planned?.reads ?? []),
        ...(submitted?.reads ?? []),
        ...(inReview?.reads ?? []),
        ...(decisions === null ? [] : [decisions]),
        ...(awaits === null ? [] : [awaits]),
        ...(answered === null ? [] : [answered]),
      ],
      inFlight = (active?.rows ?? [])
        .filter((row) => row.snapshot.lease !== null || row.snapshot.executions.some(({ state }) => state === "active"))
        .map(agendaTaskRow)
        .sort(compareAgendaTasks),
      // 评审打回、球已回到使用者手里的那批:执行已关闭、lease 已释放,既不在飞也不待裁。
      awaitingRework = (active?.rows ?? [])
        .filter(
          (row) =>
            row.snapshot.lease === null &&
            !row.snapshot.executions.some(({ state }) => state === "active") &&
            latestExecution(row.snapshot.executions)?.state === "changes_requested",
        )
        .map(agendaTaskRow)
        .sort(compareAgendaTasks),
      waitingOnOthers = [
        ...(blocked?.rows ?? []),
        ...(planned?.rows ?? []).filter(({ blockingAssessment }) => blockingAssessment.state !== "clear"),
        ...(active?.rows ?? []).filter(({ blockingAssessment }) => blockingAssessment.state !== "clear"),
      ]
        .map(agendaTaskRow)
        .sort(compareAgendaTasks),
      dispatchable = (planned?.rows ?? [])
        .filter(({ blockingAssessment }) => blockingAssessment.state === "clear")
        .map(agendaTaskRow)
        .sort(compareAgendaTasks),
      stalled = (active?.rows ?? [])
        .filter(
          (row) =>
            row.snapshot.lease === null &&
            !row.snapshot.executions.some(({ state }) => state === "active") &&
            now().getTime() - Date.parse(row.updatedAt) > 7 * 24 * 60 * 60 * 1_000,
        )
        .map(agendaTaskRow)
        .sort(compareAgendaTasks),
      // 三种「等你动手」按下一步动作分组(2026-09-20 业主裁定拆开):submitted 行 → 派审;
      // in_review 行 → 等评审/consent;decision 行 → 裁决。同一 execution 只落所属组,不再合并。
      awaitingAdjudication: AgendaExecutionRow[] = awaitingExecutionRows(submitted?.rows ?? []).sort(
        compareAwaitingExecutions,
      ),
      underReview: AgendaExecutionRow[] = awaitingExecutionRows(inReview?.rows ?? []).sort(compareAwaitingExecutions),
      decisionSignals = (decisions?.decisions ?? []).map((decision) => {
        const full = projection.readDecision(decision.decisionId).decision;
        if (!full || decisionReviewRequirement === null) return { decision, signal: "ready" as const };
        const readiness = decisionReviewState(full, decisionReviewRequirement).acceptReviewReadiness;
        if (!readiness) return { decision, signal: "ready" as const };
        if (readiness.next.action === "override-review" || readiness.next.action === "respond-review")
          return { decision, signal: "awaitingOwner" as const };
        const running = readDecisionReviewDispatches({ rootDir, projection, decision: full }).filter(
          ({ reviewContentDigest, status }) => reviewContentDigest === readiness.currentDigest && status === "running",
        );
        if (running.length > 0)
          return {
            decision,
            signal: "inProgress" as const,
            reviewers: running.map(({ dispatchId, reviewer, findingCount }) => ({
              dispatchId,
              reviewer,
              findingCount,
            })),
          };
        return {
          decision,
          signal: readiness.next.action === "dispatch-review" ? ("needsReview" as const) : ("ready" as const),
        };
      }),
      decisionRow = ({ decision }: (typeof decisionSignals)[number]): AgendaDecisionRow => ({
        decisionId: decision.decisionId,
        title: decision.title,
        riskTier: decision.riskTier,
        urgency: decision.urgency,
        proposedAt: decision.proposedAt,
      }),
      sortDecisions = <Row extends AgendaDecisionRow>(rows: Row[]) =>
        rows.sort((left, right) => left.decisionId.localeCompare(right.decisionId)),
      decisionReviewInProgress = sortDecisions(
        decisionSignals.flatMap((signal) =>
          signal.signal === "inProgress" ? [{ ...decisionRow(signal), reviewers: signal.reviewers }] : [],
        ),
      ),
      awaitingDecisionReview = sortDecisions(
        decisionSignals.filter(({ signal }) => signal === "needsReview").map(decisionRow),
      ),
      awaitingDecision = sortDecisions(decisionSignals.filter(({ signal }) => signal === "ready").map(decisionRow)),
      awaitingYou: AgendaAwaitsRow[] = (awaits?.rows ?? []).filter(relationIsCurrent).flatMap((edge) => {
        const request = parseAwaitsRequest(edge.rationale),
          relation = projection.readRelationEdge(edge.relationId);
        if (request === null || relation === null) return [];
        const source = resolveEntitySummary(edge.sourceRef);
        return [
          {
            relationId: edge.relationId,
            relationRevision: relation.workspaceRevision,
            sourceRef: edge.sourceRef,
            title: source.title,
            status: source.status,
            personId: edge.targetRef.slice("person/".length),
            ...request,
            askedAt: relation.entity.createdAt,
            askedBy: actorLabel(relation.entity.provenance.actor),
          },
        ];
      }),
      answeredForYou: AgendaAnsweredRow[] = (answered?.rows ?? []).flatMap((edge) => {
        const request = parseAwaitsRequest(edge.rationale),
          relation = projection.readRelationEdge(edge.relationId),
          answer = relation?.entity.retirementReason;
        // 被 replace 退役的边不是答复;源实体在答复所在 revision 之后有任何写入即视为已跟进。
        if (request === null || relation === null || answer === undefined || relation.entity.replacedBy) return [];
        // 评审提醒随 Decision 的评审状态撤边,撤边不是答复。
        if (
          edge.sourceRef.startsWith("decision/") &&
          edge.rationale === decisionReviewAwaitRationale(edge.sourceRef.slice("decision/".length))
        )
          return [];
        if (sourceOwnerOf(edge.sourceRef) !== query.principalId) return [];
        const sourceVersion = projection.readEntityVersionWitness(edge.sourceRef).currentVersion;
        if (typeof sourceVersion !== "number" || sourceVersion > relation.workspaceRevision) return [];
        const source = resolveEntitySummary(edge.sourceRef);
        return [
          {
            relationId: edge.relationId,
            sourceRef: edge.sourceRef,
            title: source.title,
            status: source.status,
            personId: edge.targetRef.slice("person/".length),
            ...request,
            answer,
            answeredAt: relation.entity.updatedAt,
            answeredBy: actorLabel(relation.entity.provenance.actor),
          },
        ];
      }),
      allPinnedEntities = readPinnedEntities().map(resolvePinnedEntity),
      pinnedEntities = allPinnedEntities.slice(0, sourceLimit),
      pinnedEntityOverflow = Math.max(0, allPinnedEntities.length - pinnedEntities.length),
      nextState: AgendaCursor = {
        active: active?.page?.nextCursor ?? null,
        blocked: blocked?.page?.nextCursor ?? null,
        planned: planned?.page?.nextCursor ?? null,
        submitted: submitted?.page?.nextCursor ?? null,
        inReview: inReview?.page?.nextCursor ?? null,
        decisions: decisions?.page.nextCursor ?? null,
        awaitingYou: awaits?.page?.nextCursor ?? null,
        answeredForYou: answered?.page?.nextCursor ?? null,
      },
      nextCursor = Object.values(nextState).some((value) => value !== null) ? encodeAgendaCursor(nextState) : null,
      cut = requireSameProjectionCut(
        "review queue",
        reads.length === 0 ? [projection.readRelationQuery({ limit: 1 })] : reads,
      ),
      warningCodes = [
        ...new Set([active, blocked, planned, submitted, inReview].flatMap((read) => read?.warnings ?? [])),
      ],
      warnings: DaemonAgendaResult["warnings"] = warningCodes.map((code) => ({
        code,
        source: "generated-cache",
        severity: "warning",
        message: "The agenda projection cache was rebuilt from canonical events.",
      })),
      attentionItems = buildAttentionItems({
        now: now().toISOString(),
        awaitingYou,
        answeredForYou,
        awaitingRework,
        awaitingAdjudication,
        awaitingDecision,
        waitingOnOthers,
        stalled,
        sourceRows: [active, blocked, planned, submitted, inReview].flatMap((page) => page?.rows ?? []),
      }),
      regionWeights = attentionRegionWeights(attentionItems, {
        running: inFlight.length,
        review:
          awaitingAdjudication.length +
          underReview.length +
          decisionReviewInProgress.length +
          awaitingDecisionReview.length +
          awaitingDecision.length,
        queue: pinnedEntities.length,
        worksNeedingAttention: new Set(
          attentionItems.flatMap((item) => (item.workTaskId === null ? [] : [item.workTaskId])),
        ).size,
      });
    return {
      schema: "daemon.agenda/v1",
      ok: true,
      command: "agenda",
      ...cut,
      pinnedEntities,
      pinnedEntityOverflow,
      awaitingYou,
      answeredForYou,
      attentionItems,
      regionWeights,
      inFlight,
      stalled,
      awaitingRework,
      awaitingAdjudication,
      underReview,
      decisionReviewInProgress,
      awaitingDecisionReview,
      awaitingDecision,
      waitingOnOthers,
      dispatchable,
      page: { sourceLimit, cursor: query.cursor ?? null, nextCursor },
      warnings,
      summary: renderAgendaSummary({
        pinnedEntities,
        pinnedEntityOverflow,
        awaitingYou,
        answeredForYou,
        attentionItems,
        inFlight,
        awaitingRework,
        awaitingAdjudication,
        underReview,
        decisionReviewInProgress,
        awaitingDecisionReview,
        awaitingDecision,
        waitingOnOthers,
        dispatchable,
      }),
    };
  }
  /** 源实体的归属人:task 的创建者、decision 的提案者;「待你跟进」按它判定读者是不是提问方。 */
  function sourceOwnerOf(ref: string): string | undefined {
    const parsed = /^(task|decision)\/(.+)$/u.exec(ref);
    if (parsed?.[1] === "task") {
      const principal = projection.read(parsed[2]!).snapshot.task?.createdBy.principal;
      return principal ? principalId(principal) : undefined;
    }
    if (parsed?.[1] === "decision") {
      const principal = projection.readDecision(parsed[2]!).decision?.proposer.principal;
      return principal ? principalId(principal) : undefined;
    }
    return undefined;
  }
  function resolvePinnedEntity(row: ReturnType<TaskProjection["listPinnedEntities"]>[number]): AgendaPinnedEntityRow {
    return { ref: row.entityRef, ...resolveEntitySummary(row.entityRef), pinnedAt: row.pinnedAt };
  }
  function resolveEntitySummary(ref: string): {
    readonly kind: string;
    readonly title: string;
    readonly status: string;
  } {
    const parsed = /^([^/]+)\/(.+)$/u.exec(ref),
      kind = parsed?.[1] ?? "entity",
      id = parsed?.[2] ?? ref;
    if (kind === "task") {
      const task = projection.read(id).snapshot.task;
      return { kind, title: task?.title ?? id, status: task?.status ?? "unknown" };
    }
    if (kind === "decision") {
      const decision = projection.readDecision(id).decision;
      return { kind, title: decision?.title ?? id, status: decision?.state ?? "unknown" };
    }
    const entity = projection.getEntity(kind, id),
      value = entity?.value;
    return {
      kind,
      title: typeof value?.title === "string" ? value.title : id,
      status: typeof value?.state === "string" ? value.state : (entity?.freshness ?? "current"),
    };
  }
  /**
   * Narrow relation graph read: one indexed page of converged event-backed
   * edges plus only the fact anchors and rows those edges touch, and coverage
   * rows restricted to the decisions the page references. Explicitly scoped to
   * event-backed truth; the unparameterized read calls this same relation query
   * authority with an empty filter, so query shape cannot change the truth set.
   */
  function relationGraphPage(query: TaskRelationQuery): DaemonRelationGraphFullResult {
    return relationGraphFromRead(projection.readRelationQuery(query), "relation graph page");
  }
  function relationGraphFromRead(page: TaskRelationProjectionRead, label: string): DaemonRelationGraphFullResult {
    const refs = new Set(page.rows.flatMap((edge) => [edge.sourceRef, edge.targetRef])),
      factRefs = [...refs].filter((ref) => ref.startsWith("fact/")),
      facts = projection.searchFacts({ refs: factRefs }),
      factAnchors = projection.readFactAnchors(factRefs),
      decisionRefs = [...refs].filter((ref) => ref.startsWith("decision/")),
      decisions = projection.readDecisionCoverage([
        ...new Set(decisionRefs.flatMap((ref) => /^decision\/([^/]+)/u.exec(ref)?.[1] ?? [])),
      ]),
      cut = requireSameProjectionCut(label, [page, facts, factAnchors, decisions]),
      coverageRows = decisions.coverageRows.filter((row) =>
        decisionRefs.some((ref) => row.decisionRef === ref || row.claimRef === ref),
      );
    const servedCoverage = coverageRows.map((row) => {
      const fulfillment = row.fulfillment === "standing_policy" ? ("standing-policy" as const) : row.fulfillment;
      return withFreshnessReason({ ...row, fulfillment });
    });
    const servedFacts = facts.facts.map((row) => ({
      schema: "task-fact-row/v1" as const,
      ref: row.ref,
      ...(row.taskId ? { taskId: row.taskId } : {}),
      factId: row.factId,
      statement: row.statement,
      source: row.evidenceSource,
      observedAt: row.observedAt,
      confidence: row.confidence,
      memoryClass: row.memoryClass,
      memoryTags: row.memoryTags,
      provenance: relationProvenance(row.provenance),
      liveness: row.state,
      invalidated: row.invalidated,
      archived: row.archived,
    }));
    return {
      ok: true,
      edges: page.rows.map(withRelationCurrent),
      coverageRows: servedCoverage,
      factAnchors: factAnchors.rows,
      facts: servedFacts,
      warnings: relationFacetWarnings(cut.status),
      ...cut,
      ...(page.page ? { page: page.page } : {}),
      ...("truncated" in page && page.truncated === true ? { truncated: true } : {}),
    };
  }
  return Object.freeze({ agenda, relationGraphNeighborhood, relationGraphFacet, relationGraphPage, guiTasks });
}

function projectedRuntimeHeaders(projection: TaskProjection): DispatchStreamHeader[] {
  const headers: DispatchStreamHeader[] = [];
  let cursor: { readonly startedAt: string; readonly dispatchId: string } | undefined;
  for (;;) {
    const page = projection.readRuntimeDispatchPage({
      startedAtGte: "0000-01-01T00:00:00.000Z",
      ...(cursor ? { cursor } : {}),
      limit: 500,
    });
    for (const { event } of page.rows) {
      const value = event.payload;
      headers.push({
        schema: "runtime-dispatch-stream/v1",
        kind: "dispatch",
        dispatchId: value.dispatchId,
        taskId: value.taskId ?? null,
        executionId: value.executionId ?? null,
        runtimeSessionId: value.runtimeSessionId,
        instanceId: value.instanceId,
        startedAt: value.startedAt ?? event.occurredAt,
        eventStreamRef: `file:.harness/runtime/dispatches/${value.dispatchId}.jsonl`,
        ...(value.agentId ? { agentId: value.agentId } : {}),
      });
    }
    if (page.done) return headers;
    if (!page.nextCursor) throw new Error("runtime dispatch graph page is incomplete without a next cursor");
    cursor = page.nextCursor;
  }
}
/**
 * `repo.triadic.relationGraph {facet:"runtimeEdges"}` — the agent→task dispatch edges.
 *
 * The entity registry declares no relation projection between the runtime plane and
 * tasks, so the ledger holds no authored relation event to read; the only record that
 * carries agent and task on the same row is the dispatch stream header. This is the
 * whole derivation: one (agent, task) pair per edge, `dispatches`, origin generated.
 * Schedule→agent is *not* derived here — the Schedule definition already states its
 * target, and the renderer reads it with the Schedule rows it already has.
 */
export function runtimeDispatchEdges(
  headers: ReadonlyArray<DispatchStreamHeader>,
): readonly DaemonRelationGraphEdgeRow[] {
  const rows = new Map<string, RelationGraphEdgeRow>();
  for (const header of headers) {
    if (!header.agentId || !header.taskId) continue;
    const sourceRef = `agent/${header.agentId}`,
      targetRef = `task/${header.taskId}`,
      relationId = deriveRelationId({
        source: sourceRef,
        target: targetRef,
        type: "dispatches",
        direction: "directed",
      });
    if (rows.has(relationId)) continue;
    rows.set(relationId, {
      relationId,
      workspaceRevision: null,
      sourceRef,
      targetRef,
      relationType: "dispatches",
      direction: "directed",
      strength: "strong",
      origin: "generated",
      state: "active",
      targetObservedVersion: null,
      currentTargetVersion: null,
      freshness: "suspect",
      rationale: "Agent dispatch record",
      ownerRef: sourceRef,
      sourcePath: `.harness/runtime/dispatches/${header.dispatchId}.jsonl`,
      recordIndex: 0,
    });
  }
  return [...rows.values()]
    .map(withRelationCurrent)
    .sort((left, right) => left.relationId.localeCompare(right.relationId));
}

function withRelationCurrent<T extends RelationGraphEdgeRow>(row: T): T & { readonly current: boolean } {
  return { ...row, current: relationIsCurrent(row) };
}

function relationFacetWarnings(status: "ready" | "pending") {
  return status === "ready"
    ? []
    : [
        {
          code: "relation_truth_unavailable" as const,
          source: "generated-cache" as const,
          severity: "hard-fail" as const,
          message: "Event-backed relation truth has not reached the canonical source revision.",
          repairHint: "Retry after the rebuild projection catches up.",
        },
      ];
}
export type ProjectionCut = Pick<TaskRelationProjectionRead, "status" | "watermark" | "sourceRevision">;
function projectionCut(read: ProjectionCut): ProjectionCut {
  return {
    status: read.status,
    watermark: read.watermark,
    sourceRevision: read.sourceRevision,
  };
}
export function requireSameProjectionCut(surface: string, reads: readonly ProjectionCut[]): ProjectionCut {
  const basis = reads[0];
  if (basis === undefined) throw new Error(`${surface} requires an event projection cut.`);
  for (const read of reads.slice(1))
    if (!isDeepStrictEqual(projectionCut(read), projectionCut(basis)))
      throw new Error(`${surface} spans multiple event projection cuts.`);
  return projectionCut(basis);
}
export function requiredPackageDisposition(
  taskId: string,
  disposition: "active" | "archived" | "tombstoned" | undefined,
): "active" | "archived" | "tombstoned" {
  if (disposition !== undefined) return disposition;
  throw new Error(`Event-backed task projection is missing packageDisposition for ${taskId}.`);
}
/** Attach the kernel's uncovered-cause classification so consumers never re-derive it. */
function withFreshnessReason<T extends FreshnessReasonInput>(row: T): T & { freshnessReason?: FreshnessReason } {
  const reason = freshnessReasonOf(row);
  return reason === null ? row : { ...row, freshnessReason: reason };
}
function relationProvenance(
  value: readonly { readonly runtime: string; readonly sessionId: string | null; readonly boundAt: string }[],
): readonly { readonly runtime: string; readonly sessionId: string; readonly boundAt: string }[] {
  return value.flatMap((entry) =>
    entry.sessionId === null ? [] : [{ runtime: entry.runtime, sessionId: entry.sessionId, boundAt: entry.boundAt }],
  );
}
function evidenceSubstrate(locator: string): "repository-path" | "uri" | "canonical-event" | "opaque" {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(locator)) return "uri";
  if (locator.startsWith("event:")) return "canonical-event";
  if (!path.isAbsolute(locator) && !locator.split("/").includes("..") && /^[A-Za-z0-9._/-]+$/u.test(locator))
    return "repository-path";
  return "opaque";
}
function projectExecutionEvidence(
  taskId: string,
  execution: ProjectedExecution,
  taskOrigin: TaskPlacementSupplement["origin"],
): ExecutionEvidenceProjection {
  if (execution.schema === "archived-execution/v1")
    return {
      executionId: execution.executionId,
      origin: "archival",
      outputs: execution.outputs.map((output, index) => ({
        evidenceId: `evidence_${createHash("sha256").update(`${taskId}\0${execution.executionId}\0${index}\0${output.migratedFrom}`).digest("hex").slice(0, 24)}`,
        locator: output.locator,
        substrate: output.substrate,
        checkerReceiptRef: output.checkerReceiptRef,
        checkerResult: output.checkerResult,
      })),
    };
  return {
    executionId: execution.executionId,
    origin: taskOrigin === "archival" ? "archival" : "native",
    outputs: (execution.submission?.outputs ?? []).map((locator, index) => ({
      evidenceId: `evidence_${createHash("sha256").update(`${taskId}\0${execution.executionId}\0${index}\0${locator}`).digest("hex").slice(0, 24)}`,
      locator,
      substrate: evidenceSubstrate(locator),
      checkerReceiptRef: null,
      checkerResult: "unknown",
    })),
  };
}
type AgendaSourceRow = ReturnType<TaskProjection["list"]>["rows"][number] & {
  readonly work: AgendaWorkRef | null;
  readonly blockingAssessment: DaemonTaskSnapshotListResult["rows"][number]["blockingAssessment"];
  readonly workspace: AgendaTaskRow["workspace"];
  readonly downstreamBlocked: number;
};
type AgendaWorkScope = {
  readonly members: ReadonlySet<string> | null;
  readonly reads: readonly ProjectionCut[];
  readonly workOf: (parentTaskId: string | null) => AgendaWorkRef | null;
};
type AgendaSourcePage = {
  readonly page: ProjectionPage | null;
  readonly rows: readonly AgendaSourceRow[];
  readonly warnings: ReturnType<TaskProjection["list"]>["warnings"];
  readonly reads: readonly ProjectionCut[];
};
function actorLabel(actor: ActorIdentity) {
  return actor.executor?.id ?? principalId(actor.principal);
}
function agendaTaskRow(row: AgendaSourceRow): AgendaTaskRow {
  const task = row.snapshot.task!;
  return {
    taskId: row.taskId,
    title: task.title,
    work: row.work,
    status: task.status,
    pinned: task.pinned,
    updatedAt: row.updatedAt,
    leaseExecutionId: row.snapshot.lease?.executionId ?? null,
    activeExecutionIds: row.snapshot.executions
      .filter(({ state }) => state === "active")
      .map(({ executionId }) => executionId)
      .sort(),
    blockingAssessment: row.blockingAssessment,
    workspace: row.workspace,
  };
}

/** 最新一轮 execution:按 iteration 取最大者的 state,不回看更早历史(同一轮内后到者胜出)。 */
function latestExecution(executions: readonly ProjectedExecution[]): ProjectedExecution | undefined {
  let latest: ProjectedExecution | undefined;
  for (const execution of executions)
    if (latest === undefined || execution.iteration >= latest.iteration) latest = execution;
  return latest;
}
/** 一页 task 行 → 当前切面尚无 settled approved 评审的 submitted execution 行;待派审/评审中两组共用这一谓词。 */
function awaitingExecutionRows(rows: readonly AgendaSourceRow[]): AgendaExecutionRow[] {
  return rows.flatMap((row) =>
    row.snapshot.executions
      .filter(
        (execution) =>
          execution.state === "submitted" &&
          settledApprovedReviewsForExecution(row.snapshot.reviews, execution, row.snapshot.reviewDispositions)
            .length === 0,
      )
      .map((execution) => ({
        taskId: row.taskId,
        title: row.snapshot.task?.title ?? row.taskId,
        work: row.work,
        pinned: row.snapshot.task!.pinned,
        executionId: execution.executionId,
        submittedAt: execution.submittedAt ?? row.updatedAt,
        blockingAssessment: row.blockingAssessment,
      })),
  );
}
function compareAgendaTasks(left: AgendaTaskRow, right: AgendaTaskRow): number {
  return Number(right.pinned) - Number(left.pinned) || left.taskId.localeCompare(right.taskId);
}
function compareAwaitingExecutions(left: AgendaExecutionRow, right: AgendaExecutionRow): number {
  return Number(right.pinned) - Number(left.pinned) || left.executionId.localeCompare(right.executionId);
}
