import { TabPanel } from "../components/primitives/EntryBoundary.tsx";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, PencilSimple, Play, Power, Stop, Trash } from "@phosphor-icons/react";
import type { ScheduleGuiOptionsDto, ScheduleGuiRowDto } from "@harness-anything/daemon/protocol";
import { Badge, Btn, Chip, Empty } from "../components/runtime/parts.tsx";
import { ScheduleForm } from "../components/ScheduleFormDialog.tsx";
import { ScheduleRunDetail } from "../components/scheduleRun/ScheduleRunDetail.tsx";
import { RUN_OUTCOME_META, SPARK_COLOR, missedReasonLabel, time } from "../components/scheduleRun/runMeta.ts";
import { formatDuration } from "../model/time.ts";
import { DenseRow } from "../components/primitives/DenseRow.tsx";
import { Region } from "../components/primitives/Region.tsx";
import { BoardColumn, BoardMain, BoardRegion, BoardSide, RegionBoard } from "../components/primitives/RegionBoard.tsx";
import { StatusTag } from "../components/primitives/StatusTag.tsx";
import { Tabs } from "../components/primitives/Tabs.tsx";
import { TitleText } from "../components/primitives/TitleText.tsx";
import { ViewInGraphButton } from "../components/ViewInGraphButton.tsx";
import { t, type MessageKey } from "../i18n/index.tsx";
import {
  schedulesClient,
  scheduleRunRef,
  scheduleRunRefOccurrence,
  scheduleRowHealth,
  scheduleRowMode,
  scheduleRowTargetKind,
  type ScheduleActionReceipt,
  type ScheduleBuiltinEditInput,
  type ScheduleDefinitionInput,
  type ScheduleGuiRunRowDto,
  type ScheduleRunOutcomeWord,
} from "../schedules-client.ts";

// Schedule detail hub (design M2–M5, 视觉基线 v1 §2.2 文档型页面): the list row ref
// `schedule/<id>` renders this page. Everything shown is a daemon fact — the list row, the
// occurrence rows (`schedule-run-history`), and the embedded run detail (报告正文、产出互链、
// 失败详情都在那一页)。Run sessions render here by design; the old jump into the global
// Sessions view is gone.

const AVAILABILITY_META: Record<ScheduleGuiRowDto["executionAvailability"], MessageKey> = {
  local: "schedules.availability.local",
  "claimed-elsewhere": "schedules.availability.claimedElsewhere",
  unassigned: "schedules.availability.unassigned",
  "not-on-this-node": "schedules.availability.notOnThisNode",
};
const TARGET_STATE_KEY: Readonly<Record<NonNullable<ScheduleGuiRowDto["targetState"]>, MessageKey>> = {
  invalid: "agentRuntime.catalogInvalid",
  missing: "agentRuntime.catalogMissing",
};
const OUTCOME_META: Record<string, MessageKey> = {
  succeeded: "schedules.outcome.succeeded",
  failed: "schedules.outcome.failed",
  unknown: "schedules.outcome.unknown",
  cancelled: "schedules.outcome.cancelled",
};
const OUTCOME_TONE: Record<string, "done" | "bad" | "neutral" | "active"> = {
  succeeded: "done",
  failed: "bad",
  cancelled: "neutral",
  unknown: "neutral",
  running: "active",
};

// Word → label lookups stay total: an unknown daemon word renders as the shared
// "unknown" label, never a crash.
const outcomeLabel = (outcome: string): MessageKey =>
  outcome in OUTCOME_META ? OUTCOME_META[outcome] : "schedules.outcome.unknown";

/**
 * Fallback occurrence rows while the runs read fails (daemon unreachable): exactly
 * the occurrences the list read already carries (activeRun, lastRun) plus the missed
 * aggregate, with the read failure labeled as an error — not as a pending backend.
 */
export function deriveScheduleRunRows(row: ScheduleGuiRowDto): readonly ScheduleGuiRunRowDto[] {
  const rows: ScheduleGuiRunRowDto[] = [];
  if (row.activeRun !== null) {
    rows.push({
      occurrenceId: row.activeRun.occurrenceId,
      kind: row.activeRun.kind,
      scheduledFor: row.activeRun.scheduledFor,
      claimedAt: row.activeRun.claimedAt,
      endedAt: null,
      durationMs: null,
      nodeId: row.activeRun.nodeId,
      attemptIndex: row.activeRun.attemptIndex,
      dispatchId: row.activeRun.dispatchId,
      runtimeSessionId: row.activeRun.runtimeSessionId,
      outcome: "running",
      missedReason: null,
      reportRef: null,
      reportText: null,
      detail: null,
      outputs: { facts: [], decisions: [], tasks: [] },
    });
  }
  if (row.lastRun !== null && row.lastRun.occurrenceId !== row.activeRun?.occurrenceId) {
    const settled = Date.parse(row.lastRun.endedAt),
      scheduled = Date.parse(row.lastRun.scheduledFor);
    rows.push({
      occurrenceId: row.lastRun.occurrenceId,
      kind: "scheduled",
      scheduledFor: row.lastRun.scheduledFor,
      claimedAt: null,
      endedAt: row.lastRun.endedAt,
      durationMs: Number.isFinite(settled) && Number.isFinite(scheduled) ? settled - scheduled : null,
      nodeId: row.lastRun.nodeId,
      attemptIndex: row.lastRun.attemptIndex,
      dispatchId: row.lastRun.dispatchId,
      runtimeSessionId: row.lastRun.runtimeSessionId,
      outcome: row.lastRun.outcome in RUN_OUTCOME_META ? (row.lastRun.outcome as ScheduleRunOutcomeWord) : "unknown",
      missedReason: null,
      reportRef: null,
      reportText: null,
      detail: row.lastRun.detail,
      outputs: { facts: [], decisions: [], tasks: [] },
    });
  }
  if (row.missed.count > 0) {
    rows.push({
      occurrenceId: "",
      kind: null,
      scheduledFor: row.missed.lastMissedAt ?? "",
      claimedAt: null,
      endedAt: null,
      durationMs: null,
      nodeId: null,
      attemptIndex: null,
      dispatchId: null,
      runtimeSessionId: null,
      outcome: "missed",
      missedReason: row.missed.lastMissedReason,
      reportRef: null,
      reportText: null,
      detail: null,
      outputs: { facts: [], decisions: [], tasks: [] },
    });
  }
  return rows;
}

type Tab = "overview" | "danger";

export function ScheduleDetailView({
  repoId,
  row,
  options,
  scheduleIds,
  focusedEntityRef,
  busy,
  receipt,
  actionError,
  onAction,
  onSave,
  onDelete,
  onSelectEntity,
  onFocusGraph,
  onExitRun,
  onExit,
}: {
  readonly repoId: string;
  readonly row: ScheduleGuiRowDto;
  readonly options: ScheduleGuiOptionsDto;
  readonly scheduleIds: readonly string[];
  readonly focusedEntityRef: string | null;
  readonly busy: boolean;
  readonly receipt: ScheduleActionReceipt | null;
  readonly actionError: string | null;
  readonly onAction: (kind: "enable" | "disable" | "runNow") => void;
  /** Resolves true once the daemon applied the write; false keeps the draft open beside the error. */
  readonly onSave: (input: ScheduleDefinitionInput | ScheduleBuiltinEditInput) => Promise<boolean>;
  readonly onDelete: () => void;
  /** Entity routing for refs with their own view (agent/provider/session/fact/…). Run sessions stay embedded. */
  readonly onSelectEntity: (ref: string) => void;
  /** 统一「在关系图中查看」入口(task_89d324b5);缺省不渲染。 */
  readonly onFocusGraph?: (ref: string) => void;
  /** Leave the embedded run detail back to the hub (location patch, no push). */
  readonly onExitRun: () => void;
  /** Back to the schedules list. */
  readonly onExit: () => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  // 详情默认只读:表单只在点「编辑」后出现,保存成功或取消即退出(不是与概览并列的一个页签)。
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const runOccurrence = scheduleRunRefOccurrence(focusedEntityRef);
  const runsQuery = useQuery({
    queryKey: ["schedule-runs", repoId, row.scheduleId],
    queryFn: () => schedulesClient.runs(repoId, row.scheduleId),
    retry: false,
    staleTime: 2_000,
  });
  // One daemon projection paints the timeline; the renderer never recomputes
  // cadence/nextRun/health and never invents occurrences the daemon did not emit.
  const occurrenceRows = runsQuery.data?.runs ?? deriveScheduleRunRows(row);
  const occurrence =
    runOccurrence === null
      ? null
      : (occurrenceRows.find((candidate) => candidate.occurrenceId === runOccurrence) ?? null);
  const mode = scheduleRowMode(row),
    targetKind = scheduleRowTargetKind(row),
    health = scheduleRowHealth(row);
  const tabs = [
    { key: "overview" as const, label: t("schedules.detail.tab.overview") },
    { key: "danger" as const, label: t("schedules.detail.tab.danger") },
  ];

  return (
    // 根是概况区域板的容器量尺(§1.9⑤):≥900px 时页签面板占满页头以下的高度、区域在自己
    // 内部滚动;更窄或其它页签时面板随内容往下排,由这一层滚动。
    <div data-testid="schedule-detail" className="@container flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex-none px-5 pt-3.5 md:px-7">
        <button
          type="button"
          data-testid="schedule-detail-back"
          // Returning from an embedded run lands back on the hub (run history is on Overview).
          onClick={runOccurrence === null ? onExit : onExitRun}
          className="inline-flex items-center gap-1 ui-meta text-text-faint hover:text-accent"
        >
          <ArrowLeft />
          {runOccurrence === null ? t("schedules.detail.backToList") : t("schedules.run.backToRuns")}
        </button>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="min-w-0 text-[19px] font-semibold leading-snug text-text">
                <TitleText title={row.name} />
              </h1>
              {/* 已布防是正常值:中性档;已暂停才需要被看到(灰蓝)。 */}
              <StatusTag
                tone={row.state === "armed" ? "neutral" : "plan"}
                label={t(row.state === "armed" ? "schedules.state.armed" : "schedules.state.paused")}
              />
              {row.activeRun !== null && <StatusTag tone="active" label={t("schedules.activeRun")} />}
              <ModeBadge mode={mode} />
              <Chip tone="mono">
                {targetKind === "builtin"
                  ? t("schedules.executor.builtin")
                  : targetKind === "squad"
                    ? t("schedules.executor.squad")
                    : t("schedules.executor.agent")}
              </Chip>
              {targetKind === "builtin" && (
                <Badge tip={t("schedules.builtin.hint")}>{t("schedules.builtin.preset")}</Badge>
              )}
            </div>
            <p className="mt-0.5 font-mono ui-micro text-text-faint">
              {`schedule/${row.scheduleId}`} · {t("schedules.detail.rev", { rev: String(row.definitionRevision) })} ·{" "}
              {t("schedules.fields.updatedAt")} {time(row.updatedAt)}
            </p>
          </div>
          {runOccurrence === null && !editing && (
            <div className="flex flex-wrap items-center gap-2">
              <ActionBtn
                kind="runNow"
                facet={row.actions.runNow}
                busy={busy}
                onAction={onAction}
                icon={<Play weight="bold" />}
              />
              <ActionBtn
                kind="disable"
                facet={row.actions.disable}
                busy={busy}
                onAction={onAction}
                icon={<Stop weight="bold" />}
              />
              <ActionBtn
                kind="enable"
                facet={row.actions.enable}
                busy={busy}
                onAction={onAction}
                icon={<Power weight="bold" />}
              />
              <Btn
                size="sm"
                testId="schedule-action-edit"
                disabled={busy || !row.actions.edit.available}
                tip={row.actions.edit.nextAction ?? row.actions.edit.code ?? undefined}
                onClick={() => setEditing(true)}
              >
                <PencilSimple weight="bold" />
                {t("schedules.action.edit")}
              </Btn>
              {/* 统一「在关系图中查看」入口(task_89d324b5):schedule 是图节点 kind。 */}
              <ViewInGraphButton entityRef={`schedule/${row.scheduleId}`} onFocusGraph={onFocusGraph} />
            </div>
          )}
        </div>
        {/* 关键数字行(标准 §2.2):下次运行、上次结果、错过、版本,等宽 tabular。 */}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-7 gap-y-2 border-b border-border pb-2.5">
          <KeyNumber label={t("schedules.fields.nextRun")} value={time(row.nextRunAt)} />
          <span className="flex items-baseline gap-2">
            <span className="font-mono uppercase tracking-[0.06em] text-text-faint ui-micro">
              {t("schedules.lastOutcome")}
            </span>
            {row.lastRun === null ? (
              <span className="font-mono ui-body text-text-muted">—</span>
            ) : (
              <>
                <StatusTag
                  tone={OUTCOME_TONE[row.lastRun.outcome] ?? "neutral"}
                  label={t(outcomeLabel(row.lastRun.outcome))}
                />
                <span className="font-mono tabular-nums text-text ui-body">{time(row.lastRun.endedAt)}</span>
              </>
            )}
          </span>
          <KeyNumber label={t("schedules.fields.missedCount")} value={String(row.missed.count)} />
          <KeyNumber
            label={t("schedules.fields.availability")}
            value={`${t(AVAILABILITY_META[row.executionAvailability])}${row.claim.nodeId === null ? "" : ` · ${row.claim.nodeId}`}`}
          />
        </div>
        {/* 编辑态的错误贴着表单显示(schedule-form-error),这里不重复一份。 */}
        {actionError !== null && !editing && (
          <p role="alert" data-testid="schedule-action-error" className="mt-2 font-mono ui-micro text-status-blocked">
            {actionError}
          </p>
        )}
        {receipt !== null && (
          <p role="status" data-testid="schedule-action-receipt" className="mt-2 font-mono ui-micro text-text-faint">
            {t("schedules.receipt", { command: receipt.command, outcome: receipt.outcome, opId: receipt.opId })}
            {receipt.nextAction !== null ? ` · ${receipt.nextAction}` : ""}
          </p>
        )}

        {runOccurrence !== null ? (
          occurrence === null ? (
            <Empty>{t("schedules.run.missing", { occurrence: runOccurrence })}</Empty>
          ) : (
            <ScheduleRunDetail
              repoId={repoId}
              row={row}
              occurrence={occurrence}
              onRefetchRuns={() => void runsQuery.refetch()}
              onSelectEntity={onSelectEntity}
            />
          )
        ) : editing ? null : (
          <div className="mt-2" data-testid="schedule-detail-tabs">
            <Tabs
              ariaLabel={t("schedules.title")}
              idPrefix="schedule"
              value={tab}
              onChange={(next) => {
                setTab(next);
                setConfirmDelete(false);
              }}
              tabs={tabs}
            />
          </div>
        )}
      </div>

      {runOccurrence === null && (
        <TabPanel
          idPrefix="schedule"
          value={tab}
          className={
            tab === "overview" && !editing
              ? "flex flex-col px-5 pb-4 pt-3 md:px-7 @[900px]:min-h-0 @[900px]:flex-1"
              : "px-5 pb-10 pt-4 md:px-7"
          }
        >
          {editing ? (
            <ScheduleForm
              options={options}
              scheduleIds={scheduleIds}
              initial={row}
              busy={busy}
              error={actionError}
              onCancel={() => setEditing(false)}
              onSubmit={(input) =>
                void onSave(input).then((saved) => {
                  if (saved) setEditing(false);
                })
              }
            />
          ) : tab === "overview" ? (
            <ScheduleOverviewTab
              row={row}
              mode={mode}
              health={health}
              runs={occurrenceRows}
              runsReadFailed={runsQuery.isError}
              runsError={runsQuery.error instanceof Error ? runsQuery.error.message : null}
              onSelectEntity={onSelectEntity}
              onOpenRun={(occurrenceId) => onSelectEntity(scheduleRunRef(row.scheduleId, occurrenceId))}
            />
          ) : (
            <ScheduleDangerTab
              row={row}
              busy={busy}
              confirmDelete={confirmDelete}
              onAction={onAction}
              onConfirmDelete={setConfirmDelete}
              onDelete={onDelete}
            />
          )}
        </TabPanel>
      )}
    </div>
  );
}

function KeyNumber({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="font-mono uppercase tracking-[0.06em] text-text-faint ui-micro">{label}</span>
      <span className="font-mono tabular-nums text-text ui-body">{value}</span>
    </span>
  );
}

function ModeBadge({ mode }: { readonly mode: "detect" | "remediate" }) {
  return (
    <Chip tone="mono" tip={t(mode === "detect" ? "schedules.mode.detectBoundary" : "schedules.mode.remediateBoundary")}>
      {t(mode === "detect" ? "schedules.mode.detect" : "schedules.mode.remediate")}
    </Chip>
  );
}

function ActionBtn({
  kind,
  facet,
  busy,
  onAction,
  icon,
}: {
  readonly kind: "enable" | "disable" | "runNow";
  readonly facet: { readonly available: boolean; readonly code: string | null; readonly nextAction: string | null };
  readonly busy: boolean;
  readonly onAction: (kind: "enable" | "disable" | "runNow") => void;
  readonly icon: React.ReactNode;
}) {
  const labelKey =
    kind === "enable"
      ? "schedules.action.enable"
      : kind === "disable"
        ? "schedules.action.disable"
        : "schedules.action.runNow";
  return (
    <Btn
      size="sm"
      variant={kind === "runNow" ? "primary" : "plain"}
      testId={`schedule-action-${kind}`}
      disabled={busy || !facet.available}
      tip={facet.available ? undefined : (facet.nextAction ?? facet.code ?? undefined)}
      onClick={() => onAction(kind)}
    >
      {icon}
      {t(labelKey)}
    </Btn>
  );
}

function HealthSpark({ outcomes }: { readonly outcomes: readonly ScheduleRunOutcomeWord[] }) {
  return (
    <span className="flex h-4 items-end gap-[3px]" data-testid="schedule-health-spark">
      {outcomes.map((outcome, index) => (
        <span
          key={`${index}-${outcome}`}
          title={t(RUN_OUTCOME_META[outcome].key)}
          className="w-1.5 rounded-t-sm"
          style={{ height: outcome === "running" ? "16px" : "12px", background: SPARK_COLOR[outcome] }}
        />
      ))}
    </span>
  );
}

/** 行内长文(说明句、路径、失败原因)折行显示:DenseRow 的标题与第二行默认单行省略。 */
function Wrapped({ children }: { readonly children: React.ReactNode }) {
  return <span className="whitespace-pre-wrap break-words">{children}</span>;
}

/**
 * 键值字段(标准 §4):键在标题位,短值在右侧;长值(路径)用宽松模式放第二行。
 * 没有值的字段整行不出现(§1.5),不留「—」占一行。
 */
function Field({
  name,
  value,
  long = false,
  onClick,
}: {
  readonly name: string;
  readonly value: string | null | undefined;
  readonly long?: boolean;
  readonly onClick?: () => void;
}) {
  if (value === null || value === undefined) return null;
  return long ? (
    <DenseRow relaxed title={name} reason={<Wrapped>{value}</Wrapped>} onClick={onClick} />
  ) : (
    <DenseRow title={name} time={value} onClick={onClick} />
  );
}

function ScheduleOverviewTab({
  row,
  mode,
  health,
  runs,
  runsReadFailed,
  runsError,
  onSelectEntity,
  onOpenRun,
}: {
  readonly row: ScheduleGuiRowDto;
  readonly mode: "detect" | "remediate";
  readonly health: ReturnType<typeof scheduleRowHealth>;
  readonly runs: readonly ScheduleGuiRunRowDto[];
  readonly runsReadFailed: boolean;
  readonly runsError: string | null;
  readonly onSelectEntity: (ref: string) => void;
  readonly onOpenRun: (occurrenceId: string) => void;
}) {
  const agentTarget = row.target.kind === "agent" ? row.target : null,
    builtinTarget = row.target.kind === "builtin" ? row.target : null,
    failed = runs.filter((run) => run.outcome === "failed").length,
    missed = runs.filter((run) => run.outcome === "missed").length,
    // 运行历史按计划时间倒序,第一条 failed 就是最近一次失败(与 daemon 健康度同窗)。
    lastFailed = runs.find((run) => run.outcome === "failed") ?? null,
    // 有人话失败原因(非 artifact 引用)就显示原因;引用换成「查看失败报告」入口。
    lastFailureReason =
      lastFailed === null || lastFailed.detail === null || lastFailed.detail.startsWith("artifact:")
        ? null
        : lastFailed.detail;
  return (
    // 区域板(标准 §2.1,与工作概况、任务详情同一个 RegionBoard):主区是需要处理、健康度、
    // 目的、定义、执行,运行历史固定在最右一列并区内滚动,它是这一页的主列表,两列时与主区各占一半;没有内容的区域整块消失。
    <RegionBoard side="primary" data-testid="schedule-overview-tab">
      <BoardMain>
        <BoardColumn>
          {(row.target.kind === "agent-unconfigured" || row.targetState !== undefined) && (
            <BoardRegion region="attention" data-testid="schedule-target-unconfigured-block">
              <Region title={t("schedules.detail.attention.title")} edge="bad">
                {row.target.kind === "agent-unconfigured" && (
                  <DenseRow relaxed title={<Wrapped>{t("schedules.detail.targetUnconfigured")}</Wrapped>} />
                )}
                {row.targetState !== undefined && row.targetError !== undefined && (
                  <DenseRow
                    relaxed
                    title={t(TARGET_STATE_KEY[row.targetState])}
                    reason={<Wrapped>{row.targetError.hint}</Wrapped>}
                  />
                )}
              </Region>
            </BoardRegion>
          )}
          {(health.recent.length > 0 || health.lastFailureDetail !== null) && (
            <BoardRegion region="health" data-testid="schedule-overview-health">
              <Region
                title={t("schedules.detail.health.title")}
                edge={health.bucket === "degraded" ? "bad" : undefined}
                tag={
                  <StatusTag
                    tone={health.bucket === "degraded" ? "bad" : "neutral"}
                    label={t(health.bucket === "degraded" ? "schedules.health.degraded" : "schedules.health.clean")}
                  />
                }
              >
                {health.recent.length > 0 && (
                  <DenseRow
                    tag={<HealthSpark outcomes={health.recent} />}
                    title={t("schedules.detail.health.legend", { count: String(health.recent.length) })}
                    time={
                      health.failedCount > 0
                        ? t("schedules.detail.health.failedCount", { count: String(health.failedCount) })
                        : undefined
                    }
                  />
                )}
                {health.lastFailureDetail !== null && (
                  <div data-testid="schedule-health-last-failure">
                    <DenseRow
                      relaxed
                      title={t("schedules.detail.health.lastFailure")}
                      reason={
                        lastFailureReason !== null ? (
                          <Wrapped>{lastFailureReason}</Wrapped>
                        ) : lastFailed !== null ? (
                          // 失败细节只是报告引用:入口替代三行哈希,点开内嵌的 run 详情看报告。
                          t("schedules.detail.health.viewFailureReport")
                        ) : (
                          // 运行历史读不到该失败 occurrence 时退回 daemon 原始 detail(不删数据)。
                          <Wrapped>{health.lastFailureDetail}</Wrapped>
                        )
                      }
                      onClick={lastFailed !== null ? () => onOpenRun(lastFailed.occurrenceId) : undefined}
                    />
                  </div>
                )}
              </Region>
            </BoardRegion>
          )}
          <BoardRegion region="purpose" data-testid="schedule-overview-purpose">
            {/* 正文不是「条」:板给它量「标题行 + 约三行正文」的下限,同列放不下时它先缩到这个
                下限、正文区内滚动,字段与健康度保持至少三条。 */}
            <Region title={t("schedules.detail.purpose.title")} padded>
              <p className="whitespace-pre-wrap ui-body text-text">{row.mission}</p>
              <p className="mt-2 flex flex-wrap items-center gap-2 ui-meta text-text-muted">
                <ModeBadge mode={mode} />
                <span>{t("schedules.detail.purpose.modeLine")}</span>
              </p>
              <p className="mt-1.5 ui-meta text-text-muted">
                <span className="text-text-faint">{t("schedules.detail.routing.title")}</span>{" "}
                {t("schedules.detail.routing.ternary")}
              </p>
            </Region>
          </BoardRegion>
        </BoardColumn>
        <BoardColumn>
          <BoardRegion region="definition" data-testid="schedule-overview-definition">
            <Region title={t("schedules.definition")}>
              <Field name={t("schedules.fields.trigger")} value={row.trigger.summary} />
              <Field name={t("schedules.fields.timezone")} value={row.trigger.timezone} />
              <Field name={t("schedules.fields.definitionRevision")} value={String(row.definitionRevision)} />
              <Field name={t("schedules.fields.updatedAt")} value={time(row.updatedAt)} />
              <Field name={t("schedules.fields.model")} value={agentTarget?.model} />
              <Field name={t("schedules.fields.cwd")} value={agentTarget?.cwd} long />
              {builtinTarget !== null && (
                <>
                  <Field name={t("schedules.fields.keepDays")} value={String(builtinTarget.keepDays)} />
                  <Field
                    name={t("schedules.fields.keepMonthly")}
                    value={builtinTarget.keepMonthly ? t("schedules.form.keepMonthly") : "—"}
                  />
                </>
              )}
              {/* G10: displayed entity ids are paths — the agent and runtime-instance
                  ids stay activatable rows. Run sessions are the exception by design:
                  they render embedded in this hub, never as a jump to the global list. */}
              {agentTarget && (
                <>
                  <div data-testid={`schedule-agent-link-${agentTarget.agentId}`}>
                    <Field
                      name={t("schedules.fields.agent")}
                      value={agentTarget.agentId}
                      onClick={() => onSelectEntity(`agent/${agentTarget.agentId}`)}
                    />
                  </div>
                  <div data-testid={`schedule-instance-link-${agentTarget.runtimeInstanceId}`}>
                    <Field
                      name={t("schedules.fields.instance")}
                      value={agentTarget.runtimeInstanceId}
                      onClick={() => onSelectEntity(`provider/${agentTarget.runtimeInstanceId}`)}
                    />
                  </div>
                </>
              )}
            </Region>
          </BoardRegion>
          <BoardRegion region="execution" data-testid="schedule-overview-execution">
            <Region title={t("schedules.execution")}>
              <Field
                name={t("schedules.fields.availability")}
                value={t(AVAILABILITY_META[row.executionAvailability])}
              />
              <Field name={t("schedules.fields.claimNode")} value={row.claim.nodeId} />
              <Field name={t("schedules.fields.assignment")} value={row.claim.assignmentId} />
              <Field name={t("schedules.fields.nextRun")} value={time(row.nextRunAt)} />
              <Field name={t("schedules.fields.evaluatedThrough")} value={time(row.automaticEvaluatedThrough)} />
            </Region>
          </BoardRegion>
        </BoardColumn>
      </BoardMain>
      {/* 运行历史:daemon 投影顺序(按计划时间倒序),一条 occurrence 一行,点开是内嵌的 run 详情。 */}
      {(runs.length > 0 || runsReadFailed) && (
        <BoardSide region="runs" data-testid="schedule-runs">
          <Region
            title={t("schedules.detail.runs.title")}
            big={runs.length}
            tag={
              <>
                {failed > 0 && (
                  <StatusTag tone="bad" label={t("schedules.runs.failedCount", { count: String(failed) })} />
                )}
                {missed > 0 && (
                  <StatusTag tone="bad" label={t("schedules.runs.missedCount", { count: String(missed) })} />
                )}
              </>
            }
          >
            {runsReadFailed && (
              <div role="alert" data-testid="schedule-runs-read-error">
                <DenseRow
                  relaxed
                  title={<Wrapped>{t("schedules.runs.readFailed")}</Wrapped>}
                  reason={runsError === null ? undefined : <Wrapped>{runsError}</Wrapped>}
                />
              </div>
            )}
            <ol data-testid="schedule-runs-timeline" className="flex flex-col">
              {runs.map((occurrence) => (
                <RunRow key={occurrence.occurrenceId || "aggregate"} occurrence={occurrence} onOpenRun={onOpenRun} />
              ))}
            </ol>
          </Region>
        </BoardSide>
      )}
    </RegionBoard>
  );
}

// 触发方式是人话主文字;occurrence 编号降为第二行弱色(视觉基线 v2:机器编号不当标题)。
const RUN_KIND_KEY: Readonly<Record<NonNullable<ScheduleGuiRunRowDto["kind"]>, MessageKey>> = {
  scheduled: "schedules.run.kind.scheduled",
  manual: "schedules.run.kind.manual",
};

function RunRow({
  occurrence,
  onOpenRun,
}: {
  readonly occurrence: ScheduleGuiRunRowDto;
  readonly onOpenRun: (occurrenceId: string) => void;
}) {
  const meta = RUN_OUTCOME_META[occurrence.outcome],
    aggregate = occurrence.occurrenceId === "";
  return (
    <li data-testid={`schedule-run-row-${occurrence.occurrenceId || "aggregate"}`}>
      <DenseRow
        relaxed
        tag={<StatusTag tone={OUTCOME_TONE[occurrence.outcome] ?? "neutral"} label={t(meta.key)} />}
        title={
          aggregate
            ? t("schedules.runs.missedAggregate")
            : occurrence.kind !== null
              ? t(RUN_KIND_KEY[occurrence.kind])
              : t("schedules.run.kind.fallback")
        }
        reason={
          occurrence.outcome === "missed"
            ? [
                occurrence.missedReason !== null ? missedReasonLabel(occurrence.missedReason) : null,
                t("schedules.runs.notRun"),
              ]
                .filter((part) => part !== null)
                .join(" · ")
            : [
                occurrence.outcome === "running" ? null : formatDuration(occurrence.durationMs),
                occurrence.nodeId !== null ? `node ${occurrence.nodeId}` : null,
                occurrence.occurrenceId !== "" ? occurrence.occurrenceId : null,
                occurrence.reportRef !== null
                  ? t("schedules.runs.outputReport")
                  : occurrence.detail !== null
                    ? `${t("schedules.runs.output")} ${occurrence.detail}`
                    : null,
              ]
                .filter((part) => part !== null)
                .join(" · ") || undefined
        }
        time={time(occurrence.endedAt ?? occurrence.scheduledFor)}
        // 误跑聚合行没有可打开的 occurrence;其余行点开嵌入的 run 详情。
        onClick={aggregate ? undefined : () => onOpenRun(occurrence.occurrenceId)}
      />
    </li>
  );
}

function ScheduleDangerTab({
  row,
  busy,
  confirmDelete,
  onAction,
  onConfirmDelete,
  onDelete,
}: {
  readonly row: ScheduleGuiRowDto;
  readonly busy: boolean;
  readonly confirmDelete: boolean;
  readonly onAction: (kind: "enable" | "disable" | "runNow") => void;
  readonly onConfirmDelete: (value: boolean) => void;
  readonly onDelete: () => void;
}) {
  return (
    <div data-testid="schedule-danger" className="max-w-[720px]">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <ActionBtn
          kind="enable"
          facet={row.actions.enable}
          busy={busy}
          onAction={onAction}
          icon={<Power weight="bold" />}
        />
        <ActionBtn
          kind="disable"
          facet={row.actions.disable}
          busy={busy}
          onAction={onAction}
          icon={<Stop weight="bold" />}
        />
      </div>
      <div
        className="status-edge rounded-xs border border-danger/40 px-3 py-2.5"
        style={{ "--status-edge": "var(--color-status-blocked)" } as React.CSSProperties}
      >
        <b className="ui-meta text-danger">{t("schedules.action.delete")}</b>
        <p className="mt-1 ui-micro text-text-muted">{t("schedules.deletePrompt")}</p>
        {!confirmDelete ? (
          <Btn
            size="sm"
            variant="danger"
            testId="schedule-action-delete"
            disabled={busy || !row.actions.delete.available}
            tip={row.actions.delete.nextAction ?? row.actions.delete.code ?? undefined}
            onClick={() => onConfirmDelete(true)}
          >
            <Trash weight="bold" />
            {t("schedules.action.delete")}
          </Btn>
        ) : (
          <span className="flex flex-wrap items-center gap-2" data-testid="schedule-delete-confirmation">
            <span className="ui-micro text-status-blocked">{t("schedules.deletePrompt")}</span>
            <Btn size="sm" disabled={busy} onClick={() => onConfirmDelete(false)}>
              {t("schedules.action.cancelDelete")}
            </Btn>
            <Btn size="sm" variant="primary" testId="schedule-action-confirm-delete" disabled={busy} onClick={onDelete}>
              {t("schedules.action.confirmDelete")}
            </Btn>
          </span>
        )}
      </div>
    </div>
  );
}
