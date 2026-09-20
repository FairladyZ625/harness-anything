import { t } from "../../i18n/index.tsx";
import { formatTime } from "../../model/time.ts";
import {
  FLEET_TIME_WINDOWS,
  type FleetPulseSnapshot,
  type FleetTimeWindow,
  type FleetWorkerRow,
} from "../../model/cadence-fleet.ts";

function statusTone(worker: FleetWorkerRow): string {
  if (worker.status === "live") return "bg-status-active";
  if (worker.status === "idle") return "bg-status-unknown";
  if (worker.outcome === "failed") return "bg-status-blocked";
  return "bg-text-faint";
}

function statusBadge(worker: FleetWorkerRow): string {
  if (worker.status === "live") return t("views.cadence.fleetStatus.live");
  if (worker.status === "idle") return t("views.cadence.fleetStatus.idle");
  if (worker.outcome) return t(`views.cadence.fleetOutcome.${worker.outcome}`);
  return t("views.cadence.fleetStatus.exited");
}

function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function duration(value: number | null): string {
  if (value === null) return t("views.cadence.fleetTurnaroundUnknown");
  const minutes = Math.round(value / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 6) / 10}h`;
}

function Panel({ title, children }: { readonly title: React.ReactNode; readonly children: React.ReactNode }) {
  return (
    <section className="min-h-0 rounded-lg border border-border bg-surface/60 p-3">
      <div className="mb-2 ui-body font-semibold">{title}</div>
      {children}
    </section>
  );
}

export function FleetPulsePane({
  snapshot,
  selectedWindow,
  onSelectWindow,
  onNavigateEntity,
}: {
  readonly snapshot: FleetPulseSnapshot;
  readonly selectedWindow: FleetTimeWindow;
  readonly onSelectWindow: (window: FleetTimeWindow) => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const total = snapshot.flow.claimed + snapshot.flow.inFlight + snapshot.flow.settled,
    segments = [
      ["claimed", snapshot.flow.claimed, "fill-status-unknown"],
      ["inFlight", snapshot.flow.inFlight, "fill-status-active"],
      ["settled", snapshot.flow.settled, "fill-status-done"],
    ] as const;
  let offset = 0;
  return (
    <div data-testid="cadence-fleet" className="grid min-h-0 flex-1 gap-3 overflow-y-auto lg:grid-cols-2">
      <Panel
        title={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span>{t("views.cadence.fleetWorkersTitle")}</span>
              <span className="font-mono ui-micro text-text-faint">({snapshot.workers.length})</span>
            </div>
            <div className="flex items-center gap-0.5 rounded bg-surface p-0.5" role="group">
              {FLEET_TIME_WINDOWS.map((win) => (
                <button
                  key={win}
                  type="button"
                  data-testid={`cadence-fleet-window-${win}`}
                  onClick={() => onSelectWindow(win)}
                  className={`rounded px-2 py-0.5 font-mono ui-micro transition-colors ${
                    selectedWindow === win
                      ? "bg-accent/20 font-semibold text-accent"
                      : "text-text-muted hover:text-text"
                  }`}
                >
                  {t(`views.cadence.fleetWindow.${win}`)}
                </button>
              ))}
            </div>
          </div>
        }
      >
        <div className="max-h-[32rem] space-y-1.5 overflow-y-auto pr-1">
          {snapshot.workers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <p className="ui-meta text-text-faint">
                {selectedWindow === "active"
                  ? t("views.cadence.fleetActiveEmpty")
                  : t("views.cadence.fleetWorkersEmpty")}
              </p>
              {selectedWindow === "active" ? (
                <button
                  type="button"
                  data-testid="cadence-fleet-switch-24h"
                  onClick={() => onSelectWindow("24h")}
                  className="mt-2.5 rounded bg-accent/10 px-3 py-1 font-mono ui-meta text-accent transition-colors hover:bg-accent/20"
                >
                  {t("views.cadence.fleetSwitchTo24h")}
                </button>
              ) : selectedWindow !== "all" ? (
                <button
                  type="button"
                  data-testid="cadence-fleet-switch-all"
                  onClick={() => onSelectWindow("all")}
                  className="mt-2.5 rounded bg-accent/10 px-3 py-1 font-mono ui-meta text-accent transition-colors hover:bg-accent/20"
                >
                  {t("views.cadence.fleetSwitchToAll")}
                </button>
              ) : null}
            </div>
          ) : (
            snapshot.workers.map((worker) => (
              <article
                key={worker.runtimeSessionId}
                data-testid="cadence-fleet-worker"
                className="rounded border border-border/70 bg-surface-raised/50 px-2.5 py-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${statusTone(worker)}`} />
                  <b className="truncate ui-meta">{worker.label}</b>
                  <div className="ml-auto flex items-center gap-1.5">
                    {worker.lastActiveAt ? (
                      <span className="font-mono ui-micro text-text-faint">
                        {formatTime(worker.lastActiveAt, { style: "time" }) ?? ""}
                      </span>
                    ) : null}
                    <span className="font-mono ui-micro text-text-faint">{statusBadge(worker)}</span>
                  </div>
                </div>
                {worker.taskIds.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {worker.taskIds.map((taskId) => (
                      <button
                        key={taskId}
                        type="button"
                        onClick={() => onNavigateEntity(`task/${taskId}`)}
                        className="rounded bg-accent/10 px-1.5 py-0.5 font-mono ui-micro text-accent hover:bg-accent/20"
                      >
                        {taskId}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2 ui-micro text-text-faint">
                  <p>
                    {t("views.cadence.fleetContribution", {
                      facts: worker.facts,
                      decisions: worker.decisions,
                      files: worker.touchedFiles,
                    })}
                  </p>
                  {worker.metrics ? (
                    <p className="font-mono">
                      {t("views.cadence.fleetTokens", {
                        total: formatTokens(worker.metrics.totalTokens),
                        calls: worker.metrics.toolCalls,
                      })}
                    </p>
                  ) : null}
                </div>
              </article>
            ))
          )}
        </div>
      </Panel>
      <div className="flex min-h-0 flex-col gap-3">
        <Panel title={t("views.cadence.fleetFlowTitle")}>
          <svg viewBox="0 0 100 12" role="img" aria-label={t("views.cadence.fleetFlowTitle")} className="h-8 w-full">
            {segments.map(([key, count, tone]) => {
              const width = total === 0 ? 0 : (count / total) * 100,
                x = offset;
              offset += width;
              return <rect key={key} x={x} y="1" width={width} height="10" rx="1" className={tone} />;
            })}
          </svg>
          <div className="grid grid-cols-3 gap-2 text-center ui-micro">
            {segments.map(([key, count]) => (
              <span key={key}>{t(`views.cadence.fleetFlow.${key}`, { count })}</span>
            ))}
          </div>
          <p className="mt-2 ui-meta text-text-muted">
            {t("views.cadence.fleetTurnaround", { duration: duration(snapshot.turnaroundMs) })}
          </p>
        </Panel>
        <Panel title={t("views.cadence.fleetFenceTitle")}>
          {snapshot.collisions.length === 0 ? (
            <p data-testid="cadence-fleet-fence" className="ui-meta text-status-done">
              {t("views.cadence.fleetFenceClean")}
            </p>
          ) : (
            <div data-testid="cadence-fleet-fence" className="space-y-1 text-status-blocked">
              <p className="ui-meta">{t("views.cadence.fleetFenceCollision")}</p>
              {snapshot.collisions.map(({ taskId, workerCount }) => (
                <button
                  key={taskId}
                  type="button"
                  onClick={() => onNavigateEntity(`task/${taskId}`)}
                  className="block font-mono ui-micro hover:underline"
                >
                  {t("views.cadence.fleetFenceTask", { taskId, count: workerCount })}
                </button>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
