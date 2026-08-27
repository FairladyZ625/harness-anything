import { ChartLineUp, Flask, Gauge, Timer } from "@phosphor-icons/react";
import { useCiObservatoryQuery } from "../ci-observatory-data.ts";
import { t } from "../i18n/index.tsx";

export function CiObservatoryView({ repoId }: { readonly repoId: string }) {
  const query = useCiObservatoryQuery(repoId),
    data = query.data;
  if (query.isPending) return <div className="p-6 text-text-faint">{t("views.ciObservatory.loading")}</div>;
  if (query.isError || !data) return <div className="p-6 text-danger">{t("views.ciObservatory.failed")}</div>;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="ci-observatory-view">
      <header className="mb-4 flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <Flask className="text-text-faint" />
        <h1 className="ui-title font-semibold">{t("views.ciObservatory.title")}</h1>
        <span className="font-mono text-[11px] text-text-faint">
          {data.status} · {data.runs.length} runs
        </span>
      </header>
      <div className="grid gap-3 lg:grid-cols-2">
        <Section icon={<Gauge />} title={t("views.ciObservatory.flakes")}>
          {data.flakes.length === 0 ? (
            <Empty />
          ) : (
            <table className="w-full text-left text-[12px]">
              <thead>
                <tr>
                  <th>Test</th>
                  <th>Rate</th>
                  <th>p50 / p95</th>
                  <th>Quarantine</th>
                </tr>
              </thead>
              <tbody>
                {data.flakes.slice(0, 20).map((row) => (
                  <tr key={row.test} className="border-t border-border">
                    <td className="max-w-[22rem] truncate py-1.5 pr-2 font-mono" title={row.test}>
                      {row.test}
                    </td>
                    <td>{(row.flakeRate * 100).toFixed(1)}%</td>
                    <td>
                      {Math.round(row.p50Ms)} / {Math.round(row.p95Ms)}ms
                    </td>
                    <td>{row.quarantined ? `${row.ownerTask} · ${row.quarantineDays}d` : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
        <Section icon={<Timer />} title={t("views.ciObservatory.shards")}>
          {data.shardDurations.length === 0 ? (
            <Empty />
          ) : (
            data.shardDurations.map((row) => (
              <div key={row.shard} className="flex items-center gap-2 border-t border-border py-2 text-[12px]">
                <span className="w-16 font-mono">shard {row.shard}</span>
                <div className="h-2 flex-1 bg-surface-raised">
                  <div
                    className="h-full bg-accent"
                    style={{
                      width: `${Math.min(100, (row.durationMs / Math.max(...data.shardDurations.map((entry) => entry.durationMs))) * 100)}%`,
                    }}
                  />
                </div>
                <span className="w-20 text-right font-mono">{Math.round(row.durationMs)}ms</span>
              </div>
            ))
          )}
          {data.l0MedianMs !== null ? (
            <p className="mt-3 text-[11px] text-text-faint">L0 median: {Math.round(data.l0MedianMs)}ms</p>
          ) : null}
        </Section>
        <Section icon={<ChartLineUp />} title={t("views.ciObservatory.gates")}>
          {data.gateTrends.length === 0 ? (
            <Empty />
          ) : (
            data.gateTrends.map((row) => (
              <div key={`${row.gate}:${row.metric}`} className="border-t border-border py-2 text-[12px]">
                <div className="font-mono">
                  {row.gate} · {row.metric}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {row.points.slice(-12).map((point) => (
                    <span
                      key={`${point.runId}:${point.occurredAt}`}
                      className={point.pass ? "text-status-done" : "text-danger"}
                    >
                      {point.value}
                    </span>
                  ))}
                </div>
              </div>
            ))
          )}
        </Section>
        <Section icon={<Timer />} title={t("views.ciObservatory.runs")}>
          {data.runs.slice(0, 20).map((run) => (
            <div key={`${run.runId}:${run.job}`} className="border-t border-border py-2 text-[12px]">
              <div className="flex justify-between gap-2">
                <span className="font-mono">{run.job}</span>
                <span className={run.pass ? "text-status-done" : "text-danger"}>{run.pass ? "pass" : "fail"}</span>
              </div>
              <div className="text-text-faint">
                {run.runId} · {Math.round(run.wallclockMs)}ms · {run.sha.slice(0, 10)}
              </div>
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="rounded border border-border bg-surface p-3">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
        {icon}
        {title}
      </div>
      {children}
    </section>
  );
}
function Empty() {
  return <div className="py-4 text-[12px] text-text-faint">No observations.</div>;
}
