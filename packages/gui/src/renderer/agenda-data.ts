import { useQuery, useQueryClient } from "@tanstack/react-query";
import { harnessClient, type AgendaSuccess } from "./api-client.ts";
import type { AgendaAwaitingRow, AgendaTaskRow } from "../api/renderer-dto.ts";

export const AGENDA_REFRESH_INTERVAL_MS = 5_000;
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
    // refetched by the ledger cut (invalidateLedgerDependents), not by its own timer.
    refetchInterval: (query: { readonly state: { readonly data?: AgendaSuccess } }) =>
      query.state.data?.page?.nextCursor ? AGENDA_REFRESH_INTERVAL_MS : false,
    refetchOnWindowFocus: true,
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
 * per-source 的 keyset 游标,一次续读 sweep 里同一 task 不会在同一分组出现两次,
 * 去重只防跨 sweep 的重放。watermark 取 min、sourceRevision 取 max,只有读完
 * (nextCursor === null)才报告 ready。
 */
function joinAgendaCut(previous: AgendaSuccess | undefined, read: AgendaSuccess): AgendaSuccess {
  const complete = read.page.nextCursor === null;
  if (previous === undefined) return complete ? read : { ...read, status: "pending" as const };
  const inFlight = mergeTaskRows(previous.inFlight, read.inFlight),
    waitingOnOthers = mergeTaskRows(previous.waitingOnOthers, read.waitingOnOthers),
    dispatchable = mergeTaskRows(previous.dispatchable, read.dispatchable),
    awaitingDecision = mergeAwaitingRows(previous.awaitingDecision, read.awaitingDecision);
  return {
    ok: true,
    status: complete ? read.status : "pending",
    inFlight,
    awaitingDecision,
    waitingOnOthers,
    dispatchable,
    summary: read.summary,
    page: read.page,
    watermark: Math.min(previous.watermark, read.watermark),
    sourceRevision: Math.max(previous.sourceRevision, read.sourceRevision),
  };
}

function mergeTaskRows(base: readonly AgendaTaskRow[], added: readonly AgendaTaskRow[]): readonly AgendaTaskRow[] {
  const rows = new Map(base.map((row) => [row.taskId, row]));
  for (const row of added) rows.set(row.taskId, row);
  return [...rows.values()];
}

function mergeAwaitingRows(
  base: readonly AgendaAwaitingRow[],
  added: readonly AgendaAwaitingRow[],
): readonly AgendaAwaitingRow[] {
  const rows = new Map(base.map((row) => [awaitingKey(row), row]));
  for (const row of added) rows.set(awaitingKey(row), row);
  return [...rows.values()];
}

/** 待裁行的实体 key:decision 与 execution 是两种不同的待裁对象,不共用键空间。 */
export function awaitingKey(row: AgendaAwaitingRow): string {
  return row.kind === "decision" ? `decision/${row.decisionId}` : `execution/${row.executionId}`;
}
