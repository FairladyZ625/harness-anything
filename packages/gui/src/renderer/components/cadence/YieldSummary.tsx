import { t } from "../../i18n/index.tsx";
import { formatTime } from "../../model/time.ts";
import type { CadenceYieldSnapshot } from "../../model/cadence.ts";
import { EntityRefLink } from "../EntityRefLink.tsx";

/**
 * 业务产出与资产沉淀:今日 Fact 沉淀(可跳转)、Decision 履约计数与 Agent 算力
 * 触碰的模块热度(窗口内事件可归属到投影行 module 的部分)。只读 cadence 快照。
 */

export function YieldSummary({
  snapshot,
  onNavigateEntity,
}: {
  readonly snapshot: CadenceYieldSnapshot;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const heatMax = snapshot.moduleHeat[0]?.events ?? 0;
  return (
    <section
      data-testid="cadence-yield"
      className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface"
    >
      <header className="border-b border-border px-3 py-2">
        <h2 className="ui-body font-semibold">{t("views.cadence.yieldTitle")}</h2>
      </header>
      <div data-testid="cadence-yield-body" className="flex max-h-60 flex-col overflow-y-auto">
        <div className="px-3 py-2">
          <p className="font-mono ui-micro uppercase tracking-wide text-text-faint">
            {t("views.cadence.yieldFactsToday")}
          </p>
          <p data-testid="cadence-yield-facts" className="mt-0.5 font-mono ui-heading text-text">
            {snapshot.factsToday}
          </p>
          {snapshot.recentFacts.length === 0 ? (
            <p className="mt-1 ui-micro text-text-faint">{t("views.cadence.yieldFactsNone")}</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5">
              {snapshot.recentFacts.map((fact) => (
                <li key={fact.factId} className="flex items-baseline gap-2">
                  <EntityRefLink
                    entityRef={`fact/${fact.factId}`}
                    onNavigate={onNavigateEntity}
                    title={fact.factId}
                    className="font-mono ui-micro text-accent hover:underline"
                  />
                  <span className="font-mono ui-micro text-text-faint">
                    {formatTime(fact.at ?? "", { style: "time" }) ?? ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t border-border px-3 py-2">
          <p className="font-mono ui-micro uppercase tracking-wide text-text-faint">
            {t("views.cadence.yieldDecisions")}
          </p>
          <p data-testid="cadence-yield-decisions" className="mt-0.5 ui-meta text-text-muted">
            {t("views.cadence.yieldDecisionsDetail", {
              inEffect: snapshot.decisionsInEffect,
              proposed: snapshot.decisionsProposed,
            })}
          </p>
        </div>
        <div className="border-t border-border px-3 py-2">
          <p className="font-mono ui-micro uppercase tracking-wide text-text-faint">
            {t("views.cadence.yieldModules")}
          </p>
          {snapshot.moduleHeat.length === 0 ? (
            <p className="mt-1 ui-micro text-text-faint">{t("views.cadence.yieldModulesEmpty")}</p>
          ) : (
            <ul data-testid="cadence-yield-modules" className="mt-1 flex flex-col gap-1.5">
              {snapshot.moduleHeat.map((module) => (
                <li key={module.module} className="flex items-center gap-2">
                  <span className="w-28 shrink-0 truncate font-mono ui-micro text-text" title={module.module}>
                    {module.module}
                  </span>
                  <span
                    className="h-2 min-w-1 rounded-full bg-accent/70"
                    style={{ width: `${barWidth(module.events, heatMax)}%` }}
                  />
                  <span className="shrink-0 font-mono ui-micro text-text-faint">
                    {t("views.cadence.yieldModuleEvents", { count: module.events, tasks: module.tasks })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function barWidth(events: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(4, Math.round((events / max) * 100));
}
