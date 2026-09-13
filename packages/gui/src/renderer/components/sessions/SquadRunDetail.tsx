import {
  isAvailableSquadRunDetail,
  type SquadRunAttemptMetricsDto,
  type SquadRunLeaderTurnDto,
  type SquadRunReadResult,
  type SquadRunWorkerAttemptDto,
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
import { Badge, LiveDot } from "../runtime/parts.tsx";

/**
 * 小队编排详情(G12 §2b/§2c):`ha squad status` 的 statusDto 对 GUI 开放的读面
 * (repo.squad.run.read)。主体是 leader→batch→worker 扇出树:每个 leader 轮次一节,
 * 该轮派发的 worker attempt 挂在轮次下(attempt.leaderTurnId 是父子边);轮次行内
 * 可展开该轮 receipt 原文(leader 的原始输出——「为何收敛/为何失败」的第一证据);
 * 轮次/尝试行都直达 session/<id>,任务出口直达 task 详情——与单会话段共用同一组
 * 可寻址导航。P1.3 遥测:轮次与尝试行各自带 tokenUsage/toolCallCount/compacted
 * (P1.2 暴露的 Attempt 度量,零值=未派工/未结算),详情页渲染 Token 开销看板、
 * 每成员消耗占比与 compacted 负向约束丢失警示,供人工与 CEO 定位卡顿/死循环成员。
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
        <Badge tip={run.projectionError.hint}>{t("agentRuntime.catalogInvalid")}</Badge>
      </div>
    );
  // 单一把比例尺:全 run(leader 轮 ∪ worker attempt)最大单段 token 消耗,bar 之间才可比。
  const tokenScale = Math.max(0, ...run.leaderTurns.map(totalTokens), ...run.workerAttempts.map(totalTokens));
  return (
    <div data-testid="squad-run-detail" className="flex flex-col gap-4 px-4 pt-3.5 pb-6">
      <header className="flex flex-col gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <LiveDot
            state={run.currentLeaderRuntimeSessionId === null ? "idle" : "live"}
            tip={t("agentRuntime.squadRunPhaseLeaderRunning")}
          />
          <b className="min-w-0 truncate ui-body">{squadName ?? run.squadId}</b>
          <span className="shrink-0 font-mono ui-micro text-text-faint" title={run.squadRunId}>
            {run.squadRunId}
          </span>
          <EntityRefLink
            entityRef={`task/${run.taskId}`}
            onNavigate={(ref) => onOpenTask(ref.slice("task/".length))}
            title={run.taskId}
            className={[
              "shrink-0 rounded border border-border px-1.5 py-0.5 ui-micro text-text-muted",
              "hover:border-accent hover:text-accent",
            ].join(" ")}
          >
            {t("agentRuntime.sessionsTaskDetail")} ↗
          </EntityRefLink>
        </span>
        <p data-testid="squad-run-detail-mission" className="ui-micro text-text-muted">
          {run.mission}
        </p>
        {run.error !== null && (
          <p className="font-mono ui-micro text-status-blocked" data-testid="squad-run-detail-run-error">
            {run.error}
          </p>
        )}
      </header>
      <TokenBoard turns={run.leaderTurns} attempts={run.workerAttempts} />
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
              tokenScale={tokenScale}
              onSelectEntity={onSelectEntity}
            />
          ))
        )}
      </section>
    </div>
  );
}

/** 总 Token 开销看板:Σ(leader 轮 ∪ worker attempt) 的入/出 token 与工具调用,
 * 下方按成员(leader 轮合计 + 每个 workerId 合计)给占整轮消耗的百分比条。 */
function TokenBoard({
  turns,
  attempts,
}: {
  readonly turns: readonly SquadRunLeaderTurnDto[];
  readonly attempts: readonly SquadRunWorkerAttemptDto[];
}) {
  const input = [...turns, ...attempts].reduce((sum, m) => sum + m.tokenUsage.input, 0);
  const output = [...turns, ...attempts].reduce((sum, m) => sum + m.tokenUsage.output, 0);
  const tools = [...turns, ...attempts].reduce((sum, m) => sum + m.toolCallCount, 0);
  const total = input + output;
  const workers = new Map<string, { input: number; output: number; tokens: number }>();
  for (const attempt of attempts) {
    const agg = workers.get(attempt.workerId) ?? { input: 0, output: 0, tokens: 0 };
    workers.set(attempt.workerId, {
      input: agg.input + attempt.tokenUsage.input,
      output: agg.output + attempt.tokenUsage.output,
      tokens: agg.tokens + totalTokens(attempt),
    });
  }
  const members = [
    ...(turns.length > 0
      ? [
          {
            key: "leader",
            label: t("agentRuntime.squadRunTokensLeader"),
            input: turns.reduce((sum, turn) => sum + turn.tokenUsage.input, 0),
            output: turns.reduce((sum, turn) => sum + turn.tokenUsage.output, 0),
            tokens: turns.reduce((sum, turn) => sum + totalTokens(turn), 0),
          },
        ]
      : []),
    ...[...workers.entries()].map(([key, agg]) => ({ key, label: key, ...agg })),
  ];
  return (
    <section data-testid="squad-run-token-board">
      <h3 className="mb-1.5 font-mono ui-micro uppercase tracking-[0.07em] text-text-faint">
        {t("agentRuntime.squadRunTokensSection")}
      </h3>
      <p data-testid="squad-run-token-board-total" className="font-mono ui-micro text-text-muted">
        {t("agentRuntime.squadRunTokensTotal", {
          input: compactTokens(input),
          output: compactTokens(output),
          tools,
        })}
      </p>
      <ul className="mt-1 flex flex-col gap-1">
        {members.map((member) => {
          const pct = sharePercent(member.tokens, total);
          return (
            <li
              key={member.key}
              data-testid={`squad-run-token-member-${member.key}`}
              title={t("agentRuntime.squadRunTokensMemberShare", {
                share: pct,
                input: exactTokens(member.input),
                output: exactTokens(member.output),
              })}
              className="flex items-center gap-2"
            >
              <span className="w-20 shrink-0 truncate font-mono ui-micro">{member.label}</span>
              <span className="flex h-1.5 w-36 overflow-hidden rounded-full bg-surface-raised ring-1 ring-border">
                {member.tokens > 0 && (
                  <span style={{ width: `${barPercent(member.tokens, total)}%`, background: "var(--color-accent)" }} />
                )}
              </span>
              <span className="font-mono ui-micro text-text-faint">{pct}%</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TurnSection({
  turn,
  attempts,
  active,
  tokenScale,
  onSelectEntity,
}: {
  readonly turn: SquadRunLeaderTurnDto;
  readonly attempts: readonly SquadRunWorkerAttemptDto[];
  readonly active: boolean;
  readonly tokenScale: number;
  readonly onSelectEntity: (ref: string) => void;
}) {
  const frame = active ? "border-accent/40 bg-accent/[0.14]" : "border-border";
  return (
    <section data-testid={`squad-run-turn-${turn.turnId}`} className={`cv-auto-2r rounded border px-2 py-1 ${frame}`}>
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-mono ui-micro text-text-faint">{turn.turnId}</span>
        <StatusWord status={turn.status} />
        <span className="min-w-0 flex-1 truncate ui-micro">
          {triggerLabel(turn.trigger)}
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
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono ui-micro text-text">
            {turn.resultText}
          </pre>
        )}
      </details>
      {attempts.length > 0 && (
        <div className="mt-1 ml-3 flex flex-col gap-0.5 border-l border-border pl-2">
          {attempts.map((attempt) => (
            <AttemptRow
              key={attempt.attemptId}
              attempt={attempt}
              tokenScale={tokenScale}
              onSelectEntity={onSelectEntity}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function AttemptRow({
  attempt,
  tokenScale,
  onSelectEntity,
}: {
  readonly attempt: SquadRunWorkerAttemptDto;
  readonly tokenScale: number;
  readonly onSelectEntity: (ref: string) => void;
}) {
  return (
    <div
      data-testid={`squad-run-attempt-${attempt.attemptId}`}
      className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-surface-raised"
    >
      <span aria-hidden className="shrink-0 font-mono ui-micro text-text-faint">
        ├─
      </span>
      <span className="shrink-0 font-mono ui-micro text-text-faint">{attempt.attemptId}</span>
      <StatusWord status={attempt.status} />
      <span className="min-w-0 flex-1 truncate ui-micro">
        {attempt.workerId}
        {attempt.rejection !== null && (
          <span className="ml-1.5 ui-micro text-status-blocked" title={attempt.rejection}>
            {t("agentRuntime.squadRunRejection", { reason: attempt.rejection })}
          </span>
        )}
      </span>
      <span data-testid={`squad-run-attempt-tools-${attempt.attemptId}`} className="shrink-0">
        <Badge>{t("agentRuntime.squadRunToolsBadge", { count: attempt.toolCallCount })}</Badge>
      </span>
      <span
        data-testid={`squad-run-attempt-tokens-${attempt.attemptId}`}
        title={t("agentRuntime.squadRunTokensSplit", {
          input: exactTokens(attempt.tokenUsage.input),
          output: exactTokens(attempt.tokenUsage.output),
        })}
        className="flex h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-surface-raised ring-1 ring-border"
      >
        {attempt.tokenUsage.input > 0 && (
          <span
            style={{ width: `${barPercent(attempt.tokenUsage.input, tokenScale)}%`, background: "var(--color-accent)" }}
          />
        )}
        {attempt.tokenUsage.output > 0 && (
          <span
            style={{
              width: `${barPercent(attempt.tokenUsage.output, tokenScale)}%`,
              background: "var(--color-status-done)",
            }}
          />
        )}
      </span>
      {attempt.compacted && (
        <span data-testid={`squad-run-attempt-compacted-${attempt.attemptId}`} className="shrink-0">
          <Badge status="blocked" tip={t("agentRuntime.squadRunCompactedTip")}>
            ⚠ {t("agentRuntime.squadRunCompacted")}
          </Badge>
        </span>
      )}
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

const totalTokens = (metrics: SquadRunAttemptMetricsDto): number =>
  metrics.tokenUsage.input + metrics.tokenUsage.output;
/** 可见面用紧凑记数(1.3M/210K),精确值进 title;固定 en-US 保证两种界面语言下数字形态稳定。 */
const compactTokens = (value: number): string => new Intl.NumberFormat("en-US", { notation: "compact" }).format(value);
const exactTokens = (value: number): string => new Intl.NumberFormat("en-US").format(value);
/** 条宽百分比(保留 1 位小数);分母为 0 时返回 0,不产 NaN。 */
const barPercent = (value: number, scale: number): number => (scale > 0 ? Math.round((value / scale) * 1000) / 10 : 0);
/** 占比整数标签;total 为 0 时诚实呈 0%。 */
const sharePercent = (value: number, total: number): number => (total > 0 ? Math.round((value / total) * 100) : 0);
