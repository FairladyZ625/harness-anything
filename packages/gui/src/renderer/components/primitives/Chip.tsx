import type { ReactNode } from "react";

/**
 * 可交互 chip(标准 §4.2,C8 语义映射):点击插入、链接跳转、可删除的贴片。
 * 与 StatusTag(静态状态标签)、FilterChips(筛选选择钮组)是三个不同语义,
 * 不并成万能组件。onRemove 形态下外层是 span——button 嵌 button 是非法 DOM;
 * 点击主体与删除热区(task_5dfe382f)拆成两个交互面。
 */
export function Chip({
  tip,
  tone = "plain",
  onClick,
  onRemove,
  removeLabel = "Remove",
  children,
}: {
  readonly tip?: string;
  readonly tone?: "plain" | "link" | "mono";
  readonly onClick?: () => void;
  /** 存在时 Chip 拆成「点击主体 + 独立删除热区」两个交互面(task_5dfe382f)。 */
  readonly onRemove?: () => void;
  /** 删除热区的无障碍名;调用方传本地化文案。 */
  readonly removeLabel?: string;
  readonly children: ReactNode;
}) {
  const base = `inline-flex items-center gap-1.5 rounded border border-border-strong bg-surface px-[7px] py-0.5 ui-micro ${tone === "mono" ? "font-mono ui-micro" : ""}`;
  if (onRemove !== undefined)
    return (
      <span data-tip={tip} className={`${base} ${onClick !== undefined ? "hover:border-accent" : ""}`}>
        {onClick !== undefined ? (
          <button type="button" onClick={onClick} className="text-left hover:text-accent">
            {children}
          </button>
        ) : (
          <span>{children}</span>
        )}
        <button
          type="button"
          aria-label={removeLabel}
          data-tip={removeLabel}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="text-text-faint hover:text-danger"
        >
          ✕
        </button>
      </span>
    );
  return onClick ? (
    <button type="button" data-tip={tip} onClick={onClick} className={`${base} hover:border-accent`}>
      {children}
    </button>
  ) : (
    <span data-tip={tip} className={base}>
      {children}
    </span>
  );
}
