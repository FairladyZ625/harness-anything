import { useQuery } from "@tanstack/react-query";
import type { SquadRunDetailDto, SquadRunSummaryDto } from "../../../../../daemon/src/squad-run-contract.ts";
import {
  relativeTime,
  sessionStatusDot,
  sessionStatusKey,
  sessionStatusTone,
  shortRef,
  type SessionStatus,
} from "../../sessions-model.ts";
import { squadRunsClient } from "../../squad-run-client.ts";
import { t } from "../../i18n/index.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { LiveDot } from "../runtime/parts.tsx";

/**
 * 小队编排段(设计稿 §7.3):一次 `ha squad run` 一个编排单元(squadRunId),展开后
 * leader 轮次与 worker 尝试整单元渲染。列表来自 repo.squad.runs.list,展开详情来自
 * repo.squad.runs.read;成员行的 status/agent/instance 都在 detail DTO 里,不再二次
 * 查询。GUI 发起的单次 squad 派工(dispatch 头带 squadId、无 squadRunId)归单会话段,
 * 不冒充编排单元。
 */
export function SquadRunList({
  repoId,
  runs,
  truncated,
  totalRuns,
  expandedKeys,
  squadNames,
  query,
  onToggleRun,
  onSelectSession,
  onOpenTask,
}: {
  readonly repoId: string;
  readonly runs: readonly SquadRunSummaryDto[];
  readonly truncated: boolean;
  readonly totalRuns: number;
  readonly expandedKeys: ReadonlySet<string>;
  readonly squadNames: ReadonlyMap<string, string>;
  readonly query: string;
  readonly onToggleRun: (squadRunId: string) => void;
  readonly onSelectSession: (runtimeSessionId: string) => void;
  readonly onOpenTask: (taskId: string) => void;
}) {
  return (
    <div data-testid="squad-run-list" className="min-h-0 flex-1 overflow-y-auto">
      {runs.length === 0 ? (
        <p className="px-4 py-4 text-[11.5px] text-text-faint">
          {t(query === "" ? "agentRuntime.squadRunsEmpty" : "agentRuntime.sessionsNoMatches")}
        </p>
      ) : (
        runs.map((run) => (
          <RunSection
            key={run.squadRunId}
            repoId={repoId}
            run={run}
            expanded={expandedKeys.has(run.squadRunId)}
            squadNames={squadNames}
            onToggleRun={onToggleRun}
            onSelectSession={onSelectSession}
            onOpenTask={onOpenTask}
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
  repoId,
  run,
  expanded,
  squadNames,
  onToggleRun,
  onSelectSession,
  onOpenTask,
}: {
  readonly repoId: string;
  readonly run: SquadRunSummaryDto;
  readonly expanded: boolean;
  readonly squadNames: ReadonlyMap<string, string>;
  readonly onToggleRun: (squadRunId: string) => void;
  readonly onSelectSession: (runtimeSessionId: string) => void;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const detail = useQuery({
    queryKey: ["sessions-page", repoId, "squad-run", run.squadRunId],
    queryFn: () => squadRunsClient.read(repoId, run.squadRunId),
    enabled: expanded,
    staleTime: 4_000,
  });
  const members = detail.data?.run;
  return (
    <section data-testid={`squad-run-${run.squadRunId}`} className="border-b border-border">
      <button
        type="button"
        data-testid={`squad-run-toggle-${run.squadRunId}`}
        aria-expanded={expanded}
        onClick={() => onToggleRun(run.squadRunId)}
        className="flex w-full flex-col gap-0.5 px-4 pt-3 pb-2 text-left hover:bg-surface-raised"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className={`shrink-0 text-[7px] text-text-faint transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            ▶
          </span>
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
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 pl-[14px] text-[10.5px] text-text-muted">
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
      </button>
      {expanded && (
        <div className="cv-auto-10r px-4 pb-3">
          <p className="mb-1.5 max-w-[72rem] truncate text-[11px] text-text-muted" title={run.mission}>
            {run.mission}
          </p>
          {detail.isPending && <p className="text-[10.5px] text-text-faint">{t("agentRuntime.loading")}</p>}
          {detail.isError && (
            <p role="alert" className="font-mono text-[10px] text-status-blocked">
              {detail.error instanceof Error ? detail.error.message : String(detail.error)}
            </p>
          )}
          {members?.error && (
            <p role="alert" className="mb-1.5 font-mono text-[10px] text-status-blocked">
              {members.error}
            </p>
          )}
          {members?.leaders.map((leader) => (
            <MemberRow
              key={leader.turnId}
              kind="leader"
              id={leader.turnId}
              runtimeSessionId={leader.runtimeSessionId}
              dispatchId={leader.dispatchId}
              agentName={memberText(leader, "agentName")}
              instanceId={memberText(leader, "instanceId")}
              status={memberStatus(leader)}
              rejection={null}
              startedAt={memberText(leader, "startedAt")}
              onSelectSession={onSelectSession}
            />
          ))}
          {members?.workers.map((worker) => (
            <MemberRow
              key={worker.attemptId}
              kind="worker"
              id={worker.attemptId}
              runtimeSessionId={worker.runtimeSessionId}
              dispatchId={worker.dispatchId}
              agentName={memberText(worker, "agentName")}
              instanceId={memberText(worker, "instanceId")}
              status={memberText(worker, "rejection") === null ? memberStatus(worker) : "rejected"}
              rejection={memberText(worker, "rejection")}
              startedAt={memberText(worker, "startedAt")}
              onSelectSession={onSelectSession}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function MemberRow({
  kind,
  id,
  runtimeSessionId,
  dispatchId,
  agentName,
  instanceId,
  status,
  rejection,
  startedAt,
  onSelectSession,
}: {
  readonly kind: "leader" | "worker";
  readonly id: string;
  readonly runtimeSessionId: string | null;
  readonly dispatchId: string | null;
  readonly agentName: string | null;
  readonly instanceId: string | null;
  readonly status: string;
  readonly rejection: string | null;
  readonly startedAt: string | null;
  readonly onSelectSession: (runtimeSessionId: string) => void;
}) {
  const statusKey =
    status === "rejected"
      ? "agentRuntime.squadRunRejected"
      : (sessionStatusKey[status as SessionStatus] ?? "agentRuntime.sessionStatusUnknown");
  return (
    <div
      className={"cv-auto-2r flex items-center gap-2 rounded px-1 py-1 text-left text-[11.5px] hover:bg-surface-raised"}
    >
      <span className="w-[62px] shrink-0 font-mono text-[9.5px] uppercase tracking-[0.05em] text-text-faint">
        {t(kind === "leader" ? "agentRuntime.squadRunLeader" : "agentRuntime.squadRunWorker")}
      </span>
      <span className="w-[80px] shrink-0 truncate font-mono text-[10px] text-text-muted">{id}</span>
      <LiveDot state={sessionStatusDot[status as SessionStatus] ?? "idle"} tip={status} />
      <span className="min-w-0 flex-1 truncate" title={rejection ?? undefined}>
        {rejection ?? agentName ?? instanceId ?? "—"}
        {!rejection && instanceId && agentName && (
          <span className="ml-1.5 font-mono text-[9.5px] text-text-faint">{shortRef(instanceId, 14)}</span>
        )}
      </span>
      <span className="shrink-0 font-mono text-[9.5px] text-text-faint">{startedAt?.slice(11, 16) ?? ""}</span>
      <span className="shrink-0 font-mono text-[9.5px] text-text-faint">
        {dispatchId ? shortRef(dispatchId, 14) : "—"}
      </span>
      <span
        className={`shrink-0 font-mono text-[9.5px] ${
          status === "rejected"
            ? "text-status-blocked"
            : (sessionStatusTone[status as SessionStatus] ?? "text-status-unknown")
        }`}
      >
        {t(statusKey as never)}
      </span>
      {runtimeSessionId !== null && (
        <button
          type="button"
          data-testid={`squad-run-session-${runtimeSessionId}`}
          onClick={() => onSelectSession(runtimeSessionId)}
          title={runtimeSessionId}
          className={
            "shrink-0 rounded border border-border px-1.5 py-px font-mono text-[9.5px] text-text-muted " +
            "hover:border-accent hover:text-accent"
          }
        >
          {t("agentRuntime.sessionsOpenSession")} ↗
        </button>
      )}
    </div>
  );
}

/** detail DTO 的成员行是 JsonObject(dispatch 行展开字段),读取时做窄化而不是断言。 */
function memberText(member: Record<string, unknown>, field: string): string | null {
  const value = member[field];
  return typeof value === "string" && value !== "" ? value : null;
}
function memberStatus(member: Record<string, unknown>): string {
  const value = member.status;
  return typeof value === "string" ? value : "unknown";
}
export type { SquadRunDetailDto };
