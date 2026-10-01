import type { ReactNode } from "react";
import { t } from "../../i18n/index.tsx";

/**
 * 终态分隔线(标准 §1.4/§2.4 v2):已完成的条目沉到列表底部,在「已完成 N」
 * 分隔线之后照常显示——不藏进「展开」、不折叠成计数按钮。文案由调用方组
 * (有的列表要同时报已取消/已收口/已暂停),分隔线只定高度与弱色形态。
 */
export function CompletedDivider({ children }: { readonly children?: ReactNode }) {
  return (
    <p className="border-t border-border px-3.5 pt-3 pb-1.5 ui-meta text-text-faint" data-testid="completed-divider">
      {children ?? t("components.primitives.completedDivider")}
    </p>
  );
}
