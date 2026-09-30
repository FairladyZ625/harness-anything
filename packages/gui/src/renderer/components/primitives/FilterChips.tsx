import type { ReactNode } from "react";

/**
 * 筛选按钮(标准 §4):每个带计数,选中态为青色(accent 是唯一行动强调色)。
 */
export function FilterChips<T extends string>({
  chips,
  value,
  onChange,
}: {
  readonly chips: readonly { readonly key: T; readonly label: ReactNode; readonly count: number }[];
  readonly value: T;
  readonly onChange: (key: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => {
        const active = chip.key === value;
        return (
          <button
            key={chip.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(chip.key)}
            className={`h-7 rounded-xs border px-3 ui-meta ${
              active
                ? "border-accent/40 bg-accent/15 text-accent"
                : "border-border bg-text/5 text-text-muted hover:text-text"
            }`}
          >
            {chip.label}
            <b className="ml-1 font-mono font-medium tabular-nums">{chip.count}</b>
          </button>
        );
      })}
    </div>
  );
}
