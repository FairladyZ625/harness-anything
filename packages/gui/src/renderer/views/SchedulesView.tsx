import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Clock, Plus } from "@phosphor-icons/react";
import type { ScheduleGuiRowDto, SchedulesListResult } from "../../../../daemon/src/protocol/schedules-gui-contract.ts";
import { Badge, Btn, Chip, Empty, Hint } from "../components/runtime/parts.tsx";
import { ScheduleFormDialog } from "../components/ScheduleFormDialog.tsx";
import { t, type MessageKey } from "../i18n/index.tsx";
import { formatTime } from "../model/time.ts";
import { consumeKnownError } from "../../api/error-consumption.ts";
import {
  scheduleRef,
  scheduleRefId,
  scheduleRowById,
  scheduleRowHealth,
  scheduleRowMode,
  scheduleRowTargetKind,
  schedulesClient,
  type ScheduleActionReceipt,
  type ScheduleDefinitionInput,
} from "../schedules-client.ts";
import { ScheduleDetailView } from "./ScheduleDetailView.tsx";

// Schedules plane (S4/M1): one `repo.schedules.list` read paints the list; the
// matrix only filters and formats daemon facts — no cadence/nextRun/DST/mode
// recomputation, no local node/provider picking. A focused `schedule/<id>` ref
// renders the detail hub (ScheduleDetailView) instead of the retired 420px
// inspector; run sessions stay embedded there instead of jumping to the global
// Sessions view.
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
const OUTCOME_TONE: Record<string, string> = {
  succeeded: "done",
  failed: "blocked",
  cancelled: "unknown",
};

const time = (iso: string | null): string => (iso === null ? "—" : (formatTime(iso, { style: "date-time" }) ?? iso));

const READ_ERROR_ROW_CLASS = [
  "shrink-0 border-b border-border bg-status-blocked/10",
  "px-3.5 py-1.5 font-mono text-[11px] text-status-blocked",
].join(" ");

export function SchedulesView({
  repoId,
  focusedEntityRef,
  onSelectEntity,
  onFocusSchedule,
}: {
  readonly repoId: string;
  readonly focusedEntityRef: string | null;
  /** Entity routing for refs with their own view (agent/provider, schedule/<id>). */
  readonly onSelectEntity: (ref: string) => void;
  /** In-page schedule location (schedule/<id> and back to null), patched in place. */
  readonly onFocusSchedule: (ref: string | null) => void;
}) {
  const query = useQuery({
    queryKey: ["schedules", repoId],
    queryFn: () => schedulesClient.list(repoId),
    staleTime: 2_000,
  });
  return (
    <section data-testid="schedules-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-[42px] shrink-0 items-center gap-3 border-b border-border bg-surface-raised px-3.5">
        <b className="text-[13px] tracking-[0.02em]">{t("schedules.title")}</b>
        <span className="truncate font-mono text-[10.5px] text-text-faint">{t("schedules.subtitle")}</span>
        {query.data && (
          <span className="flex items-center gap-2 whitespace-nowrap">
            <Chip tone="mono" tip={t("schedules.modeTip")}>
              {query.data.repoMode}
            </Chip>
            <Chip tone="mono" tip={t("schedules.viewerTip")}>
              {query.data.viewerNodeId ?? "—"}
            </Chip>
          </span>
        )}
      </header>
      {query.isError && (
        <p role="alert" data-testid="schedules-read-error" className={READ_ERROR_ROW_CLASS}>
          {t("schedules.readFailed", {
            error: query.error instanceof Error ? query.error.message : String(query.error),
          })}
        </p>
      )}
      <ScheduleWorkspace
        repoId={repoId}
        data={query.data ?? null}
        pending={query.isPending}
        focusedEntityRef={focusedEntityRef}
        onSelectEntity={onSelectEntity}
        onFocusSchedule={onFocusSchedule}
      />
    </section>
  );
}

export function ScheduleWorkspace({
  repoId,
  data,
  pending,
  focusedEntityRef,
  onSelectEntity,
  onFocusSchedule,
  onMutated,
}: {
  readonly repoId: string;
  readonly data: SchedulesListResult | null;
  readonly pending: boolean;
  readonly focusedEntityRef: string | null;
  readonly onSelectEntity: (ref: string) => void;
  readonly onFocusSchedule: (ref: string | null) => void;
  readonly onMutated?: () => void;
}) {
  const queryClient = useQueryClient();
  const rows = data?.schedules ?? [];
  // The ref routes: a resolvable schedule/<id> renders the detail hub; anything
  // else (including a stale ref after deletion) renders the matrix list. There is
  // no sidebar fallback row anymore — the hub is the detail surface.
  const wanted = scheduleRefId(focusedEntityRef),
    selected = useMemo(() => scheduleRowById(rows, wanted), [rows, wanted]);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<ScheduleActionReceipt | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"create" | null>(null);
  const runAction = async (kind: "enable" | "disable" | "runNow", schedule: ScheduleGuiRowDto): Promise<void> => {
    setBusy(true);
    setActionError(null);
    setReceipt(null);
    try {
      const idempotencyKey = `gui:schedule-${kind}:${schedule.scheduleId}:${Date.now().toString(36)}`;
      const next =
        kind === "enable"
          ? await schedulesClient.enable(repoId, schedule.scheduleId, idempotencyKey)
          : kind === "disable"
            ? await schedulesClient.disable(repoId, schedule.scheduleId, idempotencyKey)
            : await schedulesClient.runNow(repoId, schedule.scheduleId, idempotencyKey);
      setReceipt(next);
      await queryClient.invalidateQueries({ queryKey: ["schedules", repoId] });
      onMutated?.();
    } catch (error) {
      consumeKnownError(error);
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const saveDefinition = async (input: ScheduleDefinitionInput): Promise<void> => {
    setBusy(true);
    setActionError(null);
    setReceipt(null);
    try {
      const kind = selected === null ? "create" : "update",
        idempotencyKey = `gui:schedule-${kind}:${input.scheduleId}:${Date.now().toString(36)}`,
        next =
          kind === "create"
            ? await schedulesClient.create(repoId, input, idempotencyKey)
            : await schedulesClient.update(repoId, input, idempotencyKey);
      setReceipt(next);
      setDialog(null);
      await queryClient.invalidateQueries({ queryKey: ["schedules", repoId] });
      onFocusSchedule(scheduleRef(input.scheduleId));
      onMutated?.();
    } catch (error) {
      consumeKnownError(error);
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const deleteSchedule = async (schedule: ScheduleGuiRowDto): Promise<void> => {
    setBusy(true);
    setActionError(null);
    setReceipt(null);
    try {
      const idempotencyKey = `gui:schedule-delete:${schedule.scheduleId}:${Date.now().toString(36)}`;
      const next = await schedulesClient.delete(
        repoId,
        schedule.scheduleId,
        idempotencyKey,
        "Deleted from the Schedules GUI.",
      );
      setReceipt(next);
      onFocusSchedule(null);
      await queryClient.invalidateQueries({ queryKey: ["schedules", repoId] });
      onMutated?.();
    } catch (error) {
      consumeKnownError(error);
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {selected !== null && data !== null ? (
        <ScheduleDetailView
          repoId={repoId}
          row={selected}
          options={data.options}
          scheduleIds={rows.map((row) => row.scheduleId)}
          focusedEntityRef={focusedEntityRef}
          busy={busy}
          receipt={receipt}
          actionError={actionError}
          onAction={(kind) => void runAction(kind, selected)}
          onSave={(input) => void saveDefinition(input)}
          onDelete={() => void deleteSchedule(selected)}
          onSelectEntity={onSelectEntity}
          onExitRun={() => onFocusSchedule(scheduleRef(selected.scheduleId))}
          onExit={() => onFocusSchedule(null)}
        />
      ) : (
        <ScheduleListPane
          rows={rows}
          data={data}
          pending={pending}
          busy={busy}
          onOpenSchedule={(scheduleId) => onSelectEntity(scheduleRef(scheduleId))}
          onCreate={() => {
            setActionError(null);
            setDialog("create");
          }}
        />
      )}
      {dialog !== null && data !== null && (
        <ScheduleFormDialog
          key="create"
          options={data.options}
          scheduleIds={rows.map((row) => row.scheduleId)}
          initial={null}
          busy={busy}
          error={actionError}
          onCancel={() => setDialog(null)}
          onSubmit={(input) => void saveDefinition(input)}
        />
      )}
    </>
  );
}

type StateFilter = "all" | "armed" | "paused";
type ModeFilter = "all" | "detect" | "remediate";
type HealthFilter = "all" | "degraded" | "clean";

function ScheduleListPane({
  rows,
  data,
  pending,
  busy,
  onOpenSchedule,
  onCreate,
}: {
  readonly rows: readonly ScheduleGuiRowDto[];
  readonly data: SchedulesListResult | null;
  readonly pending: boolean;
  readonly busy: boolean;
  readonly onOpenSchedule: (scheduleId: string) => void;
  readonly onCreate: () => void;
}) {
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");
  const [healthFilter, setHealthFilter] = useState<HealthFilter>("all");
  const modeProjected = rows.some((row) => scheduleRowMode(row) !== null),
    healthProjected = rows.some((row) => scheduleRowHealth(row) !== null),
    visible = rows.filter((row) => {
      if (stateFilter !== "all" && row.state !== stateFilter) return false;
      if (modeFilter !== "all" && scheduleRowMode(row) !== modeFilter) return false;
      // The bucket is the daemon's classification of its health rollup — the
      // renderer only selects rows whose bucket matches the requested facet.
      if (healthFilter !== "all" && scheduleRowHealth(row)?.bucket !== healthFilter) return false;
      return true;
    });
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-6" data-testid="schedules-list">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5" data-testid="schedules-filters">
          <Chip>
            {t("schedules.list.count", {
              count: String(visible.length),
              total: String(rows.length),
            })}
          </Chip>
          <FilterGroup
            testId="schedules-filter-state"
            label={t("schedules.list.filter.state")}
            value={stateFilter}
            options={[
              { value: "all", label: t("schedules.list.filter.all") },
              { value: "armed", label: t("schedules.state.armed") },
              { value: "paused", label: t("schedules.state.paused") },
            ]}
            onChange={setStateFilter}
          />
          <FilterGroup
            testId="schedules-filter-mode"
            label={t("schedules.list.filter.mode")}
            tip={modeProjected ? undefined : t("schedules.list.filter.modePending")}
            disabled={!modeProjected}
            value={modeFilter}
            options={[
              { value: "all", label: t("schedules.list.filter.all") },
              { value: "detect", label: t("schedules.mode.detect") },
              { value: "remediate", label: t("schedules.mode.remediate") },
            ]}
            onChange={setModeFilter}
          />
          <FilterGroup
            testId="schedules-filter-health"
            label={t("schedules.list.filter.health")}
            tip={healthProjected ? undefined : t("schedules.list.filter.healthPending")}
            disabled={!healthProjected}
            value={healthFilter}
            options={[
              { value: "all", label: t("schedules.list.filter.all") },
              { value: "degraded", label: t("schedules.list.filter.degraded") },
              { value: "clean", label: t("schedules.list.filter.clean") },
            ]}
            onChange={setHealthFilter}
          />
        </div>
        <Btn
          size="sm"
          variant="primary"
          testId="schedule-action-create"
          disabled={busy || data === null || !data.actions.create.available}
          tip={
            data?.actions.create.available === false
              ? (data.actions.create.nextAction ?? data.actions.create.code ?? undefined)
              : undefined
          }
          onClick={onCreate}
        >
          <Plus weight="bold" />
          {t("schedules.action.new")}
        </Btn>
      </div>
      {pending ? (
        <Empty>{t("schedules.loading")}</Empty>
      ) : rows.length === 0 ? (
        <Empty>{t("schedules.empty")}</Empty>
      ) : visible.length === 0 ? (
        <Empty>{t("schedules.list.emptyFiltered")}</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border" data-testid="schedules-matrix">
          <table className="w-full border-collapse text-left text-[11.5px]">
            <thead>
              <tr className="bg-surface text-text-muted">
                {[
                  t("schedules.list.col.schedule"),
                  t("schedules.list.col.state"),
                  t("schedules.list.col.mode"),
                  t("schedules.list.col.executor"),
                  t("schedules.list.col.trigger"),
                  t("schedules.list.col.next"),
                  t("schedules.list.col.last"),
                  t("schedules.list.col.node"),
                  t("schedules.list.col.missed"),
                  t("schedules.list.col.health"),
                ].map((label) => (
                  <th
                    key={label}
                    className="border-b border-border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.06em]"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const stateMeta = STATE_META[row.state],
                  mode = scheduleRowMode(row),
                  health = scheduleRowHealth(row)?.recent ?? null;
                return (
                  <tr
                    key={row.scheduleId}
                    data-testid={`schedule-row-${row.scheduleId}`}
                    className="border-b border-border last:border-b-0 hover:bg-surface"
                  >
                    <td className="px-2.5 py-1.5">
                      <button
                        type="button"
                        data-testid={`schedule-focus-${row.scheduleId}`}
                        onClick={() => onOpenSchedule(row.scheduleId)}
                        title={t("schedules.list.openDetail")}
                        className="flex items-center gap-1.5 text-left text-[12px] font-medium hover:text-accent"
                      >
                        {row.name}
                        <ArrowRight className="size-3 text-text-faint" />
                      </button>
                      <div className="font-mono text-[10px] text-text-faint">{row.scheduleId}</div>
                    </td>
                    <td className="px-2.5 py-1.5">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="size-1.5 rounded-full"
                          style={{ background: `var(--color-status-${stateMeta.tone})` }}
                        />
                        {t(stateMeta.key)}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5">
                      {mode === null ? (
                        <Hint>{t("schedules.mode.pending")}</Hint>
                      ) : (
                        t(mode === "detect" ? "schedules.mode.detect" : "schedules.mode.remediate")
                      )}
                    </td>
                    <td className="px-2.5 py-1.5">
                      {t(
                        scheduleRowTargetKind(row) === "squad"
                          ? "schedules.executor.squad"
                          : "schedules.executor.agent",
                      )}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <Chip tone="mono" tip={t("schedules.triggerTip")}>
                        <Clock weight="bold" />
                        {row.trigger.summary}
                      </Chip>
                    </td>
                    <td className="px-2.5 py-1.5 font-mono text-[10.5px] text-text-faint">{time(row.nextRunAt)}</td>
                    <td className="px-2.5 py-1.5">
                      {row.lastRun === null ? (
                        <Hint>—</Hint>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          <Badge status={OUTCOME_TONE[row.lastRun.outcome] ?? "unknown"}>
                            {t(
                              row.lastRun.outcome in OUTCOME_META
                                ? OUTCOME_META[row.lastRun.outcome]
                                : "schedules.outcome.unknown",
                            )}
                          </Badge>
                        </span>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <span
                        className="font-mono text-[10.5px] text-text-faint"
                        title={t(AVAILABILITY_META[row.executionAvailability])}
                      >
                        {row.claim.nodeId ?? t(AVAILABILITY_META[row.executionAvailability])}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5">
                      {row.missed.count > 0 ? (
                        <span
                          className="font-mono text-[10.5px] text-status-planned"
                          title={row.missed.lastMissedReason ?? undefined}
                        >
                          {t("schedules.missedCount", { count: row.missed.count })}
                        </span>
                      ) : (
                        <Hint>—</Hint>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5">
                      {health === null ? (
                        <Hint>—</Hint>
                      ) : (
                        <span className="flex h-3 items-end gap-[2px]" data-testid={`schedule-spark-${row.scheduleId}`}>
                          {health.map((outcome, index) => (
                            <span
                              key={`${index}-${outcome}`}
                              title={outcome}
                              className="w-1 rounded-t-sm"
                              style={{
                                height: outcome === "running" ? "12px" : "9px",
                                background:
                                  outcome === "failed" || outcome === "missed"
                                    ? "var(--color-status-blocked)"
                                    : "var(--color-status-done)",
                              }}
                            />
                          ))}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FilterGroup<T extends string>({
  testId,
  label,
  tip,
  disabled = false,
  value,
  options,
  onChange,
}: {
  readonly testId: string;
  readonly label: string;
  readonly tip?: string;
  readonly disabled?: boolean;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
}) {
  return (
    <span data-testid={testId} data-tip={tip} className="inline-flex items-center gap-1 disabled:opacity-50">
      <span className="font-mono text-[9.5px] uppercase tracking-[0.06em] text-text-faint">{label}</span>
      <span
        className={`inline-flex overflow-hidden rounded border border-border-strong ${disabled ? "opacity-50" : ""}`}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            data-testid={`${testId}-${option.value}`}
            disabled={disabled}
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
            className={`px-2 py-0.5 text-[10.5px] ${option.value === value ? "bg-accent font-semibold text-accent-fg" : "text-text-muted hover:bg-surface"}`}
          >
            {option.label}
          </button>
        ))}
      </span>
    </span>
  );
}
