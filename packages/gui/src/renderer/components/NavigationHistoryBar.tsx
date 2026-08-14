import { ArrowLeft, ArrowRight } from "@phosphor-icons/react";

/**
 * AppShell 全局后退/前进栏(移植老 main 线同名组件;REQ-GUI-01 degraded 项)。
 *
 * 经典浏览器式 ← / → 按钮。状态机由 AppShell 持有(useViewHistory),
 * 本组件纯展示。Cmd+[ / Cmd+] 与鼠标侧键监听在 AppShell,不在这。
 */
export function NavigationHistoryBar({
  canBack,
  canForward,
  onBack,
  onForward,
}: {
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
}) {
  return (
    <div
      data-testid="nav-history-bar"
      className="flex items-center gap-0.5 border-b border-border bg-surface/60 px-2 py-1"
    >
      <button
        type="button"
        onClick={onBack}
        disabled={!canBack}
        title="后退 (Cmd+[ / 鼠标侧键)"
        aria-label="后退"
        className={`grid size-6 place-items-center rounded ${
          canBack
            ? "text-text-muted hover:bg-surface-raised hover:text-text"
            : "text-text-faint opacity-40"
        }`}
      >
        <ArrowLeft weight="bold" className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onForward}
        disabled={!canForward}
        title="前进 (Cmd+] / 鼠标侧键)"
        aria-label="前进"
        className={`grid size-6 place-items-center rounded ${
          canForward
            ? "text-text-muted hover:bg-surface-raised hover:text-text"
            : "text-text-faint opacity-40"
        }`}
      >
        <ArrowRight weight="bold" className="size-3.5" />
      </button>
    </div>
  );
}
