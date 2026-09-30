import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, PencilSimple, Play, Power, Stop, Trash } from "@phosphor-icons/react";
import type { ScheduleGuiOptionsDto, ScheduleGuiRowDto } from "@harness-anything/daemon/protocol";
import { Badge, Btn, Chip, Empty, KV, KVRow } from "../components/runtime/parts.tsx";
import { ScheduleForm } from "../components/ScheduleFormDialog.tsx";
import { ScheduleRunDetail } from "../components/scheduleRun/ScheduleRunDetail.tsx";
import {
  RUN_OUTCOME_META,
  SPARK_COLOR,
  formatDurationMs,
  missedReasonLabel,
  time,
} from "../components/scheduleRun/runMeta.ts";
import { DenseRow } from "../components/primitives/DenseRow.tsx";
import { CompletedDivider } from "../components/primitives/CompletedDivider.tsx";
import { Section } from "../components/primitives/Section.tsx";
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

type Tab = "overview" | "runs" | "danger";

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
  /** Leave the embedded run detail back to the hub's Runs tab (location patch, no push). */
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
  const runsReadFailed = runsQuery.isError;
  const occurrence =
    runOccurrence === null
      ? null
      : (occurrenceRows.find((candidate) => candidate.occurrenceId === runOccurrence) ?? null);
  const mode = scheduleRowMode(row),
    targetKind = scheduleRowTargetKind(row),
    health = scheduleRowHealth(row);
  const tabs = [
    { key: "overview" as const, label: t("schedules.detail.tab.overview") },
    { key: "runs" as const, label: t("schedules.detail.tab.runs", { count: String(occurrenceRows.length) }) },
    { key: "danger" as const, label: t("schedules.detail.tab.danger") },
  ];

  return (
    <div data-testid="schedule-detail" className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-5 pt-3.5 md:px-7">
        <button
          type="button"
          data-testid="schedule-detail-back"
          onClick={() => {
            if (runOccurrence === null) {
              onExit();
              return;
            }
            // Returning from an embedded run lands back on the Runs tab.
            setTab("runs");
            onExitRun();
          }}
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
              <StatusTag
                tone={row.state === "armed" ? "active" : "plan"}
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
        <div className="px-5 pb-10 pt-4 md:px-7">
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
              onSelectEntity={onSelectEntity}
              onOpenRun={(occurrenceId) => onSelectEntity(scheduleRunRef(row.scheduleId, occurrenceId))}
            />
          ) : tab === "runs" ? (
            <ScheduleRunsTab
              rows={occurrenceRows}
              readFailed={runsReadFailed}
              error={runsQuery.error instanceof Error ? runsQuery.error.message : null}
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
        </div>
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

function ScheduleOverviewTab({
  row,
  mode,
  health,
  onSelectEntity,
  onOpenRun,
}: {
  readonly row: ScheduleGuiRowDto;
  readonly mode: "detect" | "remediate";
  readonly health: ReturnType<typeof scheduleRowHealth>;
  readonly onSelectEntity: (ref: string) => void;
  readonly onOpenRun: (occurrenceId: string) => void;
}) {
  const agentTarget = row.target.kind === "agent" ? row.target : null,
    builtinTarget = row.target.kind === "builtin" ? row.target : null;
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0">
        {(row.target.kind === "agent-unconfigured" || row.targetState !== undefined) && (
          <div data-testid="schedule-target-unconfigured-block">
            <Section variant="warn" title={t("schedules.detail.attention.title")}>
              {row.target.kind === "agent-unconfigured" && (
                <p className="ui-meta text-text">{t("schedules.detail.targetUnconfigured")}</p>
              )}
              {row.targetState !== undefined && row.targetError !== undefined && (
                <p className="ui-meta text-text">
                  {t(TARGET_STATE_KEY[row.targetState])} — {row.targetError.hint}
                </p>
              )}
            </Section>
          </div>
        )}
        <Section title={t("schedules.detail.purpose.title")}>
          <p className="whitespace-pre-wrap ui-meta leading-relaxed text-text">{row.mission}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 ui-micro text-text-muted">
            <ModeBadge mode={mode} />
            <span>{t("schedules.detail.purpose.modeLine")}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 ui-micro text-text-muted">
            <span className="font-mono uppercase tracking-[0.06em] text-text-faint">
              {t("schedules.detail.routing.title")}
            </span>
            <span>{t("schedules.detail.routing.ternary")}</span>
          </div>
        </Section>
        <div data-testid="schedule-overview-health">
          <Section
            title={t("schedules.detail.health.title")}
            variant={health.bucket === "degraded" ? "warn" : undefined}
          >
            {health.recent.length === 0 ? (
              <Empty>{t("schedules.runs.empty")}</Empty>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <HealthSpark outcomes={health.recent} />
                <span className="ui-micro text-text-faint">
                  {t("schedules.detail.health.legend", { count: String(health.recent.length) })}
                </span>
                {health.failedCount > 0 && (
                  <span className="ui-micro text-status-blocked">
                    {t("schedules.detail.health.failedCount", { count: String(health.failedCount) })}
                  </span>
                )}
                <StatusTag
                  tone={health.bucket === "degraded" ? "bad" : "done"}
                  label={t(health.bucket === "degraded" ? "schedules.health.degraded" : "schedules.health.clean")}
                />
              </div>
            )}
            {health.lastFailureDetail !== null && (
              <p
                data-testid="schedule-health-last-failure"
                className="mt-2 break-all rounded-xs border border-danger/40 bg-status-blocked/10 px-2.5 py-1.5 font-mono ui-micro text-text"
              >
                {t("schedules.detail.health.lastFailure")}: {health.lastFailureDetail}
              </p>
            )}
          </Section>
        </div>
        <Section title={t("schedules.activeRunTitle")}>
          {row.activeRun === null && row.lastRun === null && row.missed.count === 0 ? (
            <p className="ui-meta text-text-faint">{t("schedules.noActiveRun")}</p>
          ) : (
            <div className="border-t border-border">
              {row.activeRun !== null && (
                <div data-testid={`schedule-run-row-${row.activeRun.occurrenceId}`}>
                  <DenseRow
                    tag={<StatusTag tone="active" label={t("schedules.outcome.running")} />}
                    title={row.activeRun.occurrenceId}
                    reason={`node ${row.activeRun.nodeId}`}
                    time={time(row.activeRun.claimedAt)}
                    onClick={() => onOpenRun(row.activeRun?.occurrenceId ?? "")}
                  />
                </div>
              )}
              {row.lastRun !== null && row.lastRun.occurrenceId !== row.activeRun?.occurrenceId && (
                <div data-testid={`schedule-run-row-${row.lastRun.occurrenceId}`}>
                  <DenseRow
                    tag={
                      <StatusTag
                        tone={OUTCOME_TONE[row.lastRun.outcome] ?? "neutral"}
                        label={t(outcomeLabel(row.lastRun.outcome))}
                      />
                    }
                    title={row.lastRun.occurrenceId}
                    reason={`node ${row.lastRun.nodeId}`}
                    time={time(row.lastRun.endedAt)}
                    onClick={() => onOpenRun(row.lastRun?.occurrenceId ?? "")}
                  />
                </div>
              )}
              {row.missed.count > 0 && (
                <div data-testid="schedule-run-row-aggregate">
                  <DenseRow
                    tag={<StatusTag tone="bad" label={t("schedules.outcome.missed")} />}
                    title={t("schedules.runs.missedAggregate")}
                    reason={missedReasonLabel(row.missed.lastMissedReason)}
                    time={time(row.missed.lastMissedAt)}
                  />
                </div>
              )}
            </div>
          )}
        </Section>
      </div>
      <aside className="min-w-0 self-start lg:sticky lg:top-2">
        <div data-testid="schedule-overview-definition">
          <Section title={t("schedules.definition")}>
            <KV>
              <KVRow name={t("schedules.fields.trigger")}>{row.trigger.summary}</KVRow>
              <KVRow name={t("schedules.fields.timezone")}>{row.trigger.timezone ?? "—"}</KVRow>
              <KVRow name={t("schedules.fields.definitionRevision")}>{String(row.definitionRevision)}</KVRow>
              <KVRow name={t("schedules.fields.updatedAt")}>{time(row.updatedAt)}</KVRow>
              <KVRow name={t("schedules.fields.model")}>
                {builtinTarget === null ? (agentTarget?.model ?? "—") : "—"}
              </KVRow>
              <KVRow name={t("schedules.fields.cwd")}>{builtinTarget === null ? (agentTarget?.cwd ?? "—") : "—"}</KVRow>
              {builtinTarget !== null && (
                <>
                  <KVRow name={t("schedules.fields.keepDays")}>{String(builtinTarget.keepDays)}</KVRow>
                  <KVRow name={t("schedules.fields.keepMonthly")}>
                    {builtinTarget.keepMonthly ? t("schedules.form.keepMonthly") : "—"}
                  </KVRow>
                </>
              )}
            </KV>
            {/* G10: displayed entity ids are paths — the agent and runtime-instance
                ids stay activatable links. Run sessions are the exception by design:
                they render embedded in this hub, never as a jump to the global list. */}
            {agentTarget && (
              <div className="mt-2 flex flex-wrap gap-3">
                <button
                  type="button"
                  data-testid={`schedule-agent-link-${agentTarget.agentId}`}
                  onClick={() => onSelectEntity(`agent/${agentTarget.agentId}`)}
                  className="font-mono ui-micro text-accent hover:underline"
                >
                  {t("schedules.fields.agent")}: {agentTarget.agentId}
                </button>
                <button
                  type="button"
                  data-testid={`schedule-instance-link-${agentTarget.runtimeInstanceId}`}
                  onClick={() => onSelectEntity(`provider/${agentTarget.runtimeInstanceId}`)}
                  className="font-mono ui-micro text-accent hover:underline"
                >
                  {t("schedules.fields.instance")}: {agentTarget.runtimeInstanceId}
                </button>
              </div>
            )}
          </Section>
        </div>
        <Section title={t("schedules.execution")}>
          <KV>
            <KVRow name={t("schedules.fields.availability")}>{t(AVAILABILITY_META[row.executionAvailability])}</KVRow>
            <KVRow name={t("schedules.fields.claimNode")}>{row.claim.nodeId ?? "—"}</KVRow>
            <KVRow name={t("schedules.fields.assignment")}>{row.claim.assignmentId ?? "—"}</KVRow>
            <KVRow name={t("schedules.fields.nextRun")}>{time(row.nextRunAt)}</KVRow>
            <KVRow name={t("schedules.fields.evaluatedThrough")}>{time(row.automaticEvaluatedThrough)}</KVRow>
          </KV>
        </Section>
      </aside>
    </div>
  );
}

function ScheduleRunsTab({
  rows,
  readFailed,
  error,
  onOpenRun,
}: {
  readonly rows: readonly ScheduleGuiRunRowDto[];
  readonly readFailed: boolean;
  readonly error: string | null;
  readonly onOpenRun: (occurrenceId: string) => void;
}) {
  // 终态沉底(标准 §1.4/§2.4 v2):成功/取消的 occurrence 沉到「已收口 N」分隔线
  // 之后照常显示,不折叠;running/failed/missed 留在注意力区,保持 daemon 投影顺序。
  const inFlight = rows.filter((row) => row.outcome !== "succeeded" && row.outcome !== "cancelled"),
    settled = rows.filter((row) => row.outcome === "succeeded" || row.outcome === "cancelled"),
    missed = rows.filter((row) => row.outcome === "missed").length,
    failed = rows.filter((row) => row.outcome === "failed").length;
  return (
    <div data-testid="schedule-runs">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="ui-micro text-text-muted">{t("schedules.runs.count", { count: String(rows.length) })}</span>
        {failed > 0 && <StatusTag tone="bad" label={t("schedules.runs.failedCount", { count: String(failed) })} />}
        {missed > 0 && <StatusTag tone="bad" label={t("schedules.runs.missedCount", { count: String(missed) })} />}
      </div>
      {readFailed && (
        <div
          role="alert"
          data-testid="schedule-runs-read-error"
          className="mb-2 rounded-xs border border-danger/40 bg-status-blocked/10 px-2.5 py-2 font-mono ui-micro text-status-blocked"
        >
          {t("schedules.runs.readFailed")}
          {error !== null ? ` · ${error}` : ""}
        </div>
      )}
      {rows.length === 0 ? (
        <Empty>{t("schedules.runs.empty")}</Empty>
      ) : (
        <ol data-testid="schedule-runs-timeline" className="flex flex-col">
          {inFlight.map((occurrence) => (
            <RunRow key={occurrence.occurrenceId || "aggregate"} occurrence={occurrence} onOpenRun={onOpenRun} />
          ))}
          {settled.length > 0 && (
            <li data-testid="schedule-runs-settled" className="border-t border-border">
              <CompletedDivider>
                {t("schedules.runs.settledDivider", { count: String(settled.length) })}
              </CompletedDivider>
            </li>
          )}
          {settled.map((occurrence) => (
            <RunRow key={occurrence.occurrenceId} occurrence={occurrence} onOpenRun={onOpenRun} />
          ))}
        </ol>
      )}
    </div>
  );
}

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
        tag={<StatusTag tone={OUTCOME_TONE[occurrence.outcome] ?? "neutral"} label={t(meta.key)} />}
        title={aggregate ? t("schedules.runs.missedAggregate") : occurrence.occurrenceId}
        reason={
          occurrence.outcome === "missed"
            ? [
                occurrence.missedReason !== null ? missedReasonLabel(occurrence.missedReason) : null,
                t("schedules.runs.notRun"),
              ]
                .filter((part) => part !== null)
                .join(" · ")
            : [
                occurrence.nodeId !== null ? `node ${occurrence.nodeId}` : null,
                occurrence.outcome === "running" ? null : formatDurationMs(occurrence.durationMs),
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
