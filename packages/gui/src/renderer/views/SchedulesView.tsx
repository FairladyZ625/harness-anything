import { Notice } from "../components/primitives/Notice";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ScheduleGuiRowDto, SchedulesListResult } from "@harness-anything/daemon/protocol";
import { ScheduleFormDialog } from "../components/ScheduleFormDialog.tsx";
import { t } from "../i18n/index.tsx";
import { consumeKnownError } from "../../api/error-consumption.ts";
import {
  scheduleRef,
  scheduleRefId,
  scheduleRowById,
  schedulesClient,
  type ScheduleActionReceipt,
  type ScheduleBuiltinEditInput,
  type ScheduleDefinitionInput,
} from "../schedules-client.ts";
import { ScheduleDetailView } from "./ScheduleDetailView.tsx";
import { ScheduleListPane } from "./ScheduleListPane.tsx";

// Schedules plane (S4/M1): one `repo.schedules.list` read paints the page; the list pane
// (`ScheduleListPane`) only groups and formats daemon facts — no cadence/nextRun/DST/mode
// recomputation, no local node/provider picking. 点卡直接进 `schedule/<id>` 详情 hub(标准 §5.1,
// 不设预览抽屉);the same ref serves deep links and graph jumps.
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
    // 列表页头(页名+汇总句)随列表态渲染在 ScheduleListPane 里;详情态整个卸载
    // (chrome 审计 B1①):详情页身份由详情头左端的「← 定时计划」返回钮承担。
    <section data-testid="schedules-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {query.isError && (
        <Notice tone="bad" variant="strip" testId="schedules-read-error">
          {t("schedules.readFailed", {
            error: query.error instanceof Error ? query.error.message : String(query.error),
          })}
        </Notice>
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
          receipt={receipt}
          actionError={dialog === null ? actionError : null}
          onRunNow={(row) => void runAction("runNow", row)}
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
