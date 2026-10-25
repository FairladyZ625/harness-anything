import { readDaemonRegistry, type DaemonRepoMode } from "@harness-anything/kernel";
import type { RepoCell } from "../repo-cell-types.ts";
import type { RepoCellStatus } from "../repo-cell-types.ts";
export interface HomeOverviewContext {
  readonly input: { readonly userRoot: string };
  readonly cells: ReadonlyMap<string, RepoCell>;
  readonly warming: ReadonlyMap<string, RepoCellStatus>;
  readonly unavailable: ReadonlyMap<string, RepoCellStatus>;
}
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import type { DaemonAgendaResult } from "../protocol/daemon-protocol-gui-types.ts";
import type { AgentRuntimeSessionGroupsResult } from "../agent-runtime-contract.ts";
import type { DaemonHomeOverviewResult, DaemonHomeRepoOverview, DaemonHomeMatter } from "./home-overview-types.ts";

export async function readHomeOverview(input: {
  readonly context: HomeOverviewContext;
  readonly auth: DaemonAuthenticationContext;
  readonly timeoutMs?: number;
}): Promise<DaemonHomeOverviewResult> {
  const { context, timeoutMs = 1200 } = input;
  const registry = readDaemonRegistry({ userRoot: context.input.userRoot });
  const observedAt = new Date().toISOString();
  const nowMs = Date.parse(observedAt);

  const repos: DaemonHomeRepoOverview[] = [];

  for (const repo of registry.repos) {
    if (repo.state === "disabled") {
      repos.push({
        repoId: repo.repoId,
        displayName: repo.displayName,
        canonicalRoot: repo.canonicalRoot ?? null,
        authoredBranch: repo.authoredBranch ?? null,
        registrationState: "disabled",
        connectionId: repo.connectionId,
        mode: repo.mode,
        cellState: "not_loaded",
        status: "offline",
        unavailableReason: "disabled",
        waitingCount: null,
        runningCount: null,
        deliveredCount: null,
        topMatters: [],
        isQuiet: true,
        lastActivityAt: null,
      });
      continue;
    }

    const cell = context.cells.get(repo.repoId);
    const status = cell?.status() ?? context.warming.get(repo.repoId) ?? context.unavailable.get(repo.repoId);
    const cellState =
      status?.state === "attached" ? "attached" : status?.state === "warming" ? "warming" : "unavailable";

    if (!cell || cellState !== "attached") {
      const unavailableReason = status?.lastError ?? (cellState === "warming" ? "warming up" : "cell not attached");
      repos.push({
        repoId: repo.repoId,
        displayName: repo.displayName,
        canonicalRoot: repo.canonicalRoot ?? null,
        authoredBranch: repo.authoredBranch ?? null,
        registrationState: "enabled",
        connectionId: repo.connectionId,
        mode: repo.mode,
        cellState,
        status: cellState === "warming" ? "warming" : "unavailable",
        unavailableReason,
        waitingCount: null,
        runningCount: null,
        deliveredCount: null,
        topMatters: [
          {
            key: `offline-${repo.repoId}`,
            tag: cellState === "warming" ? "预热中" : "不可达",
            text: unavailableReason,
            tone: cellState === "warming" ? "warning" : "danger",
          },
        ],
        isQuiet: false, // 离线/不可达仓库保持可见，不沉底折叠
        lastActivityAt: null,
      });
      continue;
    }

    repos.push(await readAttachedRepoOverview(cell, repo, nowMs, timeoutMs));
  }

  return {
    schema: "daemon.gui.home-overview/v1",
    ok: true,
    observedAt,
    repos,
  };
}

/** 已附着仓的聚合读;单仓失败降级为一行「异常」概览行并继续,不中断其余仓库。 */
async function readAttachedRepoOverview(
  cell: RepoCell,
  repo: {
    readonly repoId: string;
    readonly displayName: string;
    readonly canonicalRoot?: string | null;
    readonly authoredBranch?: string | null;
    readonly connectionId?: string;
    readonly mode: DaemonRepoMode;
  },
  nowMs: number,
  timeoutMs: number,
): Promise<DaemonHomeRepoOverview> {
  try {
    return await readSingleRepoOverviewWithTimeout(cell, repo, nowMs, timeoutMs);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      repoId: repo.repoId,
      displayName: repo.displayName,
      canonicalRoot: repo.canonicalRoot ?? null,
      authoredBranch: repo.authoredBranch ?? null,
      registrationState: "enabled",
      connectionId: repo.connectionId,
      mode: repo.mode,
      cellState: "unavailable",
      status: "unavailable",
      unavailableReason: `读取异常: ${errorMsg}`,
      waitingCount: null,
      runningCount: null,
      deliveredCount: null,
      topMatters: [
        {
          key: `err-${repo.repoId}`,
          tag: "异常",
          text: `读取失败: ${errorMsg}`,
          tone: "danger",
        },
      ],
      isQuiet: false,
      lastActivityAt: null,
    };
  }
}

async function readSingleRepoOverviewWithTimeout(
  cell: RepoCell,
  repo: {
    readonly repoId: string;
    readonly displayName: string;
    readonly canonicalRoot?: string | null;
    readonly authoredBranch?: string | null;
    readonly connectionId?: string;
    readonly mode: DaemonRepoMode;
  },
  nowMs: number,
  timeoutMs: number,
): Promise<DaemonHomeRepoOverview> {
  const since24hIso = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  // 三个读面都是 cell 内的内存投影读;任一失败由外层 catch 如实映射为该仓不可达,
  // 不在此吞错(吞成 null 会把故障仓静默显示为全 0,违反「断连不等于零」)。
  const fetchPromise = Promise.all([
    cell.read("repo.agenda.read", {}),
    cell.read("repo.projection.read", { name: "runtime-session-groups", facet: "groups", groupBy: "task" }),
    cell.read("repo.tasks.list", { status: "done", updatedAfter: since24hIso, limit: 100 }),
  ]);

  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });

  const results = await Promise.race([fetchPromise, timeoutPromise]);
  if (timer) clearTimeout(timer);

  if (results === null) {
    return {
      repoId: repo.repoId,
      displayName: repo.displayName,
      canonicalRoot: repo.canonicalRoot ?? null,
      authoredBranch: repo.authoredBranch ?? null,
      registrationState: "enabled",
      connectionId: repo.connectionId,
      mode: repo.mode,
      cellState: "attached",
      status: "unavailable",
      unavailableReason: `聚合读取超时 (> ${timeoutMs}ms)`,
      waitingCount: null,
      runningCount: null,
      deliveredCount: null,
      topMatters: [
        {
          key: `timeout-${repo.repoId}`,
          tag: "超时",
          text: `聚合读取超时 (> ${timeoutMs}ms)`,
          tone: "warning",
        },
      ],
      isQuiet: false,
      lastActivityAt: null,
    };
  }

  const [agendaRaw, sessionGroupsRaw, taskListRaw] = results;
  const agenda = agendaRaw as DaemonAgendaResult;
  const sessionGroupsResult = (sessionGroupsRaw as { projection?: AgentRuntimeSessionGroupsResult } | null)?.projection;
  const taskRows = (taskListRaw as { rows?: readonly any[] } | null)?.rows ?? [];

  // 1. 等你处理 (waitingCount)
  // 口径同「今天」页: awaitingYou (本人待办) + awaitingRework (打回重做) + awaitingAdjudication (待签发) + underReview (等consent)
  const awaitingYouList = agenda?.awaitingYou ?? [];
  const awaitingReworkList = agenda?.awaitingRework ?? [];
  const awaitingAdjudicationList = agenda?.awaitingAdjudication ?? [];
  const underReviewList = agenda?.underReview ?? [];

  const waitingCount =
    awaitingYouList.length + awaitingReworkList.length + awaitingAdjudicationList.length + underReviewList.length;

  // 2. 正在跑 (runningCount)
  const sessionGroups = sessionGroupsResult?.groups ?? [];
  const runningGroups = sessionGroups.filter((g) => (g.runningCount ?? 0) > 0);
  const runningCount = runningGroups.reduce((acc, g) => acc + (g.runningCount ?? 0), 0);

  // 3. 刚交付 (deliveredCount): 24h 内完成(服务端已按 status=done + updatedAfter 窄化;
  //    行序是 task_id 序,最近一条按 updatedAt 自取最大)。
  const deliveredCount = taskRows.length;
  const recentDelivered = taskRows.reduce<{ readonly row: any; readonly ts: number } | null>((best, row) => {
    const ts = row.updatedAt ? Date.parse(row.updatedAt) : 0;
    return ts > (best?.ts ?? 0) ? { row, ts } : best;
  }, null);

  // 4. 最要紧的 1~3 件事 (topMatters)
  const matters: DaemonHomeMatter[] = [];

  // 4.1 等你处理的事 (Priority 1, 最多 2 条)
  for (const awaitRow of awaitingYouList) {
    if (matters.length >= 2) break;
    const text = awaitRow.question ? `${awaitRow.title} · ${awaitRow.question}` : `${awaitRow.title} 等待你的答复`;
    const taskId = awaitRow.sourceRef?.startsWith("task/") ? awaitRow.sourceRef.replace(/^task\//, "") : undefined;
    matters.push({
      key: `await-${awaitRow.relationId}`,
      tag: "等你",
      text,
      tone: "danger",
      ref: awaitRow.sourceRef,
      taskId,
    });
  }
  for (const rework of awaitingReworkList) {
    if (matters.length >= 2) break;
    matters.push({
      key: `rework-${rework.taskId}`,
      tag: "重做",
      text: `${rework.title} · 评审打回等待修复`,
      tone: "danger",
      taskId: rework.taskId,
    });
  }
  // waitingCount 计的四个桶都要能以事项露面:待签发与评审中同样等业主动作,
  // 否则出现「等你 11 却暂无要紧事项」的口径断层。
  for (const adjudication of awaitingAdjudicationList) {
    if (matters.length >= 3) break;
    matters.push({
      key: `adjudicate-${adjudication.taskId}`,
      tag: "待签发",
      text: `${adjudication.title} · 历史提交切面待处理`,
      tone: "danger",
      taskId: adjudication.taskId,
    });
  }
  for (const review of underReviewList) {
    if (matters.length >= 3) break;
    matters.push({
      key: `review-${review.taskId}`,
      tag: "评审中",
      text: `${review.title} · 评审通过待你同意`,
      tone: "warning",
      taskId: review.taskId,
    });
  }

  // 4.2 卡住或正在跑的会话 (Priority 2 & 3)
  for (const group of runningGroups) {
    if (matters.length >= 3) break;
    const lastActivityMs = group.latestActivityAt ? Date.parse(group.latestActivityAt) : 0;
    const isStalled = group.latestStatus === "running" && lastActivityMs > 0 && nowMs - lastActivityMs > 5 * 60 * 1000;
    const isFailedOrBlocked =
      group.latestStatus === "blocked" || group.latestStatus === "failed" || group.latestStatus === "lost" || isStalled;

    if (isFailedOrBlocked) {
      matters.push({
        key: `group-stalled-${group.key}`,
        tag: "卡住",
        text: `${group.label} · 运行停滞或异常`,
        tone: "warning",
        taskId: group.taskId,
      });
    } else {
      const agentName = group.latestRound?.agentName ?? "Agent";
      matters.push({
        key: `group-running-${group.key}`,
        tag: "在跑",
        text: `${group.label} · ${agentName} 正在执行`,
        tone: "active",
        taskId: group.taskId,
      });
    }
  }

  // 4.3 补充最近交付项 (Priority 4, 若不足 3 条)
  if (matters.length < 3 && recentDelivered !== null) {
    const title = recentDelivered.row.snapshot?.task?.title || recentDelivered.row.taskId;
    matters.push({
      key: `delivered-${recentDelivered.row.taskId}`,
      tag: "刚交付",
      text: `${title} 已完成交付`,
      tone: "done",
      taskId: recentDelivered.row.taskId,
    });
  }

  // 4.4 若仍然没有任何事项
  if (matters.length === 0) {
    if (waitingCount === 0 && runningCount === 0 && deliveredCount === 0) {
      matters.push({
        key: `ready-${repo.repoId}`,
        tag: "就绪",
        text: "全部就绪无待办",
        tone: "neutral",
      });
    }
  }

  // 5. 最新活动时间
  let lastActivityAt: string | null = null;
  const candidateDates: number[] = [];
  for (const group of runningGroups) {
    if (group.latestActivityAt) candidateDates.push(Date.parse(group.latestActivityAt));
  }
  if (recentDelivered !== null) candidateDates.push(recentDelivered.ts);
  if (candidateDates.length > 0) {
    const maxTs = Math.max(...candidateDates.filter((d) => !Number.isNaN(d)));
    if (maxTs > 0) {
      lastActivityAt = new Date(maxTs).toISOString();
    }
  }

  // 6. 是否静止仓库 (isQuiet)
  const isQuiet =
    waitingCount === 0 &&
    runningCount === 0 &&
    deliveredCount === 0 &&
    (!lastActivityAt || nowMs - Date.parse(lastActivityAt) > 24 * 60 * 60 * 1000);

  return {
    repoId: repo.repoId,
    displayName: repo.displayName,
    canonicalRoot: repo.canonicalRoot ?? null,
    authoredBranch: repo.authoredBranch ?? null,
    registrationState: "enabled",
    connectionId: repo.connectionId,
    mode: repo.mode,
    cellState: "attached",
    status: "online",
    unavailableReason: null,
    waitingCount,
    runningCount,
    deliveredCount,
    topMatters: matters.slice(0, 3),
    isQuiet,
    lastActivityAt,
  };
}
