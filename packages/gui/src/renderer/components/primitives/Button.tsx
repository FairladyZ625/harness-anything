import { useEffect, useState, type ReactNode } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useEntryMotion } from "../../motion-config.tsx";
import { MOTION_DURATION } from "../../motion-tokens.ts";

/**
 * 通用按钮(标准 §4.2):全仓唯一按钮实现,plain/primary/danger/ghost 四档以内,
 * 不搞变体矩阵。纯交互外壳(EntityRefLink 这类自带语义的 button)不由此组件承载。
 * 桌面功能控件使用共享紧凑密度；粗指针通过样式扩展真实点击盒，不侵占邻居。
 */
export function Button({
  variant = "plain",
  size = "md",
  type = "button",
  tip,
  testId,
  ariaLabel,
  disabled,
  loading = false,
  onClick,
  children,
}: {
  readonly variant?: "plain" | "primary" | "danger" | "ghost";
  readonly size?: "sm" | "md";
  readonly type?: "button" | "submit";
  readonly tip?: string;
  readonly testId?: string;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  /** Keep the original children in place; feedback appears only after 100ms. */
  readonly loading?: boolean;
  readonly onClick?: () => void;
  readonly children: ReactNode;
}) {
  const [showSpinner, setShowSpinner] = useState(false);
  const { enabled, reduced } = useEntryMotion();
  useEffect(() => {
    if (!loading) {
      setShowSpinner(false);
      return;
    }
    const timer = setTimeout(() => setShowSpinner(true), 100);
    return () => clearTimeout(timer);
  }, [loading]);
  const feedbackVisible = loading && showSpinner;
  const tone =
    variant === "primary"
      ? "border-transparent bg-accent font-semibold text-accent-fg hover:brightness-110"
      : variant === "danger"
        ? "border-danger/45 text-danger hover:bg-danger/10"
        : variant === "ghost"
          ? "border-transparent text-text-muted hover:bg-surface hover:text-text"
          : "border-border-strong text-text hover:border-text-faint hover:bg-surface";
  return (
    <button
      type={type}
      data-control-size={size}
      data-tip={tip}
      data-testid={testId}
      aria-label={ariaLabel}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      onClick={onClick}
      className={`ui-control relative inline-grid w-max shrink-0 items-center justify-center whitespace-nowrap rounded-sm border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${size === "sm" ? "px-2 ui-micro" : "px-2.5 ui-meta"} ${tone} disabled:cursor-not-allowed disabled:opacity-45`}
    >
      <span
        className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5 ${feedbackVisible ? "opacity-0" : ""}`}
      >
        {children}
      </span>
      {feedbackVisible && (
        <motion.span
          data-testid="button-spinner"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 col-start-1 row-start-1 flex items-center justify-center"
          initial={enabled ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          transition={{ duration: MOTION_DURATION.reducedFade }}
        >
          <CircleNotch size="1em" weight="bold" className={enabled && !reduced ? "animate-spin" : undefined} />
        </motion.span>
      )}
    </button>
  );
}
