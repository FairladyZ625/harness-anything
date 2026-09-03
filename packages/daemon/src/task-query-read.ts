import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  blockingOf,
  closeoutReadiness,
  deriveRelationId,
  freshnessReasonOf,
  relationIsCurrent,
  taskBoardPlacement,
  taskCapabilities,
  taskPhase,
  taskRisk,
  taskVisibility,
  workspaceTaskStatus,
  type FreshnessReason,
  type FreshnessReasonInput,
  type ProjectedExecution,
  type RelationGraphEdgeRow,
  type TaskProjection,
  type TaskProjectionListQuery,
  type TaskRelationProjectionRead,
  type TaskRelationQuery,
} from "../../kernel/src/index.ts";
import { readDispatchStreamHeaders, type DispatchStreamHeader } from "./dispatch-stream.ts";
import {
  isolateDaemonTaskSnapshotRows,
  type AgendaAwaitingRow,
  type AgendaTaskRow,
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

/**
 * The daemon's task query read model. Extracted verbatim from repo-cell so the
 * wide queries (task snapshot list, triadic relation graph) have one importable
 * real implementation — the daemon serves it, and scale measurement exercises
 * the same functions instead of a fixture proxy. The closeout/blocking domain
 * judgments stay injected by repo-cell so the serving surface keeps consuming
 * the canonical kernel definitions directly.
 */
export interface TaskQueryReadModel {
  readonly agenda: (query?: { readonly limit?: number; readonly cursor?: string }) => DaemonAgendaResult;
  readonly relationGraph: () => DaemonRelationGraphFullResult;
  readonly relationGraphFacet: (query: DaemonRelationGraphFacetPayload) => DaemonRelationGraphFacetResult;
  readonly relationGraphPage: (query: TaskRelationQuery) => DaemonRelationGraphFullResult;
  readonly guiTasks: (query?: TaskProjectionListQuery) => DaemonTaskSnapshotListResult;
}
export interface TaskQueryJudgments {
  readonly closeout: typeof closeoutReadiness;
  readonly blocking: typeof blockingOf;
}
export function makeTaskQueryReadModel(input: {
  readonly rootDir: CanonicalRoot;
  readonly projection: TaskProjection;
  readonly judgments: TaskQueryJudgments;
}): TaskQueryReadModel {
  const { rootDir, projection, judgments } = input,
    closeout = judgments.closeout,
    blocking = judgments.blocking;
  function relationGraph(): DaemonRelationGraphFullResult {
    const relations = projection.readRelationQuery({}),
      decisions = projection.readDecisionGraph(),
      facts = projection.readFactGraph(),
      cut = requireSameProjectionCut("relation graph", [relations, decisions, facts]);
    const eventCoverage = decisions.coverageRows.map((row) => {
      const fulfillment = row.fulfillment === "standing_policy" ? ("standing-policy" as const) : row.fulfillment;
      return withFreshnessReason({ ...row, fulfillment });
    });
    const eventFacts = facts.facts.map((row) => ({
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
    }));
    return {
      ok: true,
      edges: relations.rows.map(withRelationCurrent),
      coverageRows: eventCoverage,
      factAnchors: facts.factAnchors,
      facts: eventFacts,
      warnings: relationFacetWarnings(cut.status),
      ...cut,
    };
  }
  function relationGraphFacet(query: DaemonRelationGraphFacetPayload): DaemonRelationGraphFacetResult {
    const emptyRows = { edges: [], coverageRows: [], factAnchors: [], facts: [], domainTypes: [] } as const;
    if (query.facet === "runtimeEdges") {
      return {
        ok: true,
        facet: "runtimeEdges",
        ...emptyRows,
        edges: runtimeDispatchEdges(readDispatchStreamHeaders(rootDir)),
        warnings: [],
      };
    }
    if (query.facet === "edges") {
      const read = projection.readRelationQuery({
          ...(query.relationType === undefined ? {} : { relationType: query.relationType }),
          ...(query.state === undefined ? {} : { state: query.state }),
        }),
        edges =
          query.direction === undefined
            ? read.rows.map(withRelationCurrent)
            : read.rows.filter(({ direction }) => direction === query.direction).map(withRelationCurrent);
      return {
        ok: true,
        facet: "edges",
        ...emptyRows,
        edges,
        warnings: relationFacetWarnings(read.status),
        ...projectionCut(read),
      };
    }
    if (query.facet === "facts") {
      const read = projection.searchFacts({}),
        domainTypes = projection.listFactDomainTypes();
      return {
        ok: true,
        facet: "facts",
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
        })),
        domainTypes: domainTypes.domainTypes,
        warnings: relationFacetWarnings(read.status === "ready" ? domainTypes.status : read.status),
        ...projectionCut(read),
      };
    }
    if (query.facet === "factAnchors") {
      const read = projection.readFactAnchors();
      return {
        ok: true,
        facet: "factAnchors",
        ...emptyRows,
        factAnchors: read.rows,
        warnings: relationFacetWarnings(read.status),
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
  function guiTasks(query: TaskProjectionListQuery = {}): DaemonTaskSnapshotListResult {
    const lifecycle = projection.list(query),
      taskRefs = lifecycle.rows.map(({ taskId }) => `task/${taskId}`),
      dependencies = projection.readTaskDependencyClosure(taskRefs),
      derives = projection.readTaskRelationsByTargets(taskRefs, "derives"),
      edges = [...dependencies.rows, ...derives.rows],
      relatedTaskIds = [
        ...new Set([
          ...lifecycle.rows.map(({ taskId }) => taskId),
          ...dependencies.rows.flatMap(({ sourceRef, targetRef }) =>
            [sourceRef, targetRef].flatMap((ref) => /^task\/([^/]+)$/u.exec(ref)?.[1] ?? []),
          ),
        ]),
      ],
      taskStatuses = projection.readTaskStatuses(relatedTaskIds),
      decisionIds = [
        ...new Set(derives.rows.flatMap(({ sourceRef }) => /^decision\/([^/]+)/u.exec(sourceRef)?.[1] ?? [])),
      ],
      decisionRead = projection.readDecisions(decisionIds),
      cut = requireSameProjectionCut("task control surface", [
        lifecycle,
        dependencies,
        derives,
        taskStatuses,
        decisionRead,
      ]),
      graphWarnings = [...relationFacetWarnings(dependencies.status), ...relationFacetWarnings(derives.status)],
      hardWarnings = graphWarnings.filter(({ severity }) => severity === "hard-fail").map(({ message }) => message),
      activeDerives = new Map<string, typeof edges>();
    for (const edge of derives.rows)
      if (edge.state === "active" && edge.direction === "directed" && edge.relationType === "derives")
        activeDerives.set(edge.targetRef, [...(activeDerives.get(edge.targetRef) ?? []), edge]);
    const blockingTasks = taskStatuses.rows.flatMap((row) =>
      row.status === null ? [] : [{ taskId: row.taskId, status: row.status }],
    );
    const blockingRows = new Map(
      blocking(blockingTasks, edges, {
        state: hardWarnings.length ? "error" : "ready",
        hardFailWarnings: hardWarnings,
      }).map((row) => [row.taskId, row]),
    );
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
            moduleKeys: [
              ...new Set(
                [metadata?.moduleKey, ...scopes.flatMap((scope) => scope.appliesTo.modules)].filter(
                  (value): value is string => !!value,
                ),
              ),
            ].sort(),
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
          blockingAssessment = blockingRows.get(row.taskId) ?? {
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
        };
      }),
      ...cut,
    };
    return { ...result, ...isolateDaemonTaskSnapshotRows(result.rows) };
  }
  function agenda(query: { readonly limit?: number; readonly cursor?: string } = {}): DaemonAgendaResult {
    const sourceLimit = query.limit ?? 100,
      cursor = query.cursor === undefined ? null : decodeAgendaCursor(query.cursor),
      readTaskPage = (status: "active" | "blocked" | "planned" | "in_review", key: AgendaCursorKey) =>
        cursor?.[key] === null
          ? null
          : guiTasks({
              status,
              limit: sourceLimit,
              pinnedFirst: true,
              ...(cursor?.[key] ? { cursor: cursor[key]! } : {}),
            }),
      active = readTaskPage("active", "active"),
      blocked = readTaskPage("blocked", "blocked"),
      planned = readTaskPage("planned", "planned"),
      inReview = readTaskPage("in_review", "inReview"),
      decisions =
        cursor?.decisions === null
          ? null
          : projection.listDecisionAgendaPage({
              state: "proposed",
              limit: sourceLimit,
              ...(cursor?.decisions ? { cursor: cursor.decisions } : {}),
            }),
      reads = [active, blocked, planned, inReview, decisions].filter(
        (read): read is NonNullable<typeof read> => read !== null,
      ),
      inFlight = (active?.rows ?? [])
        .filter((row) => row.snapshot.lease !== null || row.snapshot.executions.some(({ state }) => state === "active"))
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
      awaitingExecutions: AgendaAwaitingRow[] = (inReview?.rows ?? []).flatMap((row) =>
        row.snapshot.executions
          .filter(
            (execution) =>
              execution.state === "submitted" &&
              !row.snapshot.reviews.some(
                (review) =>
                  review.executionId === execution.executionId &&
                  review.verdict === "approved" &&
                  review.commitSha === execution.submission?.commitSha &&
                  review.iteration === execution.iteration,
              ),
          )
          .map((execution) => ({
            kind: "execution" as const,
            taskId: row.taskId,
            title: row.snapshot.task?.title ?? row.taskId,
            pinned: row.snapshot.task!.pinned,
            executionId: execution.executionId,
            submittedAt: execution.submittedAt ?? row.updatedAt,
            blockingAssessment: row.blockingAssessment,
          })),
      ),
      awaitingDecisions: AgendaAwaitingRow[] = (decisions?.decisions ?? []).map((decision) => ({
        kind: "decision",
        decisionId: decision.decisionId,
        title: decision.title,
        riskTier: decision.riskTier,
        urgency: decision.urgency,
        proposedAt: decision.proposedAt,
      })),
      awaitingDecision = [...awaitingExecutions, ...awaitingDecisions].sort(compareAwaiting),
      nextState: AgendaCursor = {
        active: active?.page?.nextCursor ?? null,
        blocked: blocked?.page?.nextCursor ?? null,
        planned: planned?.page?.nextCursor ?? null,
        inReview: inReview?.page?.nextCursor ?? null,
        decisions: decisions?.page.nextCursor ?? null,
      },
      nextCursor = Object.values(nextState).some((value) => value !== null) ? encodeAgendaCursor(nextState) : null,
      cut = requireSameProjectionCut(
        "review queue",
        reads.length === 0 ? [projection.readRelationQuery({ limit: 1 })] : reads,
      ),
      warningCodes = [...new Set([active, blocked, planned, inReview].flatMap((read) => read?.warnings ?? []))],
      warnings: DaemonAgendaResult["warnings"] = warningCodes.map((code) => ({
        code,
        source: "generated-cache",
        severity: "warning",
        message: "The agenda projection cache was rebuilt from canonical events.",
      }));
    return {
      schema: "daemon.agenda/v1",
      ok: true,
      command: "agenda",
      ...cut,
      inFlight,
      awaitingDecision,
      waitingOnOthers,
      dispatchable,
      page: { sourceLimit, cursor: query.cursor ?? null, nextCursor },
      warnings,
      summary: renderAgendaSummary({ inFlight, awaitingDecision, waitingOnOthers, dispatchable }),
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
    const page: TaskRelationProjectionRead = projection.readRelationQuery(query),
      refs = new Set(page.rows.flatMap((edge) => [edge.sourceRef, edge.targetRef])),
      factRefs = [...refs].filter((ref) => ref.startsWith("fact/")),
      facts = projection.searchFacts({ refs: factRefs }),
      factAnchors = projection.readFactAnchors(factRefs),
      decisionRefs = [...refs].filter((ref) => ref.startsWith("decision/")),
      decisions = projection.readDecisionGraph(),
      cut = requireSameProjectionCut("relation graph page", [page, facts, factAnchors, decisions]),
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
    };
  }
  return Object.freeze({ agenda, relationGraph, relationGraphFacet, relationGraphPage, guiTasks });
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
type ProjectionCut = Pick<TaskRelationProjectionRead, "status" | "watermark" | "sourceRevision">;
function projectionCut(read: ProjectionCut): ProjectionCut {
  return {
    status: read.status,
    watermark: read.watermark,
    sourceRevision: read.sourceRevision,
  };
}
function requireSameProjectionCut(surface: string, reads: readonly ProjectionCut[]): ProjectionCut {
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
type AgendaSourceRead = DaemonTaskSnapshotListResult["rows"][number];
type AgendaCursorKey = "active" | "blocked" | "planned" | "inReview";
type AgendaCursor = Readonly<Record<AgendaCursorKey | "decisions", string | null>>;
function agendaTaskRow(row: AgendaSourceRead): AgendaTaskRow {
  const task = row.snapshot.task!;
  return {
    taskId: row.taskId,
    title: task.title,
    status: task.status,
    pinned: task.pinned,
    updatedAt: row.updatedAt,
    leaseExecutionId: row.snapshot.lease?.executionId ?? null,
    activeExecutionIds: row.snapshot.executions
      .filter(({ state }) => state === "active")
      .map(({ executionId }) => executionId)
      .sort(),
    blockingAssessment: row.blockingAssessment,
  };
}
function compareAgendaTasks(left: AgendaTaskRow, right: AgendaTaskRow): number {
  return Number(right.pinned) - Number(left.pinned) || left.taskId.localeCompare(right.taskId);
}
function compareAwaiting(left: AgendaAwaitingRow, right: AgendaAwaitingRow): number {
  const leftPinned = left.kind === "execution" && left.pinned,
    rightPinned = right.kind === "execution" && right.pinned;
  return Number(rightPinned) - Number(leftPinned) || awaitingKey(left).localeCompare(awaitingKey(right));
}
function awaitingKey(row: AgendaAwaitingRow): string {
  return row.kind === "execution" ? `execution/${row.taskId}/${row.executionId}` : `decision/${row.decisionId}`;
}
function decodeAgendaCursor(value: string): AgendaCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("agenda cursor is invalid");
  }
  const keys = ["active", "blocked", "planned", "inReview", "decisions"] as const;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== keys.length ||
    keys.some(
      (key) =>
        !Object.hasOwn(parsed, key) ||
        ((parsed as Record<string, unknown>)[key] !== null &&
          (typeof (parsed as Record<string, unknown>)[key] !== "string" || !(parsed as Record<string, string>)[key])),
    )
  )
    throw new Error("agenda cursor is invalid");
  return parsed as AgendaCursor;
}
function encodeAgendaCursor(value: AgendaCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function renderAgendaSummary(
  groups: Pick<DaemonAgendaResult, "inFlight" | "awaitingDecision" | "waitingOnOthers" | "dispatchable">,
): string {
  const taskLine = (row: AgendaTaskRow) =>
      `- ${row.pinned ? "📌 " : ""}${row.taskId} ${row.title}${row.blockingAssessment.blockers.length ? `（阻塞: ${row.blockingAssessment.blockers.map(({ targetTaskId }) => targetTaskId).join(", ")}）` : ""}`,
    awaitingLine = (row: AgendaAwaitingRow) =>
      row.kind === "execution"
        ? `- ${row.pinned ? "📌 " : ""}execution ${row.executionId} / ${row.taskId} ${row.title}`
        : `- decision ${row.decisionId} ${row.title}`,
    section = (title: string, rows: readonly string[]) =>
      `${title} (${rows.length})\n${rows.length ? rows.join("\n") : "- 无"}`;
  return [
    section("在飞线", groups.inFlight.map(taskLine)),
    section("待裁", groups.awaitingDecision.map(awaitingLine)),
    section("球在别人手里", groups.waitingOnOthers.map(taskLine)),
    section("可派队列", groups.dispatchable.map(taskLine)),
  ].join("\n\n");
}
