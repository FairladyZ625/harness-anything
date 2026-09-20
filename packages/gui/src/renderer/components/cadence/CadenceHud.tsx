import { t } from "../../i18n/index.tsx";
import { formatUptimeMs } from "../../model/time.ts";
import type { CadenceHudSnapshot } from "../../model/cadence.ts";
import { KpiCard } from "../overview/parts.tsx";

/**
 * 项目交付节拍 HUD:流速 / 交付耗时 / 今日收口 / 待人工处理四格横幅。
 * 数字全部来自 cadence 纯聚合快照;待人工计数缺位(议程未读完)如实显示读取中,
 * 不拿部分计数冒充总数。
 */
export function CadenceHud({
  hud,
  awaitingDetail,
}: {
  readonly hud: CadenceHudSnapshot;
  /** 议程就绪时的分组细目;null = 议程未读完。 */
  readonly awaitingDetail: { readonly decisions: number; readonly executions: number } | null;
}) {
  return (
    <div data-testid="cadence-hud" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard
        label={t("views.cadence.hudActive")}
        value={hud.activeTasks}
        detail={t("views.cadence.hudActiveDetail", { stalled: hud.stalledActive })}
      />
      <KpiCard
        label={t("views.cadence.hudDelivery")}
        value={hud.avgDeliveryMs === null ? "—" : formatUptimeMs(hud.avgDeliveryMs)}
        detail={
          hud.completedInWindow === 0
            ? t("views.cadence.hudDeliveryUnknown")
            : t("views.cadence.hudDeliveryDetail", { count: hud.completedInWindow })
        }
      />
      <KpiCard
        label={t("views.cadence.hudCompletedToday")}
        value={hud.completedToday}
        detail={t("views.cadence.hudCompletedTodayDetail", { count: hud.completedInWindow })}
      />
      <KpiCard
        label={t("views.cadence.hudAwaiting")}
        value={hud.awaitingHuman ?? "…"}
        detail={
          awaitingDetail === null
            ? t("views.cadence.hudAwaitingUnknown")
            : t("views.cadence.hudAwaitingDetail", {
                decisions: awaitingDetail.decisions,
                executions: awaitingDetail.executions,
              })
        }
      />
    </div>
  );
}
