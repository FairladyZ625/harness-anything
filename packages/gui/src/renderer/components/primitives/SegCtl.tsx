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
      // 与功能按钮共用桌面密度和粗指针点击盒。
      className="inline-flex flex-wrap overflow-hidden rounded border border-border-strong"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          data-tip={option.tip}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={`ui-control inline-flex items-center justify-center px-3 ui-micro disabled:cursor-not-allowed disabled:opacity-40 ${
            option.value === value ? "bg-accent font-semibold text-accent-fg" : "text-text-muted hover:bg-surface"
          }`}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}
