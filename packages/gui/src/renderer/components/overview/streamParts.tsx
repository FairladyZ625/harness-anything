import { t } from "../../i18n/index.tsx";
import { localMonthDayTime } from "../../model/local-time.ts";

/**
 * 四条流的共用骨架:紧凑行、就地状态切换、内部滚动、空态。
 * 「不静默截断」约定:列表容器只做内部滚动,行集一页全给,不 slice。
 */

/** 分段切换钮(与旧总览/看板共用的视觉)。 */
export const seg = (active: boolean) =>
  `rounded px-2 py-0.5 font-mono text-[11px] tabular-nums ${
    active ? "bg-surface-raised font-medium text-text" : "text-text-muted hover:text-text"
  }`;

export function StreamTabs<T extends string>({
  options,
  value,
  onChange,
  testIdOf,
}: {
  options: ReadonlyArray<{ readonly key: T; readonly label: string; readonly count: number }>;
  value: T;
  onChange: (next: T) => void;
  testIdOf?: (key: T) => string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-0.5 rounded-md border border-border p-0.5" role="tablist">
      {options.map((option) => (
        <button
          key={option.key}
          role="tab"
          aria-selected={option.key === value}
          data-testid={testIdOf?.(option.key)}
          onClick={() => onChange(option.key)}
          title={option.label}
          className={seg(option.key === value)}
        >
          {option.label} {option.count}
        </button>
      ))}
    </div>
  );
}

/** 内部滚动的行容器:高度有上限、行集不截断。 */
export function StreamBody({
  children,
  testId,
  maxHeightClass = "max-h-[24rem]",
}: {
  children: React.ReactNode;
  testId?: string;
  maxHeightClass?: string;
}) {
  return (
    <div className={`${maxHeightClass} space-y-0.5 overflow-y-auto pr-1 xl:min-h-0 xl:flex-1 xl:max-h-none`} data-testid={testId}>
      {children}
    </div>
  );
}

export function StreamEmpty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-border bg-surface-raised px-3 py-4 text-[13px] text-text-muted">
      {children}
    </p>
  );
}

export function StreamExitButton({ label, onClick, title }: { label: string; onClick: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title ?? label}
      className="ml-auto shrink-0 rounded border border-border px-2 py-1 font-mono text-[11px] text-accent hover:bg-surface-raised"
    >
      {label}
    </button>
  );
}

export const streamTime = (iso: string | null | undefined) =>
  iso ? localMonthDayTime(iso) ?? t("views.overviewView.streamCreatedUnknown") : t("views.overviewView.streamCreatedUnknown");
