import { useQuery, useQueryClient } from "@tanstack/react-query";
import { attentionRegionWeights, compareAttention } from "@harness-anything/daemon/protocol";
import { harnessClient, type AgendaSuccess } from "./api-client.ts";
import { QUERY_PACING_MS } from "./query-pacing.ts";

/** 每个 agenda source 的一页上限(daemon 上限 500;GUI 用默认页大小,不放大读面)。 */
export const AGENDA_PAGE_LIMIT = 100;

export const agendaQueryKeys = {
  read: (repoId: string) => ["agenda", repoId] as const,
};

export function agendaQuery(repoId: string) {
  return {
    queryKey: agendaQueryKeys.read(repoId),
    queryFn: () => readAgenda(repoId),
    staleTime: 10_000,
    // The interval only carries an unfinished cursor read to completion; a settled agenda is
    // refetched by the ledger cut (invalidateLedgerDependents), not by its own timer or focus.
    refetchInterval: (query: { readonly state: { readonly data?: AgendaSuccess } }) =>
      query.state.data?.page?.nextCursor ? QUERY_PACING_MS.agendaCatchUp : false,
  };
}

export function useAgendaQuery(repoId: string | null) {
  const queryClient = useQueryClient(),
    selectedRepoId = repoId ?? "unselected";
  return useQuery({
    ...agendaQuery(selectedRepoId),
    // 续读状态存在缓存里:上一份切面没读完就沿 cursor 续,读完就重新水化。
    queryFn: () =>
      readAgenda(selectedRepoId, queryClient.getQueryData<AgendaSuccess>(agendaQueryKeys.read(selectedRepoId))),
    enabled: repoId !== null,
  });
}

/**
 * 议程读取形态:与台账读面同一纪律(一次刷新最多一个 `repo.agenda.read` 请求)。
 *
 *   - 上一份切面还带着 `page.nextCursor` → 沿 composite cursor 续读下一页
 *     (cursor 存在 react-query 缓存里,不需要模块级可变变量);
 *   - 否则读第一页,重新水化。
 *
 * 未读完的切面 `status` 一律是 `pending`:视图据此显示「正在追赶 r{sourceRevision}」,
 * 分组计数在这一屏不冒充全局总数。
 */
export async function readAgenda(repoId: string, previous?: AgendaSuccess): Promise<AgendaSuccess> {
  const resumeCursor = previous?.page.nextCursor ?? null;
  if (previous && resumeCursor !== null)
    return joinAgendaCut(previous, await readAgendaPage(repoId, { cursor: resumeCursor }));
  return joinAgendaCut(undefined, await readAgendaPage(repoId, {}));
}

async function readAgendaPage(repoId: string, facets: { readonly cursor?: string }): Promise<AgendaSuccess> {
  return harnessClient.getAgenda({ repoId, limit: AGENDA_PAGE_LIMIT, ...facets });
}

/**
 * 把新读到的一页并进已有切面。每个分组各自按实体 key 去重:composite cursor 是
 * per-source 的 keyset 游标,一次续读 sweep 里同一实体不会在同一分组出现两次,
 * 去重只防跨 sweep 的重放。watermark 取 min、sourceRevision 取 max,只有读完
 * (nextCursor === null)才报告 ready。
 *
 * 注意力行与区域权重(S1)按页产出,合并时用 daemon 同一对函数(compareAttention /
 * attentionRegionWeights)在合并后的切面上重算——权重与 CLI/GUI 同序只有一份实现。
 */
function joinAgendaCut(previous: AgendaSuccess | undefined, read: AgendaSuccess): AgendaSuccess {
  const complete = read.page.nextCursor === null;
  if (previous === undefined) return complete ? read : { ...read, status: "pending" as const };
  const merge = mergeAgendaRows;
  const merged: AgendaSuccess = {
    ok: true,
    status: complete ? read.status : "pending",
    pinnedEntities: read.pinnedEntities,
    pinnedEntityOverflow: read.pinnedEntityOverflow,
    awaitingYou: merge(previous.awaitingYou, read.awaitingYou, ({ relationId }) => relationId),
    answeredForYou: merge(previous.answeredForYou, read.answeredForYou, ({ relationId }) => relationId),
    // 注意力行与区域权重在下方用 daemon 同一对函数重算(同 ref 保分高者),不在这里按 ref 平铺。
    attentionItems: [],
    regionWeights: read.regionWeights,
    inFlight: merge(previous.inFlight, read.inFlight, ({ taskId }) => taskId),
    stalled: merge(previous.stalled, read.stalled, ({ taskId }) => taskId),
    awaitingRework: merge(previous.awaitingRework, read.awaitingRework, ({ taskId }) => taskId),
    awaitingAdjudication: merge(
      previous.awaitingAdjudication,
      read.awaitingAdjudication,
      ({ executionId }) => executionId,
    ),
    underReview: merge(previous.underReview, read.underReview, ({ executionId }) => executionId),
    decisionReviewInProgress: merge(
      previous.decisionReviewInProgress,
      read.decisionReviewInProgress,
      ({ decisionId }) => decisionId,
    ),
    awaitingDecisionReview: merge(
      previous.awaitingDecisionReview,
      read.awaitingDecisionReview,
      ({ decisionId }) => decisionId,
    ),
    awaitingDecision: merge(previous.awaitingDecision, read.awaitingDecision, ({ decisionId }) => decisionId),
    waitingOnOthers: merge(previous.waitingOnOthers, read.waitingOnOthers, ({ taskId }) => taskId),
    dispatchable: merge(previous.dispatchable, read.dispatchable, ({ taskId }) => taskId),
    summary: read.summary,
    page: read.page,
    watermark: Math.min(previous.watermark, read.watermark),
    sourceRevision: Math.max(previous.sourceRevision, read.sourceRevision),
  };
  const items = mergeAttentionItems(previous.attentionItems, read.attentionItems);
  return {
    ...merged,
    attentionItems: items,
    regionWeights: attentionRegionWeights(items, {
      running: merged.inFlight.length,
      review:
        merged.awaitingAdjudication.length +
        merged.underReview.length +
        merged.decisionReviewInProgress.length +
        merged.awaitingDecisionReview.length +
        merged.awaitingDecision.length,
      queue: merged.pinnedEntities.length,
      worksNeedingAttention: new Set(items.flatMap((item) => (item.workTaskId === null ? [] : [item.workTaskId]))).size,
    }),
  };
}

/** 同一 ref 两页都出现时保留分高者(与 daemon buildAttentionItems 的 highest 同判据)。 */
function mergeAttentionItems(
  previous: AgendaSuccess["attentionItems"],
  added: AgendaSuccess["attentionItems"],
): AgendaSuccess["attentionItems"] {
  const rows = new Map(previous.map((item) => [item.ref, item] as const));
  for (const item of added) {
    const held = rows.get(item.ref);
    if (held === undefined || compareAttention(item, held) < 0) rows.set(item.ref, item);
  }
  return [...rows.values()].sort(compareAttention);
}

function mergeAgendaRows<T>(base: readonly T[], added: readonly T[], keyOf: (row: T) => string): readonly T[] {
  const rows = new Map(base.map((row) => [keyOf(row), row]));
  for (const row of added) rows.set(keyOf(row), row);
  return [...rows.values()];
}
