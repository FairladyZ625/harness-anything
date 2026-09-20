import { useEffect, useMemo, useState } from "react";
import { ArrowsLeftRight, MagnifyingGlass, Plus } from "@phosphor-icons/react";
import { t } from "../../i18n/index.tsx";
import type { TaskRow } from "../../model/types.ts";
import { searchCurrentRepo, type WorkSearchRow } from "../../start-work-flow.ts";

/**
 * G1 的三个入口(S5):切仓、当前仓搜索、开始一项工作。
 *
 * 切仓复用壳层那一份 `projectSwitcherOpen`(不另建切换状态);搜索复用 ⌘K/关系图左栏
 * 共用的统一实体索引(按当前仓装配,所以默认就是当前仓),只是把「类型」与「所属任务组」
 * 显式摆到每一行上;创建走 StartWorkDialog。
 *
 * 读的节流:索引里的事实切面只在有搜索输入时启用(`onSearchActiveChange`,与关系图左栏
 * 同一个开关),首屏一条读都不多发。
 */
const SEARCH_MAX = 12;

export function WorkEntryBar({
  projectName,
  searchRows,
  tasks,
  onSwitchRepo,
  onSearchActiveChange,
  onNavigateEntity,
  onStartWork,
}: {
  readonly projectName: string;
  /** `buildPaletteIndex` 的统一实体索引(当前仓),搜索的唯一取数来源。 */
  readonly searchRows: readonly WorkSearchRow[];
  readonly tasks: readonly TaskRow[];
  readonly onSwitchRepo: () => void;
  readonly onSearchActiveChange: (active: boolean) => void;
  readonly onNavigateEntity: (ref: string) => void;
  readonly onStartWork: () => void;
}) {
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  useEffect(() => {
    onSearchActiveChange(searching);
    return () => onSearchActiveChange(false);
  }, [searching, onSearchActiveChange]);
  const hits = useMemo(() => searchCurrentRepo(searchRows, tasks, query, SEARCH_MAX), [searchRows, tasks, query]);

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="overview-next-work-entry">
      <button
        type="button"
        onClick={onSwitchRepo}
        data-testid="overview-next-switch-repo"
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-raised px-2 py-1 ui-meta text-text-muted hover:border-border-strong hover:text-text"
      >
        <ArrowsLeftRight weight="bold" aria-hidden />
        {t("views.overviewNext.switchRepo")}
      </button>
      <span className="relative min-w-[220px] flex-1">
        <span className="flex items-center gap-1.5 rounded-md border border-border bg-surface-raised px-2 py-1">
          <MagnifyingGlass weight="bold" className="shrink-0 text-text-faint" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t("views.overviewNext.searchLabel", { name: projectName })}
            placeholder={t("views.overviewNext.searchPlaceholder")}
            data-testid="overview-next-search-input"
            className="min-w-0 flex-1 bg-transparent ui-meta text-text outline-none placeholder:text-text-faint"
          />
          {/* 窄屏让位给输入框:范围在占位文案("本仓")与正上方的工作区名里已经说清。 */}
          <span className="hidden shrink-0 font-mono ui-micro text-text-faint sm:inline">
            {t("views.overviewNext.searchScope", { name: projectName })}
          </span>
        </span>
        {searching ? (
          <div
            data-testid="overview-next-search-results"
            className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-md border border-border-strong bg-surface-raised p-1 shadow-2xl"
          >
            {hits.length === 0 ? (
              <p className="px-2 py-1.5 ui-micro text-text-faint">
                {t("views.overviewNext.searchEmpty", { query: query.trim() })}
              </p>
            ) : (
              <>
                {hits.map((hit) => (
                  <button
                    key={hit.ref}
                    type="button"
                    onClick={() => {
                      setQuery("");
                      onNavigateEntity(hit.ref);
                    }}
                    className="flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left hover:bg-surface"
                  >
                    <span className="flex w-full min-w-0 items-baseline gap-2">
                      <span className="shrink-0 rounded border border-border px-1 font-mono ui-micro text-text-faint">
                        {hit.entity}
                      </span>
                      <span className="min-w-0 flex-1 truncate ui-meta text-text">{hit.label}</span>
                    </span>
                    <span className="flex w-full min-w-0 items-baseline gap-2 font-mono ui-micro text-text-faint">
                      <span className="truncate">
                        {hit.group
                          ? t("views.overviewNext.searchGroup", { group: hit.group.title })
                          : t("views.overviewNext.searchNoGroup")}
                      </span>
                      {hit.detail ? <span className="truncate">{hit.detail}</span> : null}
                    </span>
                  </button>
                ))}
                {hits.length === SEARCH_MAX ? (
                  <p className="px-2 py-1 ui-micro text-text-faint">
                    {t("views.overviewNext.searchOverflow", { shown: SEARCH_MAX })}
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </span>
      <button
        type="button"
        onClick={onStartWork}
        data-testid="overview-next-start-work"
        className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 py-1 ui-meta font-medium text-accent-fg hover:opacity-90"
      >
        <Plus weight="bold" aria-hidden />
        {t("views.overviewNext.startWorkCta")}
      </button>
    </div>
  );
}
