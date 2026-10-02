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
      className={
        "relative h-4 w-[30px] shrink-0 rounded-full border transition-colors disabled:opacity-50 " +
        (checked ? "border-transparent bg-accent" : "border-border-strong bg-surface")
      }
    >
      <span
        className={`absolute top-[2px] size-2.5 rounded-full transition-transform ${checked ? "translate-x-[16px] bg-accent-fg" : "translate-x-[2px] bg-text-faint"}`}
      />
    </button>
  );
}
