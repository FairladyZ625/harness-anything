import { ArrowLeft, ArrowRight, X } from "@phosphor-icons/react";

/**
 * 聚光灯焦点历史条(REQ-GUI-04 + REQ-GUI-01 navigation history)。
 *
 * 焦点切换推栈,back/forward/clear。breadcrumb 显示当前焦点。
 * 焦点在 territory/spotlight 间切换不丢(D6 焦点连续性)。
 */
export function FocusHistoryBar({
  canBack,
  canForward,
  breadcrumb,
  onBack,
  onForward,
  onClear,
}: {
  canBack: boolean;
  canForward: boolean;
  breadcrumb: { kindLabel: string; title: string; nodeId: string } | null;
  onBack: () => void;
  onForward: () => void;
  onClear: () => void;
}) {
  return (
    <div
      data-testid="focus-history-bar"
      className="flex items-center gap-2 border-b border-border px-3 py-1 text-[11px]"
    >
      <button
        onClick={onBack}
        disabled={!canBack}
        title="上一个焦点 (Cmd+[)"
        className="grid size-6 place-items-center rounded text-text-muted hover:bg-surface-raised hover:text-text disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ArrowLeft weight="bold" className="text-[12px]" />
      </button>
      <button
        onClick={onForward}
        disabled={!canForward}
        title="下一个焦点 (Cmd+])"
        className="grid size-6 place-items-center rounded text-text-muted hover:bg-surface-raised hover:text-text disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ArrowRight weight="bold" className="text-[12px]" />
      </button>
      {breadcrumb ? (
        <span className="min-w-0 flex-1 truncate font-mono text-text-muted">
          <span className="rounded bg-surface-raised px-1.5 py-0.5 text-text-faint">
            {breadcrumb.kindLabel}
          </span>{" "}
          <span className="text-text">{breadcrumb.title}</span>
        </span>
      ) : (
        <span className="flex-1 truncate font-mono text-text-faint">
          无焦点 — 单击节点选中,双击设焦点
        </span>
      )}
      {breadcrumb && (
        <button
          onClick={onClear}
          title="清除焦点"
          className="grid size-6 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
        >
          <X weight="bold" className="text-[12px]" />
        </button>
      )}
    </div>
  );
}
