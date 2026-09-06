import { useState } from "react";
import type { EntityKindCatalog } from "../../entity-kind-catalog-client.ts";
import type { GovernedEntityRow } from "../../graph/governedEntities.ts";

/**
 * 目录页的本仓实体清单(task_a494eac2 Goal 4):全部声明实体按 kind 分组,支持
 * title/locator/id 搜索,行上显示 freshness(归档/orphaned 如实标出),点击整条 ref
 * 深链进该 kind 详情并选中。这里只有「是什么、新不新鲜、去哪看」——编辑/归档在详情
 * 操作区,清单不再承载写动作。
 */
export function GovernedEntityCatalogList({
  catalog,
  rows,
  onOpenEntityRef,
}: {
  readonly catalog: EntityKindCatalog;
  readonly rows: readonly GovernedEntityRow[];
  readonly onOpenEntityRef: (ref: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  if (rows.length === 0) return null;
  const needle = query.trim().toLowerCase();
  const matched = rows.filter(
    (entity) =>
      (showArchived || !entity.archived) &&
      (needle === "" ||
        [entity.title ?? "", entity.entityId, entity.locator?.value ?? ""].some((text) =>
          text.toLowerCase().includes(needle),
        )),
  );
  const groups = groupByKind(catalog, matched);
  return (
    <section data-testid="governed-entity-catalog-list" className="border-t border-border pt-4">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="ui-body font-semibold">本仓实体</h2>
        <span className="ui-micro text-text-faint">{rows.length} 条</span>
        <input
          type="search"
          data-testid="governed-entity-catalog-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索标题 / id / locator"
          className={[
            "ml-auto w-64 rounded-md border border-border bg-surface px-2 py-1 ui-meta",
            "text-text placeholder:text-text-faint focus:border-border-strong focus:outline-none",
          ].join(" ")}
        />
        <label className="ui-micro text-text-faint">
          <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
          显示已归档
        </label>
      </header>
      {groups.length === 0 ? (
        <p data-testid="governed-entity-catalog-empty" className="mt-2 ui-meta text-text-faint">
          没有匹配「{query.trim()}」的实体。
        </p>
      ) : (
        groups.map(({ kind, label, entities }) => (
          <div key={kind} data-testid={`governed-entity-catalog-group-${kind}`} className="mt-3">
            <div className="flex items-baseline gap-2">
              <h3 className="ui-meta font-semibold">{label}</h3>
              <code className="min-w-0 truncate font-mono ui-micro text-text-faint" title={kind}>
                {kind}
              </code>
              <span className="ui-micro text-text-faint">{entities.length} 条</span>
            </div>
            <ul className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-1.5">
              {entities.map((entity) => (
                <li key={entity.ref}>
                  <button
                    type="button"
                    data-testid={`governed-entity-catalog-row-${entity.entityId}`}
                    onClick={() => onOpenEntityRef(entity.ref)}
                    className={[
                      "w-full rounded-md border px-2 py-1.5 text-left",
                      entity.archived ? "opacity-50 border-border" : "border-border hover:bg-surface-raised",
                    ].join(" ")}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate ui-meta text-text">
                        {entity.title ?? entity.entityId}
                      </span>
                      <span
                        title={`投影 freshness:${entity.archived ? "orphaned" : "current"}`}
                        className={[
                          "shrink-0 rounded border border-border px-1 font-mono ui-micro",
                          entity.archived ? "text-text-faint" : "text-accent",
                        ].join(" ")}
                      >
                        {entity.archived ? "已归档" : "现行"}
                      </span>
                    </span>
                    <span className="block truncate font-mono ui-micro text-text-faint">
                      {entity.locator?.value ?? entity.entityId}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

function groupByKind(catalog: EntityKindCatalog, rows: readonly GovernedEntityRow[]) {
  const order: string[] = [];
  const byKind = new Map<string, GovernedEntityRow[]>();
  for (const entity of rows) {
    if (!byKind.has(entity.kind)) {
      byKind.set(entity.kind, []);
      order.push(entity.kind);
    }
    byKind.get(entity.kind)!.push(entity);
  }
  return order.map((kind) => ({
    kind,
    label: catalog.kinds.find((row) => row.kind === kind)?.declaration?.display.plural ?? kind,
    entities: byKind.get(kind)!,
  }));
}
