import { t } from "../../i18n/index.tsx";
import { formatTime } from "../../model/time.ts";
import type { CadenceYieldSnapshot } from "../../model/cadence.ts";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { DenseRow } from "../primitives/DenseRow.tsx";
import { Region } from "../primitives/Region.tsx";

/**
 * 业务产出与资产沉淀:今日 Fact 沉淀(可跳转)与 Decision 履约计数。只读 cadence 快照。
 * 外壳是 Region(标准 §2.1);键值与 Fact 条目是 DenseRow——区域板靠它量「至少露出三条」,
 * 自写的行量不到,同列区域一多这块会被压到只剩标题。
 */

export function YieldSummary({
  snapshot,
  onNavigateEntity,
}: {
  readonly snapshot: CadenceYieldSnapshot;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  return (
    <Region title={t("views.cadence.yieldTitle")}>
      <div data-testid="cadence-yield-body">
        <DenseRow
          title={t("views.cadence.yieldFactsToday")}
          time={<span data-testid="cadence-yield-facts">{snapshot.factsToday}</span>}
        />
        <DenseRow
          title={t("views.cadence.yieldDecisions")}
          time={
            <span data-testid="cadence-yield-decisions">
              {t("views.cadence.yieldDecisionsDetail", {
                inEffect: snapshot.decisionsInEffect,
                proposed: snapshot.decisionsProposed,
              })}
            </span>
          }
        />
        {snapshot.recentFacts.length === 0 ? (
          <DenseRow title={<span className="text-text-faint">{t("views.cadence.yieldFactsNone")}</span>} />
        ) : (
          snapshot.recentFacts.map((fact) => (
            <DenseRow
              key={fact.factId}
              title={
                <EntityRefLink
                  entityRef={`fact/${fact.factId}`}
                  onNavigate={onNavigateEntity}
                  title={fact.factId}
                  className="font-mono ui-meta text-accent hover:underline"
                />
              }
              time={formatTime(fact.at ?? "", { style: "time" }) ?? undefined}
            />
          ))
        )}
      </div>
    </Region>
  );
}
