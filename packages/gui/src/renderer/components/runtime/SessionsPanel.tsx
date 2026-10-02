import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AgentRuntimeSessionDto, AgentRuntimeSessionResult } from "@harness-anything/daemon/protocol";
import { consumeKnownError } from "../../../api/error-consumption.ts";
import { agentRuntimeClient } from "../../agent-runtime-client.ts";
import { sessionInstallationBadge, type SessionRow, shortRef } from "../../sessions-model.ts";
import { t } from "../../i18n/index.tsx";
import { actorDisplayName } from "../../model/actor-name.ts";
import { formatTime } from "../../model/time.ts";
import { exactTokens } from "../../token-format.ts";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { SessionTranscript } from "../sessions/SessionTranscript.tsx";
import { Avatar, Card, CardBody, CardHead, CardTitle, Crumbs, CrumbSep, Hint, LiveDot, Right } from "./parts.tsx";
import { KV, KVRow } from "../primitives/Fields.tsx";
import { Empty } from "../primitives/Empty.tsx";
import { Button } from "../primitives/Button.tsx";
import { StatusTag } from "../primitives/StatusTag.tsx";
import type { SnapshotStatus } from "../../model/types";

// Liveness vocabulary maps, not point comparisons: the daemon's liveness word decides the
// badge tone and the cancel affordance through table lookups alone.
const LIVENESS_BADGE: Record<string, SnapshotStatus> = { live: "active", exited: "done" };
const LIVENESS_LIVE: Record<string, boolean> = { live: true };
const MISSING_EVIDENCE_KEY = {
  "exit-code-and-result": "agentRuntime.outcomeMissingExitAndResult",
  "exit-code": "agentRuntime.outcomeMissingExit",
  result: "agentRuntime.outcomeMissingResult",
} as const;

// The first-class Sessions view: the main area behind the group list's selected session, at
// the same rank as the runtime / agent / squad cards. Every fact comes from the daemon
// projection — the session read, the durable dispatch stream, and the group row the page
// already holds — nothing is inferred or re-derived here.
export function SessionsPanel({
  repoId,
  runtimeSessionId,
  snapshot,
  snapshotError,
  row,
  squadNames,
  taskTitles = new Map(),
  decisionRefs,
  busy,
  onCancel,
  onResume,
  onOpenTask,
  onNavigateEntity,
}: {
  readonly repoId: string;
  readonly runtimeSessionId: string;
  readonly snapshot: AgentRuntimeSessionResult | null;
  readonly snapshotError: string | null;
  readonly row: SessionRow | null;
  readonly squadNames: ReadonlyMap<string, string>;
  /** `task/<id>` → 标题索引(常驻任务列表投影):任务框主文字用任务标题,查不到才显示 id。
   * 缺省空表 = 没有挂载的投影,按查不到回落 id。 */
  readonly taskTitles?: ReadonlyMap<string, string>;
  readonly decisionRefs: readonly string[];
  readonly busy: boolean;
  readonly onCancel: (runtimeSessionId: string) => void;
  readonly onResume: (dispatchId: string) => Promise<void>;
  readonly onOpenTask: (taskId: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const [session, setSession] = useState<AgentRuntimeSessionDto | null>(null),
    [result, setResult] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSession(snapshot?.session ?? null);
    setResult(snapshot?.result?.text ?? null);
    setError(snapshotError);
  }, [runtimeSessionId, snapshot, snapshotError]);
  const reread = useCallback(async () => {
    try {
      const current = await agentRuntimeClient.session(repoId, runtimeSessionId);
      setSession(current.session);
      setResult(current.result?.text ?? null);
    } catch (cause) {
      consumeKnownError(cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [repoId, runtimeSessionId]);
  return (
    <>
      <Crumbs>
        <span>{t("agentRuntime.segSessions")}</span>
        <CrumbSep />
        {/* G10:载体 ID 出现就必须是路——无 agent 名时回落为 provider 链接而非死文本。 */}
        {((row?.kind === "round" ? row.agentName : null) ?? row?.instanceId ?? null) ? (
          <b className="font-semibold text-text-muted">
            {(row?.kind === "round" ? row.agentName : null) ?? row?.instanceId}
          </b>
        ) : session === null ? null : (
          <b className="font-semibold text-text-muted">
            <EntityRefLink
              entityRef={`provider/${session.instanceId}`}
              onNavigate={onNavigateEntity}
              title={session.instanceId}
              className="text-text-muted hover:text-accent hover:underline"
            >
              {session.instanceId}
            </EntityRefLink>
          </b>
        )}
        <CrumbSep />
        <EntityRefLink
          entityRef={`session/${runtimeSessionId}`}
          onNavigate={onNavigateEntity}
          title={runtimeSessionId}
          className="font-mono text-text-muted hover:text-accent hover:underline"
        />
      </Crumbs>
      {error ? (
        <p role="alert" className="ui-micro text-status-blocked">
          {error}
        </p>
      ) : session === null ? (
        <Empty>{t("agentRuntime.loading")}</Empty>
      ) : (
        <SessionDetailView
          session={session}
          row={row}
          squadNames={squadNames}
          taskTitles={taskTitles}
          decisionRefs={decisionRefs}
          result={result}
          transcript={
            <SessionTranscript
              repoId={repoId}
              dispatchId={row?.kind === "round" ? row.dispatchId : null}
              live={LIVENESS_LIVE[session.liveness] ?? false}
              onSettled={reread}
              title={t("agentRuntime.transcript")}
            />
          }
          busy={busy}
          onCancel={onCancel}
          onResume={onResume}
          onOpenTask={onOpenTask}
          onNavigateEntity={onNavigateEntity}
        />
      )}
    </>
  );
}

/** 会话消耗面板:该会话派工的输入/缓存读取/输出/总 Token、工具调用与 compaction 标记。 */
function SessionMetricsCard({ metrics }: { readonly metrics: NonNullable<AgentRuntimeSessionDto["metrics"]> }) {
  return (
    <Card>
      <CardHead>
        <CardTitle>{t("agentRuntime.sessionMetricsTitle")}</CardTitle>
        {metrics.compacted === true && (
          <span data-testid="session-metrics-compacted">
            <StatusTag
              status="blocked"
              mono
              tip={t("agentRuntime.sessionMetricsCompactedTip")}
              label={`⚠ ${t("agentRuntime.sessionMetricsCompacted")}`}
            />
          </span>
        )}
      </CardHead>
      <CardBody>
        <div data-testid="session-metrics">
          <KV>
            {metrics.usageUnavailable === true ? (
              <KVRow name={t("agentRuntime.sessionMetricsTokens")}>
                <span data-testid="session-metrics-unavailable">{t("agentRuntime.sessionMetricsUnavailable")}</span>
              </KVRow>
            ) : (
              <>
                <KVRow name={t("agentRuntime.sessionMetricsInput")}>{exactTokens(metrics.inputTokens)}</KVRow>
                <KVRow name={t("agentRuntime.sessionMetricsCacheRead")}>{exactTokens(metrics.cacheReadTokens)}</KVRow>
                <KVRow name={t("agentRuntime.sessionMetricsOutput")}>{exactTokens(metrics.outputTokens)}</KVRow>
                <KVRow name={t("agentRuntime.sessionMetricsTotal")}>{exactTokens(metrics.totalTokens)}</KVRow>
              </>
            )}
            <KVRow name={t("agentRuntime.sessionMetricsTools")}>{metrics.toolCallCount}</KVRow>
          </KV>
        </div>
      </CardBody>
    </Card>
  );
}

// Pure projection of one runtime session: whose it is, which task it is bound to, and what
// is happening right now. The container above owns the session read and durable replay timeline.
export function SessionDetailView({
  session,
  row,
  squadNames,
  taskTitles = new Map(),
  decisionRefs,
  result,
  transcript,
  busy,
  onCancel,
  onResume,
  onOpenTask,
  onNavigateEntity,
}: {
  readonly session: AgentRuntimeSessionDto;
  readonly row: SessionRow | null;
  readonly squadNames: ReadonlyMap<string, string>;
  /** 同 SessionsPanel:缺省空表 = 没有挂载的投影,回落 id。 */
  readonly taskTitles?: ReadonlyMap<string, string>;
  readonly decisionRefs: readonly string[];
  readonly result: string | null;
  readonly transcript: ReactNode;
  readonly busy: boolean;
  readonly onCancel: (runtimeSessionId: string) => void;
  readonly onResume: (dispatchId: string) => Promise<void>;
  readonly onOpenTask: (taskId: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  // 任务出口:组行携带 taskId 时用它(带标题),否则回落会话关联的第一个任务。
  const association = session.associations[0],
    rowTaskId = row === null ? null : row.taskId,
    rowTaskTitle = row === null || row.taskTitle === undefined ? null : row.taskTitle,
    target =
      rowTaskId !== null
        ? { taskId: rowTaskId, taskTitle: rowTaskTitle }
        : association
          ? { taskId: association.taskId, taskTitle: null }
          : null,
    // 主文字用任务标题:组行没有时按 id 查常驻任务投影(视觉基线 v2:机器编号不当标题)。
    taskLabel = target === null ? null : (target.taskTitle ?? taskTitles.get(`task/${target.taskId}`) ?? target.taskId),
    agentName = row?.kind === "round" ? row.agentName : null,
    squadId = row?.kind === "round" ? row.squadId : null,
    squadName = squadId === null ? null : (squadNames.get(squadId) ?? squadId),
    installationBadge = sessionInstallationBadge(session),
    resume = row?.kind === "round" ? row.resume : null;
  const [confirmResume, setConfirmResume] = useState(false);
  return (
    <div data-testid="session-detail">
      <Card>
        <CardHead>
          <CardTitle>
            {agentName ?? (
              <EntityRefLink
                entityRef={`provider/${session.instanceId}`}
                onNavigate={onNavigateEntity}
                title={session.instanceId}
                className="text-text hover:text-accent hover:underline"
              >
                {session.instanceId}
              </EntityRefLink>
            )}
          </CardTitle>
          <StatusTag status={LIVENESS_BADGE[session.liveness] ?? "unknown"} mono label={session.liveness} />
          {installationBadge && (
            <StatusTag tone="neutral" mono tip={session.installationError?.hint} label={t(installationBadge)} />
          )}
          <Right>
            {LIVENESS_LIVE[session.liveness] && (
              <Button
                size="sm"
                variant="danger"
                testId="agent-runtime-cancel"
                disabled={busy}
                onClick={() => onCancel(session.runtimeSessionId)}
              >
                {t("agentRuntime.cancelSession")}
              </Button>
            )}
            {resume && (
              <Button size="sm" testId="agent-runtime-resume" disabled={busy} onClick={() => setConfirmResume(true)}>
                {t("agentRuntime.resumeSession")}
              </Button>
            )}
            <Hint>{t("agentRuntime.livenessFromChild")}</Hint>
          </Right>
        </CardHead>
        <CardBody>
          {confirmResume && resume && (
            <div
              role="alertdialog"
              aria-label={t("agentRuntime.resumeConfirmTitle")}
              className="mb-3 rounded border border-accent/50 bg-accent/[0.06] p-3"
            >
              <p className="ui-body font-semibold">{t("agentRuntime.resumeConfirmTitle")}</p>
              <p className="mt-1 ui-micro text-text-muted">
                {t("agentRuntime.resumeConfirmDetails", {
                  agent: resume.agentId ?? t("agentRuntime.notBound"),
                  task: target?.taskId ?? t("agentRuntime.noTask"),
                })}
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  testId="agent-runtime-resume-confirm"
                  disabled={busy}
                  onClick={() => void onResume(resume.dispatchId)}
                >
                  {t("agentRuntime.resumeConfirm")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmResume(false)}>
                  {t("agentRuntime.resumeCancel")}
                </Button>
              </div>
            </div>
          )}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Avatar id={agentName ?? session.instanceId} />
            <b className="ui-body font-[650]">
              {agentName ?? (
                <EntityRefLink
                  entityRef={`provider/${session.instanceId}`}
                  onNavigate={onNavigateEntity}
                  title={session.instanceId}
                  className="text-text hover:text-accent hover:underline"
                >
                  {session.instanceId}
                </EntityRefLink>
              )}
            </b>
            {squadName && (
              <span
                data-testid="session-owner-squad"
                className={
                  "inline-flex items-center gap-1 rounded-[3px] border border-border-strong " +
                  "px-1.5 ui-micro text-text-muted"
                }
              >
                <LiveDot state="idle" />
                {squadName}
              </span>
            )}
            <span className="flex min-w-0 items-center gap-1 font-mono ui-micro text-text-faint">
              <EntityRefLink
                entityRef={`provider/${session.instanceId}`}
                onNavigate={onNavigateEntity}
                title={session.instanceId}
                className="text-text-faint hover:text-accent hover:underline"
              />{" "}
              · {session.definitionSnapshot?.model ?? t("agentRuntime.definitionSnapshotNotPersisted")}
              {!session.definitionSnapshotPersisted && session.definitionSnapshot !== null
                ? ` · ${t("agentRuntime.definitionSnapshotNotPersisted")}`
                : ""}
            </span>
          </div>
          {/* 没绑定任务时整段不渲染(规范 1.5「空了就消失」)。 */}
          {target !== null && (
            <h3 className="mb-1 font-mono ui-micro uppercase tracking-[0.07em] text-text-faint">
              {t("agentRuntime.sessionTaskSection")}
            </h3>
          )}
          {target !== null && (
            <button
              type="button"
              data-testid="session-open-task"
              data-task={target.taskId}
              title={t("agentRuntime.openTask")}
              onClick={() => onOpenTask(target.taskId)}
              className={
                "flex w-full items-center gap-2 rounded border border-border px-2.5 py-1.5 text-left " +
                "hover:border-accent/50 hover:bg-accent/[0.06]"
              }
            >
              <span className="min-w-0 flex-1 truncate ui-meta font-[550]">{taskLabel}</span>
              <span className="shrink-0 font-mono ui-micro text-text-faint" title={target.taskId}>
                {shortRef(target.taskId, 14)}
              </span>
              <span aria-hidden className="shrink-0 ui-micro text-text-faint">
                ↗
              </span>
            </button>
          )}
          {/* 该任务 Decision:全局关系里 decision→task 边派生;无边时整段隐藏(不占位)。 */}
          {target !== null && decisionRefs.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="font-mono ui-micro uppercase tracking-[0.06em] text-text-faint">
                {t("agentRuntime.sessionsTaskDecisionLabel")}
              </span>
              {decisionRefs.map((decisionRef) => (
                <EntityRefLink
                  key={decisionRef}
                  entityRef={decisionRef}
                  onNavigate={onNavigateEntity}
                  title={decisionRef}
                  className={
                    "rounded border border-border px-1.5 py-px font-mono ui-micro text-text-muted " +
                    "hover:border-accent hover:text-accent"
                  }
                >
                  {shortRef(decisionRef.split("/")[1] ?? decisionRef, 14)}
                </EntityRefLink>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
      {/* 单次会话消耗面板(P1.3):数据随会话读的 metrics 字段下发——与 liveness 同一份
          dispatch stream summary。未上报、无结果文本时整块不渲染(规范 1.5)。 */}
      {session.metrics != null && <SessionMetricsCard metrics={session.metrics} />}
      {result !== null && (
        <Card>
          <CardHead>
            <CardTitle>{t("agentRuntime.resultText")}</CardTitle>
          </CardHead>
          <CardBody>
            <pre className="rt-pre max-h-56 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{result}</pre>
          </CardBody>
        </Card>
      )}
      {/* 会话记录自带卡片,没有记录时由它自己整块不渲染。 */}
      {transcript}
      <Card>
        <CardHead>
          <CardTitle>{t("agentRuntime.sessionFacts")}</CardTitle>
        </CardHead>
        <CardBody>
          <KV>
            <KVRow name={t("agentRuntime.facts.session")}>
              <EntityRefLink
                entityRef={`session/${session.runtimeSessionId}`}
                onNavigate={onNavigateEntity}
                title={session.runtimeSessionId}
                className="text-accent hover:underline"
              />
            </KVRow>
            <KVRow name={t("agentRuntime.facts.providerSession")}>
              <span title={session.providerSessionId ?? undefined}>
                {session.providerSessionId ?? t("agentRuntime.notBound")}
              </span>
            </KVRow>
            <KVRow name={t("agentRuntime.facts.instance")}>
              <EntityRefLink
                entityRef={`provider/${session.instanceId}`}
                onNavigate={onNavigateEntity}
                title={session.instanceId}
                className="text-accent hover:underline"
              />
            </KVRow>
            <KVRow name={t("agentRuntime.facts.model")}>
              {session.definitionSnapshot?.model ?? t("agentRuntime.definitionSnapshotNotPersisted")}
            </KVRow>
            <KVRow name={t("agentRuntime.facts.auth")}>{session.definitionSnapshot?.authMode ?? "—"}</KVRow>
            <KVRow name={t("agentRuntime.facts.snapshot")} title={session.definitionSnapshotRef ?? undefined}>
              {session.definitionSnapshotPersisted
                ? session.definitionSnapshotRef
                : t("agentRuntime.definitionSnapshotNotPersisted")}
            </KVRow>
            <KVRow name={t("agentRuntime.facts.outcome")}>{session.activity.outcome ?? "—"}</KVRow>
            {session.activity.missingEvidence !== null && (
              <KVRow name={t("agentRuntime.facts.missingEvidence")}>
                {t(MISSING_EVIDENCE_KEY[session.activity.missingEvidence])}
              </KVRow>
            )}
            <KVRow name={t("agentRuntime.facts.exitCode")}>{session.activity.exitCode ?? "—"}</KVRow>
            <KVRow name={t("agentRuntime.facts.result")} title={session.activity.resultRef ?? undefined}>
              {session.activity.resultRef ?? "—"}
            </KVRow>
            <KVRow name={t("agentRuntime.facts.task")}>
              {target !== null ? (
                <EntityRefLink
                  entityRef={`task/${target.taskId}`}
                  onNavigate={(ref) => onOpenTask(ref.slice(5))}
                  title={target.taskId}
                  className="text-accent hover:underline"
                >
                  {taskLabel}
                </EntityRefLink>
              ) : (
                "—"
              )}
            </KVRow>
            <KVRow name={t("agentRuntime.facts.holder")}>
              {association?.holder?.personId
                ? actorDisplayName(association.holder.personId).name
                : t("agentRuntime.unheld")}
            </KVRow>
            <KVRow
              name={t("agentRuntime.facts.lease")}
              title={association?.lease ? association.lease.expiresAt : undefined}
            >
              {association?.lease
                ? `${association.lease.phase} · ${formatTime(association.lease.expiresAt, { style: "date-time" }) ?? association.lease.expiresAt}`
                : t("agentRuntime.noLease")}
            </KVRow>
            <KVRow name={t("agentRuntime.facts.dispatch")}>
              {row?.kind === "round" && target !== null ? (
                <EntityRefLink
                  entityRef={`task/${target.taskId}`}
                  onNavigate={(ref) => onOpenTask(ref.slice(5))}
                  title={t("agentRuntime.sessionsDispatchChain", { dispatchId: row.dispatchId })}
                  className="text-accent hover:underline"
                >
                  {row.dispatchId}
                </EntityRefLink>
              ) : row?.kind === "round" ? (
                row.dispatchId
              ) : (
                "—"
              )}
            </KVRow>
            <KVRow name={t("agentRuntime.facts.delegation")}>
              {row?.kind === "round" ? (row.delegation ?? "—") : "—"}
            </KVRow>
            <KVRow name={t("agentRuntime.facts.lastActivity")} title={session.activity.lastObservedAt ?? undefined}>
              {formatTime(session.activity.lastObservedAt, { style: "date-time" }) ??
                session.activity.lastObservedAt ??
                "—"}
            </KVRow>
          </KV>
        </CardBody>
      </Card>
    </div>
  );
}
