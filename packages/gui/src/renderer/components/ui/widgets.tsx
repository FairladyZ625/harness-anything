import type { ReactNode } from "react";

export const BTN =
  "rounded-md border border-border px-3 py-1.5 ui-body text-text-muted transition-colors duration-100 hover:border-border-strong hover:bg-surface-raised hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-transparent disabled:hover:text-text-muted";

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="font-mono ui-meta uppercase tracking-wide text-text-faint">{title}</span>
        {action}
      </div>
      <div>{children}</div>
    </section>
  );
}

/**
 * 设置表单行(标准 §2.5):标签在上、控件在下占满行宽、说明小字垫底——三段竖排,
 * 不再把控件挤到行右端。多控件(主题分段、时区选择、状态色例)在 children 里横向排。
 */
export function Row({ label, desc, children }: { label: ReactNode; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="ui-body font-medium text-text">{label}</div>
      {children ? <div className="mt-1.5 flex flex-wrap items-center gap-2">{children}</div> : null}
      {desc ? <div className="mt-1 ui-meta text-text-faint">{desc}</div> : null}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-surface-raised px-1.5 py-0.5 font-mono ui-body text-text-muted">
      {children}
    </kbd>
  );
}

export interface SelectorOption {
  readonly value: string;
  readonly label: string;
}

export function SettingSelect({
  label,
  testId,
  value,
  options,
  onChange,
  disabled,
}: {
  readonly label: string;
  readonly testId: string;
  readonly value: string;
  readonly options: readonly SelectorOption[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}) {
  return (
    <select
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      className={[
        "w-72 max-w-full rounded border border-border bg-surface-raised px-2 py-1",
        "font-mono ui-meta text-text disabled:cursor-not-allowed disabled:opacity-40",
      ].join(" ")}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
