import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Play, Power, Stop } from "@phosphor-icons/react";
import type { ScheduleGuiRowDto, SchedulesListResult } from "../../../../daemon/src/protocol/schedules-gui-contract.ts";
import {
  Badge,
  Btn,
  Card,
  CardBody,
  CardHead,
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
import { t, type MessageKey } from "../i18n/index.tsx";
import { formatTime } from "../model/time.ts";
import { consumeKnownError } from "../../api/error-consumption.ts";
import {
  scheduleRef,
  scheduleRefId,
  scheduleRowById,
  schedulesClient,
  type ScheduleActionReceipt,
} from "../schedules-client.ts";

// Schedules plane (S4): one `repo.schedules.list` read paints the whole page. The DTO
// already joins definition ledger + run projection + repo mode/availability, so this
// file only formats — no cadence/nextRun/DST/mode recomputation and no local
// node/provider picking. Action enablement comes from the daemon facets; a disabled
// button shows the daemon's exact blocker instead of a renderer-side mode branch.
const STATE_META: Record<string, { readonly key: MessageKey; readonly tone: "active" | "in-review" }> = {
  armed: { key: "schedules.state.armed", tone: "active" },
  paused: { key: "schedules.state.paused", tone: "in-review" },
};
const AVAILABILITY_META: Record<string, MessageKey> = {
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
const MISSED_REASON_META: Record<string, MessageKey> = {
  scheduler_unavailable: "schedules.missedReason.schedulerUnavailable",
  single_flight: "schedules.missedReason.singleFlight",
};
// Badge tone for the daemon's outcome word — a lookup table, not a renderer-side
// status judgment (the daemon already classified the run; we only color it).
const OUTCOME_TONE: Record<string, string> = {
  succeeded: "done",
  failed: "blocked",
  cancelled: "unknown",
};

const time = (iso: string | null): string => (iso === null ? "—" : (formatTime(iso, { style: "date-time" }) ?? iso));

export function SchedulesView({
  repoId,
  focusedEntityRef,
  onSelectEntity,
  onFocusSchedule,
}: {
  readonly repoId: string;
  readonly focusedEntityRef: string | null;
  /** Runtime deep-links out (session/…, agent/…); routed through entityRoutes. */
  readonly onSelectEntity: (ref: string) => void;
  /** In-page schedule focus (schedule/<id>), kept in the app location for reload/history. */
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
            <Chip tip={t("schedules.modeTip")} tone="mono">
              {query.data.repoMode}
            </Chip>
            <Chip tip={t("schedules.viewerTip")} tone="mono">
              {query.data.viewerNodeId ?? "—"}
            </Chip>
            {query.data.assignmentResolution === "unavailable" && (
              <Chip tip={t("schedules.rosterUnavailableTip")}>{t("schedules.rosterUnavailable")}</Chip>
            )}
          </span>
        )}
      </header>
      {query.isError && (
        <p
          role="alert"
          data-testid="schedules-read-error"
          className="shrink-0 border-b border-border bg-status-blocked/10 px-3.5 py-1.5 font-mono text-[11px] text-status-blocked"
        >
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
  const wanted = scheduleRefId(focusedEntityRef),
    selected = useMemo(() => scheduleRowById(rows, wanted) ?? rows[0] ?? null, [rows, wanted]);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<ScheduleActionReceipt | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-6" data-testid="schedules-list">
        {pending ? (
          <Empty>{t("schedules.loading")}</Empty>
        ) : rows.length === 0 ? (
          <Empty>{t("schedules.empty")}</Empty>
        ) : (
          rows.map((row) => {
            const stateMeta = STATE_META[row.state] ?? {
              key: "schedules.state.paused" as MessageKey,
              tone: "in-review" as const,
            };
            return (
              <Card key={row.scheduleId} testId={`schedule-row-${row.scheduleId}`}>
                <CardHead>
                  <button
                    type="button"
                    onClick={() => onFocusSchedule(scheduleRef(row.scheduleId))}
                    className="min-w-0 truncate text-left text-[12.5px] font-medium hover:text-accent"
                    data-testid={`schedule-focus-${row.scheduleId}`}
                  >
                    {row.name}
                  </button>
                  <RoleTag tone={stateMeta.tone}>{t(stateMeta.key)}</RoleTag>
                  {row.activeRun !== null && <RoleTag tone="active">{t("schedules.activeRun")}</RoleTag>}
                  <Right>
                    <Hint>{row.scheduleId}</Hint>
                  </Right>
                </CardHead>
                <CardBody>
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                    <Chip tone="mono" tip={t("schedules.triggerTip")}>
                      <Clock weight="bold" />
                      {row.trigger.summary}
                    </Chip>
                    <Chip
                      tip={t(AVAILABILITY_META[row.executionAvailability] ?? "schedules.availability.notOnThisNode")}
                    >
                      {t(AVAILABILITY_META[row.executionAvailability] ?? "schedules.availability.notOnThisNode")}
                    </Chip>
                    <span className="font-mono text-[10.5px] text-text-faint">
                      {t("schedules.nextRun")}: {time(row.nextRunAt)}
                    </span>
                    {row.claim.nodeId !== null && (
                      <span className="font-mono text-[10.5px] text-text-faint">
                        {t("schedules.claimNode")}: {row.claim.nodeId}
                      </span>
                    )}
                    {row.missed.count > 0 && (
                      <span className="font-mono text-[10.5px] text-text-faint">
                        {t("schedules.missedCount", { count: row.missed.count })}
                      </span>
                    )}
                    {row.lastRun !== null && (
                      <span className="font-mono text-[10.5px] text-text-faint">
                        {t("schedules.lastOutcome")}:{" "}
                        {t(OUTCOME_META[row.lastRun.outcome] ?? "schedules.outcome.unknown")}
                      </span>
                    )}
                  </div>
                </CardBody>
              </Card>
            );
          })
        )}
      </div>
      <aside
        className="hidden w-[420px] shrink-0 overflow-y-auto border-l border-border md:block"
        data-testid="schedules-inspector"
      >
        {selected === null ? (
          <div className="px-3.5 py-3">
            <Empty>{pending ? t("schedules.loading") : t("schedules.empty")}</Empty>
          </div>
        ) : (
          <ScheduleInspector
            row={selected}
            busy={busy}
            receipt={receipt}
            actionError={actionError}
            onAction={(kind) => void runAction(kind, selected)}
            onSelectEntity={onSelectEntity}
          />
        )}
      </aside>
    </div>
  );
}

function ScheduleInspector({
  row,
  busy,
  receipt,
  actionError,
  onAction,
  onSelectEntity,
}: {
  readonly row: ScheduleGuiRowDto;
  readonly busy: boolean;
  readonly receipt: ScheduleActionReceipt | null;
  readonly actionError: string | null;
  readonly onAction: (kind: "enable" | "disable" | "runNow") => void;
  readonly onSelectEntity: (ref: string) => void;
}) {
  const stateMeta = STATE_META[row.state] ?? {
      key: "schedules.state.paused" as MessageKey,
      tone: "in-review" as const,
    },
    availabilityKey = AVAILABILITY_META[row.executionAvailability] ?? "schedules.availability.notOnThisNode";
  return (
    <div className="pb-6">
      <Sect title={t("schedules.definition")} desc={row.scheduleId}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <b className="text-[12.5px]">{row.name}</b>
          <RoleTag tone={stateMeta.tone}>{t(stateMeta.key)}</RoleTag>
          <Chip tone="mono" tip={t("schedules.residencyTip")}>
            {row.definitionResidency}
          </Chip>
        </div>
        <FieldGrid>
          <Field label={t("schedules.fields.trigger")} value={row.trigger.summary} />
          <Field label={t("schedules.fields.timezone")} value={row.trigger.timezone ?? "—"} />
          <Field label={t("schedules.fields.definitionRevision")} value={String(row.definitionRevision)} />
          <Field label={t("schedules.fields.updatedAt")} value={time(row.updatedAt)} />
          <Field label={t("schedules.fields.agent")} value={row.target.agentId} />
          <Field label={t("schedules.fields.instance")} value={row.target.runtimeInstanceId} />
          <Field label={t("schedules.fields.model")} value={row.target.model ?? "—"} />
          <Field label={t("schedules.fields.cwd")} value={row.target.cwd ?? "—"} />
        </FieldGrid>
        <div className="mt-2">
          <button
            type="button"
            data-testid={`schedule-agent-link-${row.target.agentId}`}
            onClick={() => onSelectEntity(`agent/${row.target.agentId}`)}
            className="font-mono text-[11px] text-accent hover:underline"
          >
            {t("schedules.openAgent")}
          </button>
        </div>
        <p className="mt-2 whitespace-pre-wrap text-[11.5px] leading-relaxed text-text-muted">{row.mission}</p>
      </Sect>
      <Sect title={t("schedules.execution")} desc={t(availabilityKey)}>
        <KV>
          <KVRow name={t("schedules.fields.availability")}>{t(availabilityKey)}</KVRow>
          <KVRow name={t("schedules.fields.claimNode")}>{row.claim.nodeId ?? "—"}</KVRow>
          <KVRow name={t("schedules.fields.assignment")}>{row.claim.assignmentId ?? "—"}</KVRow>
          <KVRow name={t("schedules.fields.nextRun")}>{time(row.nextRunAt)}</KVRow>
          <KVRow name={t("schedules.fields.evaluatedThrough")}>{time(row.automaticEvaluatedThrough)}</KVRow>
        </KV>
      </Sect>
      <Sect title={t("schedules.activeRunTitle")}>
        {row.activeRun === null ? (
          <Empty>{t("schedules.noActiveRun")}</Empty>
        ) : (
          <KV>
            <KVRow name={t("schedules.fields.occurrence")}>{row.activeRun.occurrenceId}</KVRow>
            <KVRow name={t("schedules.fields.kind")}>{row.activeRun.kind}</KVRow>
            <KVRow name={t("schedules.fields.claimedAt")}>{time(row.activeRun.claimedAt)}</KVRow>
            <KVRow name={t("schedules.fields.claimNode")}>{row.activeRun.nodeId}</KVRow>
            <KVRow name={t("schedules.fields.attempt")}>{String(row.activeRun.attemptIndex)}</KVRow>
            {row.activeRun.dispatchId !== null && (
              <KVRow name={t("schedules.fields.dispatch")}>{row.activeRun.dispatchId}</KVRow>
            )}
            {row.activeRun.runtimeSessionId !== null && (
              <KVRow name={t("schedules.fields.session")}>
                <button
                  type="button"
                  data-testid={`schedule-session-link-${row.activeRun.runtimeSessionId}`}
                  onClick={() => onSelectEntity(`session/${row.activeRun?.runtimeSessionId ?? ""}`)}
                  className="font-mono text-[11px] text-accent hover:underline"
                >
                  {row.activeRun.runtimeSessionId}
                </button>
              </KVRow>
            )}
          </KV>
        )}
      </Sect>
      <Sect title={t("schedules.lastRunTitle")}>
        {row.lastRun === null ? (
          <Empty>{t("schedules.noLastRun")}</Empty>
        ) : (
          <>
            <div className="mb-1.5 flex items-center gap-2">
              <Badge status={OUTCOME_TONE[row.lastRun.outcome]}>
                {t(OUTCOME_META[row.lastRun.outcome] ?? "schedules.outcome.unknown")}
              </Badge>
              <Hint>{time(row.lastRun.endedAt)}</Hint>
            </div>
            <KV>
              <KVRow name={t("schedules.fields.occurrence")}>{row.lastRun.occurrenceId}</KVRow>
              <KVRow name={t("schedules.fields.claimNode")}>{row.lastRun.nodeId}</KVRow>
              <KVRow name={t("schedules.fields.attempt")}>{String(row.lastRun.attemptIndex)}</KVRow>
              {row.lastRun.dispatchId !== null && (
                <KVRow name={t("schedules.fields.dispatch")}>{row.lastRun.dispatchId}</KVRow>
              )}
              {row.lastRun.runtimeSessionId !== null && (
                <KVRow name={t("schedules.fields.session")}>
                  <button
                    type="button"
                    data-testid={`schedule-session-link-${row.lastRun?.runtimeSessionId ?? ""}`}
                    onClick={() => onSelectEntity(`session/${row.lastRun?.runtimeSessionId ?? ""}`)}
                    className="font-mono text-[11px] text-accent hover:underline"
                  >
                    {row.lastRun.runtimeSessionId}
                  </button>
                </KVRow>
              )}
              {row.lastRun.detail !== null && <KVRow name={t("schedules.fields.detail")}>{row.lastRun.detail}</KVRow>}
            </KV>
          </>
        )}
      </Sect>
      <Sect title={t("schedules.missedTitle")}>
        <KV>
          <KVRow name={t("schedules.fields.missedCount")}>{String(row.missed.count)}</KVRow>
          <KVRow name={t("schedules.fields.lastMissedAt")}>{time(row.missed.lastMissedAt)}</KVRow>
          <KVRow name={t("schedules.fields.missedReason")}>
            {row.missed.lastMissedReason === null
              ? "—"
              : t(MISSED_REASON_META[row.missed.lastMissedReason] ?? "schedules.missedReason.schedulerUnavailable")}
          </KVRow>
        </KV>
      </Sect>
      <Sect title={t("schedules.actions")}>
        <div className="flex flex-wrap items-center gap-2">
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
          <ActionBtn
            kind="runNow"
            facet={row.actions.runNow}
            busy={busy}
            onAction={onAction}
            icon={<Play weight="bold" />}
          />
        </div>
        {actionError !== null && (
          <p
            role="alert"
            data-testid="schedule-action-error"
            className="mt-2 font-mono text-[11px] text-status-blocked"
          >
            {actionError}
          </p>
        )}
        {receipt !== null && (
          <p
            role="status"
            data-testid="schedule-action-receipt"
            className="mt-2 font-mono text-[10.5px] text-text-faint"
          >
            {t("schedules.receipt", { command: receipt.command, outcome: receipt.outcome, opId: receipt.opId })}
            {receipt.nextAction !== null ? ` · ${receipt.nextAction}` : ""}
          </p>
        )}
      </Sect>
    </div>
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
