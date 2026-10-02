import type { CSSProperties, ReactNode } from "react";
import { useMemo } from "react";
import { useCatalogSnapshot } from "../catalog-data.ts";
import type { TaskRow } from "../model/types.ts";
import { t } from "../i18n/index.tsx";
import { DenseRow } from "../components/primitives/DenseRow.tsx";
import { StatusTag, TONE_COLOR } from "../components/primitives/StatusTag.tsx";

/**
 * Adapter 注册表目录页(标准 §2.5):回答「有哪些引擎适配器、哪个不可用、谁在用它」。
 * 每 engine 一行 DenseRow——可用性用有底色的 StatusTag,不可用的置顶并带红竖线,
 * 投影任务数(REQ-GUI-09,按现有 task 投影的 engine 字段聚合)回答「谁在用它」;
 * 纯前端派生,不新增后端读面。安装、卸载与配置由 CLI 管理,本页只读。
 */
export function AdaptersView({
  repoId,
  tasks = [],
  renderHeader,
}: {
  readonly repoId: string;
  readonly tasks?: readonly TaskRow[];
  /** 页头渲染:缺省装目录页头;工作台面板传空渲染(面板标签即标题)。 */
  readonly renderHeader?: () => ReactNode;
}) {
  const catalog = useCatalogSnapshot(repoId);
  const projectedByEngine = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) counts.set(task.engine, (counts.get(task.engine) ?? 0) + 1);
    return counts;
  }, [tasks]);
  if (catalog.isPending)
    return <div className="p-6 text-text-faint">{t("views.adaptersView.readingAdapterRegistry")}</div>;
  if (catalog.isError || !catalog.data)
    return (
      <div className="p-6 text-status-blocked">
        {t("views.adaptersView.adapterRegistryReadFailed")}{" "}
        {catalog.error instanceof Error ? catalog.error.message : t("views.adaptersView.unknownNotProjected")}
      </div>
    );
  const adapters = catalog.data.adapters,
    unavailable = adapters.filter((adapter) => adapter.unavailableReason !== null),
    available = adapters.filter((adapter) => adapter.unavailableReason === null),
    ordered = [...unavailable, ...available];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {renderHeader !== undefined ? (
        renderHeader()
      ) : (
        <header className="border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <h1 className="ui-title font-semibold">{t("views.adaptersView.registryTitle")}</h1>
            <span className="font-mono ui-micro text-text-faint">
              {repoId} · {adapters.length}
            </span>
            {unavailable.length > 0 ? (
              <StatusTag tone="bad" label={t("views.adaptersView.unavailableCount", { count: unavailable.length })} />
            ) : null}
          </div>
          <p className="mt-1 ui-meta text-text-faint">{t("views.adaptersView.readOnlyDescription")}</p>
        </header>
      )}
      <div data-testid="adapters-content" className="w-full p-4">
        {ordered.map((adapter) => {
          const projectedCount = projectedByEngine.get(adapter.adapterId) ?? 0,
            blocked = adapter.unavailableReason !== null;
          return (
            <div
              key={adapter.adapterId}
              className="status-edge relative"
              style={blocked ? ({ "--status-edge": TONE_COLOR.bad } as CSSProperties) : undefined}
            >
              <DenseRow
                tag={
                  <StatusTag
                    tone={blocked ? "bad" : "neutral"}
                    label={blocked ? adapter.unavailableReason : t("views.adaptersView.registeredAvailable")}
                  />
                }
                title={
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate font-mono">{adapter.adapterId}</span>
                    {adapter.defaultProvider ? (
                      <span className="shrink-0 rounded-xs border border-accent/60 px-1.5 py-px font-mono ui-micro text-accent">
                        {t("views.adaptersView.default")}
                      </span>
                    ) : null}
                    <span className="shrink-0 rounded-xs border border-border px-1.5 py-px font-mono ui-micro text-text-muted">
                      {adapter.writability}
                    </span>
                  </span>
                }
                reason={
                  adapter.capabilities.length > 0
                    ? `${t("views.adaptersView.capabilities")}: ${adapter.capabilities.join(", ")}`
                    : t("views.adaptersView.unknownNotProjected")
                }
                time={t("views.adaptersView.tasksInUse", { count: projectedCount })}
              />
            </div>
          );
        })}
        {adapters.length === 0 && <p className="ui-meta text-text-faint">{t("views.adaptersView.registryEmpty")}</p>}
      </div>
    </div>
  );
}
