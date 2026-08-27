import type {
  SquadRunReadResult,
  SquadRunLeaderTurnDto,
  SquadRunWorkerAttemptDto,
} from "../../../../../daemon/src/squad-run-contract.ts";
import {
  sessionStatusDot,
  sessionStatusKey,
  sessionStatusTone,
  shortRef,
  type SessionStatus,
} from "../../sessions-model.ts";
import { t } from "../../i18n/index.tsx";
import { formatTime } from "../../model/time.ts";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { LiveDot } from "../runtime/parts.tsx";

/**
 * 小队编排详情(G12 §2b/§2c):`ha squad status` 的 statusDto 对 GUI 开放的读面
 * (repo.squad.run.read)。主体是 leader→batch→worker 扇出树:每个 leader 轮次一节,
 * 该轮派发的 worker attempt 挂在轮次下(attempt.leaderTurnId 是父子边);轮次行内
 * 可展开该轮 receipt 原文(leader 的原始输出——「为何收敛/为何失败」的第一证据);
 * 轮次/尝试行都直达 session/<id>,任务出口直达 task 详情——与单会话段共用同一组
 * 可寻址导航。早于 leaderTurnId 字段的存量 run,其 attempt 归入尾部未关联组。
 */
export function SquadRunDetail({
  detail,
  squadName,
  pending,
  error,
  onOpenTask,
  onSelectEntity,
}: {
  readonly detail: SquadRunReadResult | null;
  readonly squadName: string | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onOpenTask: (taskId: string) => void;
  readonly onSelectEntity: (ref: string) => void;
}) {
  if (error !== null)
    return (
      <p
        role="alert"
        data-testid="squad-run-detail-error"
        className="px-4 py-4 font-mono text-[11px] text-status-blocked"
      >
        {t("agentRuntime.readFailed", { error })}
      </p>
    );
  if (pending || detail === null)
    return <p className="px-4 py-4 text-[11.5px] text-text-faint">{t("agentRuntime.loading")}</p>;
  const run = detail.run;
  return (
    <div data-testid="squad-run-detail" className="flex flex-col gap-4 px-4 pt-3.5 pb-6">
      <header className="flex flex-col gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <LiveDot
            state={run.currentLeaderRuntimeSessionId === null ? "idle" : "live"}
            tip={t("agentRuntime.squadRunPhaseLeaderRunning")}
          />
          <b className="min-w-0 truncate text-[14px]">{squadName ?? run.squadId}</b>
          <span className="shrink-0 font-mono text-[10px] text-text-faint" title={run.squadRunId}>
            {run.squadRunId}
          </span>
          <EntityRefLink
            entityRef={`task/${run.taskId}`}
            onNavigate={(ref) => onOpenTask(ref.slice("task/".length))}
            title={run.taskId}
            className={[
              "shrink-0 rounded border border-border px-1.5 py-0.5 text-[10.5px] text-text-muted",
              "hover:border-accent hover:text-accent",
            ].join(" ")}
          >
            {t("agentRuntime.sessionsTaskDetail")} ↗
          </EntityRefLink>
        </span>
        <p data-testid="squad-run-detail-mission" className="text-[11.5px] text-text-muted">
          {run.mission}
        </p>
        {run.error !== null && (
          <p className="font-mono text-[10.5px] text-status-blocked" data-testid="squad-run-detail-run-error">
            {run.error}
          </p>
        )}
      </header>
      <section>
        <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.07em] text-text-faint">
          {t("agentRuntime.squadRunLeaderTurnsSection", { count: run.leaderTurns.length })}
        </h3>
        {run.leaderTurns.length === 0 ? (
          <p className="text-[11px] text-text-faint">{t("agentRuntime.squadRunNoTurns")}</p>
        ) : (
          run.leaderTurns.map((turn) => (
            <TurnSection
              key={turn.turnId}
              turn={turn}
              attempts={run.workerAttempts.filter((attempt) => attempt.leaderTurnId === turn.turnId)}
              active={turn.runtimeSessionId === run.currentLeaderRuntimeSessionId}
              onSelectEntity={onSelectEntity}
            />
          ))
        )}
      </section>
      <UnlinkedAttempts attempts={run.workerAttempts} onSelectEntity={onSelectEntity} />
    </div>
  );
}

function TurnSection({
  turn,
  attempts,
  active,
  onSelectEntity,
}: {
  readonly turn: SquadRunLeaderTurnDto;
  readonly attempts: readonly SquadRunWorkerAttemptDto[];
  readonly active: boolean;
  readonly onSelectEntity: (ref: string) => void;
}) {
  const frame = active ? "border-accent/40 bg-accent/[0.14]" : "border-border";
  return (
    <section data-testid={`squad-run-turn-${turn.turnId}`} className={`cv-auto-2r rounded border px-2 py-1 ${frame}`}>
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-[9.5px] text-text-faint">{turn.turnId}</span>
        <StatusWord status={turn.status} />
        <span className="min-w-0 flex-1 truncate text-[11.5px]">
          {triggerLabel(turn.trigger)}
          <span className="ml-1.5 text-[10px] text-text-muted">{decisionLabel(turn.decision)}</span>
        </span>
        <span className="shrink-0 font-mono text-[9.5px] text-text-faint">
          {turn.startedAt === null ? "—" : (formatTime(turn.startedAt, { style: "time" }) ?? "—")}
        </span>
        <EntityRefLink
          entityRef={`session/${turn.runtimeSessionId}`}
          onNavigate={onSelectEntity}
          title={turn.runtimeSessionId}
          className="shrink-0 font-mono text-[9.5px] text-accent hover:underline"
        >
          {shortRef(turn.runtimeSessionId, 12)}
        </EntityRefLink>
      </div>
      <details className="mt-1 rounded border border-border bg-surface px-1.5 py-1">
        <summary
          data-testid={`squad-run-receipt-${turn.turnId}`}
          className="cursor-pointer font-mono text-[9.5px] text-text-faint"
        >
          {t("agentRuntime.squadRunReceipt")}
        </summary>
        {turn.resultText === null ? (
          <p className="mt-1 text-[10.5px] text-text-faint">{t("agentRuntime.squadRunNoReceipt")}</p>
        ) : (
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-[10.5px] text-text">
            {turn.resultText}
          </pre>
        )}
      </details>
      {attempts.length > 0 && (
        <div className="mt-1 ml-3 flex flex-col gap-0.5 border-l border-border pl-2">
          {attempts.map((attempt) => (
            <AttemptRow key={attempt.attemptId} attempt={attempt} onSelectEntity={onSelectEntity} />
          ))}
        </div>
      )}
    </section>
  );
}

/** 存量 run(早于 leaderTurnId 字段)的 attempt 无父子边:整组呈现,不猜轮次。 */
function UnlinkedAttempts({
  attempts,
  onSelectEntity,
}: {
  readonly attempts: readonly SquadRunWorkerAttemptDto[];
  readonly onSelectEntity: (ref: string) => void;
}) {
  const unlinked = attempts.filter((attempt) => attempt.leaderTurnId === null);
  if (unlinked.length === 0) return null;
  return (
    <section data-testid="squad-run-unlinked">
      <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.07em] text-text-faint">
        {t("agentRuntime.squadRunUnlinkedSection", { count: unlinked.length })}
      </h3>
      {unlinked.map((attempt) => (
        <AttemptRow key={attempt.attemptId} attempt={attempt} onSelectEntity={onSelectEntity} />
      ))}
    </section>
  );
}

function AttemptRow({
  attempt,
  onSelectEntity,
}: {
  readonly attempt: SquadRunWorkerAttemptDto;
  readonly onSelectEntity: (ref: string) => void;
}) {
  return (
    <div
      data-testid={`squad-run-attempt-${attempt.attemptId}`}
      className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-surface-raised"
    >
      <span aria-hidden className="shrink-0 font-mono text-[9px] text-text-faint">
        ├─
      </span>
      <span className="shrink-0 font-mono text-[9.5px] text-text-faint">{attempt.attemptId}</span>
      <StatusWord status={attempt.status} />
      <span className="min-w-0 flex-1 truncate text-[11.5px]">
        {attempt.workerId}
        {attempt.rejection !== null && (
          <span className="ml-1.5 text-[10px] text-status-blocked" title={attempt.rejection}>
            {t("agentRuntime.squadRunRejection", { reason: attempt.rejection })}
          </span>
        )}
      </span>
      <span className="shrink-0 font-mono text-[9.5px] text-text-faint">
        {attempt.startedAt === null ? "—" : (formatTime(attempt.startedAt, { style: "time" }) ?? "—")}
      </span>
      {attempt.runtimeSessionId !== null ? (
        <EntityRefLink
          entityRef={`session/${attempt.runtimeSessionId}`}
          onNavigate={onSelectEntity}
          title={attempt.runtimeSessionId}
          className="shrink-0 font-mono text-[9.5px] text-accent hover:underline"
        >
          {shortRef(attempt.runtimeSessionId, 12)}
        </EntityRefLink>
      ) : (
        <span className="shrink-0 font-mono text-[9.5px] text-text-faint">{t("agentRuntime.squadRunNoDispatch")}</span>
      )}
    </div>
  );
}

function StatusWord({ status }: { readonly status: SessionStatus | null }) {
  if (status === null)
    return (
      <span className="shrink-0 font-mono text-[9.5px] text-text-faint">{t("agentRuntime.squadRunNoDispatch")}</span>
    );
  return (
    <span className={`shrink-0 font-mono text-[9.5px] ${sessionStatusTone[status]}`}>
      <LiveDot state={sessionStatusDot[status]} tip={t(sessionStatusKey[status] as never)} />{" "}
      {t(sessionStatusKey[status] as never)}
    </span>
  );
}

function triggerLabel(trigger: SquadRunLeaderTurnDto["trigger"]): string {
  if (trigger.kind === "initial") return t("agentRuntime.squadRunTriggerInitial");
  if (trigger.kind === "leader_retry") return t("agentRuntime.squadRunTriggerLeaderRetry", { ref: trigger.turnId });
  if (trigger.kind === "worker_wait") return trigger.reason;
  return trigger.kind === "worker_outcome"
    ? t("agentRuntime.squadRunTriggerWorkerOutcome", { ref: shortRef(trigger.runtimeSessionId, 10) })
    : t("agentRuntime.squadRunTriggerWorkerRejected", { ref: trigger.attemptId });
}

function decisionLabel(decision: SquadRunLeaderTurnDto["decision"]): string {
  if (decision === null) return t("agentRuntime.squadRunDecisionPending");
  return decision.kind === "converged"
    ? t("agentRuntime.squadRunDecisionConverged")
    : t("agentRuntime.squadRunDecisionPlan", { count: decision.dispatchCount });
}
