import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import type { RuntimeHealth } from "../../model/runtime-health.ts";
import { runtimeHealthWorst } from "../../model/runtime-health.ts";
import { formatUptimeMs } from "../../views/SystemView.tsx";
import { t } from "../../i18n/index.tsx";
import { StreamExitButton } from "./streamParts.tsx";
import { localDateTime } from "../../model/local-time.ts";

const HEALTH_TONE = {
  ok: "text-success",
  degraded: "text-stale",
  down: "text-danger",
} as const;

function HealthRow({
  label,
  ok,
  value,
  detail,
}: {
  label: string;
  ok: boolean | null;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-raised px-3 py-2">
      <div className="flex items-center gap-1.5 font-mono text-[11px] text-text-faint">
        {ok === null ? (
          <span className="text-text-faint">·</span>
        ) : ok ? (
          <CheckCircle weight="bold" className="text-success" />
        ) : (
          <WarningCircle weight="bold" className="text-danger" />
        )}
        {label}
      </div>
      <div className={`mt-1 font-mono text-[13px] ${ok === false ? "text-danger" : ok === null ? "text-text-faint" : "text-text"}`} title={detail}>
        {value}
      </div>
      {detail && <div className="mt-0.5 truncate font-mono text-[11px] text-text-faint" title={detail}>{detail}</div>}
    </div>
  );
}

function ageText(seconds: number | null): string {
  if (seconds === null) return t("views.overviewView.healthUnknown");
  if (seconds < 90) return t("views.overviewView.healthSecondsAgo", { seconds });
  if (seconds < 5_400) return t("views.overviewView.healthMinutesAgo", { minutes: Math.round(seconds / 60) });
  return t("views.overviewView.healthHoursAgo", { hours: Math.round(seconds / 3_600) });
}

const CELL_LABEL: Record<string, string> = {
  warming: "warming",
  attached: "attached",
  unavailable: "unavailable",
  not_loaded: "not_loaded",
  unknown: "—",
};

/**
 * 总览第四格「运行时健康」:台账服务是否响应、投影落后多少、最近一次台账变化。
 * 信号面见 model/runtime-health.ts——全部来自现有可读面,零 daemon 改动;
 * 2026-08-21 daemon 冻死那类停摆会以「观测年龄持续增长 → 无响应」显影。
 */
export function RuntimeHealthCard({
  health,
  onOpenSystem,
}: {
  health: RuntimeHealth;
  onOpenSystem: () => void;
}) {
  const worst = runtimeHealthWorst(health);
  return (
    <div className="flex flex-col gap-2" data-testid="runtime-health-card">
      <div className="flex items-center gap-2">
        <span className={`font-mono text-[12px] font-semibold ${HEALTH_TONE[worst]}`} data-testid="runtime-health-worst">
          {worst === "ok" ? t("views.overviewView.healthAllGreen") : worst === "degraded" ? t("views.overviewView.healthDegraded") : t("views.overviewView.healthDown")}
        </span>
        <span className="font-mono text-[11px] text-text-faint">
          {t("views.overviewView.healthObservedAge", { age: ageText(health.daemon.observedAgeSec) })}
        </span>
        <StreamExitButton
          label={t("views.overviewView.goSystem")}
          title={t("views.overviewView.goSystemTitle")}
          onClick={onOpenSystem}
        />
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <HealthRow
          label={t("views.overviewView.healthDaemon")}
          ok={health.daemon.state === "responsive" ? true : health.daemon.state === "unresponsive" ? false : null}
          value={
            health.daemon.state === "responsive"
              ? t("views.overviewView.healthResponsive")
              : health.daemon.state === "unresponsive"
                ? t("views.overviewView.healthUnresponsive")
                : t("views.overviewView.healthUnknown")
          }
          detail={health.daemon.uptimeMs === null ? undefined : `${t("views.overviewView.healthUptime")} ${formatUptimeMs(health.daemon.uptimeMs)}`}
        />
        <HealthRow
          label={t("views.overviewView.healthCell")}
          ok={health.cell.state === "attached" ? true : health.cell.state === "unavailable" ? false : null}
          value={CELL_LABEL[health.cell.state] ?? health.cell.state}
          detail={
            health.cell.problem
              ?? (health.cell.queueDepth === null ? undefined : t("views.overviewView.healthQueueDepth", { depth: health.cell.queueDepth }))
          }
        />
        <HealthRow
          label={t("views.overviewView.healthLag")}
          ok={(health.projection.lag ?? 0) === 0 ? true : health.projection.lag === null ? null : false}
          value={
            health.projection.lag === null
              ? t("views.overviewView.healthUnknown")
              : health.projection.lag === 0
                ? t("views.overviewView.healthLagZero")
                : t("views.overviewView.healthLagRevs", { lag: health.projection.lag })
          }
          detail={
            health.projection.status === "pending"
              ? t("views.overviewView.healthCatchingUp")
              : health.projection.lag === null || health.projection.lag === 0
                ? undefined
                : t("views.overviewView.healthCatchingUp")
          }
        />
        <HealthRow
          label={t("views.overviewView.healthLedgerChange")}
          ok={null}
          value={health.ledgerChange.at ? ageText(health.ledgerChange.ageSec) : t("views.overviewView.healthNever")}
          detail={health.ledgerChange.at ? localDateTime(health.ledgerChange.at, true) ?? undefined : undefined}
        />
      </div>
    </div>
  );
}
