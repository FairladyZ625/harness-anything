import { useMemo } from "react";
import { PlugsConnected } from "@phosphor-icons/react";
import { useCatalogSnapshot } from "../catalog-data.ts";
import type { TaskRow } from "../model/types.ts";
import { t } from "../i18n/index.tsx";

/**
 * Adapter registry 只读视图。每 engine 显示 projectedCount(REQ-GUI-09;
 * 参考老 main 线 AdapterContextRail):按现有 task 投影的 engine 字段聚合,
 * 纯前端派生,不新增后端读面。
 */
export function AdaptersView({ repoId, tasks = [] }: { readonly repoId: string; readonly tasks?: readonly TaskRow[] }) {
  const catalog = useCatalogSnapshot(repoId);
  const projectedByEngine = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) counts.set(task.engine, (counts.get(task.engine) ?? 0) + 1);
    return counts;
  }, [tasks]);
  if (catalog.isPending) return <div className="p-6 text-text-faint">{t("views.adaptersView.readingAdapterRegistry")}</div>;
  if (catalog.isError || !catalog.data) return <div className="p-6 text-status-blocked">{t("views.adaptersView.adapterRegistryReadFailed")} {catalog.error instanceof Error ? catalog.error.message : t("views.adaptersView.unknownNotProjected")}</div>;
  return <div className="flex flex-1 flex-col overflow-y-auto"><header className="border-b border-border px-4 py-3"><div className="flex items-center gap-2"><PlugsConnected className="text-text-faint"/><h1 className="ui-title font-semibold">{t("views.adaptersView.registryTitle")}</h1><span className="font-mono text-[11px] text-text-faint">{repoId} · {catalog.data.adapters.length}</span></div><p className="mt-1 text-[12px] text-text-faint">{t("views.adaptersView.readOnlyDescription")}</p></header>
    <div className="mx-auto grid w-full max-w-5xl gap-3 p-4 md:grid-cols-2">{catalog.data.adapters.map((adapter) => { const projectedCount = projectedByEngine.get(adapter.adapterId) ?? 0; return <article key={adapter.adapterId} data-testid={`adapter-card-${adapter.adapterId}`} className="rounded-lg border border-border bg-surface p-3"><div className="flex items-center gap-2"><b className="font-mono text-[13px]">{adapter.adapterId}</b>{adapter.defaultProvider && <span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-accent">{t("views.adaptersView.default")}</span>}<span className="ml-auto rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-muted">{adapter.writability}</span></div><div className="mt-2 flex items-baseline gap-2"><span className="font-mono text-[18px] font-semibold tabular-nums text-text" data-testid={`adapter-projected-count-${adapter.adapterId}`}>{projectedCount}</span><span className="text-[11px] text-text-faint">{t("views.adaptersView.projectedTasks")}</span></div><p className="mt-2 text-[12px] text-text-muted">{t("views.adaptersView.capabilities")}: {adapter.capabilities.join(", ") || t("views.adaptersView.unknownNotProjected")}</p><p className={`mt-2 text-[11px] ${adapter.unavailableReason ? "text-status-blocked" : "text-status-done"}`}>{adapter.unavailableReason ?? t("views.adaptersView.registeredAvailable")}</p></article>; })}{catalog.data.adapters.length === 0 && <p className="rounded-lg border border-dashed border-border p-5 text-text-faint">{t("views.adaptersView.registryEmpty")}</p>}</div>
  </div>;
}
