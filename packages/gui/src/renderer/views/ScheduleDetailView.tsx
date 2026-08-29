import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, PencilSimple, Play, Power, Stop, Trash } from "@phosphor-icons/react";
import type {
  ScheduleGuiOptionsDto,
  ScheduleGuiRowDto,
} from "../../../../daemon/src/protocol/schedules-gui-contract.ts";
import type { SquadRunReadResult } from "../../../../daemon/src/squad-run-contract.ts";
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
  PlannedBox,
  Right,
  RoleTag,
  Sect,
} from "../components/runtime/parts.tsx";
import { ScheduleForm } from "../components/ScheduleFormDialog.tsx";
import { SessionTranscript } from "../components/sessions/SessionTranscript.tsx";
import { t, type MessageKey } from "../i18n/index.tsx";
import { formatTime } from "../model/time.ts";
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
// the list row, the occurrence rows (from `repo.schedules.runs` once it lands, else
// the occurrences the list read already projects), and the embedded session replay
// (dispatch ledger via SessionTranscript). Run sessions render here by design; the
// old jump into the global Sessions view is gone.

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
const OUTCOME_META: Record<string, MessageKey> = {
  succeeded: "schedules.outcome.succeeded",
  failed: "schedules.outcome.failed",
  unknown: "schedules.outcome.unknown",
  cancelled: "schedules.outcome.cancelled",
};
const RUN_OUTCOME_META: Record<ScheduleRunOutcomeWord, { readonly key: MessageKey; readonly tone: string }> = {
  running: { key: "schedules.outcome.running", tone: "active" },
  succeeded: { key: "schedules.outcome.succeeded", tone: "done" },
  failed: { key: "schedules.outcome.failed", tone: "blocked" },
  missed: { key: "schedules.outcome.missed", tone: "planned" },
  cancelled: { key: "schedules.outcome.cancelled", tone: "cancelled" },
  unknown: { key: "schedules.outcome.unknown", tone: "unknown" },
};
const SPARK_COLOR: Record<ScheduleRunOutcomeWord, string> = {
  running: "var(--color-status-active)",
  succeeded: "var(--color-status-done)",
  failed: "var(--color-status-blocked)",
  missed: "var(--color-status-planned)",
  cancelled: "var(--color-status-cancelled)",
  unknown: "var(--color-status-unknown)",
};
const MISSED_REASON_META: Record<string, MessageKey> = {
  scheduler_unavailable: "schedules.missedReason.schedulerUnavailable",
  single_flight: "schedules.missedReason.singleFlight",
};

const time = (iso: string | null): string => (iso === null ? "—" : (formatTime(iso, { style: "date-time" }) ?? iso));

/** Shared styling for the occurrence shortcut buttons (keeps lines under the
 * 120-character budget without compressing the class string). */
const OCCURRENCE_CHIP_CLASS =
  "rounded border border-border px-2 py-0.5 font-mono text-[11px] text-text-muted " +
  "hover:border-accent hover:text-accent";

// Word → label lookups stay total: an unknown daemon word renders as its own
// text (missed reasons) or the shared "unknown" label (outcomes), never a crash.
const outcomeLabel = (outcome: string): MessageKey =>
  outcome in OUTCOME_META ? OUTCOME_META[outcome] : "schedules.outcome.unknown";
const missedReasonLabel = (reason: string | null): string =>
  reason === null ? "—" : reason in MISSED_REASON_META ? t(MISSED_REASON_META[reason]) : reason;

export function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60),
    seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
  const hours = Math.floor(minutes / 60),
    rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

/**
 * Fallback occurrence rows while the `repo.schedules.runs` projection is pending
 * the backend task: exactly the occurrences the list read already carries
 * (activeRun, lastRun) plus the missed aggregate, with the boundary labeled in
 * the UI. The only derived value is the lastRun duration — arithmetic over two
 * daemon-projected timestamps, same class as formatting them.
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
      squadRunId: null,
      outcome: "running",
      missedReason: null,
      reportRef: null,
      detail: null,
    });
  }
  if (row.lastRun !== null && row.lastRun.occurrenceId !== row.activeRun?.occurrenceId) {
    const settled = Date.parse(row.lastRun.endedAt),
      scheduled = Date.parse(row.lastRun.scheduledFor);
    rows.push({
      occurrenceId: row.lastRun.occurrenceId,
      kind: null,
      scheduledFor: row.lastRun.scheduledFor,
      claimedAt: null,
      endedAt: row.lastRun.endedAt,
      durationMs: Number.isFinite(settled) && Number.isFinite(scheduled) ? settled - scheduled : null,
      nodeId: row.lastRun.nodeId,
      attemptIndex: row.lastRun.attemptIndex,
      dispatchId: row.lastRun.dispatchId,
      runtimeSessionId: row.lastRun.runtimeSessionId,
      squadRunId: null,
      outcome: row.lastRun.outcome in RUN_OUTCOME_META ? (row.lastRun.outcome as ScheduleRunOutcomeWord) : "unknown",
      missedReason: null,
      reportRef: null,
      detail: row.lastRun.detail,
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
      squadRunId: null,
      outcome: "missed",
      missedReason: row.missed.lastMissedReason,
      reportRef: null,
      detail: null,
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
  /** Entity routing for non-session refs (agent/provider). Run sessions stay embedded. */
  readonly onSelectEntity: (ref: string) => void;
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
  const runsPendingBackend = runsQuery.isError;
  const occurrence =
    runOccurrence === null
      ? null
      : (occurrenceRows.find((candidate) => candidate.occurrenceId === runOccurrence) ?? null);
  const stateMeta = STATE_META[row.state],
    mode = scheduleRowMode(row),
    targetKind = scheduleRowTargetKind(row),
    health = scheduleRowHealth(row)?.recent ?? null;

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
        className="mb-1.5 inline-flex items-center gap-1 text-[11px] text-text-faint hover:text-accent"
      >
        <ArrowLeft />
        {runOccurrence === null ? t("schedules.detail.backToList") : t("schedules.run.backToRuns")}
      </button>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <b className="text-[14px] font-[650]">{row.name}</b>
            <RoleTag tone={stateMeta.tone}>{t(stateMeta.key)}</RoleTag>
            {row.activeRun !== null && <RoleTag tone="active">{t("schedules.activeRun")}</RoleTag>}
            <ModeBadge mode={mode} />
            <Chip tone="mono">
              {targetKind === "squad" ? t("schedules.executor.squad") : t("schedules.executor.agent")}
            </Chip>
          </div>
          <p className="font-mono text-[10.5px] text-text-faint">
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
          </div>
        )}
      </div>
      {actionError !== null && (
        <p role="alert" data-testid="schedule-action-error" className="mt-2 font-mono text-[11px] text-status-blocked">
          {actionError}
        </p>
      )}
      {receipt !== null && (
        <p role="status" data-testid="schedule-action-receipt" className="mt-2 font-mono text-[10.5px] text-text-faint">
          {t("schedules.receipt", { command: receipt.command, outcome: receipt.outcome, opId: receipt.opId })}
          {receipt.nextAction !== null ? ` · ${receipt.nextAction}` : ""}
        </p>
      )}

      {runOccurrence !== null ? (
        occurrence === null ? (
          <Empty>{t("schedules.run.missing", { occurrence: runOccurrence })}</Empty>
        ) : (
          <ScheduleRunDetailView
            repoId={repoId}
            row={row}
            occurrence={occurrence}
            onRefetchRuns={() => void runsQuery.refetch()}
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
                className={`rounded-t border-b-2 px-3 py-1 text-[12px] font-semibold ${
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
              pendingBackend={runsPendingBackend}
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

function ModeBadge({ mode }: { readonly mode: "detect" | "remediate" | null }) {
  if (mode === null)
    return (
      <Chip tone="mono" tip={t("schedules.mode.pendingTip")}>
        {t("schedules.mode.pending")}
      </Chip>
    );
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
  readonly mode: "detect" | "remediate" | null;
  readonly health: readonly ScheduleRunOutcomeWord[] | null;
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
            <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-text">{row.mission}</p>
            <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
              <ModeBadge mode={mode} />
              <span>{t("schedules.detail.purpose.modeLine")}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
              <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-text-faint">
                {t("schedules.detail.routing.title")}
              </span>
              <span>{t("schedules.detail.routing.ternary")}</span>
            </div>
          </CardBody>
        </Card>
        <Card testId="schedule-overview-health">
          <CardHead>
            <CardTitle>{t("schedules.detail.health.title")}</CardTitle>
          </CardHead>
          <CardBody>
            {health === null ? (
              <PlannedBox>{t("schedules.detail.health.pending")}</PlannedBox>
            ) : health.length === 0 ? (
              <Empty>{t("schedules.runs.empty")}</Empty>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <HealthSpark outcomes={health} />
                <Hint>{t("schedules.detail.health.legend", { count: String(health.length) })}</Hint>
              </div>
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
                  className="font-mono text-[11px] text-accent hover:underline"
                >
                  {t("schedules.fields.agent")}: {agentTarget.agentId}
                </button>
                <button
                  type="button"
                  data-testid={`schedule-instance-link-${agentTarget.runtimeInstanceId}`}
                  onClick={() => onSelectEntity(`provider/${agentTarget.runtimeInstanceId}`)}
                  className="font-mono text-[11px] text-accent hover:underline"
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
  pendingBackend,
  error,
  onOpenRun,
}: {
  readonly rows: readonly ScheduleGuiRunRowDto[];
  readonly pendingBackend: boolean;
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
      {pendingBackend && (
        <div className="mb-2 rounded border border-dashed border-text-faint/55 px-2.5 py-2 text-[11px] text-text-faint">
          {t("schedules.runs.pendingBackend")}
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
                    <span className="font-mono text-[11px] text-text-faint">{t("schedules.runs.missedAggregate")}</span>
                  ) : (
                    <button
                      type="button"
                      data-testid={`schedule-run-open-${occurrence.occurrenceId}`}
                      onClick={() => onOpenRun(occurrence.occurrenceId)}
                      className="font-mono text-[11px] font-semibold text-text hover:text-accent"
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
                  <span className="text-[11px] text-text-faint">
                    {time(occurrence.endedAt ?? occurrence.scheduledFor)}
                    {occurrence.outcome === "running" ? "" : ` · ${formatDurationMs(occurrence.durationMs)}`}
                  </span>
                  <span className="flex-1" />
                  {occurrence.outcome === "missed" ? (
                    <span className="text-[11px] text-status-planned">
                      {t("schedules.runs.notRun")}
                      {occurrence.missedReason !== null ? ` · ${missedReasonLabel(occurrence.missedReason)}` : ""}
                    </span>
                  ) : (
                    <span className="text-[11px] text-text-faint">
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
        <b className="text-[12px] text-danger">{t("schedules.action.delete")}</b>
        <p className="mt-1 text-[11.5px] text-text-muted">{t("schedules.deletePrompt")}</p>
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
            <span className="text-[11px] text-status-blocked">{t("schedules.deletePrompt")}</span>
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

function ScheduleRunDetailView({
  repoId,
  row,
  occurrence,
  onRefetchRuns,
}: {
  readonly repoId: string;
  readonly row: ScheduleGuiRowDto;
  readonly occurrence: ScheduleGuiRunRowDto;
  readonly onRefetchRuns: () => void;
}) {
  const meta = RUN_OUTCOME_META[occurrence.outcome];
  return (
    <div data-testid="schedule-run-detail" className="mt-3">
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2.5">
        <Badge status={meta.tone}>{t(meta.key)}</Badge>
        <b className="font-mono text-[13px]">{occurrence.occurrenceId}</b>
        {occurrence.kind !== null && <Chip tone="mono">{occurrence.kind}</Chip>}
        <span className="flex-1" />
        <Hint>
          node {occurrence.nodeId ?? "—"} · {t("schedules.fields.nextRun")} {time(occurrence.scheduledFor)} ·{" "}
          {time(occurrence.endedAt)} · {formatDurationMs(occurrence.durationMs)}
        </Hint>
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-[5fr_7fr]">
        <div className="min-w-0">
          <h4 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.07em] text-text-faint">
            {t("schedules.run.session.title")}
          </h4>
          {/* M4: the run session is embedded here — occurrence replay through the
              dispatch ledger, not a jump into the global Sessions view. */}
          {occurrence.dispatchId === null ? (
            <PlannedBox>{t("schedules.run.session.noDispatch")}</PlannedBox>
          ) : (
            <div data-testid={`schedule-run-session-${occurrence.occurrenceId}`}>
              <SessionTranscript
                repoId={repoId}
                dispatchId={occurrence.dispatchId}
                live={occurrence.outcome === "running"}
                onSettled={onRefetchRuns}
              />
            </div>
          )}
          {occurrence.squadRunId !== null && <ScheduleSquadLanesPlaceholder squadRunId={occurrence.squadRunId} />}
          {scheduleRowTargetKind(row) === "agent" && <Hint>{t("schedules.run.session.squadNote")}</Hint>}
        </div>
        <div className="min-w-0">
          <h4 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.07em] text-text-faint">
            {t("schedules.run.artifacts.title")}
          </h4>
          {occurrence.reportRef === null && occurrence.detail === null ? (
            <PlannedBox>{t("schedules.run.artifacts.none")}</PlannedBox>
          ) : (
            <>
              {occurrence.reportRef !== null && (
                <ArtifactRow
                  testId="schedule-run-artifact-report"
                  title="report.md"
                  artifactRef={occurrence.reportRef}
                />
              )}
              {occurrence.detail !== null && (
                <ArtifactRow
                  testId="schedule-run-artifact-runtime"
                  title="runtime-result"
                  artifactRef={occurrence.detail}
                />
              )}
            </>
          )}
          <KV>
            {occurrence.dispatchId !== null && (
              <KVRow name={t("schedules.fields.dispatch")}>{occurrence.dispatchId}</KVRow>
            )}
            {/* The runtime session id is a fact of this occurrence, shown as text:
                its transcript is embedded above, by design not a global-list link. */}
            {occurrence.runtimeSessionId !== null && (
              <KVRow name={t("schedules.fields.session")}>{occurrence.runtimeSessionId}</KVRow>
            )}
            <KVRow name={t("schedules.fields.attempt")}>
              {occurrence.attemptIndex === null ? "—" : String(occurrence.attemptIndex)}
            </KVRow>
            <KVRow name={t("schedules.fields.claimedAt")}>{time(occurrence.claimedAt)}</KVRow>
          </KV>
          <h4 className="mb-1.5 mt-3 font-mono text-[10px] uppercase tracking-[0.07em] text-text-faint">
            {t("schedules.run.routing.title")}
          </h4>
          <div className="rounded border border-border bg-surface-raised px-2.5 py-2">
            <ol className="ml-4 list-decimal text-[11.5px] text-text-muted">
              <li>{t("schedules.run.routing.step1")}</li>
              <li>{t("schedules.run.routing.step2")}</li>
              <li>{t("schedules.run.routing.step3")}</li>
            </ol>
            <PlannedBox>{t("schedules.run.routing.pending")}</PlannedBox>
          </div>
        </div>
      </div>
    </div>
  );
}

function ArtifactRow({
  testId,
  title,
  artifactRef,
}: {
  readonly testId: string;
  readonly title: string;
  readonly artifactRef: string;
}) {
  return (
    <div
      data-testid={testId}
      className="mb-1.5 flex items-start gap-2 rounded border border-border px-2.5 py-1.5 text-[11.5px]"
    >
      <b className="shrink-0">{title}</b>
      <span className="min-w-0 flex-1 break-all font-mono text-[10.5px] text-text-faint">{artifactRef}</span>
    </div>
  );
}

/**
 * M4 squad executor skeleton: shape follows `SquadRunReadResult`
 * (leaderTurns[] / workerAttempts[]) so the lanes render from the existing squad
 * read once `target.kind: "squad"` is wired. Only the join id is forward-projected
 * on occurrence rows today, so this placeholder names the read it is waiting for.
 */
export function ScheduleSquadLanes({ run }: { readonly run: SquadRunReadResult["run"] }) {
  return (
    <div data-testid="schedule-run-squad-lanes" className="mt-2 rounded border border-border px-2.5 py-2">
      <b className="text-[12px]">{t("schedules.run.squad.leaderTurns", { count: String(run.leaderTurns.length) })}</b>
      <ol className="mt-1 space-y-1">
        {run.leaderTurns.map((turn) => (
          <li key={turn.turnId} className="rounded border border-border px-2 py-1 text-[11px]">
            <span className="font-mono text-[10.5px] text-text-muted">{turn.turnId}</span>{" "}
            <Chip tone="mono">{turn.trigger.kind}</Chip>{" "}
            {turn.decision !== null && (
              <Chip tone="mono">
                {turn.decision.kind === "plan"
                  ? t("schedules.run.squad.plan", { count: String(turn.decision.dispatchCount) })
                  : t("schedules.run.squad.converged")}
              </Chip>
            )}{" "}
            <Hint>
              {turn.startedAt ?? "—"} → {turn.endedAt ?? "—"}
            </Hint>
          </li>
        ))}
      </ol>
      <b className="mt-2 block text-[12px]">
        {t("schedules.run.squad.workerAttempts", { count: String(run.workerAttempts.length) })}
      </b>
      <ol className="mt-1 space-y-1">
        {run.workerAttempts.map((attempt) => (
          <li key={attempt.attemptId} className="rounded border border-border px-2 py-1 text-[11px]">
            <span className="font-mono text-[10.5px] text-text-muted">{attempt.workerId}</span>{" "}
            <Chip tone="mono">{attempt.status ?? "—"}</Chip>{" "}
            <Hint>
              {attempt.startedAt ?? "—"} → {attempt.endedAt ?? "—"}
            </Hint>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ScheduleSquadLanesPlaceholder({ squadRunId }: { readonly squadRunId: string }) {
  return (
    <div className="mt-2 rounded border border-dashed border-text-faint/55 px-2.5 py-2 text-[11px] text-text-faint">
      {t("schedules.run.squad.pendingJoin", { squadRunId })}
    </div>
  );
}
