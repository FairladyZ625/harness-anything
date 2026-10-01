import type { ReactNode } from "react";
import { TitleText } from "./TitleText.tsx";
import { formatListTime, formatTime } from "../../model/time.ts";

/** 条目高度(标准 §3 v2):单行 ≥40px,宽松两行 56px。仪表盘落位按同一档计算行高。 */
export const DENSE_ROW_PX = 40;
export const DENSE_ROW_RELAXED_PX = 56;

/** 列表行尾时间(标准 §2.4):按偏好显示相对或绝对,悬停始终给到秒的绝对时间。 */
export function RowTime({ at, className }: { readonly at: string | number; readonly className?: string }) {
  const absolute = formatTime(typeof at === "string" ? at : new Date(at).toISOString(), {
    style: "date-time-seconds",
  });
  return (
    <span title={absolute ?? undefined} className={className}>
      {formatListTime(at)}
    </span>
  );
}

/**
 * 列表条目(标准 §4):可选序号、状态标签、标题(省略号)+ 灰色原因、右侧等宽时间。
 * relaxed 为宽松两行:标题一行、原因换行成弱色第二行——目录页(§2.5)、仪表盘区域
 * 富余足够时与放大层列表都用它展示原因。高度、字号、间距只在这里定,调用点不压缩。
 * 字符串标题经 TitleText 拆成重点与弱色补充;调用方传节点(如搜索高亮)时原样渲染。
 * data-dense-row 是 RegionBoard 量「至少露出三条」时认的行标记。
 * action 是行右侧的就地动作(标准 §4:行的动作放在该行右侧):主点击面变成包住
 * 内容列的内层 button,动作在它右边,避免按钮嵌套。
 */
export function DenseRow({
  index,
  tag,
  title,
  reason,
  time,
  action,
  relaxed = false,
  selected = false,
  hoverTitle,
  onClick,
}: {
  readonly index?: number | string;
  readonly tag?: ReactNode;
  readonly title: ReactNode;
  readonly reason?: ReactNode;
  readonly time?: ReactNode;
  readonly action?: ReactNode;
  readonly relaxed?: boolean;
  readonly selected?: boolean;
  /** 行悬停全文:主文字被收束(可读名、人话短语)时,原始机器串放这里(视觉基线 v2)。 */
  readonly hoverTitle?: string;
  readonly onClick?: () => void;
}) {
  // 没有标签就不留标签列:否则每行前面空出 3rem 缩进。
  const cols =
    tag === undefined
      ? index === undefined
        ? "grid-cols-[minmax(0,1fr)_auto]"
        : "grid-cols-[1rem_minmax(0,1fr)_auto]"
      : index === undefined
        ? "grid-cols-[minmax(3rem,auto)_minmax(0,1fr)_auto]"
        : "grid-cols-[1rem_minmax(3rem,auto)_minmax(0,1fr)_auto]";
  const stateCls = selected
    ? "bg-accent/10 shadow-[inset_2px_0_0_var(--color-accent)]"
    : onClick === undefined
      ? ""
      : "hover:bg-text/5";
  const sizeCls = relaxed ? "min-h-14 py-2" : "min-h-10 py-2.5";
  const content = (
    <>
      {index !== undefined && <span className="font-mono text-text-faint ui-meta">{index}</span>}
      {tag !== undefined && <span className="min-w-0">{tag}</span>}
      <span className={`min-w-0 ${relaxed ? "" : "truncate"}`}>
        <span className={`${relaxed ? "block " : ""}truncate text-text`}>
          {typeof title === "string" ? <TitleText title={title} /> : title}
        </span>
        {reason !== undefined &&
          (relaxed ? (
            <span className="mt-0.5 block truncate text-text-faint ui-meta">{reason}</span>
          ) : (
            <span className="ml-1.5 text-text-faint ui-meta">· {reason}</span>
          ))}
      </span>
      {time !== undefined && (
        <span className="whitespace-nowrap font-mono tabular-nums text-text-muted ui-meta">{time}</span>
      )}
    </>
  );
  if (action !== undefined) {
    const Surface = onClick === undefined ? "div" : "button";
    return (
      <div
        data-dense-row
        data-selected={selected || undefined}
        className={`flex w-full items-center gap-2.5 border-t border-border px-3.5 ui-body ${sizeCls} ${stateCls}`}
      >
        {/* 主点击面只包内容列:行右侧动作不落在它里面,选中/悬停态仍整行生效。 */}
        <Surface
          {...(onClick === undefined ? {} : { type: "button" as const, onClick })}
          className={`grid min-w-0 flex-1 items-center gap-2.5 text-left ${cols} ${
            onClick === undefined ? "" : "cursor-pointer"
          }`}
        >
          {content}
        </Surface>
        <span className="flex shrink-0 items-center">{action}</span>
      </div>
    );
  }
  const rowCls = `grid w-full items-center gap-2.5 border-t border-border px-3.5 ui-body ${cols} ${sizeCls} ${stateCls}`;
  if (onClick === undefined) {
    return (
      <div data-dense-row data-selected={selected || undefined} title={hoverTitle} className={rowCls}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      data-dense-row
      data-selected={selected || undefined}
      title={hoverTitle}
      className={`w-full cursor-pointer text-left ${rowCls}`}
    >
      {content}
    </button>
  );
}
