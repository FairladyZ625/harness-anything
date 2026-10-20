import { useQuery } from "@tanstack/react-query";
import { attentionRegionWeights, compareAttention } from "@harness-anything/daemon/protocol";
import { harnessClient, type AgendaSuccess } from "./api-client.ts";
import { drainCursorPages } from "./paginated-read.ts";

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
    // 续读在 queryFn 内排空,不需要计时器;读完的 agenda 由台账 cut
    // (invalidateLedgerDependents)刷新,它既不是探针也不自持轮询。
  };
}

export function useAgendaQuery(repoId: string | null) {
  return useQuery({ ...agendaQuery(repoId ?? "unselected"), enabled: repoId !== null });
}

/**
 * 议程读取形态:与台账读面同一纪律(与 readTaskList 同族的受控水化;议程切面小,
 * 一次刷新内沿 composite cursor 排空到读完,不把续读交给任何节拍定时器)。
 * 每页严格等上一页回来;页数上界是 drainCursorPages 的 CURSOR_READ_PAGE_BUDGET,
 * 服务端游标异常循环时 fail-closed 抛错。
 *
 * 分组各自按实体 key 去重:composite cursor 是 per-source 的 keyset 游标,一次
 * 排空 sweep 里同一实体不会在同一分组出现两次,去重只防跨 sweep 的重放。watermark
 * 取 min、sourceRevision 取 max;daemon 在 cut 追赶中会把 status 报成 pending,
 * 原样透传,视图据此显示「正在追赶 r{sourceRevision}」。
 */
export async function readAgenda(repoId: string): Promise<AgendaSuccess> {
  const [first, ...rest] = await drainCursorPages((facets) => readAgendaPage(repoId, facets), "agenda read");
  let aspect = joinAgendaCut(undefined, first);
  for (const page of rest) aspect = joinAgendaCut(aspect, page);
  return aspect;
}

export async function readAgendaPage(repoId: string, facets: { readonly cursor?: string }): Promise<AgendaSuccess> {
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
