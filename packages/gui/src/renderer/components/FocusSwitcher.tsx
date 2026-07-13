import { Graph, MagnifyingGlass } from "@phosphor-icons/react";
import type { EntityHit } from "../model/entitySearch";
import { t } from "../i18n/index.tsx";

/**
 * GraphView 左栏:Cmd+K 触发器 + 最近焦点实体(≤12)。
 *
 * gui-b 之前是「全量列表 + 搜索框」(~400 行线性滚动,结构性排除 fact);
 * 现在统一查找入口已迁移到 Cmd+K 命令面板(三原语都进索引)。本组件降级为
 * 「打开面板的按钮 + Recent」——Recent 仍允许单击直接切换画布焦点,
 * 让常用实体不用每次都开面板。
 *
 * Recent 的真源在 App.tsx:任何 focusEntityInGraph / focusEntityInWorkspace
 * 触发时把 ref 推到最前,App 通过 GraphView 把解析好的 EntityHit[] 传进来。
 *
 * 焦点切换的 navRef 形态:task/<id> | decision/<id> | fact/<task>/<anchor>。
 * useEgoCanvas.openFocus 内部经 egoFocusIdOf 归一到 byId 键空间,这里直接透传。
 */

const RECENT_MAX = 12;

const KIND_LABEL: Record<EntityHit["kind"], string> = {
  decision: "decision",
  task: "task",
  fact: "fact",
};

const KIND_COLOR: Record<EntityHit["kind"], string> = {
  decision: "var(--color-accent)",
  task: "var(--color-axis-execution)",
  fact: "var(--color-axis-evidence)",
};

interface Props {
  /** 最近访问的实体(权重最高的 RECENT_MAX 个,已解析好 title/subtitle)。 */
  recentHits: readonly EntityHit[];
  /** 当前焦点节点的 byId key(裸 task id / decision/<id> / fact/...);列表命中即高亮。 */
  focusId: string | null;
  /** 用户点 Recent 项触发;父组件把 ref 翻译成画布焦点。 */
  onFocus: (navRef: string) => void;
  /** 点击触发器或快捷键提示时打开 Cmd+K 面板。 */
  onOpenPalette: () => void;
}

export function FocusSwitcher({ recentHits, focusId, onFocus, onOpenPalette }: Props) {
  const recent = recentHits.slice(0, RECENT_MAX);

  return (
    <aside
      data-testid="focus-switcher"
      className="flex w-64 shrink-0 flex-col border-r border-border bg-surface"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Graph weight="duotone" className="shrink-0 text-text-muted" />
        <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
          {t("components.focusSwitcher.focusSwitch")}
        </span>
      </div>

      {/* Cmd+K 触发器:代替原来的搜索框。点击打开命令面板。 */}
      <button
        type="button"
        onClick={onOpenPalette}
        data-testid="focus-switcher-palette-trigger"
        className="m-2 flex items-center gap-2 rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-left text-[12px] text-text-muted transition-colors hover:border-border-strong hover:text-text"
      >
        <MagnifyingGlass weight="bold" className="size-3.5 shrink-0 text-text-faint" />
        <span className="flex-1 truncate">{t("components.focusSwitcher.searchEntityPlaceholder")}</span>
        <span className="font-mono text-[10px] text-text-faint">⌘K</span>
      </button>

      <div className="flex items-center justify-between px-3 pb-1 pt-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
          {t("components.focusSwitcher.recent")}
        </span>
        <span className="font-mono text-[10px] text-text-faint">
          {t("components.focusSwitcher.recentCount", { count: recent.length })}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {recent.length === 0 ? (
          <div className="px-3 py-3 text-[12px] leading-relaxed text-text-faint">
            {t("components.focusSwitcher.recentEmptyHint")}
          </div>
        ) : (
          <ul className="flex flex-col py-1">
            {recent.map((hit) => {
              // focusId 是 ego byId key;hit.ref 是 navRef。对 decision/fact 两者同形,
              // 只 task 不同(裸 id vs task/<id>)。统一对比时归一一下。
              const hitFocusKey = hit.kind === "task" ? hit.id : hit.ref;
              const active = hitFocusKey === focusId;
              const accent = KIND_COLOR[hit.kind];
              return (
                <li key={hit.ref}>
                  <button
                    type="button"
                    onClick={() => onFocus(hit.ref)}
                    title={hit.title}
                    aria-pressed={active}
                    className={`group flex w-full flex-col gap-0.5 border-l-2 px-3 py-1.5 text-left transition-colors ${
                      active
                        ? "border-l-accent bg-accent/10 text-text"
                        : "border-l-transparent text-text-muted hover:bg-surface-raised hover:text-text"
                    }`}
                    style={active ? { borderColor: accent } : undefined}
                  >
                    <span className="flex items-center gap-1.5">
                      <span
                        className="inline-block size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: accent }}
                        aria-hidden="true"
                      />
                      <span
                        className={`font-mono text-[10px] uppercase tracking-wide ${
                          active ? "text-accent" : "text-text-faint"
                        }`}
                      >
                        {KIND_LABEL[hit.kind]}
                      </span>
                      <span className="ml-auto truncate font-mono text-[10px] text-text-faint">
                        {hit.id}
                      </span>
                    </span>
                    <span className="line-clamp-2 text-[12px] leading-snug">
                      {hit.title}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
