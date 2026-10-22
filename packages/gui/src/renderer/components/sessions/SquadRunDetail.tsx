import {
  isAvailableSquadRunDetail,
  type SquadRunLeaderTurnDto,
  type SquadRunReadResult,
  type SquadRunWorkerAttemptDto,
} from "@harness-anything/daemon/protocol";
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
import { RowTime } from "../primitives/DenseRow.tsx";
import { StatusTag } from "../primitives/StatusTag.tsx";

/**
 * 小队编排详情(G12 §2b/§2c):`ha squad status` 的 statusDto 对 GUI 开放的读面
 * (repo.squad.run.read)。主体是 leader→batch→worker 扇出树:每个 leader 轮次一节,
 * 该轮派发的 worker attempt 挂在轮次下(attempt.leaderTurnId 是父子边);轮次行内
 * 可展开该轮 receipt 原文(leader 的原始输出——「为何收敛/为何失败」的第一证据);
 * 轮次/尝试行都直达 session/<id>,任务出口直达 task 详情——与单会话段共用同一组
 * 可寻址导航。Token 消耗不在本页:系统 Tab 的「Token 消耗」页与会话详情消耗面板
 * (P1.3)是唯一消耗视图,attempts 上的度量字段仍经 repo.squad.run.read 暴露。
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
      <p role="alert" data-testid="squad-run-detail-error" className="px-4 py-4 font-mono ui-micro text-status-blocked">
        {t("agentRuntime.readFailed", { error })}
      </p>
    );
  if (pending || detail === null)
    return <p className="px-4 py-4 ui-micro text-text-faint">{t("agentRuntime.loading")}</p>;
  const run = detail.run;
  if (!isAvailableSquadRunDetail(run))
    return (
      <div data-testid="squad-run-detail" className="flex items-center gap-2 px-4 py-4 text-text-faint">
        <span className="font-mono ui-micro">{run.squadRunId}</span>
        <StatusTag tone="neutral" tip={run.projectionError.hint} label={t("agentRuntime.catalogInvalid")} />
      </div>
    );
  // 「第 N 轮」只有 leader 轮次一个含义:worker 行用它回指派发它的 leader 轮,
  // 不再把 runtime session id / attemptId 拼进句子里。
  const turnNumber = new Map(run.leaderTurns.map((turn, index) => [turn.turnId, index + 1])),
    workerRound = new Map(
      run.workerAttempts.flatMap((attempt) => {
        const round = turnNumber.get(attempt.leaderTurnId);
        return attempt.runtimeSessionId !== null && round !== undefined
          ? [[attempt.runtimeSessionId, round] as const]
          : [];
      }),
    ),
    attemptRound = new Map(
      run.workerAttempts.flatMap((attempt) => {
        const round = turnNumber.get(attempt.leaderTurnId);
        return round === undefined ? [] : [[attempt.attemptId, round] as const];
      }),
    );
  return (
    <div data-testid="squad-run-detail" className="flex flex-col gap-4 px-4 pt-3.5 pb-6">
      <header className="flex flex-col gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <b className="min-w-0 truncate ui-body">{squadName ?? run.squadId}</b>
          <span className="shrink-0 font-mono ui-micro text-text-faint" title={run.squadRunId}>
            {run.squadRunId}
          </span>
          {run.subject.kind === "task" && (
            <EntityRefLink
              entityRef={`task/${run.subject.taskId}`}
              onNavigate={(ref) => onOpenTask(ref.slice("task/".length))}
              title={run.subject.taskId}
              className={[
                "shrink-0 rounded border border-border px-1.5 py-0.5 ui-micro text-text-muted",
                "hover:border-accent hover:text-accent",
              ].join(" ")}
            >
              {t("agentRuntime.sessionsTaskDetail")} ↗
            </EntityRefLink>
          )}
          {run.subject.kind === "schedule-occurrence" && (
            <span
              title={`${run.subject.scheduleId} / ${run.subject.occurrenceId}`}
              className="shrink-0 rounded border border-border px-1.5 py-0.5 ui-micro text-text-muted"
            >
              {t("agentRuntime.sessionsScheduleOccurrence")}
            </span>
          )}
        </span>
        <p data-testid="squad-run-detail-mission" className="ui-body text-text">
          {run.mission}
        </p>
        <p data-testid="squad-run-observation" className="ui-micro text-text-faint">
          {t("agentRuntime.squadRunLastReport")} <RowTime at={run.acceptedAt} />
        </p>
        {run.error !== null && (
          <p className="font-mono ui-micro text-status-blocked" data-testid="squad-run-detail-run-error">
            {run.error}
          </p>
        )}
      </header>
      <section>
        <h3 className="mb-1.5 font-mono ui-micro uppercase tracking-[0.07em] text-text-faint">
          {t("agentRuntime.squadRunLeaderTurnsSection", { count: run.leaderTurns.length })}
        </h3>
        {run.leaderTurns.length === 0 ? (
          <p className="ui-micro text-text-faint">{t("agentRuntime.squadRunNoTurns")}</p>
        ) : (
          run.leaderTurns.map((turn) => (
            <TurnSection
              key={turn.turnId}
              turn={turn}
              attempts={run.workerAttempts.filter((attempt) => attempt.leaderTurnId === turn.turnId)}
              active={turn.runtimeSessionId === run.currentLeaderRuntimeSessionId}
              workerRound={workerRound}
              attemptRound={attemptRound}
              onSelectEntity={onSelectEntity}
            />
          ))
        )}
      </section>
    </div>
  );
}

/** 总 Token 开销看板已随 P1.3 交付形态调整撤销:消耗视图收敛到系统 Tab 的「Token 消耗」
 * 页与会话详情消耗面板,不在小队编排详情重复一套。 */

function TurnSection({
  turn,
  attempts,
  active,
  workerRound,
  attemptRound,
  onSelectEntity,
}: {
  readonly turn: SquadRunLeaderTurnDto;
  readonly attempts: readonly SquadRunWorkerAttemptDto[];
  readonly active: boolean;
  readonly workerRound: ReadonlyMap<string, number>;
  readonly attemptRound: ReadonlyMap<string, number>;
  readonly onSelectEntity: (ref: string) => void;
}) {
  const frame = active ? "border-accent/40 bg-accent/[0.14]" : "border-border";
  return (
    <section data-testid={`squad-run-turn-${turn.turnId}`} className={`cv-auto-2r rounded border px-2 py-1 ${frame}`}>
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-mono ui-micro text-text-faint">{turn.turnId}</span>
        <StatusWord status={turn.status} />
        <span className="min-w-0 flex-1 truncate ui-micro">
          <span title={triggerDetail(turn.trigger)}>{triggerLabel(turn.trigger, workerRound, attemptRound)}</span>
          <span className="ml-1.5 ui-micro text-text-muted">{decisionLabel(turn.decision)}</span>
        </span>
        <span className="shrink-0 font-mono ui-micro text-text-faint">
          {turn.startedAt === null ? "—" : (formatTime(turn.startedAt, { style: "time" }) ?? "—")}
        </span>
        <EntityRefLink
          entityRef={`session/${turn.runtimeSessionId}`}
          onNavigate={onSelectEntity}
          title={turn.runtimeSessionId}
          className="shrink-0 font-mono ui-micro text-accent hover:underline"
        >
          {shortRef(turn.runtimeSessionId, 12)}
        </EntityRefLink>
      </div>
      <details className="mt-1 rounded border border-border bg-surface px-1.5 py-1">
        <summary
          data-testid={`squad-run-receipt-${turn.turnId}`}
          className="cursor-pointer font-mono ui-micro text-text-faint"
        >
          {t("agentRuntime.squadRunReceipt")}
        </summary>
        {turn.resultText === null ? (
          <p className="mt-1 ui-micro text-text-faint">{t("agentRuntime.squadRunNoReceipt")}</p>
        ) : (
          <pre className="mt-1 bounded-content overflow-auto whitespace-pre-wrap break-all font-mono ui-micro text-text">
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
      title={attempt.attemptId}
      className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-surface-raised"
    >
      <span aria-hidden className="shrink-0 font-mono ui-micro text-text-faint">
        ├─
      </span>
      <StatusWord status={attempt.status} />
      <span className="min-w-0 flex-1 truncate ui-micro">
        {attempt.workerId}
        {attempt.taskId !== null && (
          <span className="ml-1.5 ui-micro text-text-muted" title={attempt.taskId}>
            {t("agentRuntime.squadRunWorkerTask", { ref: shortRef(attempt.taskId, 14) })}
          </span>
        )}
        {attempt.rejection !== null && (
          <span className="ml-1.5 ui-micro text-status-blocked" title={attempt.rejection}>
            {t("agentRuntime.squadRunRejection", { reason: attempt.rejection })}
          </span>
        )}
      </span>
      <span className="shrink-0 font-mono ui-micro text-text-faint">
        {attempt.startedAt === null ? "—" : (formatTime(attempt.startedAt, { style: "time" }) ?? "—")}
      </span>
      {attempt.runtimeSessionId !== null ? (
        <EntityRefLink
          entityRef={`session/${attempt.runtimeSessionId}`}
          onNavigate={onSelectEntity}
          title={attempt.runtimeSessionId}
          className="shrink-0 font-mono ui-micro text-accent hover:underline"
        >
          {shortRef(attempt.runtimeSessionId, 12)}
        </EntityRefLink>
      ) : (
        <span className="shrink-0 font-mono ui-micro text-text-faint">{t("agentRuntime.squadRunNoDispatch")}</span>
      )}
    </div>
  );
}

function StatusWord({ status }: { readonly status: SessionStatus | null }) {
  if (status === null)
    return <span className="shrink-0 font-mono ui-micro text-text-faint">{t("agentRuntime.squadRunNoDispatch")}</span>;
  return (
    <span className={`shrink-0 font-mono ui-micro ${sessionStatusTone[status]}`}>
      <LiveDot state={sessionStatusDot[status]} tip={t(sessionStatusKey[status] as never)} />{" "}
      {t(sessionStatusKey[status] as never)}
    </span>
  );
}

/** 触发语用「第 N 轮」而不是裸 runtime/attempt id;id 留在 title(triggerDetail)。 */
function triggerLabel(
  trigger: SquadRunLeaderTurnDto["trigger"],
  workerRound: ReadonlyMap<string, number>,
  attemptRound: ReadonlyMap<string, number>,
): string {
  if (trigger.kind === "initial") return t("agentRuntime.squadRunTriggerInitial");
  if (trigger.kind === "leader_retry") return t("agentRuntime.squadRunTriggerLeaderRetry", { ref: trigger.turnId });
  if (trigger.kind === "worker_wait") {
    const round = workerRound.get(trigger.runtimeSessionId);
    return round === undefined
      ? trigger.reason
      : `${t("agentRuntime.squadRunTriggerWorkerWaitRound", { round })} · ${trigger.reason}`;
  }
  if (trigger.kind === "worker_outcome") {
    const round = workerRound.get(trigger.runtimeSessionId);
    return round === undefined
      ? t("agentRuntime.squadRunTriggerWorkerOutcome", { ref: shortRef(trigger.runtimeSessionId, 10) })
      : t("agentRuntime.squadRunTriggerWorkerOutcomeRound", { round });
  }
  const round = attemptRound.get(trigger.attemptId);
  return round === undefined
    ? t("agentRuntime.squadRunTriggerWorkerRejected", { ref: trigger.attemptId })
    : t("agentRuntime.squadRunTriggerWorkerRejectedRound", { round });
}

/** 机器 id 不进行内句子,但必须可达:触发语悬停给原始 id。 */
function triggerDetail(trigger: SquadRunLeaderTurnDto["trigger"]): string | undefined {
  if (trigger.kind === "initial") return undefined;
  if (trigger.kind === "leader_retry") return `${trigger.turnId} · ${trigger.reason}`;
  if (trigger.kind === "worker_wait") return `${trigger.runtimeSessionId} · ${trigger.reason}`;
  if (trigger.kind === "worker_outcome") return trigger.runtimeSessionId;
  return trigger.attemptId;
}

function decisionLabel(decision: SquadRunLeaderTurnDto["decision"]): string {
  if (decision === null) return t("agentRuntime.squadRunDecisionPending");
  return decision.kind === "converged"
    ? t("agentRuntime.squadRunDecisionConverged")
    : t("agentRuntime.squadRunDecisionPlan", { count: decision.dispatchCount });
}
