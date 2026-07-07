import type { CloseoutReadiness, PackageDisposition } from "../../model/types";

export interface Seg {
  key: string;
  count: number;
  color: string;
  opacity?: number;
}

export const CLOSEOUT_ORDER: CloseoutReadiness[] = [
  "ready",
  "incomplete",
  "missing",
  "failed",
  "passed",
  "not_required",
];

const CLOSEOUT_GRAY: Record<CloseoutReadiness, number> = {
  not_required: 14,
  missing: 30,
  incomplete: 44,
  passed: 60,
  failed: 78,
  ready: 0,
};

export const closeoutColor = (v: CloseoutReadiness) =>
  v === "ready"
    ? "var(--color-accent)"
    : `color-mix(in oklch, var(--color-text) ${CLOSEOUT_GRAY[v]}%, transparent)`;

export const DISPOSITION_ORDER: PackageDisposition[] = ["active", "archived", "tombstoned"];

export const DISPOSITION_OPACITY: Record<PackageDisposition, number> = {
  active: 1,
  archived: 0.35,
  tombstoned: 0.15,
};

export function AxisBar({ label, segments }: { label: string; segments: Seg[] }) {
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  return (
    <div className="grid gap-2 md:grid-cols-[132px_1fr] md:items-center">
      <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">{label}</span>
      <div className="min-w-0">
        <div className="flex h-3.5 overflow-hidden rounded-full bg-surface-raised ring-1 ring-border">
          {total > 0 &&
            segments
              .filter((s) => s.count > 0)
              .map((s) => (
                <div
                  key={s.key}
                  title={`${s.key} · ${s.count}`}
                  style={{ width: `${(s.count / total) * 100}%`, background: s.color, opacity: s.opacity ?? 1 }}
                />
              ))}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-text-faint">
          {segments
            .filter((s) => s.count > 0)
            .map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color, opacity: s.opacity ?? 1 }} />
                {s.key} {s.count}
              </span>
            ))}
        </div>
      </div>
    </div>
  );
}

export function Card({
  title,
  children,
  bodyClassName = "p-3",
}: {
  title: string;
  children: React.ReactNode;
  bodyClassName?: string;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface">
      <div className="border-b border-border px-3 py-2 font-mono text-[11px] uppercase tracking-wide text-text-faint">
        {title}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

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
      <div className="font-mono text-[11px] uppercase tracking-wide text-text-faint">{label}</div>
      <div className="mt-1 flex items-end gap-2">
        <span className="font-mono text-[28px] font-semibold leading-none text-text">{value}</span>
        {tone && <span className="mb-1 h-2 w-2 rounded-full" style={{ background: tone }} />}
      </div>
      <p className="mt-2 text-[12px] leading-snug text-text-muted">{detail}</p>
    </section>
  );
}
