import { ArrowRight, Play, Power, Stop } from "@phosphor-icons/react";
import type { ScheduleGuiRowDto } from "@harness-anything/daemon/protocol";
import { Drawer } from "./primitives/Drawer.tsx";
import { DenseRow } from "./primitives/DenseRow.tsx";
import { StatusTag } from "./primitives/StatusTag.tsx";
import { t, type MessageKey } from "../i18n/index.tsx";
import { scheduleRowHealth, scheduleRowMode, scheduleRowTargetKind } from "../schedules-client.ts";
import { time } from "./scheduleRun/runMeta.ts";

/**
 * 列表行点击的预览抽屉(标准 §2.4「点行打开 Drawer,不整页跳转」):一行结论 + 最近一次
 * 运行 + 就地动作(启用/暂停/立即跑),「打开完整详情」才路由到 schedule/<id> hub。
 * 全部字段是 daemon 列表行事实,抽屉不另发请求。
 */

const AVAILABILITY_META: Record<ScheduleGuiRowDto["executionAvailability"], MessageKey> = {
  local: "schedules.availability.local",
  "claimed-elsewhere": "schedules.availability.claimedElsewhere",
  unassigned: "schedules.availability.unassigned",
  "not-on-this-node": "schedules.availability.notOnThisNode",
};

const OUTCOME_LABEL: Record<string, MessageKey> = {
  succeeded: "schedules.outcome.succeeded",
  failed: "schedules.outcome.failed",
  unknown: "schedules.outcome.unknown",
  cancelled: "schedules.outcome.cancelled",
  running: "schedules.outcome.running",
};

const outcomeLabel = (outcome: string): MessageKey =>
  outcome in OUTCOME_LABEL ? OUTCOME_LABEL[outcome] : "schedules.outcome.unknown";

export function SchedulePreviewDrawer({
  row,
  busy,
  onAction,
  onOpenFull,
  onClose,
}: {
  readonly row: ScheduleGuiRowDto | null;
  readonly busy: boolean;
  readonly onAction: (kind: "enable" | "disable" | "runNow") => void;
  /** 打开完整详情:路由到 schedule/<id> hub(标准 §2.4 抽屉给完整页出口)。 */
  readonly onOpenFull: (ref: string) => void;
  readonly onClose: () => void;
}) {
  return (
    <Drawer open={row !== null} onClose={onClose} ariaLabel={row === null ? undefined : row.name} modal={false}>
      {row !== null && <SchedulePreviewBody row={row} busy={busy} onAction={onAction} onOpenFull={onOpenFull} />}
    </Drawer>
  );
}

function SchedulePreviewBody({
  row,
  busy,
  onAction,
  onOpenFull,
}: {
  readonly row: ScheduleGuiRowDto;
  readonly busy: boolean;
  readonly onAction: (kind: "enable" | "disable" | "runNow") => void;
  readonly onOpenFull: (ref: string) => void;
}) {
  const stateTag =
      row.state === "armed" ? (
        <StatusTag tone="active" label={t("schedules.state.armed")} />
      ) : row.state === "paused" ? (
        <StatusTag tone="plan" label={t("schedules.state.paused")} />
      ) : (
        <StatusTag tone="bad" label={t("schedules.state.invalid")} />
      ),
    health = scheduleRowHealth(row),
    last = row.lastRun,
    mode = scheduleRowMode(row),
    targetKind = scheduleRowTargetKind(row);
  return (
    <div className="flex flex-col gap-3.5" data-testid="schedule-preview-drawer">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 text-[17px] font-semibold leading-snug text-text">{row.name}</h2>
          {stateTag}
        </div>
        <p className="mt-1 truncate font-mono ui-micro text-text-faint">
          {`schedule/${row.scheduleId}`} ·{" "}
          {t(
            targetKind === "builtin"
              ? "schedules.executor.builtin"
              : targetKind === "squad"
                ? "schedules.executor.squad"
                : "schedules.executor.agent",
          )}{" "}
          · {t(mode === "detect" ? "schedules.mode.detect" : "schedules.mode.remediate")}
        </p>
      </div>
      <p className="whitespace-pre-wrap ui-meta leading-relaxed text-text-muted">{row.mission}</p>
      <div className="flex flex-col border-t border-border">
        <DenseRow
          tag={stateTag}
          title={t("schedules.fields.nextRun")}
          time={<span title={t("schedules.triggerTip")}>{time(row.nextRunAt)}</span>}
        />
        <DenseRow
          tag={
            row.activeRun !== null ? (
              <StatusTag tone="active" label={t("schedules.outcome.running")} />
            ) : last === null ? (
              <StatusTag tone="neutral" label={t("schedules.outcome.unknown")} />
            ) : (
              <StatusTag
                tone={last.outcome === "succeeded" ? "done" : last.outcome === "failed" ? "bad" : "neutral"}
                label={t(outcomeLabel(last.outcome))}
              />
            )
          }
          title={t("schedules.lastRunTitle")}
          time={row.activeRun !== null ? time(row.activeRun.claimedAt) : last === null ? "—" : time(last.endedAt)}
        />
        {row.missed.count > 0 && (
          <DenseRow
            tag={<StatusTag tone="bad" label={t("schedules.missedCount", { count: row.missed.count })} />}
            title={t("schedules.missedTitle")}
            time={time(row.missed.lastMissedAt)}
          />
        )}
        <DenseRow
          title={t("schedules.fields.availability")}
          reason={t(AVAILABILITY_META[row.executionAvailability])}
          time={row.claim.nodeId ?? "—"}
        />
        {health.recent.length > 0 && (
          <DenseRow
            title={t("schedules.detail.health.title")}
            reason={t("schedules.detail.health.legend", { count: String(health.recent.length) })}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <PreviewActionBtn
          kind="runNow"
          facet={row.actions.runNow}
          busy={busy}
          onAction={onAction}
          icon={<Play weight="bold" />}
        />
        <PreviewActionBtn
          kind="disable"
          facet={row.actions.disable}
          busy={busy}
          onAction={onAction}
          icon={<Stop weight="bold" />}
        />
        <PreviewActionBtn
          kind="enable"
          facet={row.actions.enable}
          busy={busy}
          onAction={onAction}
          icon={<Power weight="bold" />}
        />
        <button
          type="button"
          data-testid="schedule-preview-open-full"
          onClick={() => onOpenFull(`schedule/${row.scheduleId}`)}
          className="ml-auto inline-flex items-center gap-1.5 rounded-xs border border-border bg-text/5 px-2.5 py-1 ui-meta text-text hover:bg-text/10"
        >
          {t("schedules.drawer.openFull")}
          <ArrowRight aria-hidden className="size-3" />
        </button>
      </div>
    </div>
  );
}

function PreviewActionBtn({
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
    <button
      type="button"
      data-testid={`schedule-action-${kind}`}
      disabled={busy || !facet.available}
      title={facet.available ? undefined : (facet.nextAction ?? facet.code ?? undefined)}
      onClick={() => onAction(kind)}
      className={
        kind === "runNow"
          ? "inline-flex items-center gap-1.5 rounded-xs border border-accent bg-accent px-2.5 py-1 ui-meta font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
          : "inline-flex items-center gap-1.5 rounded-xs border border-border bg-text/5 px-2.5 py-1 ui-meta text-text hover:bg-text/10 disabled:opacity-50"
      }
    >
      {icon}
      {t(labelKey)}
    </button>
  );
}
