import { ArrowLeft, ArrowRight, Crosshair, X } from "@phosphor-icons/react";
import { t } from "../i18n/index.tsx";

/**
 * GraphView 焦点历史 + 面包屑(dec_01KXA7811SVVT8P66HNDFZQ7DF — 关系图可用性)。
 *
 * 经典浏览器式 back/forward 按钮 + 当前焦点实体的「类型 + 标题」面包屑。
 * 让用户「跳过去回得来」,知道当前看的是谁的图。
 *
 * 纯展示;状态机由 GraphView 用 graph/focusHistory.ts 持有,本组件只接
 * (state, label) + 三个回调。breadcrumbLabel 为空表示当前无焦点或焦点是
 * 布局器挑的默认(不在历史里),此时仍允许 back 到上一个手动焦点。
 */

interface Props {
  canBack: boolean;
  canForward: boolean;
  /** 当前焦点节点的展示信息(kind/title);focusId 不在历史里也可显示。 */
  breadcrumb: { kindLabel: string; title: string; nodeId: string } | null;
  onBack: () => void;
  onForward: () => void;
  onClear: () => void;
}

export function FocusHistoryBar({
  canBack,
  canForward,
  breadcrumb,
  onBack,
  onForward,
  onClear,
}: Props) {
  return (
    <div
      data-testid="focus-history-bar"
      className="flex items-center gap-1 border-b border-border bg-surface/60 px-2 py-1 text-[11px]"
    >
      <button
        type="button"
        onClick={onBack}
        disabled={!canBack}
        title={t("components.focusHistoryBar.previousFocusBack")}
        aria-label={t("components.focusHistoryBar.previousFocus")}
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
        title={t("components.focusHistoryBar.nextFocusForward")}
        aria-label={t("components.focusHistoryBar.nextFocus")}
        className={`grid size-6 place-items-center rounded ${
          canForward
            ? "text-text-muted hover:bg-surface-raised hover:text-text"
            : "text-text-faint opacity-40"
        }`}
      >
        <ArrowRight weight="bold" className="size-3.5" />
      </button>

      {breadcrumb ? (
        <>
          <span className="mx-1 inline-flex items-center gap-1 rounded border border-border bg-surface-raised px-1.5 py-0.5">
            <Crosshair weight="bold" className="size-3 text-accent" />
            <span className="font-mono uppercase tracking-wide text-text-faint">
              {breadcrumb.kindLabel}
            </span>
            <span
              className="max-w-[280px] truncate text-text"
              title={breadcrumb.title}
            >
              {breadcrumb.title}
            </span>
            <span
              className="truncate font-mono text-[10px] text-text-faint"
              title={breadcrumb.nodeId}
            >
              {breadcrumb.nodeId}
            </span>
          </span>
          <button
            type="button"
            onClick={onClear}
            title={t("components.focusHistoryBar.exitFocus")}
            aria-label={t("components.focusHistoryBar.exitFocus")}
            className="grid size-5 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
          >
            <X weight="bold" className="size-3" />
          </button>
        </>
      ) : (
        <span className="px-2 font-mono text-text-faint">
          {t("components.focusHistoryBar.defaultFocusedEgoDoubleClickNodeClick")}</span>
      )}
    </div>
  );
}
