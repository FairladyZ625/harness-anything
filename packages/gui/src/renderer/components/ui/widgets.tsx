import type { ReactNode } from "react";

export const BTN =
  "rounded-md border border-border px-3 py-1.5 text-[13px] text-text-muted hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="font-mono text-[12px] uppercase tracking-wide text-text-faint">{title}</span>
        {action}
      </div>
      <div>{children}</div>
    </section>
  );
}

export function Row({
  label,
  desc,
  children,
}: {
  label: ReactNode;
  desc?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="ui-body">{label}</div>
        {desc && <div className="ui-meta mt-0.5 text-text-faint">{desc}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { key: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border">
      {options.map((o, i) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`px-3 py-1.5 text-[13px] ${i > 0 ? "border-l border-border" : ""} ${
            value === o.key
              ? "bg-surface-raised font-medium"
              : "text-text-muted hover:bg-surface-raised/50"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={`relative inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-accent" : "bg-border-strong"
      } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
    >
      <span
        className={`absolute left-[2px] h-[14px] w-[14px] rounded-full transition-transform ${
          checked ? "translate-x-[14px] bg-accent-fg" : "bg-surface"
        }`}
      />
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-surface-raised px-1.5 py-0.5 font-mono text-[13px] text-text-muted">
      {children}
    </kbd>
  );
}
