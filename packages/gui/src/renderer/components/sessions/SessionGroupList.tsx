import { memo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AgentRuntimeUnattributedGroupKey } from "@harness-anything/daemon/protocol";
import { agentRuntimeSearchMatches } from "@harness-anything/daemon/protocol";
import {
  relativeTime,
  sessionStatusKey,
  sessionUnattributedKey,
  shortRef,
  type SessionGroup,
  type SessionOrphan,
  type SessionRound,
  type SessionStatus,
} from "../../sessions-model.ts";
import { t } from "../../i18n/index.tsx";
import { formatTime } from "../../model/time.ts";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { DENSE_ROW_RELAXED_PX, DenseRow } from "../primitives/DenseRow.tsx";
import { CompletedDivider } from "../primitives/CompletedDivider.tsx";
import { StatusTag, type StatusTone } from "../primitives/StatusTag.tsx";
import type { DecisionReviewRound } from "../../model/decision-review.ts";
import { decisionReviewRef, decisionSessionsRef } from "../../navigation/decisionReviewRoutes.ts";
import { dispatchStatusText, VerdictBadge } from "../decisionReview/parts.tsx";

/**
 * 单会话段的组列表(设计稿 §3/§7.1;标准 §2.5 v2):左列目录,组头两行——标题一行,
 * 执行者·轮数·最新活动一行弱色;组内行整组渲染不分批,已完成沉到「已完成 N」分隔线
 * 之后照常显示——单组轮数典型 ≤30。数据由页级持有并传入:组头来自
 * sessionGroups,展开任务组的轮次来自 task.dispatches,「无派工记录」小节来自
 * overview { taskId } 的绑定会话。检索词在展示层对轮次行做同口径过滤(daemon 已对
 * 组成员过滤,这里复用同一匹配函数让轮次行与命中口径一致)。
 */
export type SessionGroupRows = {
  readonly rounds: readonly SessionRound[];
  readonly orphans: readonly SessionOrphan[];
  readonly pending: boolean;
  readonly error: string | null;
};
/** Decision 评审组的展开行:来自 Decision full 行的 reviewDispatches;null = 读面不含该 Decision。 */
export type DecisionGroupRows = {
  readonly title: string | null;
  readonly rounds: readonly DecisionReviewRound[] | null;
  readonly pending: boolean;
  readonly error: string | null;
};

const NO_DECISION_ROWS: ReadonlyMap<string, DecisionGroupRows> = new Map();
/** 折叠组头为宽松两行 DenseRow + 1px 边框;展开组行高由 measureElement 实测收敛。 */
export const GROUP_HEADER_ESTIMATE_PX = DENSE_ROW_RELAXED_PX + 1;
export const GROUP_OVERSCAN = 10;
/** 无布局环境(静态渲染/happy-dom)的视口兜底:ResizeObserver 上报前按 800px 高出首屏。 */
const GROUP_INITIAL_RECT = { width: 400, height: 800 } as const;

export function SessionGroupList({
  groups,
  pending = false,
  truncated,
  expandedKeys,
  rowsByGroup,
  decisionRowsByGroup = NO_DECISION_ROWS,
  selectedId,
  query,
  decisionRefsFor,
  onSelectSession,
  onToggleGroup,
  onOpenTask,
  onSelectEntity,
}: {
  readonly groups: readonly SessionGroup[];
  readonly pending?: boolean;
  readonly truncated: boolean;
  readonly expandedKeys: ReadonlySet<string>;
  readonly rowsByGroup: ReadonlyMap<string, SessionGroupRows>;
  readonly decisionRowsByGroup?: ReadonlyMap<string, DecisionGroupRows>;
  readonly selectedId: string | null;
  readonly query: string;
  readonly decisionRefsFor: (taskId: string) => readonly string[];
  readonly onSelectSession: (runtimeSessionId: string) => void;
  readonly onToggleGroup: (key: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onSelectEntity: (ref: string) => void;
}) {
  const scrollRef = useRef<HTMLElement | null>(null);
  // 列内 windowing(与看板列同构):DOM 组数 = 视口内 + 两侧 overscan,不随组总数
  // 线性增长(harness 仓 858+ 组全挂载是每 2s 轮询整列表重渲的载体)。组 key 稳定,
  // 轮询刷新时未变组由 memo(GroupSection) 跳过重渲染。
  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GROUP_HEADER_ESTIMATE_PX,
    overscan: GROUP_OVERSCAN,
    getItemKey: (index) => groups[index]!.key,
    initialRect: GROUP_INITIAL_RECT,
  });
  return (
    <nav
      ref={scrollRef}
      data-testid="sessions-group-list"
      aria-label={t("agentRuntime.segSessions")}
      className="flex w-[26%] min-w-[320px] max-w-[440px] shrink-0 flex-col overflow-y-auto border-r border-border"
    >
      {groups.length === 0 ? (
        <p className="px-3.5 py-3 ui-meta text-text-faint">
          {t(
            pending
              ? "agentRuntime.loading"
              : query === ""
                ? "agentRuntime.noSessions"
                : "agentRuntime.sessionsNoMatches",
          )}
        </p>
      ) : (
        // spacer 带 shrink-0:nav 是 flex 列也是滚动容器,spacer 作为 flex item 会被默认的
        // flex-shrink 压回视口高,滚动范围就只剩首屏(实测 scrollHeight 被压到 2031px)。
        <div className="relative shrink-0" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <GroupSection
                group={groups[item.index]!}
                rows={rowsByGroup.get(groups[item.index]!.key)}
                decisionRows={decisionRowsByGroup.get(groups[item.index]!.key)}
                expanded={expandedKeys.has(groups[item.index]!.key)}
                selectedId={selectedId}
                query={query}
                decisionRefsFor={decisionRefsFor}
                onSelectSession={onSelectSession}
                onToggleGroup={onToggleGroup}
                onOpenTask={onOpenTask}
                onSelectEntity={onSelectEntity}
              />
            </div>
          ))}
        </div>
      )}
      {truncated && (
        <p
          data-testid="sessions-groups-truncated"
          className="border-t border-border px-3.5 py-2.5 ui-meta text-text-faint"
        >
          {t("agentRuntime.sessionsGroupsTruncated", { count: groups.length })}
        </p>
      )}
    </nav>
  );
}

/** 行级 memo(与看板 Card 同构):比较键是组对象引用 + 标量 props。台账 cut 扇出
 * 每 ~2s 失效一次 sessionGroups,react-query 结构共享让内容未变的组保持同一引用,
 * 回调由页级 useCallback 稳定——「数据刷新但组没变」时挂载中的组行不再重渲染。 */
const GroupSection = memo(function GroupSection({
  group,
  rows,
  decisionRows,
  expanded,
  selectedId,
  query,
  decisionRefsFor,
  onSelectSession,
  onToggleGroup,
  onOpenTask,
  onSelectEntity,
}: {
  readonly group: SessionGroup;
  readonly rows: SessionGroupRows | undefined;
  readonly decisionRows: DecisionGroupRows | undefined;
  readonly expanded: boolean;
  readonly selectedId: string | null;
  readonly query: string;
  readonly decisionRefsFor: (taskId: string) => readonly string[];
  readonly onSelectSession: (runtimeSessionId: string) => void;
  readonly onToggleGroup: (key: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onSelectEntity: (ref: string) => void;
}) {
  const decisionGroup = group.kind === "decision",
    expandable = group.kind === "task" || decisionGroup,
    open = expanded && expandable,
    decisions = expandable && group.taskId ? decisionRefsFor(group.taskId) : [],
    // 检索命中时轮次行按同一词表过滤;无检索词时整组渲染。
    terms = query.trim() === "" ? [] : query.trim().toLocaleLowerCase().split(/\s+/u),
    visibleRounds = (rows?.rounds ?? []).filter((row) => roundMatchesQuery(row, terms)),
    visibleOrphans = (rows?.orphans ?? []).filter((row) =>
      agentRuntimeSearchMatches([row.runtimeSessionId, row.instanceId, row.taskId, row.taskTitle, row.status], terms),
    );
  // 展开是 Task 组的能力(一次 task.dispatches 拿全部轮次,设计稿 §6.5 预算);
  // Squad/Agent/时间组没有单次往返的成员读面,头部按静态行呈现,不提供假展开。
  // 两行:标题一行;执行者·轮数·最新活动一行弱色。任务短码只进详情,不进行。
  const headerBody = (
    <DenseRow
      index={expandable ? (open ? "▾" : "▸") : undefined}
      tag={<SessionStatusTag status={group.latestStatus} />}
      title={
        group.kind === "unattributed"
          ? t(sessionUnattributedKey[group.key as AgentRuntimeUnattributedGroupKey] as never)
          : (decisionRows?.title ?? group.label)
      }
      reason={[
        group.latestRound?.agentName,
        t("agentRuntime.sessionsRoundCount", { count: group.roundCount }),
        group.sessionCount > group.roundCount
          ? t("agentRuntime.sessionsSessionCount", { count: group.sessionCount })
          : undefined,
        relativeTime(group.latestActivityAt),
      ]
        .filter(Boolean)
        .join(" · ")}
      relaxed
    />
  );
  return (
    <section data-testid={`session-group-${group.key}`} className={open ? "pb-5" : undefined}>
      {expandable ? (
        <button
          type="button"
          data-testid={`session-group-toggle-${group.key}`}
          aria-expanded={open}
          onClick={() => onToggleGroup(group.key)}
          className="w-full text-left hover:bg-surface-raised"
        >
          {headerBody}
        </button>
      ) : (
        <div className="cursor-default">{headerBody}</div>
      )}
      {open && decisionGroup && group.decisionId && (
        <DecisionGroupBody
          decisionId={group.decisionId}
          rows={decisionRows}
          selectedId={selectedId}
          onSelectEntity={onSelectEntity}
        />
      )}
      {open && !decisionGroup && (
        <div className="cv-auto-10r pl-3">
          {rows === undefined && <p className="px-3.5 py-2 ui-meta text-text-faint">{t("agentRuntime.loading")}</p>}
          {rows?.pending && <p className="px-3.5 py-2 ui-meta text-text-faint">{t("agentRuntime.loading")}</p>}
          {rows?.error && (
            <p role="alert" className="px-3.5 py-2 font-mono ui-meta text-status-blocked">
              {t("agentRuntime.readFailed", { error: rows.error })}
            </p>
          )}
          {visibleRounds
            .filter((row) => !isCompleted(row.status))
            .map((row) => (
              <RoundRow
                key={row.dispatchId}
                row={row}
                selected={selectedId === row.runtimeSessionId}
                onSelectSession={onSelectSession}
              />
            ))}
          {visibleOrphans
            .filter((row) => !isCompleted(row.status))
            .map((row) => (
              <OrphanRow
                key={row.runtimeSessionId}
                row={row}
                selected={selectedId === row.runtimeSessionId}
                onSelectSession={onSelectSession}
              />
            ))}
          {[...visibleRounds, ...visibleOrphans].some((row) => isCompleted(row.status)) && (
            <>
              <CompletedCount
                count={[...visibleRounds, ...visibleOrphans].filter((row) => isCompleted(row.status)).length}
              />
              {visibleRounds
                .filter((row) => isCompleted(row.status))
                .map((row) => (
                  <RoundRow
                    key={row.dispatchId}
                    row={row}
                    selected={selectedId === row.runtimeSessionId}
                    onSelectSession={onSelectSession}
                  />
                ))}
              {visibleOrphans
                .filter((row) => isCompleted(row.status))
                .map((row) => (
                  <OrphanRow
                    key={row.runtimeSessionId}
                    row={row}
                    selected={selectedId === row.runtimeSessionId}
                    onSelectSession={onSelectSession}
                  />
                ))}
            </>
          )}
          {group.taskId && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 px-2">
              <EntityRefLink
                entityRef={`task/${group.taskId}`}
                onNavigate={(ref) => onOpenTask(ref.slice("task/".length))}
                title={t("agentRuntime.openTask")}
                className={
                  "rounded border border-border px-2 py-0.5 ui-meta text-text-muted " +
                  "hover:border-accent hover:text-accent"
                }
              >
                {t("agentRuntime.sessionsTaskDetail")} ↗
              </EntityRefLink>
              {decisions.map((decisionRef) => (
                <EntityRefLink
                  key={decisionRef}
                  entityRef={decisionRef}
                  onNavigate={onSelectEntity}
                  title={decisionRef}
                  className={
                    "rounded border border-border px-2 py-0.5 font-mono ui-meta text-text-muted " +
                    "hover:border-accent hover:text-accent"
                  }
                >
                  {t("agentRuntime.sessionsTaskDecision", {
                    ref: shortRef(decisionRef.split("/")[1] ?? decisionRef, 12),
                  })}{" "}
                  ↗
                </EntityRefLink>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
});

/** 检索词对轮次行的展示过滤:与 daemon 组成员过滤同一匹配函数、同一字段表
 * (agent-runtime-session-groups.ts 的 commonSearch)——检索词为会话 id 时 daemon
 * 命中该组,轮次行也必须可见,否则组展开为空、续跑按钮不可达。 */
function roundMatchesQuery(row: SessionRound, terms: readonly string[]): boolean {
  return agentRuntimeSearchMatches(
    [
      row.runtimeSessionId,
      row.instanceId,
      row.dispatchId,
      row.agentId,
      row.agentName,
      row.squadId,
      row.status,
      row.taskId,
      row.taskTitle,
    ],
    terms,
  );
}

function RoundRow({
  row,
  selected,
  onSelectSession,
}: {
  readonly row: SessionRound;
  readonly selected: boolean;
  readonly onSelectSession: (runtimeSessionId: string) => void;
}) {
  return (
    <button
      type="button"
      className="w-full text-left hover:bg-text/5"
      data-testid={`rail-session-${row.runtimeSessionId}`}
      aria-current={selected}
      onClick={() => onSelectSession(row.runtimeSessionId)}
    >
      <DenseRow
        tag={
          <span data-testid={`runtime-outcome-${row.runtimeSessionId}`}>
            <SessionStatusTag status={row.status} />
          </span>
        }
        title={row.agentName ?? row.instanceId}
        reason={
          <span data-testid={`runtime-classification-${row.runtimeSessionId}`}>
            {[
              t("agentRuntime.sessionsRoundIndex", { index: row.roundIndex }),
              row.classification,
              row.nextAction,
              row.delegation,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        }
        time={formatTime(row.startedAt, { style: "time" }) ?? row.startedAt}
        relaxed
        selected={selected}
      />
    </button>
  );
}

function OrphanRow({
  row,
  selected,
  onSelectSession,
}: {
  readonly row: SessionOrphan;
  readonly selected: boolean;
  readonly onSelectSession: (runtimeSessionId: string) => void;
}) {
  return (
    <button
      type="button"
      className="w-full text-left hover:bg-text/5"
      data-testid={`rail-session-${row.runtimeSessionId}`}
      aria-current={selected}
      onClick={() => onSelectSession(row.runtimeSessionId)}
    >
      <DenseRow
        tag={<SessionStatusTag status={row.status} />}
        title={row.instanceId}
        reason={t("agentRuntime.sessionsNoDispatch", { count: 1 })}
        time={formatTime(row.startedAt, { style: "time" }) ?? row.startedAt}
        relaxed
        selected={selected}
      />
    </button>
  );
}

/** 已完成分隔线(标准 §1.4):终态沉底、照常显示,不收进「展开」。 */
function CompletedCount({ count }: { readonly count: number }) {
  return <CompletedDivider>{t("agentRuntime.sessionsCompleted", { count })}</CompletedDivider>;
}

const isCompleted = (status: SessionStatus) => status === "succeeded" || status === "cancelled";
const statusTones: Record<SessionStatus, StatusTone> = {
  running: "active",
  succeeded: "done",
  cancelled: "cancel",
  failed: "bad",
  lost: "bad",
  unknown: "neutral",
  "ended-indeterminate": "neutral",
  unavailable: "neutral",
};
function SessionStatusTag({ status }: { readonly status: SessionStatus }) {
  return <StatusTag tone={statusTones[status]} label={t(sessionStatusKey[status] as never)} />;
}

/** Decision 评审组展开体:每轮一个评审派工,点击精确选中该会话;组尾回到被评审 Decision。 */
function DecisionGroupBody({
  decisionId,
  rows,
  selectedId,
  onSelectEntity,
}: {
  readonly decisionId: string;
  readonly rows: DecisionGroupRows | undefined;
  readonly selectedId: string | null;
  readonly onSelectEntity: (ref: string) => void;
}) {
  const completed = rows?.rounds?.filter((round) => round.dispatch.status === "succeeded") ?? [];
  const renderRound = (round: DecisionReviewRound) => (
    <button
      type="button"
      className="w-full text-left hover:bg-text/5"
      onClick={() => onSelectEntity(decisionSessionsRef(decisionId, round.dispatch.runtimeSessionId))}
      key={round.dispatch.dispatchId}
      data-testid={`rail-session-${round.dispatch.runtimeSessionId}`}
      aria-current={selectedId === round.dispatch.runtimeSessionId}
    >
      <DenseRow
        tag={<SessionStatusTag status={round.dispatch.status} />}
        title={shortRef(round.dispatch.runtimeSessionId, 18)}
        reason={
          round.review ? <VerdictBadge verdict={round.review.verdict} /> : dispatchStatusText(round.dispatch.status)
        }
        relaxed
        selected={selectedId === round.dispatch.runtimeSessionId}
      />
    </button>
  );
  return (
    <div className="cv-auto-10r pl-3">
      {(rows === undefined || rows.pending) && (
        <p className="px-3.5 py-2 ui-meta text-text-faint">{t("agentRuntime.loading")}</p>
      )}
      {rows?.error && (
        <p role="alert" className="px-3.5 py-2 font-mono ui-meta text-status-blocked">
          {t("agentRuntime.readFailed", { error: rows.error })}
        </p>
      )}
      {rows && !rows.pending && !rows.error && rows.rounds === null && (
        <p className="px-3.5 py-2 ui-meta text-text-faint">{t("agentRuntime.sessionsDecisionRowsUnavailable")}</p>
      )}
      {rows?.rounds?.filter((round) => round.dispatch.status !== "succeeded").map(renderRound)}
      {completed.length > 0 && (
        <>
          <CompletedCount count={completed.length} />
          {completed.map(renderRound)}
        </>
      )}
      <div className="mt-2 px-2">
        <EntityRefLink
          entityRef={decisionReviewRef(decisionId, "review")}
          onNavigate={onSelectEntity}
          title={decisionId}
          className="rounded border border-border px-2 py-0.5 ui-meta text-text-muted hover:border-accent hover:text-accent"
        >
          {t("agentRuntime.sessionsDecisionDetail")} ↗
        </EntityRefLink>
      </div>
    </div>
  );
}
