export function SegCtl<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
}: {
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string; readonly tip?: string }[];
  readonly onChange: (value: T) => void;
  readonly label?: string;
  readonly disabled?: boolean;
}) {
  return (
    <span
      role="group"
      aria-label={label}
      aria-disabled={disabled || undefined}
      // overflow-hidden 会把段钮的命中区伪元素一并裁掉;首末段自带内圆角
      // (容器圆角 3.5px − 1px 边框)补回原本由裁切提供的圆角观感。
      className="inline-flex flex-wrap rounded border border-border-strong"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          data-tip={option.tip}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={`disabled:cursor-not-allowed disabled:opacity-40 relative px-2.5 py-0.5 ui-micro first:rounded-l-[2.5px] last:rounded-r-[2.5px] after:absolute after:content-[''] after:inset-x-0 after:-top-[10.5px] after:-bottom-[10.5px] ${
            option.value === value ? "bg-accent font-semibold text-accent-fg" : "text-text-muted hover:bg-surface"
          }`}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}
