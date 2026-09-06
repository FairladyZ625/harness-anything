import { useState } from "react";
import { Plus } from "@phosphor-icons/react";
import type { EntityKindRow } from "../../entity-kind-catalog-client.ts";
import type { GovernedEntityRow } from "../../graph/governedEntities.ts";

/**
 * 声明实体的实况面·左列形态:这个 kind 现在有哪些实体、搜一个、新建一个。
 * 选中哪条的正文与操作渲染在详情页右栏(EntityLocatorPreview + EntityDetailActions),
 * 所以选择状态上提到 EntityDocDetailView,本组件只报 `onSelect`。
 *
 * 列表行只承载「是什么、新不新鲜」:title / locator / 归档态。编辑与归档在详情操作区,
 * 不再每行挂一排按钮。行上的 freshness 如实来自行读面——`archived`(投影 orphaned)
 * 显式标出,未归档即现行。
 */
export function GovernedEntityPanel({
  row,
  rows,
  selectedRef,
  onSelect,
  onCreate,
}: {
  readonly row: EntityKindRow;
  readonly rows: readonly GovernedEntityRow[];
  readonly selectedRef: string | null;
  readonly onSelect: (ref: string) => void;
  /** 「新建」只负责把右栏切到向导;kind 已由本页钉死。 */
  readonly onCreate: () => void;
}) {
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const needle = query.trim().toLowerCase();
  const activeRows = showArchived ? rows : rows.filter((entity) => !entity.archived);
  const visible =
    needle === ""
      ? activeRows
      : activeRows.filter((entity) =>
          [entity.title ?? "", entity.entityId, entity.locator?.value ?? ""].some((text) =>
            text.toLowerCase().includes(needle),
          ),
        );
  return (
    <section data-testid="governed-entity-panel" className="mt-6 border-t border-border pt-4">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="ui-body font-semibold">本仓实体</h2>
        <span className="ui-micro text-text-faint">{rows.length} 条</span>
        {row.importable && !row.retired && (
          <button
            type="button"
            data-testid="governed-entity-new"
            onClick={onCreate}
            className={[
              "inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 ui-meta text-text-muted",
              "hover:border-border-strong hover:text-text",
            ].join(" ")}
          >
            <Plus weight="bold" />
            新建
          </button>
        )}
        <label className="ml-auto ui-micro text-text-faint">
          <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
          显示已归档
        </label>
      </header>
      {rows.length === 0 ? (
        <p data-testid="governed-entity-empty" className="mt-2 ui-meta text-text-faint">
          本仓还没有这个 kind 的实体。
        </p>
      ) : (
        <>
          <input
            type="search"
            data-testid="governed-entity-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题 / id / locator"
            className={[
              "mt-2 w-full rounded-md border border-border bg-surface px-2 py-1 ui-meta",
              "text-text placeholder:text-text-faint focus:border-border-strong focus:outline-none",
            ].join(" ")}
          />
          {visible.length === 0 ? (
            <p data-testid="governed-entity-search-empty" className="mt-2 ui-meta text-text-faint">
              没有匹配「{query.trim()}」的实体。
            </p>
          ) : (
            <ul data-testid="governed-entity-list" className="mt-2 flex flex-col gap-1">
              {visible.map((entity) => (
                <li key={entity.ref}>
                  <button
                    type="button"
                    data-testid={`governed-entity-row-${entity.entityId}`}
                    onClick={() => onSelect(entity.ref)}
                    className={[
                      "w-full rounded-md border px-2 py-1.5 text-left",
                      entity.archived ? "opacity-50" : "",
                      entity.ref === selectedRef
                        ? "border-border-strong bg-surface-raised"
                        : "border-border hover:bg-surface-raised",
                    ].join(" ")}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate ui-meta text-text">
                        {entity.title ?? entity.entityId}
                      </span>
                      {entity.archived ? (
                        <span
                          title="投影 freshness:orphaned"
                          className="shrink-0 rounded border border-border px-1 font-mono ui-micro text-text-faint"
                        >
                          已归档
                        </span>
                      ) : (
                        <span
                          title="投影 freshness:current"
                          className="shrink-0 rounded border border-border px-1 font-mono ui-micro text-accent"
                        >
                          现行
                        </span>
                      )}
                    </span>
                    <span className="block truncate font-mono ui-micro text-text-faint">
                      {entity.locator?.value ?? entity.entityId}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export type { GovernedEntityRow };
