import type { SquadRunSummaryDto } from "../../../../../daemon/src/squad-run-contract.ts";
import { relativeTime, shortRef } from "../../sessions-model.ts";
import { t } from "../../i18n/index.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { LiveDot } from "../runtime/parts.tsx";

/**
 * 小队编排段:一次 `ha squad run` 一个列表单元。GUI 发起的单次 squad 派工
 * (dispatch 头带 squadId、无 squadRunId)归单会话段,不冒充编排单元。
 */
export function SquadRunList({
  runs,
  truncated,
  totalRuns,
  squadNames,
  query,
  onOpenTask,
}: {
  readonly runs: readonly SquadRunSummaryDto[];
  readonly truncated: boolean;
  readonly totalRuns: number;
  readonly squadNames: ReadonlyMap<string, string>;
  readonly query: string;
  readonly onOpenTask: (taskId: string) => void;
}) {
  return (
    <div data-testid="squad-run-list" className="min-h-0 flex-1 overflow-y-auto">
      {runs.length === 0 ? (
        <p className="px-4 py-4 text-[11.5px] text-text-faint">
          {t(query === "" ? "agentRuntime.squadRunsEmpty" : "agentRuntime.sessionsNoMatches")}
        </p>
      ) : (
        runs.map((run) => <RunSection key={run.squadRunId} run={run} squadNames={squadNames} onOpenTask={onOpenTask} />)
      )}
      {truncated && (
        <p
          data-testid="squad-runs-truncated"
          className="border-t border-border px-4 py-2 text-[10.5px] text-text-faint"
        >
          {t("agentRuntime.squadRunsTruncated", { count: runs.length, total: totalRuns })}
        </p>
      )}
    </div>
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
  onOpenTask,
}: {
  readonly run: SquadRunSummaryDto;
  readonly squadNames: ReadonlyMap<string, string>;
  readonly onOpenTask: (taskId: string) => void;
}) {
  return (
    <section data-testid={`squad-run-${run.squadRunId}`} className="border-b border-border">
      <div className="flex w-full flex-col gap-0.5 px-4 pt-3 pb-2 text-left">
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
          <EntityRefLink
            entityRef={`task/${run.taskId}`}
            onNavigate={(ref) => onOpenTask(ref.slice(5))}
            title={run.taskId}
            className="text-accent hover:underline"
          >
            {shortRef(run.taskId, 14)}
          </EntityRefLink>
          <span>· {t("agentRuntime.squadRunLeaderTurns", { count: run.leaderTurnCount })}</span>
          <span>· {t("agentRuntime.squadRunWorkerAttempts", { count: run.workerAttemptCount })}</span>
          <span className="ml-auto shrink-0 font-mono text-[9.5px] text-text-faint">
            {relativeTime(run.latestActivityAt)}
          </span>
        </span>
        <p className="max-w-[72rem] truncate text-[11px] text-text-muted" title={run.mission}>
          {run.mission}
        </p>
      </div>
    </section>
  );
}
