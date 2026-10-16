import { useId } from "react";
import { motion } from "motion/react";
import { useEntryMotion } from "../../motion-config.tsx";
import { MOTION_DURATION, MOTION_EASE } from "../../motion-tokens.ts";

export function SegCtl<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
}: {
  readonly value: T;
  readonly options: readonly {
    readonly value: T;
    readonly label: string;
    readonly tip?: string;
    readonly testId?: string;
  }[];
  readonly onChange: (value: T) => void;
  readonly label?: string;
  readonly disabled?: boolean;
}) {
  // 选中背景是共享元素(layoutId 按实例隔离),切换时从旧选项滑到新选项;
  // 减少动态效果或偏好「关」时不渲染 motion 元素,瞬时到位(规范 §6)。
  // 层级契约:thumb 置底(z-auto),所有 label 提 z-10——layoutId 滑动途中 thumb
  // 挂在新选项按钮内、DOM 序在旧选项之后,不提层就会把途经选项的文字盖住。
  // thumb 用 accent/10 洗底 + accent 左竖线(与 DenseRow/RecordRow 选中语言一致):
  // 途经的 muted 文字压在洗底上仍可读(暗 7.96/亮 5.74),纯 accent 实底只有 1.05/1.82。
  const thumbId = useId();
  const { enabled, reduced } = useEntryMotion();
  const sliding = enabled && !reduced;
  const thumbClass = "absolute inset-0 bg-accent/10 shadow-[inset_2px_0_0_var(--color-accent)]";
  return (
    <span
      role="group"
      aria-label={label}
      aria-disabled={disabled || undefined}
      // 与功能按钮共用桌面密度和粗指针点击盒。
      className="inline-flex flex-wrap overflow-hidden rounded border border-border-strong"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            data-testid={option.testId}
            disabled={disabled}
            data-tip={option.tip}
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={`relative ui-control inline-flex shrink-0 whitespace-nowrap items-center justify-center px-3 ui-micro disabled:cursor-not-allowed disabled:opacity-40 ${
              selected ? "font-semibold text-text" : "text-text-muted hover:bg-surface"
            }`}
          >
            {selected &&
              (sliding ? (
                <motion.span
                  layoutId={thumbId}
                  data-testid="seg-ctl-thumb"
                  className={thumbClass}
                  transition={{ duration: MOTION_DURATION.controlSlide, ease: MOTION_EASE.out }}
                />
              ) : (
                <span data-testid="seg-ctl-thumb" className={thumbClass} />
              ))}
            <span className="relative z-10">{option.label}</span>
          </button>
        );
      })}
    </span>
  );
}
