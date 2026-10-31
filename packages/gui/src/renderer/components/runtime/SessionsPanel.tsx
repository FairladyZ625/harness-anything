import { RuntimeHandoff } from "./RuntimeHandoff.tsx";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AgentRuntimeSessionDto, AgentRuntimeSessionResult } from "@harness-anything/daemon/protocol";
import { consumeKnownError } from "../../../api/error-consumption.ts";
import { agentRuntimeClient } from "../../agent-runtime-client.ts";
import { sessionDispatchIdOf, sessionInstallationBadge, type SessionRow, shortRef } from "../../sessions-model.ts";
import { t } from "../../i18n/index.tsx";
import { actorDisplayName } from "../../model/actor-name.ts";
import { formatDuration, formatTime } from "../../model/time.ts";
import { runtimeModelFullLabel } from "../../model/runtime-models.ts";
import {
  sessionElapsedMs,
  sessionOutputs,
  sessionVerdict,
  sessionVerdictKey,
  sessionVerdictTone,
  type SessionOutput,
  type SessionSettlement,
} from "../../model/session-achievement.ts";
import {
  conclusionVerdictTone,
  sessionConclusion,
  sessionConclusionSourceKey,
} from "../../model/session-conclusion.ts";
import { exactTokens } from "../../token-format.ts";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { SessionTranscript } from "../sessions/SessionTranscript.tsx";
import { Card, CardBody, CardHead, CardTitle, LiveDot, Right } from "./parts.tsx";
import { KV, KVRow } from "../primitives/Fields.tsx";
import { Empty } from "../primitives/Empty.tsx";
import { Button } from "../primitives/Button.tsx";
import { StatusTag } from "../primitives/StatusTag.tsx";
import { CacheTimer } from "../agent-ui/CacheTimer.tsx";
import { ContextMeter, type ContextSegment } from "../agent-ui/ContextMeter.tsx";
import type { PromptCacheTtlState } from "../../model/smart-attention.ts";
import type { SnapshotStatus, TaskRow } from "../../model/types.ts";
import { useMemo } from "react";

// Liveness vocabulary maps, not point comparisons: the daemon's liveness word decides the
// badge tone and the cancel affordance through table lookups alone.
const LIVENESS_BADGE: Record<string, SnapshotStatus> = { live: "active", exited: "done" };
const LIVENESS_LIVE: Record<string, boolean> = { live: true };
const MISSING_EVIDENCE_KEY = {
  "exit-code-and-result": "agentRuntime.outcomeMissingExitAndResult",
  "exit-code": "agentRuntime.outcomeMissingExit",
  result: "agentRuntime.outcomeMissingResult",
} as const;
/** 结局词 → 状态词条(与组列表同一个词表,不在详情另造一套结局措辞)。 */
const AUTH_MODE_KEY: Record<string, string> = {
  subscription: "agentRuntime.authModeSubscription",
  "api-key": "agentRuntime.authModeApiKey",
};
/** 任务包路径前缀之后的相对路径:文件页签按包相对路径读文档。 */
function packageRelative(path: string, packagePath: string | null | undefined): string | null {
  if (!packagePath) return null;
  const prefix = `${packagePath.replace(/\/+$/u, "")}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

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
  task = null,
  busy,
  onCancel,
  onResume,
  onOpenTask,
  onOpenTaskDoc,
  onNavigateEntity,
  cacheTtl,
  needsYou,
  remoteEdge = false,
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
  /** 该会话绑定任务的投影行(执行记录里带提交与产物):本次产出读它,不另设读面。 */
  readonly task?: Pick<TaskRow, "executions" | "packagePath"> | null;
  readonly busy: boolean;
  readonly onCancel: (runtimeSessionId: string) => void;
  readonly onResume: (dispatchId: string) => Promise<void>;
  readonly onOpenTask: (taskId: string) => void;
  /** 打开任务包内的一份文档(任务详情的文件页签);缺省时产物行只显示路径,不给假链接。 */
  readonly onOpenTaskDoc?: (taskId: string, path: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
  readonly cacheTtl?: PromptCacheTtlState | null;
  readonly needsYou?: boolean;
  readonly remoteEdge?: boolean;
}) {
  const [session, setSession] = useState<AgentRuntimeSessionDto | null>(null),
    [result, setResult] = useState<string | null>(null),
    [settlement, setSettlement] = useState<SessionSettlement | null>(null),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSession(snapshot?.session ?? null);
    setResult(snapshot?.result?.text ?? null);
    setSettlement(snapshot?.settlement ?? null);
    setError(snapshotError);
  }, [runtimeSessionId, snapshot, snapshotError]);
  const reread = useCallback(async () => {
    try {
      const current = await agentRuntimeClient.session(repoId, runtimeSessionId);
      setSession(current.session);
      setResult(current.result?.text ?? null);
      setSettlement(current.settlement ?? null);
    } catch (cause) {
      consumeKnownError(cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [repoId, runtimeSessionId]);
  const edgeRuntimeUnavailable = remoteEdge && snapshotError?.includes("runtime_session_not_found") === true;
  return (
    <>
      {edgeRuntimeUnavailable ? (
        <p data-testid="session-detail-edge-unavailable" role="status" className="ui-micro text-text-muted">
          {t("agentRuntime.edgeRuntimeDetailsUnavailable")}
        </p>
      ) : error ? (
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
          task={task}
          settlement={settlement}
          result={result}
          cacheTtl={cacheTtl}
          needsYou={needsYou}
          transcript={
            <SessionTranscript
              repoId={repoId}
              dispatchId={sessionDispatchIdOf(session, row)}
              live={LIVENESS_LIVE[session.liveness] ?? false}
              onSettled={reread}
              title={t("agentRuntime.transcript")}
            />
          }
          busy={busy}
          onCancel={onCancel}
          onResume={onResume}
          onOpenTask={onOpenTask}
          onOpenTaskDoc={onOpenTaskDoc}
          onNavigateEntity={onNavigateEntity}
        />
      )}
      {row?.kind === "round" && session?.kindId === "codex" && session.liveness === "exited" && (
        <RuntimeHandoff
          key={row.dispatchId}
          repoId={repoId}
          dispatchId={row.dispatchId}
          onNavigate={onNavigateEntity}
        />
      )}
    </>
  );
}

/** 当前上下文:只认 provider 自报的窗口填充,是「此刻占了多少」;累计消耗在另一张卡里,
 * 两个口径各自标注、互不冒充(业主 2026-10-21 定案:同一组数字不同屏出现两次)。 */
function SessionContextCard({
  context,
  compacted,
}: {
  readonly context: NonNullable<AgentRuntimeSessionDto["context"]>;
  readonly compacted: boolean | null | undefined;
}) {
  const segments: readonly ContextSegment[] = [
    { kind: "reserve", label: t("agentRuntime.sessionMetricsContextUsed"), tokens: context.usedTokens },
  ];
  return (
    <Card>
      <CardHead>
        <CardTitle>{t("agentRuntime.sessionMetricsContextLabel")}</CardTitle>
        {compacted === true && (
          <span data-testid="session-context-compacted">
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
        <div data-testid="session-detail-context" className="max-w-md">
          <ContextMeter segments={segments} limitTokens={context.windowTokens} testId="session-detail-context-meter" />
        </div>
      </CardBody>
    </Card>
  );
}

/** 会话消耗:累计输入/缓存读取/输出/总量与工具调用。累计 token 每轮重算缓存前缀,
 * 是求和而不是窗口占用:分段条只画组成,没有 meter 角色与百分比。 */
function SessionMetricsCard({ metrics }: { readonly metrics: NonNullable<AgentRuntimeSessionDto["metrics"]> }) {
  // satisfies 保住 kind 的字面量窄化:.filter 会切断数组字面量的上下文类型,直接标注会把 kind 拓宽成 string。
  const segments = (
    [
      { kind: "cache", label: t("agentRuntime.sessionMetricsCacheRead"), tokens: metrics.cacheReadTokens ?? 0 },
      { kind: "input", label: t("agentRuntime.sessionMetricsInput"), tokens: metrics.inputTokens ?? 0 },
      { kind: "output", label: t("agentRuntime.sessionMetricsOutput"), tokens: metrics.outputTokens ?? 0 },
    ] satisfies ContextSegment[]
  ).filter((s) => s.tokens > 0);

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
        {/* provider 不上报 token 时没有可画的组成:整个累计条连同比注一起消失,不留一个 0。 */}
        {metrics.usageUnavailable !== true && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="w-48 shrink-0">
              <ContextMeter segments={segments} testId="session-metrics-context-meter" />
            </div>
            <span className="ui-micro text-text-faint">{t("agentRuntime.sessionMetricsCumulativeNote")}</span>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** 本次产出:提交、交付文件、任务产物、结果报告。只有能真正打开的行才可点(产物走任务文档读面),
 * 仓库路径与提交号如实以文本给出,不造假链接。 */
function SessionOutputsCard({
  outputs,
  packagePath,
  onOpenDoc,
}: {
  readonly outputs: readonly SessionOutput[];
  readonly packagePath: string | null | undefined;
  readonly onOpenDoc: ((path: string) => void) | null;
}) {
  return (
    <Card>
      <CardHead>
        <CardTitle>{t("agentRuntime.sessionOutputs")}</CardTitle>
      </CardHead>
      <CardBody>
        <div data-testid="session-outputs">
          <KV>
            {outputs.map((output) =>
              output.kind === "commit" ? (
                <KVRow
                  key={`commit:${output.commitSha}`}
                  name={t("agentRuntime.sessionOutputCommit")}
                  title={output.commitSha}
                >
                  <span className="font-mono">{output.commitSha.slice(0, 10)}</span>
                </KVRow>
              ) : output.kind === "file" ? (
                <KVRow key={`file:${output.path}`} name={t("agentRuntime.sessionOutputFile")} title={output.path}>
                  <OutputPath path={output.path} />
                </KVRow>
              ) : (
                <KVRow
                  key={`${output.kind}:${output.path}`}
                  name={t(`agentRuntime.sessionOutput_${output.kind}` as never)}
                >
                  <OutputDocLink
                    path={output.path}
                    relative={packageRelative(output.path, packagePath)}
                    onOpenDoc={onOpenDoc}
                  />
                </KVRow>
              ),
            )}
          </KV>
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * 长路径的可读呈现:首屏给文件名,左对齐、单行截断,完整路径放悬停(title)。
 * 业主截图里的居中折行与参差缩进来自把整条路径塞进按钮的可见文字;文件名 + 悬停是
 * 同一条事实的两种密度,不丢内容。
 */
function OutputPath({ path }: { readonly path: string }) {
  return (
    <span className="block max-w-full truncate text-left font-mono" title={path}>
      {path.split("/").at(-1) ?? path}
    </span>
  );
}

/** 包内文档:能定位到包相对路径且宿主给了打开口 → 可点的按钮;否则只显示路径文本。 */
function OutputDocLink({
  path,
  relative,
  onOpenDoc,
}: {
  readonly path: string;
  readonly relative: string | null;
  readonly onOpenDoc: ((path: string) => void) | null;
}) {
  if (relative === null || onOpenDoc === null) return <OutputPath path={path} />;
  // 按钮默认是居中 inline-block(inline 内容的默认对齐),显式改成左对齐块级截断:
  // 业主截图里路径居中折行、缩进参差就是少了这一层。
  return (
    <button
      type="button"
      data-testid="session-open-output"
      data-path={relative}
      title={path}
      onClick={() => onOpenDoc(relative)}
      className="block max-w-full truncate text-left font-mono text-accent hover:underline"
    >
      {path.split("/").at(-1) ?? path}
    </button>
  );
}

// Pure projection of one runtime session: whose it is, which task it is bound to, and what
// it achieved. The container above owns the session read and durable replay timeline.
export function SessionDetailView({
  session,
  row,
  squadNames,
  taskTitles = new Map(),
  decisionRefs,
  task = null,
  settlement = null,
  result,
  transcript,
  busy,
  onCancel,
  onResume,
  onOpenTask,
  onOpenTaskDoc,
  onNavigateEntity,
  cacheTtl,
  needsYou,
}: {
  readonly session: AgentRuntimeSessionDto;
  readonly row: SessionRow | null;
  readonly squadNames: ReadonlyMap<string, string>;
  /** 同 SessionsPanel:缺省空表 = 没有挂载的投影,回落 id。 */
  readonly taskTitles?: ReadonlyMap<string, string>;
  readonly decisionRefs: readonly string[];
  /** 绑定任务的投影行:只取执行记录(提交/交付文件/产物)与评审记录,不复制整行的读面。 */
  readonly task?: Pick<TaskRow, "executions" | "reviews" | "packagePath"> | null;
  /** daemon 的终局裁决;没有它时按会话语义状态判。 */
  readonly settlement?: SessionSettlement | null;
  readonly result: string | null;
  readonly transcript: ReactNode;
  readonly busy: boolean;
  readonly onCancel: (runtimeSessionId: string) => void;
  readonly onResume: (dispatchId: string) => Promise<void>;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenTaskDoc?: (taskId: string, path: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
  readonly cacheTtl?: PromptCacheTtlState | null;
  readonly needsYou?: boolean;
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
    resume = row?.kind === "round" ? row.resume : null,
    // 结局:daemon settlement 优先,其次语义状态/结局词;live 会话一律「运行中」。
    verdict = sessionVerdict({
      liveness: session.liveness,
      ...(session.semanticState === undefined ? {} : { semanticState: session.semanticState }),
      outcome: session.activity.outcome,
      settlement,
    }),
    // 快照没落盘与「有快照但没写模型」是两种事实:前者沿用既有词条如实说快照缺失,
    // 后者说未记录模型,不把两种情况压成同一句话。
    modelLabel =
      session.definitionSnapshot === null
        ? t("agentRuntime.definitionSnapshotNotPersisted")
        : (runtimeModelFullLabel(session.definitionSnapshot.model) ?? t("agentRuntime.modelNotRecorded")),
    durationMs = sessionElapsedMs(row?.kind === "round" ? row : null),
    startedLabel = row === null ? null : formatTime(row.startedAt, { style: "date-time" }),
    outputs = useMemo(
      () =>
        sessionOutputs({
          executions: task?.executions,
          executionId: association?.executionId ?? null,
          reportPath: row?.kind === "round" ? row.reportPath : null,
        }),
      [task?.executions, association?.executionId, row],
    ),
    // 首屏结论:评审派工的 verdict+理由 / 本次执行的提交 claim / 失败裁决理由,
    // 最后才退回剔除过程叙述后的 result 原文(见 model/session-conclusion.ts)。
    conclusion = sessionConclusion({
      reviewTarget: row?.kind === "round" ? row.reviewTarget : null,
      reviews: task?.reviews,
      executions: task?.executions,
      executionId: association?.executionId ?? null,
      settlement,
      result,
    }),
    openOutputDoc =
      onOpenTaskDoc === undefined || target === null ? null : (path: string) => onOpenTaskDoc(target.taskId, path);
  const [confirmResume, setConfirmResume] = useState(false);

  return (
    <div data-testid="session-detail">
      <Card>
        <CardHead>
          {target !== null && taskLabel !== null ? (
            // 卡头标题就是「这次会话在干什么」:任务名是主文字,点击进任务详情(唯一任务出口)。
            <button
              type="button"
              data-testid="session-open-task"
              data-task={target.taskId}
              title={t("agentRuntime.openTask")}
              onClick={() => onOpenTask(target.taskId)}
              className="min-w-0 max-w-[52ch] truncate text-left ui-meta font-[650] text-text hover:text-accent"
            >
              {taskLabel}
            </button>
          ) : (
            <CardTitle>
              <EntityRefLink
                entityRef={`provider/${session.instanceId}`}
                onNavigate={onNavigateEntity}
                title={session.instanceId}
                className="text-text hover:text-accent hover:underline"
              >
                {session.instanceId}
              </EntityRefLink>
            </CardTitle>
          )}
          {/* 结局是首屏第二个答案:成 / 没成 / 还在跑,一个词。 */}
          <span data-testid="session-verdict">
            <StatusTag tone={sessionVerdictTone[verdict]} label={t(sessionVerdictKey[verdict] as never)} />
          </span>
          {needsYou ? (
            <StatusTag tone="agent-question" mono label={t("agentRuntime.smartClassNeedsYou")} />
          ) : (
            <StatusTag status={LIVENESS_BADGE[session.liveness] ?? "unknown"} mono label={session.liveness} />
          )}
          {installationBadge && (
            <StatusTag tone="neutral" mono tip={session.installationError?.hint} label={t(installationBadge)} />
          )}
          {squadName && (
            <span
              data-testid="session-owner-squad"
              className={
                "inline-flex items-center gap-1 rounded-sm border border-border-strong " +
                "px-1.5 ui-micro text-text-muted"
              }
            >
              <LiveDot state="idle" />
              {squadName}
            </span>
          )}
          {/* 面包屑并入卡头(S5 身份只写一遍):会话 id 的可寻址出口收进这里,可见文字
              用短码(运行时 id 不当主文字),悬停给完整引用。 */}
          <EntityRefLink
            entityRef={`session/${session.runtimeSessionId}`}
            onNavigate={onNavigateEntity}
            title={session.runtimeSessionId}
            className="font-mono ui-micro text-text-faint hover:text-accent hover:underline"
          >
            {`session/${shortRef(session.runtimeSessionId, 14)}`}
          </EntityRefLink>
          <div className="flex items-center gap-2" data-testid="session-detail-meters">
            {cacheTtl != null && (
              <CacheTimer
                state={cacheTtl.kind}
                remainingMs={cacheTtl.remainingMs}
                testId="session-detail-cache-timer"
              />
            )}
          </div>
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
          {/* 身份行:谁在跑、用的什么模型、哪个实例、跑了多久。可读字段留在首屏。 */}
          <dl data-testid="session-identity" className="flex flex-wrap items-baseline gap-x-4 gap-y-1 ui-micro">
            {agentName !== null && (
              <div className="flex items-baseline gap-1.5">
                <dt className="font-mono uppercase tracking-[0.07em] text-text-faint">
                  {t("agentRuntime.sessionIdentityAgent")}
                </dt>
                <dd className="text-text">{agentName}</dd>
              </div>
            )}
            <div className="flex min-w-0 items-baseline gap-1.5">
              <dt className="font-mono uppercase tracking-[0.07em] text-text-faint">
                {t("agentRuntime.sessionIdentityModel")}
              </dt>
              <dd className="min-w-0 truncate text-text" title={modelLabel}>
                {modelLabel}
              </dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="font-mono uppercase tracking-[0.07em] text-text-faint">
                {t("agentRuntime.sessionIdentityInstance")}
              </dt>
              <dd>
                <EntityRefLink
                  entityRef={`provider/${session.instanceId}`}
                  onNavigate={onNavigateEntity}
                  title={session.instanceId}
                  className="text-accent hover:underline"
                />
              </dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="font-mono uppercase tracking-[0.07em] text-text-faint">
                {t(
                  durationMs === null ? "agentRuntime.sessionIdentityStarted" : "agentRuntime.sessionIdentityDuration",
                )}
              </dt>
              <dd className="text-text" title={row?.kind === "round" ? (row.endedAt ?? undefined) : undefined}>
                {durationMs === null ? (startedLabel ?? "—") : formatDuration(durationMs)}
              </dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="font-mono uppercase tracking-[0.07em] text-text-faint">
                {t("agentRuntime.facts.lastActivity")}
              </dt>
              <dd className="text-text" title={session.activity.lastObservedAt}>
                {formatTime(session.activity.lastObservedAt, { style: "date-time" }) ?? session.activity.lastObservedAt}
              </dd>
            </div>
            {row?.kind === "round" && row.delegation !== null && (
              <div className="flex items-baseline gap-1.5">
                <dt className="font-mono uppercase tracking-[0.07em] text-text-faint">
                  {t("agentRuntime.facts.delegation")}
                </dt>
                <dd className="text-text">{row.delegation}</dd>
              </div>
            )}
          </dl>
          {/* 最终结论:先给这次会话的裁决/结论(评审 verdict+理由、worker 的提交 claim、
              失败裁决理由),不是 agent 最后一条消息的过程叙述;全文可展开,长行换行不裁。 */}
          <div className="mt-2.5" data-testid="session-conclusion">
            <p className="mb-1 flex flex-wrap items-baseline gap-x-2 font-mono ui-micro uppercase tracking-[0.07em] text-text-faint">
              <span>{t("agentRuntime.sessionConclusion")}</span>
              {conclusion.source !== "none" && (
                <span data-testid="session-conclusion-source" className="normal-case tracking-normal text-text-faint">
                  {t(sessionConclusionSourceKey[conclusion.source] as never)}
                </span>
              )}
              {conclusion.verdict !== null && (
                <span data-testid="session-conclusion-verdict">
                  <StatusTag
                    tone={conclusionVerdictTone[conclusion.verdict]}
                    label={t(
                      (conclusion.verdict === "approved"
                        ? "views.decisionReview.verdictApproved"
                        : conclusion.verdict === "changes_requested"
                          ? "views.decisionReview.verdictChangesRequested"
                          : "agentRuntime.sessionVerdictUnknown") as never,
                    )}
                  />
                </span>
              )}
            </p>
            {conclusion.source === "none" ? (
              <Empty>
                {session.liveness === "live"
                  ? t("agentRuntime.sessionConclusionRunning")
                  : t("agentRuntime.sessionConclusionMissing")}
              </Empty>
            ) : (
              // 全文照给,长行换行(rt-pre-wrap 收换行口径),块内滚动而不截断成几句。
              <p data-testid="session-conclusion-text" className="rt-pre rt-pre-wrap bounded-content">
                {conclusion.text}
              </p>
            )}
          </div>
          {session.activity.missingEvidence !== null && (
            <p data-testid="session-missing-evidence" className="mt-1 ui-micro text-status-submitted">
              {t(MISSING_EVIDENCE_KEY[session.activity.missingEvidence])}
            </p>
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
      {/* 本次产出:有才画(规范 1.5「空了就消失」)。 */}
      {outputs.length > 0 && (
        <SessionOutputsCard outputs={outputs} packagePath={task?.packagePath} onOpenDoc={openOutputDoc} />
      )}
      {/* 当前上下文只画一次:provider 没报窗口就没有这一块(不猜默认分母)。 */}
      {session.context !== undefined && (
        <SessionContextCard context={session.context} compacted={session.metrics?.compacted} />
      )}
      {session.metrics != null && <SessionMetricsCard metrics={session.metrics} />}
      {/* 会话记录自带卡片,没有记录时由它自己整块不渲染。 */}
      {transcript}
      {/* 原始字段全部收进默认折叠的「技术详情」(业主 2026-10-21 定案):首屏回答「做成了什么」,
          排查时才需要的 provider 会话 id、定义快照、认证方式、租约、游标在这里按需展开。 */}
      <details
        data-testid="session-technical-details"
        className="mb-3 rounded-lg border border-border bg-surface-raised"
      >
        <summary className="cursor-pointer px-3 py-2 ui-meta font-[550] text-text-muted hover:text-text">
          {t("agentRuntime.sessionTechnicalDetails")}
        </summary>
        <div className="border-t border-border px-3 py-2.5">
          <KV>
            <KVRow name={t("agentRuntime.techProviderSession")} title={session.providerSessionId ?? undefined}>
              {session.providerSessionId ?? "—"}
            </KVRow>
            <KVRow name={t("agentRuntime.techDefinitionSnapshot")} title={session.definitionSnapshotRef}>
              {session.definitionSnapshotRef}
            </KVRow>
            <KVRow name={t("agentRuntime.facts.model")}>{modelLabel}</KVRow>
            <KVRow name={t("agentRuntime.techAuthMode")}>
              {session.definitionSnapshot?.authMode === undefined
                ? "—"
                : t(
                    (AUTH_MODE_KEY[session.definitionSnapshot.authMode] ??
                      session.definitionSnapshot.authMode) as never,
                  )}
            </KVRow>
            <KVRow name={t("agentRuntime.facts.outcome")}>{session.activity.outcome ?? "—"}</KVRow>
            <KVRow name={t("agentRuntime.facts.exitCode")}>{session.activity.exitCode ?? "—"}</KVRow>
            {session.activity.reasonCode !== undefined && (
              <KVRow name={t("agentRuntime.facts.reasonCode")}>{session.activity.reasonCode}</KVRow>
            )}
            <KVRow name={t("agentRuntime.facts.holder")}>
              {association?.holder?.personId
                ? actorDisplayName(association.holder.personId).name
                : t("agentRuntime.unheld")}
            </KVRow>
            <KVRow name={t("agentRuntime.techLease")}>
              {association?.lease === null || association?.lease === undefined
                ? "—"
                : `${association.lease.phase} · ${formatTime(association.lease.expiresAt, { style: "date-time-seconds" }) ?? association.lease.expiresAt}`}
            </KVRow>
            <KVRow name={t("agentRuntime.techAttach")}>{session.attachCapability}</KVRow>
            <KVRow name={t("agentRuntime.techStreamCursor")} title={session.streamCursor ?? undefined}>
              {session.streamCursor ?? "—"}
            </KVRow>
            {row?.kind === "round" && (
              <KVRow name={t("agentRuntime.techDispatch")} title={row.dispatchId}>
                {shortRef(row.dispatchId, 18)}
              </KVRow>
            )}
          </KV>
        </div>
      </details>
    </div>
  );
}
