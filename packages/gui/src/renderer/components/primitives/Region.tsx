import type { CSSProperties, ReactNode } from "react";
import { RegionDragHandle, RegionLayoutControls } from "./page-regions.tsx";
import { motion } from "motion/react";
import { TONE_COLOR, type StatusTone } from "./StatusTag";

/**
 * 仪表盘区域(标准 §4):玻璃面板 + 状态竖线 + 标题行(标题、状态标签、大数字);
 * 行体铺满剩余高度,内容溢出时在区域内部滚动;可进入放大层。
 *
 * 行体两种形态:默认贴框,给自带左右边距的 DenseRow;padded 带与行同宽的边距,给正文
 * 段落、整篇文档、按天进展这类自己不带边距的内容——调用点不再各包一层。
 * 标题行不设动作位:右侧是大数字(本身是入口),整块又可点开放大层;行的动作放在该行
 * 右侧,区域级的去向放在页脚右侧。
 *
 * 放大层联动:给 focusId 后本区域成为 motion 共享布局的一员,FocusLayer 用同一
 * layoutId 从原位长到中央(标准 §6:布局动画用 motion,不手写 FLIP)。布局过渡只发生在
 * 放大层开合那一刻(focusOpen 变化):平时区域的尺寸、位置变化直接到位——布局过渡是
 * 缩放外框,文字会跟着被拉伸压扁。开合时外框在缩放,标题行、行体、页脚保持原尺寸。
 */
export function Region({
  title,
  tag,
  big,
  bigTone,
  edge,
  footer,
  focusId,
  focusOpen = false,
  onOpen,
  padded = false,
  children,
}: {
  readonly title: ReactNode;
  readonly tag?: ReactNode;
  readonly big?: number | string;
  readonly bigTone?: StatusTone;
  readonly edge?: StatusTone;
  readonly footer?: ReactNode;
  readonly focusId?: string;
  readonly focusOpen?: boolean;
  readonly onOpen?: () => void;
  readonly padded?: boolean;
  readonly children: ReactNode;
}) {
  // 没有 focusId 的区域不参与任何布局过渡;有的,内容层只跟随外框位置、不随它缩放。
  const handle = RegionDragHandle();
  const content = focusId === undefined ? undefined : "position";
  return (
    <motion.section
      data-entry-region
      layoutId={focusId}
      layoutDependency={focusOpen}
      onClick={onOpen}
      className={`${handle === null ? "glass" : "border border-border bg-surface"} status-edge relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-sm ${
        onOpen === undefined ? "" : "cursor-zoom-in"
      }`}
      style={edge === undefined ? undefined : ({ "--status-edge": TONE_COLOR[edge] } as CSSProperties)}
    >
      <motion.div
        layout={content}
        layoutDependency={focusOpen}
        className="flex flex-none items-center gap-2 px-3 pb-[7px] pt-[9px]"
      >
        {handle}
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
        <span className="ml-auto shrink-0">
          <RegionLayoutControls />
        </span>
      </motion.div>
      <motion.div layout={content} layoutDependency={focusOpen} className="relative min-h-0 flex-1">
        {/* padded 是长正文容器(标准 §4.1):滚动/裁切/边距由这里统一管,正文词内换行默认开。 */}
        <div className={`h-full overflow-y-auto ${padded ? "break-words px-3.5 pb-3" : ""}`}>{children}</div>
      </motion.div>
      {footer !== undefined && (
        <motion.div
          layout={content}
          layoutDependency={focusOpen}
          className="flex flex-none items-center gap-1.5 px-3 pb-[7px] pt-1 text-text-faint ui-meta"
        >
          {footer}
        </motion.div>
      )}
    </motion.section>
  );
}
