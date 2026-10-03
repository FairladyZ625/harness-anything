/** 表单文本输入(标准 §2.5 表单字段契约的一部分):label 必填走 aria-label,mono 档用于机器值。 */
export function TextInput({
  value,
  onChange,
  placeholder,
  mono = false,
  type = "text",
  label,
  disabled,
  testId,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly mono?: boolean;
  readonly type?: "text" | "password" | "number";
  readonly label: string;
  readonly disabled?: boolean;
  readonly testId?: string;
}) {
  return (
    <input
      type={type}
      aria-label={label}
      data-testid={testId}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      autoComplete={type === "password" ? "off" : undefined}
      spellCheck={type === "password" ? false : undefined}
      onChange={(event) => onChange(event.target.value)}
      className={`min-w-0 rounded border border-border-strong bg-surface px-2 py-1 ui-meta text-text outline-none focus-visible:border-accent disabled:opacity-50 ${mono ? "font-mono ui-micro" : ""}`}
    />
  );
}
