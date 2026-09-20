import { t } from "../../i18n/index.tsx";
import type { FleetPulseSnapshot, FleetWorkerStatus } from "../../model/cadence-fleet.ts";

const STATUS_TONE: Record<FleetWorkerStatus, string> = {
  live: "bg-status-active",
  idle: "bg-status-unknown",
  exited: "bg-text-faint",
};

function duration(value: number | null): string {
  if (value === null) return t("views.cadence.fleetTurnaroundUnknown");
  const minutes = Math.round(value / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 6) / 10}h`;
}

function Panel({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="min-h-0 rounded-lg border border-border bg-surface/60 p-3">
      <h2 className="mb-2 ui-body font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function FleetPulsePane({
  snapshot,
  onNavigateEntity,
}: {
  readonly snapshot: FleetPulseSnapshot;
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
      <Panel title={t("views.cadence.fleetWorkersTitle")}>
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {snapshot.workers.length === 0 ? (
            <p className="ui-meta text-text-faint">{t("views.cadence.fleetWorkersEmpty")}</p>
          ) : (
            snapshot.workers.map((worker) => (
              <article
                key={worker.runtimeSessionId}
                data-testid="cadence-fleet-worker"
                className="rounded border border-border/70 bg-surface-raised/50 px-2 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${STATUS_TONE[worker.status]}`} />
                  <b className="truncate ui-meta">{worker.label}</b>
                  <span className="ml-auto font-mono ui-micro text-text-faint">
                    {t(`views.cadence.fleetStatus.${worker.status}`)}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
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
                <p className="mt-1 ui-micro text-text-faint">
                  {t("views.cadence.fleetContribution", {
                    facts: worker.facts,
                    decisions: worker.decisions,
                    files: worker.touchedFiles,
                  })}
                </p>
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
