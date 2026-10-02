import type { ReactNode } from "react";

/**
 * 通用按钮(标准 §4.2):全仓唯一按钮实现,plain/primary/danger/ghost 四档以内,
 * 不搞变体矩阵。纯交互外壳(EntityRefLink 这类自带语义的 button)不由此组件承载。
 */
export function Button({
  variant = "plain",
  size = "md",
  type = "button",
  tip,
  testId,
  disabled,
  onClick,
  children,
}: {
  readonly variant?: "plain" | "primary" | "danger" | "ghost";
  readonly size?: "sm" | "md";
  readonly type?: "button" | "submit";
  readonly tip?: string;
  readonly testId?: string;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly children: ReactNode;
}) {
  const tone =
    variant === "primary"
      ? "border-transparent bg-accent font-semibold text-accent-fg hover:brightness-110"
      : variant === "danger"
        ? "border-danger/45 text-danger hover:bg-danger/10"
        : variant === "ghost"
          ? "border-transparent text-text-muted hover:border-border-strong"
          : "border-border-strong text-text hover:border-text-faint hover:bg-surface";
  return (
    <button
      type={type}
      data-tip={tip}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded border ${size === "sm" ? "px-2 py-0.5 ui-micro" : "px-2.5 py-1 ui-meta"} ${tone} disabled:cursor-not-allowed disabled:opacity-45`}
    >
      {children}
    </button>
  );
}
