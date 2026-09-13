import { memo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AgentRuntimeUnattributedGroupKey } from "../../../../../daemon/src/agent-runtime-contract.ts";
import {
  relativeTime,
  sessionStatusDot,
  sessionStatusKey,
  sessionStatusTone,
  sessionUnattributedKey,
  shortRef,
  type SessionGroup,
  type SessionOrphan,
  type SessionRound,
} from "../../sessions-model.ts";
import { t } from "../../i18n/index.tsx";
import { formatTime } from "../../model/time.ts";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { KindDot, LiveDot } from "../runtime/parts.tsx";

/**
 * 单会话段的组列表(设计稿 §3/§7.1):组头一行(标题/短码、最新状态、轮数、最新
 * 活动),组内行整组渲染不分批——单组轮数典型 ≤30。数据由页级持有并传入:组头来自
 * sessionGroups,展开任务组的轮次来自 task.dispatches,「无派工记录」小节来自
 * overview { taskId } 的绑定会话。检索词在展示层对轮次行做同口径过滤(daemon 已对
 * 组成员过滤,这里让轮次行与命中口径一致)。
 */
export type SessionGroupRows = {
  readonly rounds: readonly SessionRound[];
  readonly orphans: readonly SessionOrphan[];
  readonly pending: boolean;
  readonly error: string | null;
};

/** 折叠组头的估算高度(两行文本 + padding);展开组行高由 measureElement 实测收敛。 */
export const GROUP_HEADER_ESTIMATE_PX = 56;
export const GROUP_OVERSCAN = 10;
/** 无布局环境(静态渲染/happy-dom)的视口兜底:ResizeObserver 上报前按 800px 高出首屏。 */
const GROUP_INITIAL_RECT = { width: 400, height: 800 } as const;

export function SessionGroupList({
  groups,
  truncated,
  expandedKeys,
  rowsByGroup,
  selectedId,
  query,
  decisionRefsFor,
  onSelectSession,
  onToggleGroup,
  onOpenTask,
  onSelectEntity,
}: {
  readonly groups: readonly SessionGroup[];
  readonly truncated: boolean;
  readonly expandedKeys: ReadonlySet<string>;
  readonly rowsByGroup: ReadonlyMap<string, SessionGroupRows>;
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
      className="flex basis-1/4 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface"
    >
      {groups.length === 0 ? (
        <p className="px-3 py-3 ui-micro text-text-faint">
          {t(query === "" ? "agentRuntime.noSessions" : "agentRuntime.sessionsNoMatches")}
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
          className="border-t border-border px-3 py-2 ui-micro text-text-faint"
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
  readonly expanded: boolean;
  readonly selectedId: string | null;
  readonly query: string;
  readonly decisionRefsFor: (taskId: string) => readonly string[];
  readonly onSelectSession: (runtimeSessionId: string) => void;
  readonly onToggleGroup: (key: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onSelectEntity: (ref: string) => void;
}) {
  const expandable = group.kind === "task",
    open = expanded && expandable,
    decisions = expandable && group.taskId ? decisionRefsFor(group.taskId) : [],
    // 检索命中时轮次行按同一词表过滤;无检索词时整组渲染。
    terms = query.trim() === "" ? [] : query.trim().toLocaleLowerCase().split(/\s+/u),
    visibleRounds = (rows?.rounds ?? []).filter((row) => roundMatchesQuery(row, terms)),
    visibleOrphans = (rows?.orphans ?? []).filter(
      (row) =>
        terms.length === 0 ||
        terms.every((term) =>
          [row.runtimeSessionId, row.instanceId, row.taskId, row.taskTitle, row.status]
            .filter((value): value is string => typeof value === "string")
            .join("\n")
            .toLocaleLowerCase()
            .includes(term),
        ),
    );
  // 展开是 Task 组的能力(一次 task.dispatches 拿全部轮次,设计稿 §6.5 预算);
  // Squad/Agent/时间组没有单次往返的成员读面,头部按静态行呈现,不提供假展开。
  const headerBody = (
    <span className="flex w-full flex-col gap-0.5 px-2.5 pt-2 pb-1.5 text-left">
      <span className="flex min-w-0 items-center gap-1.5">
        {expandable && (
          <span
            aria-hidden
            className={`shrink-0 ui-micro text-text-faint transition-transform ${open ? "rotate-90" : ""}`}
          >
            ▶
          </span>
        )}
        <LiveDot state={sessionStatusDot[group.latestStatus]} tip={t(sessionStatusKey[group.latestStatus] as never)} />
        <b className="min-w-0 flex-1 truncate ui-meta">
          {group.kind === "unattributed"
            ? t(sessionUnattributedKey[group.key as AgentRuntimeUnattributedGroupKey] as never)
            : group.label}
        </b>
        {expandable && group.taskId && (
          <span className="shrink-0 font-mono ui-micro text-text-faint">{shortRef(group.taskId, 11)}</span>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-[15px] ui-micro text-text-muted">
        <span className={sessionStatusTone[group.latestStatus]}>
          {t(sessionStatusKey[group.latestStatus] as never)}
        </span>
        {expandable && (
          <>
            <span>· {t("agentRuntime.sessionsRoundCount", { count: group.roundCount })}</span>
            {group.sessionCount > group.roundCount && (
              <span>· {t("agentRuntime.sessionsSessionCount", { count: group.sessionCount })}</span>
            )}
          </>
        )}
        {group.latestRound?.agentName && <span className="truncate">· {group.latestRound.agentName}</span>}
        <span className="ml-auto shrink-0 font-mono ui-micro text-text-faint">
          {relativeTime(group.latestActivityAt)}
        </span>
      </span>
    </span>
  );
  return (
    <section data-testid={`session-group-${group.key}`} className="border-b border-border">
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
      {open && (
        <div className="cv-auto-10r px-1.5 pb-2">
          {rows === undefined && <p className="px-1.5 py-1 ui-micro text-text-faint">{t("agentRuntime.loading")}</p>}
          {rows?.pending && <p className="px-1.5 py-1 ui-micro text-text-faint">{t("agentRuntime.loading")}</p>}
          {rows?.error && (
            <p role="alert" className="px-1.5 py-1 font-mono ui-micro text-status-blocked">
              {t("agentRuntime.readFailed", { error: rows.error })}
            </p>
          )}
          {visibleRounds.map((row) => (
            <RoundRow
              key={row.dispatchId}
              row={row}
              selected={selectedId === row.runtimeSessionId}
              onSelectSession={onSelectSession}
            />
          ))}
          {visibleOrphans.length > 0 && (
            <p className="mt-1 px-1.5 font-mono ui-micro uppercase tracking-[0.06em] text-text-faint">
              {t("agentRuntime.sessionsNoDispatch", { count: visibleOrphans.length })}
            </p>
          )}
          {visibleOrphans.map((row) => (
            <OrphanRow
              key={row.runtimeSessionId}
              row={row}
              selected={selectedId === row.runtimeSessionId}
              onSelectSession={onSelectSession}
            />
          ))}
          {group.taskId && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 px-1.5">
              <EntityRefLink
                entityRef={`task/${group.taskId}`}
                onNavigate={(ref) => onOpenTask(ref.slice("task/".length))}
                title={t("agentRuntime.openTask")}
                className={
                  "rounded border border-border px-1.5 py-0.5 ui-micro text-text-muted " +
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
                    "rounded border border-border px-1.5 py-0.5 font-mono ui-micro text-text-muted " +
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

/** 检索词对轮次行的展示过滤:与 daemon 组成员过滤同口径(多检索词 AND、子串)。 */
function roundMatchesQuery(row: SessionRound, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = [row.dispatchId, row.agentId, row.agentName, row.instanceId, row.status, row.taskId, row.taskTitle]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
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
      data-testid={`rail-session-${row.runtimeSessionId}`}
      aria-current={selected}
      onClick={() => onSelectSession(row.runtimeSessionId)}
      className={`cv-auto-2r flex w-full items-center gap-2 rounded border px-2 py-1 text-left ${
        selected ? "border-accent/40 bg-accent/[0.14]" : "border-transparent hover:bg-surface-raised"
      }`}
    >
      <span className="shrink-0 font-mono ui-micro text-text-faint">
        {t("agentRuntime.sessionsRoundIndex", { index: row.roundIndex })}
      </span>
      <LiveDot state={sessionStatusDot[row.status]} tip={t(sessionStatusKey[row.status] as never)} />
      <span className="min-w-0 flex-1 truncate ui-micro">
        {row.agentName ?? row.instanceId}
        <span className="ml-1.5 font-mono ui-micro text-text-faint">{shortRef(row.instanceId, 14)}</span>
        {row.delegation && <span className="ml-1.5 ui-micro text-text-muted">{row.delegation}</span>}
      </span>
      <span className="shrink-0 font-mono ui-micro text-text-faint">
        {formatTime(row.startedAt, { style: "time" }) ?? row.startedAt}
      </span>
      <span className="shrink-0 font-mono ui-micro text-text-faint">{shortRef(row.dispatchId, 14)}</span>
      <span
        data-testid={`runtime-outcome-${row.runtimeSessionId}`}
        className={`shrink-0 font-mono ui-micro ${sessionStatusTone[row.status]}`}
      >
        {t(sessionStatusKey[row.status] as never)}
      </span>
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
      data-testid={`rail-session-${row.runtimeSessionId}`}
      aria-current={selected}
      onClick={() => onSelectSession(row.runtimeSessionId)}
      className={`cv-auto-2r flex w-full items-center gap-2 rounded border px-2 py-1 text-left ${
        selected ? "border-accent/40 bg-accent/[0.14]" : "border-transparent hover:bg-surface-raised"
      }`}
    >
      <KindDot kind="any" />
      <span className="min-w-0 flex-1 truncate ui-micro">
        {row.instanceId}
        <span className="ml-1.5 font-mono ui-micro text-text-faint">{t("agentRuntime.sessionsNoDispatchTag")}</span>
      </span>
      <span className="shrink-0 font-mono ui-micro text-text-faint">
        {formatTime(row.startedAt, { style: "time" }) ?? row.startedAt}
      </span>
      <span className={`shrink-0 font-mono ui-micro ${sessionStatusTone[row.status]}`}>
        {t(sessionStatusKey[row.status] as never)}
      </span>
    </button>
  );
}
