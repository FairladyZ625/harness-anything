import type { SquadRunSummaryDto } from "../../../../../daemon/src/squad-run-contract.ts";
import { relativeTime, shortRef } from "../../sessions-model.ts";
import { t } from "../../i18n/index.tsx";
import { LiveDot } from "../runtime/parts.tsx";

/**
 * 小队编排段:一次 `ha squad run` 一个列表单元。GUI 发起的单次 squad 派工
 * (dispatch 头带 squadId、无 squadRunId)归单会话段,不冒充编排单元。
 * 行整体可点(G12 §2b):选中后右侧详情区渲染 leader 轮次 → worker 派工链
 * (repo.squad.run.read)。任务短码是行内文本,正式出口在详情区(EntityRefLink)。
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
  readonly runs: readonly SquadRunSummaryDto[];
  readonly truncated: boolean;
  readonly totalRuns: number;
  readonly squadNames: ReadonlyMap<string, string>;
  readonly query: string;
  readonly range: string;
  readonly selectedId: string | null;
  readonly onSelectRun: (squadRunId: string) => void;
}) {
  return (
    <nav
      data-testid="squad-run-list"
      aria-label={t("agentRuntime.sessionsSegmentSquad")}
      className="flex w-[420px] shrink-0 flex-col overflow-y-auto border-r border-border bg-surface"
    >
      {runs.length === 0 ? (
        <p data-testid="squad-runs-empty" className="px-4 py-4 text-[11.5px] text-text-faint">
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
        runs.map((run) => (
          <RunSection
            key={run.squadRunId}
            run={run}
            squadNames={squadNames}
            selected={selectedId === run.squadRunId}
            onSelectRun={onSelectRun}
          />
        ))
      )}
      {truncated && (
        <p
          data-testid="squad-runs-truncated"
          className="border-t border-border px-4 py-2 text-[10.5px] text-text-faint"
        >
          {t("agentRuntime.squadRunsTruncated", { count: runs.length, total: totalRuns })}
        </p>
      )}
    </nav>
  );
}

const PHASE_KEY: Readonly<Record<SquadRunSummaryDto["phase"], string>> = {
  planning: "agentRuntime.squadRunPhasePlanning",
  leader_running: "agentRuntime.squadRunPhaseLeaderRunning",
  workers_running: "agentRuntime.squadRunPhaseWorkersRunning",
  converged: "agentRuntime.squadRunPhaseConverged",
  failed: "agentRuntime.squadRunPhaseFailed",
};
const PHASE_TONE: Readonly<Record<SquadRunSummaryDto["phase"], string>> = {
  planning: "text-status-unknown",
  leader_running: "text-status-active",
  workers_running: "text-status-active",
  converged: "text-status-done",
  failed: "text-status-blocked",
};

function RunSection({
  run,
  squadNames,
  selected,
  onSelectRun,
}: {
  readonly run: SquadRunSummaryDto;
  readonly squadNames: ReadonlyMap<string, string>;
  readonly selected: boolean;
  readonly onSelectRun: (squadRunId: string) => void;
}) {
  return (
    <section data-testid={`squad-run-${run.squadRunId}`} className="border-b border-border">
      <button
        type="button"
        data-testid={`squad-run-toggle-${run.squadRunId}`}
        aria-current={selected}
        onClick={() => onSelectRun(run.squadRunId)}
        className={`w-full text-left hover:bg-surface-raised ${selected ? "bg-accent/[0.08]" : ""}`}
      >
        <span className="flex w-full flex-col gap-0.5 px-4 pt-3 pb-2 text-left">
          <span className="flex min-w-0 items-center gap-1.5">
            <LiveDot
              state={run.runningCount > 0 ? "live" : "idle"}
              tip={t("agentRuntime.liveSessions", { count: run.runningCount })}
            />
            <b className="min-w-0 truncate text-[12.5px]">{squadNames.get(run.squadId) ?? run.squadId}</b>
            <span className="shrink-0 font-mono text-[9.5px] text-text-faint">{shortRef(run.squadId, 12)}</span>
            <span className={`ml-auto shrink-0 font-mono text-[9.5px] ${PHASE_TONE[run.phase]}`}>
              {t(PHASE_KEY[run.phase] as never)}
            </span>
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[10.5px] text-text-muted">
            {t("agentRuntime.squadRunTask")}
            <span className="font-mono text-[10.5px] text-text-muted">{shortRef(run.taskId, 14)}</span>
            <span>· {t("agentRuntime.squadRunLeaderTurns", { count: run.leaderTurnCount })}</span>
            <span>· {t("agentRuntime.squadRunWorkerAttempts", { count: run.workerAttemptCount })}</span>
            <span className="ml-auto shrink-0 font-mono text-[9.5px] text-text-faint">
              {relativeTime(run.latestActivityAt)}
            </span>
          </span>
          <p className="max-w-full truncate text-[11px] text-text-muted" title={run.mission}>
            {run.mission}
          </p>
        </span>
      </button>
    </section>
  );
}
