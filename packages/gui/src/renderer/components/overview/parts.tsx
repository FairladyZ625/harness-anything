/** 总览旧版(#3068)的 AxisBar/统计条已随 S3 区域板重做删除;这里只剩研发态势 HUD 的 KPI 卡。 */
export function KpiCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: number | string;
  detail: string;
  tone?: string;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface px-3 py-3">
      <div className="font-mono ui-micro uppercase tracking-wide text-text-faint">{label}</div>
      <div className="mt-1 flex items-end gap-2">
        <span className="font-mono ui-heading font-semibold leading-none text-text">{value}</span>
        {tone && <span className="mb-1 h-2 w-2 rounded-full" style={{ background: tone }} />}
      </div>
      <p className="mt-2 ui-meta leading-snug text-text-muted">{detail}</p>
    </section>
  );
}
