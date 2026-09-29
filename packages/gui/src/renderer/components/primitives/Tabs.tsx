import type { ReactNode } from "react";

/**
 * 标签栏(标准 §4):下划线式,标签可带计数与提示徽标(如「N 待你」琥珀块)。
 * idPrefix 同时生成 `{prefix}-tab-{key}` 的 id 与 aria-controls=`{prefix}-panel`,
 * 与页面的 role="tabpanel" 容器配对。
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  idPrefix,
}: {
  readonly tabs: readonly {
    readonly key: T;
    readonly label: ReactNode;
    readonly count?: number;
    readonly hint?: string;
  }[];
  readonly value: T;
  readonly onChange: (key: T) => void;
  readonly ariaLabel?: string;
  readonly idPrefix?: string;
}) {
  return (
    <nav role="tablist" aria-label={ariaLabel} className="flex gap-[18px] overflow-x-auto border-b border-border">
      {tabs.map((tab) => {
        const active = tab.key === value;
        return (
          <button
            key={tab.key}
            id={idPrefix === undefined ? undefined : `${idPrefix}-tab-${tab.key}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={idPrefix === undefined ? undefined : `${idPrefix}-panel`}
            onClick={() => onChange(tab.key)}
            className={`flex flex-none items-center gap-1.5 border-b-2 pb-2 pt-2 ui-body ${
              active ? "border-accent text-text" : "border-transparent text-text-muted hover:text-text"
            }`}
          >
            {tab.label}
            {(tab.count !== undefined || tab.hint !== undefined) && " "}
            {tab.count !== undefined && (
              <em className="rounded-xs bg-text/10 px-[5px] font-mono not-italic text-text-faint ui-micro">
                {tab.count}
              </em>
            )}
            {tab.hint !== undefined && (
              <>
                {" "}
                <em className="rounded-xs bg-status-submitted px-[5px] font-mono font-medium not-italic text-bg ui-micro">
                  {tab.hint}
                </em>
              </>
            )}
          </button>
        );
      })}
    </nav>
  );
}
