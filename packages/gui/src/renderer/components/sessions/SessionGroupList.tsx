import {
  relativeTime,
  sessionStatusDot,
  sessionStatusKey,
  sessionStatusTone,
  shortRef,
  type SessionGroup,
  type SessionOrphan,
  type SessionRound,
} from "../../sessions-model.ts";
import { t } from "../../i18n/index.tsx";
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
  return (
    <nav
      data-testid="sessions-group-list"
      aria-label={t("agentRuntime.segSessions")}
      className="flex w-[380px] shrink-0 flex-col overflow-y-auto border-r border-border bg-surface"
    >
      {groups.length === 0 ? (
        <p className="px-3 py-3 text-[11px] text-text-faint">
          {t(query === "" ? "agentRuntime.noSessions" : "agentRuntime.sessionsNoMatches")}
        </p>
      ) : (
        groups.map((group) => (
          <GroupSection
            key={group.key}
            group={group}
            rows={rowsByGroup.get(group.key)}
            expanded={expandedKeys.has(group.key)}
            selectedId={selectedId}
            query={query}
            decisionRefsFor={decisionRefsFor}
            onSelectSession={onSelectSession}
            onToggleGroup={onToggleGroup}
            onOpenTask={onOpenTask}
            onSelectEntity={onSelectEntity}
          />
        ))
      )}
      {truncated && (
        <p
          data-testid="sessions-groups-truncated"
          className="border-t border-border px-3 py-2 text-[10.5px] text-text-faint"
        >
          {t("agentRuntime.sessionsGroupsTruncated", { count: groups.length })}
        </p>
      )}
    </nav>
  );
}

function GroupSection({
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
            className={`shrink-0 text-[7px] text-text-faint transition-transform ${open ? "rotate-90" : ""}`}
          >
            ▶
          </span>
        )}
        <LiveDot state={sessionStatusDot[group.latestStatus]} tip={t(sessionStatusKey[group.latestStatus] as never)} />
        <b className="min-w-0 flex-1 truncate text-[12px]">
          {group.kind === "unattributed" ? t("agentRuntime.unattributed") : group.label}
        </b>
        {expandable && group.taskId && (
          <span className="shrink-0 font-mono text-[9.5px] text-text-faint">{shortRef(group.taskId, 11)}</span>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-[15px] text-[10.5px] text-text-muted">
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
        <span className="ml-auto shrink-0 font-mono text-[9.5px] text-text-faint">
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
          {rows === undefined && (
            <p className="px-1.5 py-1 text-[10.5px] text-text-faint">{t("agentRuntime.loading")}</p>
          )}
          {rows?.pending && <p className="px-1.5 py-1 text-[10.5px] text-text-faint">{t("agentRuntime.loading")}</p>}
          {rows?.error && (
            <p role="alert" className="px-1.5 py-1 font-mono text-[10px] text-status-blocked">
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
            <p className="mt-1 px-1.5 font-mono text-[9.5px] uppercase tracking-[0.06em] text-text-faint">
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
                  "rounded border border-border px-1.5 py-0.5 text-[10.5px] text-text-muted " +
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
                    "rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-muted " +
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
}

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
      <span className="shrink-0 font-mono text-[9px] text-text-faint">
        {t("agentRuntime.sessionsRoundIndex", { index: row.roundIndex })}
      </span>
      <LiveDot state={sessionStatusDot[row.status]} tip={t(sessionStatusKey[row.status] as never)} />
      <span className="min-w-0 flex-1 truncate text-[11.5px]">
        {row.agentName ?? row.instanceId}
        <span className="ml-1.5 font-mono text-[9.5px] text-text-faint">{shortRef(row.instanceId, 14)}</span>
        {row.delegation && <span className="ml-1.5 text-[10px] text-text-muted">{row.delegation}</span>}
      </span>
      <span className="shrink-0 font-mono text-[9.5px] text-text-faint">{row.startedAt.slice(11, 16)}</span>
      <span className="shrink-0 font-mono text-[9.5px] text-text-faint">{shortRef(row.dispatchId, 14)}</span>
      <span
        data-testid={`runtime-outcome-${row.runtimeSessionId}`}
        className={`shrink-0 font-mono text-[9.5px] ${sessionStatusTone[row.status]}`}
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
      <span className="min-w-0 flex-1 truncate text-[11.5px]">
        {row.instanceId}
        <span className="ml-1.5 font-mono text-[9.5px] text-text-faint">{t("agentRuntime.sessionsNoDispatchTag")}</span>
      </span>
      <span className="shrink-0 font-mono text-[9.5px] text-text-faint">{row.startedAt.slice(11, 16)}</span>
      <span className={`shrink-0 font-mono text-[9.5px] ${sessionStatusTone[row.status]}`}>
        {t(sessionStatusKey[row.status] as never)}
      </span>
    </button>
  );
}
