import type { ReactNode } from "react";
import { t } from "../../i18n/index.tsx";

// 目录页双栏的窄容器退化(标准 §2.3/§5.1、原则 9②,先例 PR #3167 会话页):内容区
// <720px(= 目录最小 320px + 详情最小可用 ~400px)时切单列——目录全宽、点行进详情
// (带返回),≥720px 恢复左目录右常驻详情。同一机制出现第二次,收拢到这里一处实现,
// 会话/Agent·Squad/Provider 三页共用;容器查询与 data-detail-open 互斥在 styles.css
// 的 .catalog-split。

/** 目录 rail 的自适应宽度:窄容器全宽单列,宽容器(≥720px)按比例收窄并出右边框。 */
export const catalogRailClass =
  "flex w-full flex-col overflow-y-auto @min-[720px]:w-[26%] @min-[720px]:min-w-[320px] @min-[720px]:max-w-[440px] @min-[720px]:shrink-0 @min-[720px]:border-r @min-[720px]:border-border";

/**
 * 目录 rail 的紧凑宽度档(视觉基线 v2.2,共享行为不等于固定尺寸):名称型目录
 * (Agent·Squad)不按比例长宽,宽容器下取定宽 300px——名字可读的最小宽度,多出来的
 * 宽度全部让给详情。会话/Provider 等行文更长的目录继续用 catalogRailClass。
 */
export const catalogRailCompactClass =
  "flex w-full flex-col overflow-y-auto @min-[720px]:w-[300px] @min-[720px]:shrink-0 @min-[720px]:border-r @min-[720px]:border-border";

/** 目录页双栏容器:窄容器下由 data-detail-open 驱动目录/详情互换,宽容器下不参与。 */
export function CatalogSplit({
  detailOpen,
  className = "",
  children,
}: {
  readonly detailOpen: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={`catalog-split flex min-h-0 flex-1 ${className}`} data-detail-open={detailOpen}>
      {children}
    </div>
  );
}

/** 单列形态的返回键(容器 ≥720px 时隐藏,styles.css .catalog-split);onBack 走全局历史弹栈。 */
export function CatalogBackButton({ testId, onBack }: { readonly testId: string; readonly onBack: () => void }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onBack}
      className="@min-[720px]:hidden mb-3 inline-flex h-7 items-center gap-1.5 rounded-xs border border-border px-3 ui-meta text-text-muted hover:border-accent hover:text-accent"
    >
      ← {t("agentRuntime.catalogBackToList")}
    </button>
  );
}

/**
 * 单列形态的「详情已开」状态(业主 2026-10-11 全局导航):由当前导航条目的选中引用
 * 派生——点行/深链推栈使 focusKey 非空即进详情,全局后退/前进弹回无引用的条目即回
 * 目录,不再持有第二份本地开关。`focusKey` 是当前段落的深链落点(null = 无):会话页
 * 按段落取 session/squadrun 引用,切换段落自然回到目录。
 */
export function useCatalogDetailPane(focusKey: string | null) {
  return { detailOpen: focusKey !== null };
}
