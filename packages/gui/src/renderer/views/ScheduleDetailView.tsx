import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, PencilSimple, Play, Power, Stop, Trash } from "@phosphor-icons/react";
import type {
  ScheduleGuiOptionsDto,
  ScheduleGuiRowDto,
} from "../../../../daemon/src/protocol/schedules-gui-contract.ts";
import {
  Badge,
  Btn,
  Card,
  CardBody,
  CardHead,
  CardTitle,
  Chip,
  Empty,
  Field,
  FieldGrid,
  Hint,
  KV,
  KVRow,
  Right,
  RoleTag,
  Sect,
} from "../components/runtime/parts.tsx";
import { ScheduleForm } from "../components/ScheduleFormDialog.tsx";
import { ScheduleRunDetail } from "../components/scheduleRun/ScheduleRunDetail.tsx";
import {
  RUN_OUTCOME_META,
  SPARK_COLOR,
  formatDurationMs,
  missedReasonLabel,
  time,
} from "../components/scheduleRun/runMeta.ts";
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
  type ScheduleDefinitionInput,
  type ScheduleGuiRunRowDto,
  type ScheduleRunOutcomeWord,
} from "../schedules-client.ts";

// Schedule detail hub (design M2–M5): the list row ref `schedule/<id>` renders this
// page instead of the retired 420px inspector. Everything shown is a daemon fact —
// the list row, the occurrence rows (`schedule-run-history`), and the embedded run
// detail (报告正文、产出互链、失败详情都在那一页)。Run sessions render here by design;
// the old jump into the global Sessions view is gone.

type StateMeta = { readonly key: MessageKey; readonly tone: "active" | "in-review" };
const STATE_META: Record<ScheduleGuiRowDto["state"], StateMeta> = {
  armed: { key: "schedules.state.armed", tone: "active" },
  paused: { key: "schedules.state.paused", tone: "in-review" },
};
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

/** Shared styling for the occurrence shortcut buttons (keeps lines under the
 *  120-character budget without compressing the class string). */
const OCCURRENCE_CHIP_CLASS =
  "rounded border border-border px-2 py-0.5 font-mono ui-micro text-text-muted " +
  "hover:border-accent hover:text-accent";

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

type Tab = "overview" | "runs" | "edit" | "danger";

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
  readonly onSave: (input: ScheduleDefinitionInput) => void;
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
  const stateMeta = STATE_META[row.state],
    mode = scheduleRowMode(row),
    targetKind = scheduleRowTargetKind(row),
    health = scheduleRowHealth(row);

  return (
    <div data-testid="schedule-detail" className="min-h-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-6">
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
        className="mb-1.5 inline-flex items-center gap-1 ui-micro text-text-faint hover:text-accent"
      >
        <ArrowLeft />
        {runOccurrence === null ? t("schedules.detail.backToList") : t("schedules.run.backToRuns")}
      </button>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <b className="ui-body font-[650]">{row.name}</b>
            <RoleTag tone={stateMeta.tone}>{t(stateMeta.key)}</RoleTag>
            {row.activeRun !== null && <RoleTag tone="active">{t("schedules.activeRun")}</RoleTag>}
            <ModeBadge mode={mode} />
            <Chip tone="mono">
              {targetKind === "squad" ? t("schedules.executor.squad") : t("schedules.executor.agent")}
            </Chip>
            {row.targetState !== undefined && row.targetError !== undefined && (
              <Badge tip={row.targetError.hint}>{t(TARGET_STATE_KEY[row.targetState])}</Badge>
            )}
          </div>
          <p className="font-mono ui-micro text-text-faint">
            {`schedule/${row.scheduleId}`} · {t("schedules.detail.rev", { rev: String(row.definitionRevision) })} ·{" "}
            {t("schedules.fields.updatedAt")} {time(row.updatedAt)}
          </p>
        </div>
        {runOccurrence === null && (
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
              onClick={() => setTab("edit")}
            >
              <PencilSimple weight="bold" />
              {t("schedules.action.edit")}
            </Btn>
            {/* 统一「在关系图中查看」入口(task_89d324b5):schedule 是图节点 kind。 */}
            <ViewInGraphButton entityRef={`schedule/${row.scheduleId}`} onFocusGraph={onFocusGraph} />
          </div>
        )}
      </div>
      {actionError !== null && (
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
      ) : (
        <>
          <div className="mt-3 mb-3 flex flex-wrap gap-1 border-b border-border" data-testid="schedule-detail-tabs">
            {(["overview", "runs", "edit", "danger"] as const).map((item) => (
              <button
                key={item}
                type="button"
                data-testid={`schedule-tab-${item}`}
                aria-pressed={tab === item}
                onClick={() => {
                  setTab(item);
                  setConfirmDelete(false);
                }}
                className={`rounded-t border-b-2 px-3 py-1 ui-meta font-semibold ${
                  tab === item
                    ? "border-accent bg-surface-raised text-accent"
                    : "border-transparent text-text-muted hover:text-text"
                }`}
              >
                {item === "runs"
                  ? t("schedules.detail.tab.runs", { count: String(occurrenceRows.length) })
                  : t(
                      item === "overview"
                        ? "schedules.detail.tab.overview"
                        : item === "edit"
                          ? "schedules.detail.tab.edit"
                          : "schedules.detail.tab.danger",
                    )}
              </button>
            ))}
          </div>
          {tab === "overview" ? (
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
          ) : tab === "edit" ? (
            <ScheduleForm
              // A successful save bumps the definition revision, which remounts
              // the form with the freshly-read daemon values (no stale draft).
              key={`edit:${row.definitionRevision}`}
              options={options}
              scheduleIds={scheduleIds}
              initial={row}
              busy={busy}
              error={actionError}
              onCancel={() => setTab("overview")}
              onSubmit={onSave}
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
        </>
      )}
    </div>
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
  const availabilityKey = AVAILABILITY_META[row.executionAvailability],
    agentTarget = row.target.kind === "agent" ? row.target : null;
  return (
    <div className="grid gap-3 lg:grid-cols-[5fr_7fr]">
      <div className="min-w-0">
        <Card testId="schedule-overview-purpose">
          <CardHead>
            <CardTitle>{t("schedules.detail.purpose.title")}</CardTitle>
          </CardHead>
          <CardBody>
            <p className="whitespace-pre-wrap ui-meta leading-relaxed text-text">{row.mission}</p>
            <div className="mt-2.5 flex flex-wrap items-center gap-2 ui-micro text-text-muted">
              <ModeBadge mode={mode} />
              <span>{t("schedules.detail.purpose.modeLine")}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 ui-micro text-text-muted">
              <span className="font-mono ui-micro uppercase tracking-[0.06em] text-text-faint">
                {t("schedules.detail.routing.title")}
              </span>
              <span>{t("schedules.detail.routing.ternary")}</span>
            </div>
          </CardBody>
        </Card>
        <Card testId="schedule-overview-health">
          <CardHead>
            <CardTitle>{t("schedules.detail.health.title")}</CardTitle>
            <Right>
              <Badge status={health.bucket === "degraded" ? "blocked" : "done"}>
                {t(health.bucket === "degraded" ? "schedules.health.degraded" : "schedules.health.clean")}
              </Badge>
            </Right>
          </CardHead>
          <CardBody>
            {health.recent.length === 0 ? (
              <Empty>{t("schedules.runs.empty")}</Empty>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <HealthSpark outcomes={health.recent} />
                <Hint>{t("schedules.detail.health.legend", { count: String(health.recent.length) })}</Hint>
                {health.failedCount > 0 && (
                  <Hint>{t("schedules.detail.health.failedCount", { count: String(health.failedCount) })}</Hint>
                )}
              </div>
            )}
            {health.lastFailureDetail !== null && (
              <p
                data-testid="schedule-health-last-failure"
                className="mt-2 break-all rounded border border-danger/40 bg-status-blocked/10 px-2.5 py-1.5 font-mono ui-micro text-text"
              >
                {t("schedules.detail.health.lastFailure")}: {health.lastFailureDetail}
              </p>
            )}
          </CardBody>
        </Card>
      </div>
      <div className="min-w-0">
        <Card testId="schedule-overview-definition">
          <CardHead>
            <CardTitle>{t("schedules.definition")}</CardTitle>
            <Right>
              <Hint>{row.scheduleId}</Hint>
            </Right>
          </CardHead>
          <CardBody>
            <FieldGrid>
              <Field label={t("schedules.fields.trigger")} value={row.trigger.summary} />
              <Field label={t("schedules.fields.timezone")} value={row.trigger.timezone ?? "—"} />
              <Field label={t("schedules.fields.definitionRevision")} value={String(row.definitionRevision)} />
              <Field label={t("schedules.fields.updatedAt")} value={time(row.updatedAt)} />
              <Field label={t("schedules.fields.model")} value={agentTarget?.model ?? "—"} />
              <Field label={t("schedules.fields.cwd")} value={agentTarget?.cwd ?? "—"} />
            </FieldGrid>
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
          </CardBody>
        </Card>
        <Card testId="schedule-overview-execution">
          <CardHead>
            <CardTitle>{t("schedules.execution")}</CardTitle>
            <Right>
              <Hint>{t(availabilityKey)}</Hint>
            </Right>
          </CardHead>
          <CardBody>
            <KV>
              <KVRow name={t("schedules.fields.availability")}>{t(availabilityKey)}</KVRow>
              <KVRow name={t("schedules.fields.claimNode")}>{row.claim.nodeId ?? "—"}</KVRow>
              <KVRow name={t("schedules.fields.assignment")}>{row.claim.assignmentId ?? "—"}</KVRow>
              <KVRow name={t("schedules.fields.nextRun")}>{time(row.nextRunAt)}</KVRow>
              <KVRow name={t("schedules.fields.evaluatedThrough")}>{time(row.automaticEvaluatedThrough)}</KVRow>
            </KV>
          </CardBody>
        </Card>
        <Card testId="schedule-overview-runs">
          <CardHead>
            <CardTitle>{t("schedules.activeRunTitle")}</CardTitle>
          </CardHead>
          <CardBody>
            {row.activeRun === null ? (
              <Empty>{t("schedules.noActiveRun")}</Empty>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid={`schedule-open-run-${row.activeRun.occurrenceId}`}
                  onClick={() => onOpenRun(row.activeRun?.occurrenceId ?? "")}
                  className={OCCURRENCE_CHIP_CLASS}
                >
                  {row.activeRun.occurrenceId}
                </button>
                <Badge status={RUN_OUTCOME_META.running.tone}>{t("schedules.outcome.running")}</Badge>
                <Chip tone="mono">node {row.activeRun.nodeId}</Chip>
                <Hint>{time(row.activeRun.claimedAt)}</Hint>
              </div>
            )}
          </CardBody>
          <Sect title={t("schedules.lastRunTitle")}>
            {row.lastRun === null ? (
              <Empty>{t("schedules.noLastRun")}</Empty>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid={`schedule-open-run-${row.lastRun.occurrenceId}`}
                  onClick={() => onOpenRun(row.lastRun?.occurrenceId ?? "")}
                  className={OCCURRENCE_CHIP_CLASS}
                >
                  {row.lastRun.occurrenceId}
                </button>
                <Badge status={OUTCOME_ROW_TONE[row.lastRun.outcome] ?? "unknown"}>
                  {t(outcomeLabel(row.lastRun.outcome))}
                </Badge>
                <Chip tone="mono">node {row.lastRun.nodeId}</Chip>
                <Hint>{time(row.lastRun.endedAt)}</Hint>
              </div>
            )}
          </Sect>
          <Sect title={t("schedules.missedTitle")}>
            <KV>
              <KVRow name={t("schedules.fields.missedCount")}>{String(row.missed.count)}</KVRow>
              <KVRow name={t("schedules.fields.lastMissedAt")}>{time(row.missed.lastMissedAt)}</KVRow>
              <KVRow name={t("schedules.fields.missedReason")}>{missedReasonLabel(row.missed.lastMissedReason)}</KVRow>
            </KV>
          </Sect>
        </Card>
      </div>
    </div>
  );
}

const OUTCOME_ROW_TONE: Record<string, string> = {
  succeeded: "done",
  failed: "blocked",
  cancelled: "cancelled",
  unknown: "unknown",
};

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
  const missed = rows.filter((row) => row.outcome === "missed").length,
    failed = rows.filter((row) => row.outcome === "failed").length;
  return (
    <div data-testid="schedule-runs">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Chip>{t("schedules.runs.count", { count: String(rows.length) })}</Chip>
        {failed > 0 && <Chip>{t("schedules.runs.failedCount", { count: String(failed) })}</Chip>}
        {missed > 0 && <Chip>{t("schedules.runs.missedCount", { count: String(missed) })}</Chip>}
      </div>
      {readFailed && (
        <div
          role="alert"
          data-testid="schedule-runs-read-error"
          className="mb-2 rounded border border-danger/40 bg-status-blocked/10 px-2.5 py-2 font-mono ui-micro text-status-blocked"
        >
          {t("schedules.runs.readFailed")}
          {error !== null ? ` · ${error}` : ""}
        </div>
      )}
      {rows.length === 0 ? (
        <Empty>{t("schedules.runs.empty")}</Empty>
      ) : (
        <ol data-testid="schedule-runs-timeline" className="ml-1 flex flex-col">
          {rows.map((occurrence) => {
            const meta = RUN_OUTCOME_META[occurrence.outcome],
              aggregate = occurrence.occurrenceId === "";
            return (
              <li
                key={aggregate ? "missed-aggregate" : occurrence.occurrenceId}
                data-testid={`schedule-run-row-${occurrence.occurrenceId || "aggregate"}`}
                className="relative border-l border-border-strong py-2 pl-4"
              >
                <span
                  className="absolute top-3.5 -left-[4.5px] size-2 rounded-full border border-surface-raised"
                  style={{ background: `var(--color-status-${meta.tone})` }}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Badge status={meta.tone}>{t(meta.key)}</Badge>
                  {aggregate ? (
                    <span className="font-mono ui-micro text-text-faint">{t("schedules.runs.missedAggregate")}</span>
                  ) : (
                    <button
                      type="button"
                      data-testid={`schedule-run-open-${occurrence.occurrenceId}`}
                      onClick={() => onOpenRun(occurrence.occurrenceId)}
                      className="font-mono ui-micro font-semibold text-text hover:text-accent"
                    >
                      {occurrence.occurrenceId}
                    </button>
                  )}
                  {occurrence.kind !== null && <Chip tone="mono">{occurrence.kind}</Chip>}
                  {occurrence.nodeId !== null && (
                    <Chip tone="mono" tip={t("schedules.runs.nodeTip")}>
                      node {occurrence.nodeId}
                    </Chip>
                  )}
                  <span className="ui-micro text-text-faint">
                    {time(occurrence.endedAt ?? occurrence.scheduledFor)}
                    {occurrence.outcome === "running" ? "" : ` · ${formatDurationMs(occurrence.durationMs)}`}
                  </span>
                  <span className="flex-1" />
                  {occurrence.outcome === "missed" ? (
                    <span className="ui-micro text-status-planned">
                      {t("schedules.runs.notRun")}
                      {occurrence.missedReason !== null ? ` · ${missedReasonLabel(occurrence.missedReason)}` : ""}
                    </span>
                  ) : (
                    <span className="ui-micro text-text-faint">
                      {occurrence.reportRef !== null
                        ? t("schedules.runs.outputReport")
                        : occurrence.detail !== null
                          ? `${t("schedules.runs.output")} ${occurrence.detail}`
                          : t("schedules.runs.outputNone")}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
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
      <div className="rounded border border-danger/40 px-3 py-2.5">
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
