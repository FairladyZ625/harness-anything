import type { CSSProperties, ReactNode } from "react";
import { motion } from "motion/react";
import { TONE_COLOR, type StatusTone } from "./StatusTag";

/**
 * 仪表盘区域(标准 §4):玻璃面板 + 状态竖线 + 标题行(标题、状态标签、大数字);
 * 行体铺满剩余高度,内容溢出时在区域内部滚动;可进入放大层。
 *
 * 放大层联动:给 focusId 后本区域成为 motion 共享布局的一员,FocusLayer 用同一
 * layoutId 从原位长到中央(标准 §6:布局动画用 motion,不手写 FLIP)。区域重排
 * (权重变化)由 layout 属性平滑过渡。
 */
export function Region({
  title,
  tag,
  big,
  bigTone,
  edge,
  footer,
  focusId,
  onOpen,
  children,
}: {
  readonly title: ReactNode;
  readonly tag?: ReactNode;
  readonly big?: number | string;
  readonly bigTone?: StatusTone;
  readonly edge?: StatusTone;
  readonly footer?: ReactNode;
  readonly focusId?: string;
  readonly onOpen?: () => void;
  readonly children: ReactNode;
}) {
  return (
    <motion.section
      data-entry-region
      layout
      layoutId={focusId}
      onClick={onOpen}
      className={`glass status-edge relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-sm ${
        onOpen === undefined ? "" : "cursor-zoom-in"
      }`}
      style={edge === undefined ? undefined : ({ "--status-edge": TONE_COLOR[edge] } as CSSProperties)}
    >
      <div className="flex flex-none items-center gap-2 px-3 pb-[7px] pt-[9px]">
        <h2 className="min-w-0 truncate font-semibold ui-meta">{title}</h2>
        {tag}
        {big !== undefined && (
          <span
            className="ml-auto font-mono font-semibold leading-none tabular-nums ui-heading"
            style={bigTone === undefined ? undefined : { color: TONE_COLOR[bigTone] }}
          >
            {big}
          </span>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="h-full overflow-y-auto">{children}</div>
      </div>
      {footer !== undefined && (
        <div className="flex flex-none items-center gap-1.5 px-3 pb-[7px] pt-1 text-text-faint ui-meta">{footer}</div>
      )}
    </motion.section>
  );
}
