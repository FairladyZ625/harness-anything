import type { CSSProperties, ReactNode } from "react";

/**
 * 动作失败的就地呈现(标准 §2.5 表单:保存失败时就地显示原因与下一步,不只弹通用
 * 错误;业主 2026-09-30 遇到 daemon 超时导致 Agent 声明保存失败只显示通用错误)。
 * 红竖线 + 低饱和底,紧贴触发动作的区域渲染;文本是通道里带原因的完整消息。
 */
export function ActionError({ children }: { readonly children: ReactNode }) {
  return (
    <p
      role="alert"
      data-testid="action-error"
      className="status-edge relative mt-2 rounded-xs bg-status-blocked/5 py-1.5 pl-3.5 pr-3 ui-meta text-status-blocked"
      style={{ "--status-edge": "var(--color-status-blocked)" } as CSSProperties}
    >
      {children}
    </p>
  );
}
