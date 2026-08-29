import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DecisionProjectionRow, RelationCoverageRow, RelationGraphEdgeRow } from "../api/renderer-dto.ts";
import { harnessClient } from "./api-client.ts";
import type { DecisionListSuccess, RelationFactSummaryRow, RelationGraphSuccess } from "./api-client.ts";
import { KIND_LABEL } from "./graph/constants.ts";
import type { DecisionClaim, DecisionRow, DecisionState, FactRef, RelationEdge } from "./model/types.ts";
import { activeProducesFactRefs } from "./model/triadic.ts";

/**
 * 读面分层的键空间(fact F-D5605ABF 的消费者清单 + 2026-08-29 CEO 裁决):
 *   - `derives`  / `decisionSummary` — 根级常驻 chrome(看板决策徽章、⌘K 决策条目、
 *     任务详情的决策标题)读的窄面;
 *   - `activeEdges` — 任务↔任务/决策↔决策边的窄面,只在预览抽屉、任务详情或会话页
 *     挂载时读;
 *   - `facts` — ⌘K 面板的事实条目,面板打开时才读;
 *   - `graph` / `decisions` — 完整投影,只有渲染它的视图挂载时读。
 * 全部共享 `["triadic", repoId]` 前缀,`invalidateLedgerDependents` 一次失效覆盖所有
 * 切面;未挂载的切面只标记 stale,不会被重取(react-query v5 默认 `refetchType:"active"`)。
 */
export const triadicQueryKeys = {
  all: (repoId: string) => ["triadic", repoId] as const,
  graph: (repoId: string) => ["triadic", repoId, "relation-graph"] as const,
  derives: (repoId: string) => ["triadic", repoId, "relation-graph", "edges", "derives-active-directed"] as const,
  activeEdges: (repoId: string) => ["triadic", repoId, "relation-graph", "edges", "active"] as const,
  facts: (repoId: string) => ["triadic", repoId, "relation-graph", "facts"] as const,
  decisions: (repoId: string) => ["triadic", repoId, "decisions"] as const,
  decisionSummary: (repoId: string) => ["triadic", repoId, "decisions", "summary"] as const,
};

export interface RelationReadState {
  readonly relations: RelationEdge[];
  readonly relationState: "ready" | "loading" | "error";
  readonly relationWarnings: ReadonlyArray<{
    readonly severity?: string;
    readonly code?: string;
    readonly message?: string;
  }>;
}

function relationReadState(
  query: { readonly data?: RelationGraphSuccess; readonly isPending: boolean; readonly isError: boolean },
  enabled: boolean,
): RelationReadState {
  return {
    relations: adaptRelationRows(query.data?.edges ?? []),
    relationState: query.isError ? "error" : enabled && query.isPending ? "loading" : "ready",
    relationWarnings: query.data?.warnings ?? [],
  };
}

/**
 * 根级常驻读面:decision→task 的 active directed `derives` 边。
 * 看板徽章(`spawningDecisionOf`)、任务预览抽屉与会话页的决策引用只需要这一种边;
 * 量过的切面是 258,037 B,是完整 4.96 MB 图投影的 2.8%。
 */
export function useDecisionDerivesQuery(repoId: string | null): RelationReadState {
  const query = useQuery({
    queryKey: triadicQueryKeys.derives(repoId ?? "unselected"),
    queryFn: () =>
      harnessClient.getRelationGraph({
        repoId: repoId!,
        facet: "edges",
        relationType: "derives",
        state: "active",
        direction: "directed",
      }),
    enabled: repoId !== null,
    staleTime: 10_000,
  });
  return useMemo(() => relationReadState(query, repoId !== null), [query.data, query.isPending, query.isError, repoId]);
}

/**
 * 预览抽屉 / 任务详情 / 会话页自己的读面:全部 active 边(含 task↔task 与
 * decision↔decision 的 `relates`/`supersedes`/`depends-on`)。这些界面渲染的是边本身,
 * 不是完整投影,所以读边切面(~2.8 MB)而不是 4.96 MB 的完整图。`enabled` 由挂载方
 * 决定;完整图已在缓存里时调用方应传 `false`,避免同一批边读两遍。
 */
export function useActiveEdgesQuery(repoId: string | null, enabled: boolean): RelationReadState {
  const query = useQuery({
    queryKey: triadicQueryKeys.activeEdges(repoId ?? "unselected"),
    queryFn: () => harnessClient.getRelationGraph({ repoId: repoId!, facet: "edges", state: "active" }),
    enabled: repoId !== null && enabled,
    staleTime: 10_000,
  });
  const active = repoId !== null && enabled;
  return useMemo(() => relationReadState(query, active), [query.data, query.isPending, query.isError, active]);
}

/** 根级常驻读面:决策摘要投影(decisionId/title/state/appliesTo),157,246 B 量级。 */
export function useDecisionSummaryQuery(repoId: string | null) {
  const query = useQuery({
    queryKey: triadicQueryKeys.decisionSummary(repoId ?? "unselected"),
    queryFn: () => harnessClient.getDecisionSummaries({ repoId: repoId! }),
    enabled: repoId !== null,
    staleTime: 10_000,
  });
  return {
    decisions: query.data?.decisions ?? [],
    isPending: repoId !== null && query.isPending,
    isError: query.isError,
  };
}

/**
 * ⌘K 面板自己的读面:事实切面(989,858 B 量级)。面板没打开就不读——这不是缓存或
 * 降频,是"没有挂载的视图就不请求"。
 */
export function usePaletteFactsQuery(repoId: string | null, enabled: boolean) {
  const query = useQuery({
    queryKey: triadicQueryKeys.facts(repoId ?? "unselected"),
    queryFn: () => harnessClient.getRelationFacts({ repoId: repoId!, facet: "facts" }),
    enabled: repoId !== null && enabled,
    staleTime: 10_000,
  });
  const facts = useMemo<ReadonlyArray<RelationFactSummaryRow>>(() => query.data?.facts ?? [], [query.data]);
  return { facts, isPending: repoId !== null && enabled && query.isPending, isError: query.isError };
}

/**
 * 完整三元投影(图 + 决策)。**只有渲染它的视图挂载时才读**:`enabled` 由调用方按
 * 当前视图给出。这里没有 TTL/缓存层——省下的是"没人看的时候不请求",不是"少请求"。
 */
export function useTriadicProjectionQuery(repoId: string | null, options: { readonly enabled?: boolean } = {}) {
  const enabled = options.enabled !== false && repoId !== null;
  const graph = useQuery({
    queryKey: triadicQueryKeys.graph(repoId ?? "unselected"),
    queryFn: () => harnessClient.getRelationGraph({ repoId: repoId! }),
    enabled,
    staleTime: 10_000,
  });
  const decisions = useQuery({
    queryKey: triadicQueryKeys.decisions(repoId ?? "unselected"),
    queryFn: () => harnessClient.getDecisions({ repoId: repoId! }),
    enabled,
    staleTime: 10_000,
  });
  const rendererData = useMemo(
    () =>
      buildTriadicRendererData({
        graph: graph.data ?? emptyRelationGraph,
        decisions: decisions.data ?? emptyDecisionList,
      }),
    [graph.data, decisions.data],
  );
  const isLoading = graph.isLoading || decisions.isLoading;
  const isError = graph.isError || decisions.isError;
  /** 缓存里是否已有完整图(含之前挂载时读到的):有就不再读边切面。 */
  const graphAvailable = graph.data !== undefined;
  /** 挂载方需要它而它还没到位(禁用且无缓存时为 false,不冒充加载态)。 */
  const isPending = enabled && (graph.isPending || decisions.isPending);

  return useMemo(
    () => ({
      isLoading,
      isPending,
      isError,
      graphAvailable,
      relationState: graph.isError
        ? ("error" as const)
        : enabled && graph.isPending
          ? ("loading" as const)
          : ("ready" as const),
      relationWarnings: graph.data?.warnings ?? [],
      ...rendererData,
    }),
    [isLoading, isPending, isError, graphAvailable, graph.isError, graph.isPending, enabled, graph.data, rendererData],
  );
}

export interface TriadicRendererData {
  readonly decisions: DecisionRow[];
  readonly facts: FactRef[];
  readonly relations: RelationEdge[];
  readonly coverageRows: ReadonlyArray<RelationCoverageRow>;
  readonly factAnchors: RelationGraphSuccess["factAnchors"];
  readonly warnings: unknown[];
}

/**
 * Converts the public GUI bridge DTOs into the renderer's triadic model.
 * Keeping this pure makes the complete ledger -> bridge -> renderer path
 * testable without adding a second read path beside the daemon service.
 */
export function buildTriadicRendererData(input: {
  readonly graph: RelationGraphSuccess;
  readonly decisions: DecisionListSuccess;
}): TriadicRendererData {
  const relationRows = input.graph.edges,
    producedBy = new Map(
      activeProducesFactRefs(relationRows).map((row) => [row.targetRef, row.sourceRef.slice("task/".length)] as const),
    );
  return {
    decisions: adaptDecisionRows(input.decisions.decisions, relationRows, input.graph.coverageRows),
    facts: input.graph.facts.map((row) => ({
      anchor: `fact/${row.factId}`,
      ...(producedBy.get(row.ref) ? { taskId: producedBy.get(row.ref) } : {}),
      category: row.memoryClass === "semantic" ? "lesson" : row.memoryClass === "procedural" ? "progress" : "finding",
      text: row.statement,
      at: row.observedAt,
      confidence: row.confidence,
      source: row.source,
      provenance: row.provenance,
      invalidated:
        /* @gate-identity check-gui-status-judgments/gui-status-055 */
        row.liveness === "superseded_fact",
    })),
    relations: adaptRelationRows(relationRows),
    coverageRows: input.graph.coverageRows,
    factAnchors: input.graph.factAnchors,
    warnings: [...input.graph.warnings, ...input.decisions.warnings],
  };
}

const emptyRelationGraph: RelationGraphSuccess = {
  ok: true,
  edges: [],
  coverageRows: [],
  factAnchors: [],
  facts: [],
  warnings: [],
};

const emptyDecisionList: DecisionListSuccess = {
  ok: true,
  decisions: [],
  warnings: [],
};

function adaptRelationRows(rows: ReadonlyArray<RelationGraphEdgeRow>): RelationEdge[] {
  const edges: RelationEdge[] = [];
  for (const row of rows) {
    if (
      /* @gate-identity check-gui-status-judgments/gui-status-056 */
      row.state !== "active"
    )
      continue;
    if (!isKernelRelationKind(row.relationType)) continue;
    edges.push({
      relationId: row.relationId,
      from: row.sourceRef,
      to: row.targetRef,
      kind: row.relationType,
      direction: row.direction,
      state: row.state,
      provenance: row.origin === "imported_snapshot" ? "external-engine" : "local-document",
      rationale: row.rationale,
    });
  }
  return edges;
}

function isKernelRelationKind(value: string): value is RelationEdge["kind"] {
  return Object.hasOwn(KIND_LABEL, value);
}

function adaptDecisionRows(
  rows: ReadonlyArray<DecisionProjectionRow>,
  relationRows: ReadonlyArray<RelationGraphEdgeRow>,
  coverageRows: ReadonlyArray<RelationCoverageRow>,
): DecisionRow[] {
  const relationsBySource = new Map<string, string[]>();
  for (const row of relationRows) {
    if (
      /* @gate-identity check-gui-status-judgments/gui-status-057 */
      row.state !== "active"
    )
      continue;
    if (!row.targetRef.startsWith("fact/")) continue;
    const values = relationsBySource.get(row.sourceRef) ?? [];
    values.push(row.targetRef);
    relationsBySource.set(row.sourceRef, values);
  }
  for (const row of coverageRows) {
    if (!row.coveringFactRef) continue;
    const values = relationsBySource.get(row.claimRef) ?? [];
    values.push(row.coveringFactRef);
    relationsBySource.set(row.claimRef, values);
  }

  return rows.map((row) => {
    const chosen = row.chosen.map((entry) => ({
      ...decisionClaim(row.decisionId, entry.id, entry.text, relationsBySource),
      ...(entry.rationale ? { rationale: entry.rationale } : {}),
    }));
    const rejected = row.rejected.map((entry) => ({
      ...decisionClaim(row.decisionId, entry.id, entry.text, relationsBySource),
      whyNot: entry.whyNot,
    }));
    return {
      decisionId: row.decisionId,
      ...(row.legacyId ? { legacyId: row.legacyId } : {}),
      path: row.path,
      title: row.title,
      state: decisionState(row.state),
      riskTier: row.riskTier,
      urgency: row.urgency,
      vertical: row.vertical,
      preset: row.preset,
      decisionClass: row.decisionClass,
      workspaceRevision: row.workspaceRevision,
      proposedBy: actorRef(row.proposer),
      proposedAt: row.proposedAt,
      ...(row.arbiter ? { arbiter: actorRef(row.arbiter) } : {}),
      ...(row.decidedAt ? { decidedAt: row.decidedAt } : {}),
      question: row.question,
      chosen,
      rejected,
      claims: row.claims.map((claim) => ({
        id: claim.id,
        text: claim.text,
        loadBearing: claim.loadBearing,
        fulfillment: claim.fulfillment,
      })),
      judgmentConsents: row.judgmentConsents.map((consent) => ({ ...consent })),
      body: row.body ? { ...row.body } : null,
      appliesTo: { modules: [...row.appliesTo.modules], productLines: [...row.appliesTo.productLines] },
      ...(row.readiness
        ? {
            readinessSignals: {
              appliesToDrift: { ...row.readiness.appliesToDrift, paths: [...row.readiness.appliesToDrift.paths] },
              conflictMarker: { ...row.readiness.conflictMarker, paths: [...row.readiness.conflictMarker.paths] },
            },
          }
        : {}),
      lastChangedAt: row.decidedAt ?? row.proposedAt,
    };
  });
}

function decisionClaim(
  decisionId: string,
  id: string,
  text: string,
  relationsBySource: ReadonlyMap<string, ReadonlyArray<string>>,
): DecisionClaim {
  const ref = `decision/${decisionId}/${id}`;
  return {
    id,
    text,
    evidence: [...new Set(relationsBySource.get(ref) ?? [])],
  };
}

/**
 * Kernel decision states pass through; anything else is unknown — never a plausible
 * neighbour (ADR-0020 D1: `superseded` is not "awaiting approval").
 */
const kernelDecisionStates: ReadonlySet<string> = new Set([
  "proposed",
  "rejected",
  "deferred",
  "superseded",
  "in_effect",
  "outcome_retired",
]);
function decisionState(value: string): DecisionState {
  return kernelDecisionStates.has(value) ? (value as DecisionState) : "unknown";
}
function actorRef(value: DecisionProjectionRow["proposer"]): { readonly kind: "agent" | "human"; readonly id: string } {
  return value.executor ? { kind: "agent", id: value.executor.id } : { kind: "human", id: value.principal.personId };
}
