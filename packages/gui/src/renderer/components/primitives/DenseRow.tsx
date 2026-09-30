import type { ReactNode } from "react";
import { TitleText } from "./TitleText.tsx";

/**
 * 单行条目(标准 §4):可选序号、状态标签、标题(省略号)+ 灰色原因、右侧等宽时间。
 * relaxed 为宽松模式两行(约 44px):标题一行、原因换行成第二行——仪表盘区域
 * 富余足够时与放大层列表都用它展示原因(标准 §2.1)。字符串标题经 TitleText 拆成
 * 重点与弱色补充;调用方传节点(如搜索高亮)时原样渲染。
 */
export function DenseRow({
  index,
  tag,
  title,
  reason,
  time,
  relaxed = false,
  selected = false,
  onClick,
}: {
  readonly index?: number | string;
  readonly tag?: ReactNode;
  readonly title: ReactNode;
  readonly reason?: ReactNode;
  readonly time?: ReactNode;
  readonly relaxed?: boolean;
  readonly selected?: boolean;
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
  const rowCls = `grid w-full items-center gap-[7px] border-t border-border px-3 ${cols} ${
    relaxed ? "min-h-11 py-1" : "h-[25px]"
  } ${stateCls}`;
  const content = (
    <>
      {index !== undefined && <span className="font-mono text-text-faint ui-micro">{index}</span>}
      {tag !== undefined && <span className="min-w-0">{tag}</span>}
      <span className={`min-w-0 ${relaxed ? "" : "truncate"}`}>
        <span className={`${relaxed ? "block " : ""}truncate text-text`}>
          {typeof title === "string" ? <TitleText title={title} /> : title}
        </span>
        {reason !== undefined &&
          (relaxed ? (
            <span className="block truncate text-text-faint ui-meta">{reason}</span>
          ) : (
            <span className="ml-[5px] text-text-faint ui-meta">· {reason}</span>
          ))}
      </span>
      {time !== undefined && (
        <span className="whitespace-nowrap font-mono tabular-nums text-text-muted ui-meta">{time}</span>
      )}
    </>
  );
  if (onClick === undefined) {
    return (
      <div data-selected={selected || undefined} className={rowCls}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      data-selected={selected || undefined}
      className={`w-full cursor-pointer text-left ${rowCls}`}
    >
      {content}
    </button>
  );
}
