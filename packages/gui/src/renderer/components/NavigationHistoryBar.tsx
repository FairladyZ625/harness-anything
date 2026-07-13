import { ArrowLeft, ArrowRight } from "@phosphor-icons/react";
import { t } from "../i18n/index.tsx";

/**
 * AppShell 全局后退/前进栏。经典浏览器式 ← / → 按钮 + 快捷键提示。
 *
 * 状态机由 AppShell 用 navigation/useNavigationHistory 持有,本组件纯展示。
 * 快捷键 Cmd+[ / Cmd+] 和鼠标侧键(button 3/4)在 AppShell 的 useEffect 里监听,
 * 不在这——保持本组件无副作用、可 SSR。
 */
interface Props {
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

export function NavigationHistoryBar({ canBack, canForward, onBack, onForward }: Props) {
  return (
    <div
      data-testid="nav-history-bar"
      className="flex items-center gap-0.5 border-b border-border bg-surface/60 px-2 py-1"
    >
      <button
        type="button"
        onClick={onBack}
        disabled={!canBack}
        title={t("components.navigationHistoryBar.backCmdMouseSideButton")}
        aria-label={t("components.navigationHistoryBar.back")}
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
        title={t("components.navigationHistoryBar.forwardCmdMouseSideButton")}
        aria-label={t("components.navigationHistoryBar.moveForward")}
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
