import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "@phosphor-icons/react";
import type { ScheduleGuiListRowDto, ScheduleGuiRowDto, SchedulesListResult } from "@harness-anything/daemon/protocol";
import { Empty } from "../components/runtime/parts.tsx";
import { ScheduleFormDialog } from "../components/ScheduleFormDialog.tsx";
import { DenseRow } from "../components/primitives/DenseRow.tsx";
import { CompletedDivider } from "../components/primitives/CompletedDivider.tsx";
import { FilterChips } from "../components/primitives/FilterChips.tsx";
import { StatusTag } from "../components/primitives/StatusTag.tsx";
import { t, type MessageKey } from "../i18n/index.tsx";
import { formatTime } from "../model/time.ts";
import { consumeKnownError } from "../../api/error-consumption.ts";
import {
  scheduleRef,
  scheduleRefId,
  scheduleRowById,
  scheduleRowHealth,
  scheduleRowTargetKind,
  schedulesClient,
  type ScheduleActionReceipt,
  type ScheduleBuiltinEditInput,
  type ScheduleDefinitionInput,
} from "../schedules-client.ts";
import { ScheduleDetailView } from "./ScheduleDetailView.tsx";

// Schedules plane (S4/M1, 视觉基线 v1 §2.4 列表页): one `repo.schedules.list` read paints the
// list; the pane only filters and formats daemon facts — no cadence/nextRun/DST/mode
// recomputation, no local node/provider picking. 点行直接进 `schedule/<id>` 详情 hub(标准 §2.4,
// 不设预览抽屉);the same ref serves deep links and graph jumps.
const TARGET_STATE_KEY: Readonly<Record<NonNullable<ScheduleGuiRowDto["targetState"]>, MessageKey>> = {
  invalid: "agentRuntime.catalogInvalid",
  missing: "agentRuntime.catalogMissing",
};

const READ_ERROR_ROW_CLASS = [
  "shrink-0 border-b border-border bg-status-blocked/10",
  "px-3.5 py-1.5 font-mono ui-micro text-status-blocked",
].join(" ");

export function SchedulesView({
  repoId,
  focusedEntityRef,
  onSelectEntity,
  onFocusSchedule,
  onFocusGraph,
}: {
  readonly repoId: string;
  readonly focusedEntityRef: string | null;
  /** Entity routing for refs with their own view (agent/provider, schedule/<id>). */
  readonly onSelectEntity: (ref: string) => void;
  /** In-page schedule location (schedule/<id> and back to null), patched in place. */
  readonly onFocusSchedule: (ref: string | null) => void;
  /** 统一「在关系图中查看」入口(task_89d324b5);缺省不渲染。 */
  readonly onFocusGraph?: (ref: string) => void;
}) {
  const query = useQuery({
    queryKey: ["schedules", repoId],
    queryFn: () => schedulesClient.list(repoId),
    staleTime: 2_000,
  });
  return (
    <section data-testid="schedules-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex flex-wrap items-baseline gap-3 px-5 py-3">
        <h1 className="text-xl font-semibold text-text">{t("schedules.title")}</h1>
        <span data-testid="schedules-summary" className="min-w-0 truncate text-sm text-text-muted">
          {t("schedules.summary", { count: query.data?.schedules.length ?? 0 })}
        </span>
        {query.data && (
          <span className="ml-auto flex items-center gap-2 font-mono ui-micro text-text-faint">
            <span>{query.data.repoMode}</span>
            {query.data.viewerNodeId && <span>· {query.data.viewerNodeId}</span>}
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
        onFocusGraph={onFocusGraph}
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
  onFocusGraph,
  onMutated,
}: {
  readonly repoId: string;
  readonly data: SchedulesListResult | null;
  readonly pending: boolean;
  readonly focusedEntityRef: string | null;
  readonly onSelectEntity: (ref: string) => void;
  readonly onFocusSchedule: (ref: string | null) => void;
  /** 统一「在关系图中查看」入口(task_89d324b5);透传给详情 hub。 */
  readonly onFocusGraph?: (ref: string) => void;
  readonly onMutated?: () => void;
}) {
  const queryClient = useQueryClient();
  const rows = data?.schedules ?? [];
  // The ref routes: a resolvable schedule/<id> renders the detail hub; anything
  // else (including a stale ref after deletion) renders the list. There is
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
  /** Resolves true once the daemon applied the write; a rejection stays on the form as `actionError`. */
  const saveDefinition = async (input: ScheduleDefinitionInput | ScheduleBuiltinEditInput): Promise<boolean> => {
    setBusy(true);
    setActionError(null);
    setReceipt(null);
    try {
      const kind = selected === null ? "create" : "update",
        idempotencyKey = `gui:schedule-${kind}:${input.scheduleId}:${Date.now().toString(36)}`,
        // Create stays agent-shaped (a built-in is only ever system-seeded); an update may
        // carry the partial builtin edit input.
        next =
          kind === "create"
            ? await schedulesClient.create(repoId, input as ScheduleDefinitionInput, idempotencyKey)
            : await schedulesClient.update(repoId, input, idempotencyKey);
      setReceipt(next);
      setDialog(null);
      await queryClient.invalidateQueries({ queryKey: ["schedules", repoId] });
      onFocusSchedule(scheduleRef(input.scheduleId));
      onMutated?.();
      return true;
    } catch (error) {
      consumeKnownError(error);
      setActionError(error instanceof Error ? error.message : String(error));
      return false;
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
          // One hub instance per schedule: tab and edit mode never carry over to another schedule.
          key={selected.scheduleId}
          repoId={repoId}
          row={selected}
          options={data.options}
          scheduleIds={rows.map((row) => row.scheduleId)}
          focusedEntityRef={focusedEntityRef}
          busy={busy}
          receipt={receipt}
          actionError={actionError}
          onAction={(kind) => void runAction(kind, selected)}
          onSave={saveDefinition}
          onDelete={() => void deleteSchedule(selected)}
          onSelectEntity={onSelectEntity}
          onFocusGraph={onFocusGraph}
          onExitRun={() => onFocusSchedule(scheduleRef(selected.scheduleId))}
          onExit={() => onFocusSchedule(null)}
        />
      ) : (
        <ScheduleListPane
          rows={rows}
          data={data}
          pending={pending}
          busy={busy}
          onOpen={(scheduleId) => {
            setActionError(null);
            onSelectEntity(scheduleRef(scheduleId));
          }}
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

type ScheduleFilter = "attn" | "paused" | "all";

/** 注意力序:无效定义最先,健康降级次之,再按错过的次数,最后按下次运行时间;数值全来自 daemon。 */
function attentionRank(row: ScheduleGuiListRowDto): number {
  if (row.state === "invalid") return 0;
  if (row.state !== "armed") return 9;
  if (scheduleRowHealth(row).bucket === "degraded") return 1;
  if (row.missed.count > 0) return 2;
  return 3;
}

/** 需要关注 = 无效定义,或在跑且健康降级 / 错过运行 / 执行目标不可用(标准 §2.4 默认筛选)。 */
function needsAttention(row: ScheduleGuiListRowDto): boolean {
  if (row.state === "invalid") return true;
  if (row.state !== "armed") return false;
  return scheduleRowHealth(row).bucket === "degraded" || row.missed.count > 0 || row.targetState !== undefined;
}

function ScheduleListPane({
  rows,
  data,
  pending,
  busy,
  onOpen,
  onCreate,
}: {
  readonly rows: readonly ScheduleGuiListRowDto[];
  readonly data: SchedulesListResult | null;
  readonly pending: boolean;
  readonly busy: boolean;
  readonly onOpen: (scheduleId: string) => void;
  readonly onCreate: () => void;
}) {
  const [filter, setFilter] = useState<ScheduleFilter>("attn");
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const matchesSearch = (row: ScheduleGuiListRowDto) =>
    query.length === 0 ||
    (row.state === "invalid"
      ? `${row.scheduleId} ${row.invalidReason}`.toLocaleLowerCase().includes(query)
      : `${row.name} ${row.scheduleId} ${row.trigger.summary}`.toLocaleLowerCase().includes(query));
  const matchesFilter = (row: ScheduleGuiListRowDto, key: ScheduleFilter) =>
    key === "all" ? true : key === "attn" ? needsAttention(row) : row.state === "paused";
  const nextRunAtOf = (row: ScheduleGuiListRowDto) => (row.state === "invalid" ? "" : (row.nextRunAt ?? ""));
  const visible = rows.filter((row) => matchesSearch(row) && matchesFilter(row, filter)),
    // 终态沉底(标准 §2.4/§1.4 v2):暂停的计划不需要注意力,沉到「已暂停 N」分隔线
    // 之后照常显示,不折叠;要看纯暂停态走顶部「已暂停」筛选。
    activeRows = visible
      .filter((row) => row.state !== "paused")
      .sort(
        (left, right) =>
          attentionRank(left) - attentionRank(right) ||
          nextRunAtOf(left).localeCompare(nextRunAtOf(right)) ||
          left.scheduleId.localeCompare(right.scheduleId),
      ),
    pausedRows = visible.filter((row) => row.state === "paused");
  const chips = (
    [
      ["attn", t("schedules.list.filter.attn")],
      ["paused", t("schedules.state.paused")],
      ["all", t("schedules.list.filter.all")],
    ] as const
  ).map(([key, label]) => ({ key, label, count: rows.filter((row) => matchesFilter(row, key)).length }));
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="schedules-list">
      <div className="flex flex-wrap items-center gap-2 px-5 py-2" data-testid="schedules-filters">
        <FilterChips chips={chips} value={filter} onChange={setFilter} />
        <input
          type="search"
          aria-label={t("schedules.list.searchLabel")}
          placeholder={t("schedules.list.searchPlaceholder")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="min-w-[200px] flex-1 rounded-xs border border-border bg-surface-raised px-3 py-1.5 text-text ui-meta outline-none placeholder:text-text-faint focus:border-border-strong"
        />
        <button
          type="button"
          data-testid="schedule-action-create"
          disabled={busy || data === null || !data.actions.create.available}
          title={
            data?.actions.create.available === false
              ? (data.actions.create.nextAction ?? data.actions.create.code ?? undefined)
              : undefined
          }
          onClick={onCreate}
          className="inline-flex items-center gap-1.5 rounded-xs border border-accent bg-accent px-2.5 py-1 ui-meta font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
        >
          <Plus weight="bold" aria-hidden />
          {t("schedules.action.new")}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-6" data-testid="schedules-matrix">
        {pending ? (
          <Empty>{t("schedules.loading")}</Empty>
        ) : rows.length === 0 ? (
          <Empty>{t("schedules.empty")}</Empty>
        ) : visible.length === 0 ? (
          <Empty>{t("schedules.list.emptyFiltered")}</Empty>
        ) : (
          <>
            {activeRows.map((row) => (
              <ScheduleRow key={row.scheduleId} row={row} onOpen={onOpen} />
            ))}
            {pausedRows.length > 0 ? (
              <>
                <CompletedDivider>{t("schedules.list.pausedDivider", { count: pausedRows.length })}</CompletedDivider>
                {pausedRows.map((row) => (
                  <ScheduleRow key={row.scheduleId} row={row} onOpen={onOpen} />
                ))}
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function ScheduleRow({
  row,
  onOpen,
}: {
  readonly row: ScheduleGuiListRowDto;
  readonly onOpen: (scheduleId: string) => void;
}) {
  if (row.state === "invalid") {
    return (
      <div
        data-testid={`schedule-row-${row.scheduleId}`}
        className="status-edge bg-status-blocked/5"
        style={{ "--status-edge": "var(--color-status-blocked)" } as React.CSSProperties}
      >
        <DenseRow
          tag={<StatusTag tone="bad" label={t("schedules.state.invalid")} />}
          title={row.scheduleId}
          reason={row.invalidReason}
        />
      </div>
    );
  }
  const degraded = scheduleRowHealth(row).bucket === "degraded",
    targetKind = scheduleRowTargetKind(row),
    healthRecent = scheduleRowHealth(row).recent,
    reason = [
      row.missed.count > 0 ? t("schedules.missedCount", { count: row.missed.count }) : null,
      targetKind === "builtin" ? `${t("schedules.executor.builtin")} · ${t("schedules.builtin.preset")}` : null,
      row.targetState !== undefined ? (
        <span key="target-state" data-tip={row.targetError?.hint} className="text-status-blocked">
          {t(TARGET_STATE_KEY[row.targetState])}
        </span>
      ) : null,
      t(AVAILABILITY_LABEL[row.executionAvailability]),
    ]
      .filter((part) => part !== null)
      .map((part, i) => (
        <span key={i}>
          {i > 0 ? " · " : ""}
          {part}
        </span>
      ));
  return (
    <div data-testid={`schedule-row-${row.scheduleId}`} className={degraded ? "bg-status-blocked/5" : undefined}>
      <DenseRow
        tag={
          <span className="flex items-center gap-1">
            <StatusTag
              tone={row.state === "armed" ? "active" : "plan"}
              label={t(row.state === "armed" ? "schedules.state.armed" : "schedules.state.paused")}
            />
            {row.lastRun !== null && row.lastRun.outcome === "failed" && (
              <StatusTag tone="bad" label={t("schedules.outcome.failed")} />
            )}
            {degraded && row.lastRun?.outcome !== "failed" && (
              <StatusTag tone="bad" label={t("schedules.health.degraded")} />
            )}
          </span>
        }
        title={`${row.name}: ${row.trigger.summary}`}
        reason={reason.length > 0 ? <span>{reason}</span> : undefined}
        time={
          <span className="flex items-center gap-2">
            {healthRecent.length > 0 && (
              <span className="flex h-3 items-end gap-[2px]" data-testid={`schedule-spark-${row.scheduleId}`}>
                {healthRecent.map((outcome, index) => (
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
            <span>{row.nextRunAt === null ? "—" : time(row.nextRunAt)}</span>
          </span>
        }
        onClick={() => onOpen(row.scheduleId)}
      />
    </div>
  );
}

const AVAILABILITY_LABEL: Record<
  ScheduleGuiRowDto["executionAvailability"],
  | "schedules.availability.local"
  | "schedules.availability.claimedElsewhere"
  | "schedules.availability.unassigned"
  | "schedules.availability.notOnThisNode"
> = {
  local: "schedules.availability.local",
  "claimed-elsewhere": "schedules.availability.claimedElsewhere",
  unassigned: "schedules.availability.unassigned",
  "not-on-this-node": "schedules.availability.notOnThisNode",
};

/** 右侧等宽时间:与详情页同一 time 格式(daemon ISO → 本地 date-time)。 */
function time(iso: string | null): string {
  return iso === null ? "—" : (formatTime(iso, { style: "date-time" }) ?? iso);
}
