import { useState } from "react";
import {
  isAvailableSquadRunSummary,
  type SquadRunListRowDto,
  type SquadRunSummaryDto,
} from "@harness-anything/daemon/protocol";

type SquadRunInvalidSummaryDto = Extract<SquadRunListRowDto, { readonly projectionState: "invalid" }>;
import { t } from "../../i18n/index.tsx";
import { formatListTime } from "../../model/time.ts";
import { catalogRailClass } from "../primitives/CatalogSplit.tsx";
import { DenseRow, RowTime } from "../primitives/DenseRow.tsx";
import { StatusTag, type StatusTone } from "../primitives/StatusTag.tsx";

/**
 * 小队编排段:一次 `ha squad run` 一个列表单元。GUI 发起的单次 squad 派工
 * (dispatch 头带 squadId、无 squadRunId)归单会话段,不冒充编排单元。
 *
 * 第一层是小队(名称 + 在编/收敛状态 + run 数),第二层才是该小队的 runs;
 * run 行只留 phase + mission 一句 + 相对时间。revision/executionId/taskId 短码
 * 与 leader/worker 计数都撤到详情里——列表先回答「哪些小队在动」,再回答「这一次
 * 编排在干什么」。行整体可点(沿用 squadrun/<id> 的可寻址选择)。
 */
export function SquadRunList({
  runs,
  truncated,
  totalRuns,
  squadNames,
  query,
  range,
  selectedId,
  onSelectRun,
}: {
  readonly runs: readonly SquadRunListRowDto[];
  readonly truncated: boolean;
  readonly totalRuns: number;
  readonly squadNames: ReadonlyMap<string, string>;
  readonly query: string;
  readonly range: string;
  readonly selectedId: string | null;
  readonly onSelectRun: (squadRunId: string) => void;
}) {
  // 折叠的是小队,不是 run:默认展开,首次进页面就能同时看见「小队」和「它的 runs」。
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (squadId: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(squadId)) next.delete(squadId);
      else next.add(squadId);
      return next;
    });
  const available = runs.filter(isAvailableSquadRunSummary),
    invalid = runs.filter((run): run is SquadRunInvalidSummaryDto => !isAvailableSquadRunSummary(run)),
    groups = squadRunGroups(available, squadNames);
  return (
    <nav
      data-testid="squad-run-list"
      data-pane="list"
      aria-label={t("agentRuntime.sessionsSegmentSquad")}
      className={catalogRailClass}
    >
      {runs.length === 0 ? (
        <p data-testid="squad-runs-empty" className="px-4 py-4 ui-micro text-text-faint">
          {t(
            query !== ""
              ? "agentRuntime.sessionsNoMatches"
              : range === "all"
                ? "agentRuntime.squadRunsEmpty"
                : "agentRuntime.squadRunsEmptyWindow",
            { range },
          )}
        </p>
      ) : (
        <>
          {groups.map((group) => (
            <SquadSection
              key={group.squadId}
              group={group}
              collapsed={collapsed.has(group.squadId)}
              selectedId={selectedId}
              onToggle={() => toggle(group.squadId)}
              onSelectRun={onSelectRun}
            />
          ))}
          {invalid.map((run) => (
            <section
              key={run.squadRunId}
              data-testid={`squad-run-${run.squadRunId}`}
              className="border-b border-border"
            >
              <button
                type="button"
                disabled
                data-tip={run.projectionError.hint}
                data-testid={`squad-run-toggle-${run.squadRunId}`}
                className="flex w-full cursor-not-allowed items-center gap-2 px-4 py-3 text-left opacity-70"
              >
                <span className="min-w-0 flex-1 truncate font-mono ui-micro text-text-faint">{run.squadRunId}</span>
                <StatusTag tone="neutral" tip={run.projectionError.hint} label={t("agentRuntime.catalogInvalid")} />
              </button>
            </section>
          ))}
        </>
      )}
      {truncated && (
        <p data-testid="squad-runs-truncated" className="border-t border-border px-4 py-2 ui-micro text-text-faint">
          {t(runs.length === 1 ? "agentRuntime.squadRunsTruncatedOne" : "agentRuntime.squadRunsTruncated", {
            count: runs.length,
            total: totalRuns,
          })}
        </p>
      )}
    </nav>
  );
}

export type SquadRunGroup = {
  readonly squadId: string;
  readonly label: string;
  readonly runs: readonly SquadRunSummaryDto[];
  readonly active: boolean;
  readonly failed: boolean;
  readonly latestActivityAt: string;
};

/** 先小队后 run:在编的小队排前,再按最新活动;组内 run 也按最新活动倒序。 */
export function squadRunGroups(
  runs: readonly SquadRunSummaryDto[],
  squadNames: ReadonlyMap<string, string>,
): readonly SquadRunGroup[] {
  const bySquad = new Map<string, SquadRunSummaryDto[]>();
  for (const run of runs) {
    const bucket = bySquad.get(run.squadId);
    if (bucket === undefined) bySquad.set(run.squadId, [run]);
    else bucket.push(run);
  }
  return [...bySquad]
    .map(([squadId, squadRuns]) => {
      const ordered = [...squadRuns].sort((left, right) => right.latestActivityAt.localeCompare(left.latestActivityAt));
      const active = ordered.some((run) => !isSettledPhase(run.phase)),
        failed = !active && ordered.some((run) => run.phase === "failed");
      return {
        squadId,
        label: squadNames.get(squadId) ?? squadId,
        runs: ordered,
        active,
        failed,
        latestActivityAt: ordered[0]?.latestActivityAt ?? "",
      };
    })
    .sort(
      (left, right) =>
        Number(right.active) - Number(left.active) ||
        right.latestActivityAt.localeCompare(left.latestActivityAt) ||
        left.label.localeCompare(right.label),
    );
}

const isSettledPhase = (phase: SquadRunSummaryDto["phase"]): boolean =>
  phase === "converged" || phase === "failed" || phase === "cancelled";

const PHASE_KEY: Readonly<Record<SquadRunSummaryDto["phase"], string>> = {
  planning: "agentRuntime.squadRunPhasePlanning",
  leader_running: "agentRuntime.squadRunPhaseLeaderRunning",
  workers_running: "agentRuntime.squadRunPhaseWorkersRunning",
  cancelled: "agentRuntime.squadRunPhaseCancelled",
  converged: "agentRuntime.squadRunPhaseConverged",
  failed: "agentRuntime.squadRunPhaseFailed",
};
const PHASE_TONE: Readonly<Record<SquadRunSummaryDto["phase"], StatusTone>> = {
  planning: "neutral",
  leader_running: "active",
  workers_running: "active",
  cancelled: "cancel",
  converged: "done",
  failed: "bad",
};

function SquadSection({
  group,
  collapsed,
  selectedId,
  onToggle,
  onSelectRun,
}: {
  readonly group: SquadRunGroup;
  readonly collapsed: boolean;
  readonly selectedId: string | null;
  readonly onToggle: () => void;
  readonly onSelectRun: (squadRunId: string) => void;
}) {
  const tone: StatusTone = group.active ? "active" : group.failed ? "bad" : "done",
    label = group.active
      ? t("agentRuntime.squadRunGroupActive")
      : group.failed
        ? t("agentRuntime.squadRunGroupFailed")
        : t("agentRuntime.squadRunGroupConverged");
  return (
    <section data-testid={`squad-group-${group.squadId}`} className="border-b border-border">
      <button
        type="button"
        data-testid={`squad-group-toggle-${group.squadId}`}
        aria-expanded={!collapsed}
        aria-controls={`squad-group-body-${group.squadId}`}
        onClick={onToggle}
        className="w-full text-left hover:bg-surface-raised"
      >
        <DenseRow
          index={collapsed ? "▸" : "▾"}
          tag={<StatusTag tone={tone} label={label} />}
          title={<span className="font-semibold">{group.label}</span>}
          hoverTitle={group.label}
          reason={t(group.runs.length === 1 ? "agentRuntime.squadRunGroupRun" : "agentRuntime.squadRunGroupRuns", {
            count: group.runs.length,
          })}
          time={formatListTime(group.latestActivityAt)}
          relaxed
        />
      </button>
      {!collapsed && (
        <div
          id={`squad-group-body-${group.squadId}`}
          data-testid={`squad-group-body-${group.squadId}`}
          className="ml-3.5 border-l border-border pl-1.5"
        >
          {group.runs.map((run) => (
            <button
              key={run.squadRunId}
              type="button"
              data-testid={`squad-run-toggle-${run.squadRunId}`}
              aria-current={selectedId === run.squadRunId}
              onClick={() => onSelectRun(run.squadRunId)}
              className={`w-full text-left hover:bg-text/5 ${selectedId === run.squadRunId ? "bg-accent/[0.08]" : ""}`}
            >
              <DenseRow
                tag={<StatusTag tone={PHASE_TONE[run.phase]} label={t(PHASE_KEY[run.phase] as never)} />}
                title={run.mission}
                time={<RowTime at={run.latestActivityAt} />}
                hoverTitle={run.squadRunId}
                selected={selectedId === run.squadRunId}
              />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
