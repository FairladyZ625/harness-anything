import type { ReactNode } from "react";
import { TONE_COLOR, type StatusTone } from "./StatusTag";

/**
 * 文档型区块(标准 §2.2/§4):标题 + 计数 + 一句说明 + 右侧动作,高度由内容决定。
 * hero = 需要人动手的块(琥珀左粗边,标题与计数放大);warn = 异常块(红左粗边)。
 * 需要注意力的块用左粗边强调,不用整块高饱和底色(标准 §3)。
 */
export function Section({
  title,
  count,
  note,
  action,
  variant,
  children,
}: {
  readonly title: ReactNode;
  readonly count?: number | string;
  readonly note?: ReactNode;
  readonly action?: ReactNode;
  readonly variant?: "hero" | "warn";
  readonly children: ReactNode;
}) {
  const edgeTone: StatusTone | null = variant === "hero" ? "wait" : variant === "warn" ? "bad" : null;
  return (
    <section
      className={`mb-[26px] ${variant === undefined ? "" : "border-l-[3px] py-0.5 pl-4"}`}
      style={edgeTone === null ? undefined : { borderLeftColor: TONE_COLOR[edgeTone] }}
    >
      <div className="mb-2 flex items-baseline gap-2.5">
        <h2 className={`min-w-0 font-semibold ${variant === "hero" ? "ui-title" : "ui-body"}`}>{title}</h2>
        {count !== undefined && (
          <span
            className={`font-mono font-semibold ${variant === "hero" ? "ui-title" : "ui-body"}`}
            style={edgeTone === null ? undefined : { color: TONE_COLOR[edgeTone] }}
          >
            {count}
          </span>
        )}
        {note !== undefined && <span className="min-w-0 truncate text-text-faint ui-meta">{note}</span>}
        {action !== undefined && <span className="ml-auto shrink-0">{action}</span>}
      </div>
      {children}
    </section>
  );
}
