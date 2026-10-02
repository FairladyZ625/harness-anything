/**
 * 开关(标准 §4.2):全仓唯一 Toggle。小轨道放进有实际尺寸的 button 外壳——
 * 40px 命中区由外壳的真实布局尺寸承担(标准 §1.9-③),不用伪元素外扩、不压相邻控件。
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  readonly checked: boolean;
  readonly onChange?: (checked: boolean) => void;
  readonly label: string;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded disabled:opacity-50"
    >
      <span
        className={`relative h-4 w-[30px] rounded-full border transition-colors ${
          checked ? "border-transparent bg-accent" : "border-border-strong bg-surface"
        }`}
      >
        <span
          className={`absolute top-[2px] size-2.5 rounded-full transition-transform ${checked ? "translate-x-[16px] bg-accent-fg" : "translate-x-[2px] bg-text-faint"}`}
        />
      </span>
    </button>
  );
}
