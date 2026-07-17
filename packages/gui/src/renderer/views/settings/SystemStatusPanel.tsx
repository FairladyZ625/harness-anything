import type { ReactNode } from "react";
import {
  ArrowsClockwise,
  CircleNotch,
  HardDrives,
  Warning,
  WarningCircle,
} from "@phosphor-icons/react";
import { BTN, Section, Row } from "../../components/ui/widgets";
import { useDaemonRestartMutation, useDaemonStatusQuery } from "../../model/daemon-status-query.ts";
import type {
  DaemonActiveControl,
  DaemonServiceStatus,
  DaemonStatusModel,
} from "../../model/daemon-status.ts";
import { t } from "../../i18n/index.tsx";
import { DaemonRepoTable } from "./DaemonRepoTable.tsx";

function formatUptimeMs(uptimeMs: number | undefined): string {
  if (typeof uptimeMs !== "number" || !Number.isFinite(uptimeMs) || uptimeMs < 0) {
    return t("views.settingsView.systemUnknownDash");
  }
  return formatDurationMs(uptimeMs);
}

function formatDurationMs(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return t("views.settingsView.systemUnknownDash");
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3_600);
  const minutes = Math.floor((totalSec % 3_600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function ReachabilityBadge({ started }: { started: boolean }) {
  if (started) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-success/15 px-2.5 py-1 text-[13px] font-semibold text-success">
        <span className="h-2 w-2 rounded-full bg-success" aria-hidden />
        {t("views.settingsView.systemRunning")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-danger/15 px-2.5 py-1 text-[13px] font-semibold text-danger">
      <span className="h-2 w-2 rounded-full bg-danger" aria-hidden />
      {t("views.settingsView.systemStopped")}
    </span>
  );
}

function StaleBuildChip() {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md bg-stale/15 px-2.5 py-1 text-[13px] font-semibold text-stale"
      title={t("views.settingsView.systemStaleBuildHint")}
    >
      <Warning weight="bold" className="text-[12px]" aria-hidden />
      {t("views.settingsView.systemStaleBuild")}
    </span>
  );
}

function MonoValue({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="max-w-full break-all font-mono text-[12px] text-text-muted" title={title}>
      {children}
    </span>
  );
}

function ActiveControlBanner({ control }: { control: DaemonActiveControl }) {
  const kindLabel =
    control.kind === "restart"
      ? t("views.settingsView.systemControlKindRestart")
      : t("views.settingsView.systemControlKindRefresh");
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-stale/40 bg-stale/10 px-3 py-2 text-[13px] text-stale"
      role="status"
    >
      <CircleNotch weight="bold" className="animate-spin text-[14px]" aria-hidden />
      <span>
        {t("views.settingsView.systemActiveControl", {
          kind: kindLabel,
          phase: control.phase,
          operationId: control.operationId,
        })}
      </span>
    </div>
  );
}

function RepoSummary({ service }: { service: DaemonServiceStatus }) {
  const summary = t("views.settingsView.systemRepoSummary", {
    attached: String(service.attachedCount),
    total: String(service.repoCount),
  });
  return (
    <span className="inline-flex flex-wrap items-center gap-2 font-mono text-[12px] text-text-muted">
      <span>{summary}</span>
      {service.unavailableCount > 0 ? (
        <span className="text-danger">
          {t("views.settingsView.systemUnavailableCount", {
            count: String(service.unavailableCount),
          })}
        </span>
      ) : null}
    </span>
  );
}

function DaemonStatusCard({ status }: { status: DaemonStatusModel }) {
  const { service } = status;
  const connectionsLabel = `${service.connections.active} / ${service.connections.total}`;
  const reconcile = service.lastReconcileError;

  return (
    <Section
      title={t("views.settingsView.systemDaemonStatus")}
      action={
        <span className="inline-flex flex-wrap items-center gap-2">
          <ReachabilityBadge started={service.started} />
          {service.build.stale ? <StaleBuildChip /> : null}
        </span>
      }
    >
      <Row label={t("views.settingsView.systemVersion")}>
        <MonoValue>{service.build.version || "—"}</MonoValue>
      </Row>
      <Row label={t("views.settingsView.systemUptime")}>
        <MonoValue>{formatUptimeMs(service.uptimeMs)}</MonoValue>
      </Row>
      <Row label={t("views.settingsView.systemPid")}>
        <MonoValue>{service.pid || "—"}</MonoValue>
      </Row>
      <Row label={t("views.settingsView.systemEndpoint")}>
        <MonoValue title={service.endpoint}>{service.endpoint || "—"}</MonoValue>
      </Row>
      <Row label={t("views.settingsView.systemDaemonId")}>
        <MonoValue>{service.daemonId || "—"}</MonoValue>
      </Row>
      <Row label={t("views.settingsView.systemUserRoot")}>
        <MonoValue title={service.userRoot}>{service.userRoot || "—"}</MonoValue>
      </Row>
      <Row label={t("views.settingsView.systemQueueDepth")}>
        <MonoValue>{service.queue.depth}</MonoValue>
      </Row>
      <Row label={t("views.settingsView.systemConnections")}>
        <MonoValue>{connectionsLabel}</MonoValue>
      </Row>
      <Row label={t("views.settingsView.systemRepoSummaryLabel")}>
        <RepoSummary service={service} />
      </Row>
      {reconcile ? (
        <Row label={t("views.settingsView.systemLastReconcileError")}>
          <span className="font-mono text-[12px] text-danger" title={reconcile.message}>
            {reconcile.code}: {reconcile.message}
          </span>
        </Row>
      ) : null}
    </Section>
  );
}

function ControlsRow({
  onRefresh,
  isRefreshing,
  onRestart,
  isRestarting,
  restartBlocked,
  restartError,
  restartAcceptedOperationId,
}: {
  onRefresh: () => void;
  isRefreshing: boolean;
  onRestart: () => void;
  isRestarting: boolean;
  restartBlocked: boolean;
  restartError: string | null;
  restartAcceptedOperationId: string | null;
}) {
  const busy = isRefreshing || isRestarting || restartBlocked;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onRefresh}
          disabled={isRefreshing || isRestarting}
          className={BTN}
        >
          <span className="inline-flex items-center gap-1">
            <ArrowsClockwise
              weight="bold"
              className={`text-[12px] ${isRefreshing ? "animate-spin" : ""}`}
            />
            {t("views.settingsView.systemRefresh")}
          </span>
        </button>
        <button
          type="button"
          onClick={onRestart}
          disabled={busy}
          title={
            restartBlocked
              ? t("views.settingsView.systemRestartInProgress")
              : t("views.settingsView.systemRestartHint")
          }
          className={BTN}
        >
          <span className="inline-flex items-center gap-1">
            {isRestarting || restartBlocked ? (
              <CircleNotch weight="bold" className="animate-spin text-[12px]" aria-hidden />
            ) : null}
            {isRestarting || restartBlocked
              ? t("views.settingsView.systemRestarting")
              : t("views.settingsView.systemRestart")}
          </span>
        </button>
      </div>
      {restartAcceptedOperationId ? (
        <p className="text-[12px] text-success" role="status">
          {t("views.settingsView.systemRestartAccepted", {
            operationId: restartAcceptedOperationId,
          })}
        </p>
      ) : null}
      {restartError ? (
        <p className="text-[12px] text-danger" role="alert">
          {t("views.settingsView.systemRestartFailed", { error: restartError })}
        </p>
      ) : null}
    </div>
  );
}

export function SystemStatusPanel() {
  const query = useDaemonStatusQuery();
  const restart = useDaemonRestartMutation();
  const activeControl = query.data?.service.activeControl ?? null;
  const restartBlocked = activeControl?.kind === "restart";
  const restartError =
    restart.isError
      ? ((restart.error as Error | undefined)?.message ?? t("views.settingsView.systemRestartFailedGeneric"))
      : null;
  const restartAcceptedOperationId =
    restart.isSuccess && restart.data.ok ? restart.data.accepted.operationId : null;

  const controls = (
    <ControlsRow
      onRefresh={() => void query.refetch()}
      isRefreshing={query.isFetching}
      onRestart={() => restart.mutate()}
      isRestarting={restart.isPending}
      restartBlocked={Boolean(restartBlocked)}
      restartError={restartError}
      restartAcceptedOperationId={restartAcceptedOperationId}
    />
  );

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-8 text-[13px] text-text-muted">
          <CircleNotch weight="bold" className="animate-spin" />
          {t("views.settingsView.systemLoading")}
        </div>
      </div>
    );
  }

  if (query.isError) {
    const message =
      (query.error as Error | undefined)?.message ??
      t("views.settingsView.systemUnreachableReason");
    return (
      <div className="flex flex-col gap-3">
        {controls}
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong bg-surface py-12 text-center">
          <WarningCircle weight="duotone" className="text-2xl text-danger" />
          <p className="text-[13px] text-text">{t("views.settingsView.systemUnreachable")}</p>
          <p className="max-w-md font-mono text-[11px] text-text-faint">{message}</p>
        </div>
      </div>
    );
  }

  const status = query.data;
  if (!status) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong bg-surface py-12 text-center">
        <HardDrives weight="duotone" className="text-2xl text-text-faint" />
        <p className="text-[13px] text-text-muted">{t("views.settingsView.systemNoData")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {controls}
      {status.service.activeControl ? (
        <ActiveControlBanner control={status.service.activeControl} />
      ) : null}
      <DaemonStatusCard status={status} />
      <Section title={t("views.settingsView.systemRepos")}>
        <DaemonRepoTable status={status} />
      </Section>
    </div>
  );
}
