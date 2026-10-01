import { useCallback, useEffect, useState, type ReactNode } from "react";
import { t } from "../../i18n/index.tsx";

// 目录页双栏的窄容器退化(标准 §2.3/§5.1、原则 9②,先例 PR #3167 会话页):内容区
// <720px(= 目录最小 320px + 详情最小可用 ~400px)时切单列——目录全宽、点行进详情
// (带返回),≥720px 恢复左目录右常驻详情。同一机制出现第二次,收拢到这里一处实现,
// 会话/Agent·Squad/Provider 三页共用;容器查询与 data-detail-open 互斥在 styles.css
// 的 .catalog-split。

/** 目录 rail 的自适应宽度:窄容器全宽单列,宽容器(≥720px)按比例收窄并出右边框。 */
export const catalogRailClass =
  "flex w-full flex-col overflow-y-auto @min-[720px]:w-[26%] @min-[720px]:min-w-[320px] @min-[720px]:max-w-[440px] @min-[720px]:shrink-0 @min-[720px]:border-r @min-[720px]:border-border";

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

/** 单列形态的返回键(容器 ≥720px 时隐藏,styles.css .catalog-split)。 */
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
 * 单列形态的「详情已开」状态:点行/深链进详情,返回键回目录;宽容器下不参与显隐。
 * `focusKey` 是当前深链落点(null = 无):变化即视为一次点行——窄容器下,深链/跨页
 * 实体跳转让详情取代目录;返回键只清 open,不动导航栈。同页再点同一行仍能进详情
 * (点行回调直接 openDetail,不经过本 effect)。
 */
export function useCatalogDetailPane(focusKey: string | null) {
  const [detailOpen, setDetailOpen] = useState(false);
  useEffect(() => {
    if (focusKey !== null) setDetailOpen(true);
  }, [focusKey]);
  // 稳定引用:调用方(如会话页的行回调)拿它组 useCallback 做行级 memo。
  const openDetail = useCallback(() => setDetailOpen(true), []),
    backToList = useCallback(() => setDetailOpen(false), []);
  return { detailOpen, openDetail, backToList };
}
