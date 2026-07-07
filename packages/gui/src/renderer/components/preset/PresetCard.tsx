import { useState } from "react";
import { ArrowRight, CaretDown } from "@phosphor-icons/react";
import type { PresetEntry } from "../../model/types";
import { ACTION_BTN, CHIP, SECTION_LABEL, chainOf, shortRef } from "./shared";
import { LocaleBadges } from "./LocaleBadges";

export function PresetCard({
  entry,
  all,
  active,
  expanded,
  onToggle,
  onJump,
}: {
  entry: PresetEntry;
  all: PresetEntry[];
  active: boolean;
  expanded: boolean;
  onToggle: () => void;
  onJump: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const builtin = entry.source === "builtin";
  const chain = chainOf(entry, all);

  const act = (text: string) => {
    setNote(text);
    setMenuOpen(false);
  };

  return (
    <div
      id={`preset-${entry.id}`}
      className={`rounded-lg border bg-surface ${
        active ? "border-accent" : "border-border"
      }`}
    >
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-raised/60"
      >
        <span className="min-w-[9rem] shrink-0 font-mono text-[13px] font-semibold">
          {entry.name}
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className="shrink-0 rounded border border-accent/60 px-1.5 py-px font-mono text-[10px] text-accent">
            {entry.vertical}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-text-faint">
            v{entry.version}
          </span>
          {entry.profile && <span className={`shrink-0 ${CHIP}`}>profile: {entry.profile}</span>}
          {active && (
            <span className="shrink-0 rounded bg-accent px-1.5 py-px text-[10px] text-accent-fg">
              激活中
            </span>
          )}
          {entry.overriddenBy && (
            <span className="shrink-0 rounded border border-stale/60 px-1.5 py-px font-mono text-[10px] text-stale">
              被 {entry.overriddenBy} 覆盖
            </span>
          )}
        </span>
        <span className="hidden min-w-[12rem] max-w-[25rem] flex-1 truncate text-[11px] text-text-muted lg:block">
          {entry.description}
        </span>
        <CaretDown
          className={`shrink-0 text-[12px] text-text-faint ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </button>

      {expanded && (
        <div className="flex flex-col gap-3 border-t border-border px-3 py-2.5">
          <div>
            <div className={SECTION_LABEL}>继承链</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {chain.map((p, i) => (
                <span key={p.id} className="flex items-center gap-1.5">
                  {i > 0 && <ArrowRight className="text-[11px] text-text-faint" />}
                  <button
                    onClick={() => onJump(p.id)}
                    className={`rounded border px-1.5 py-px font-mono text-[10px] ${
                      p.id === entry.id
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-border text-text-muted hover:bg-surface-raised hover:text-text"
                    }`}
                  >
                    {p.id}
                  </button>
                </span>
              ))}
              <span className="ml-1 text-[10px] text-text-faint">单父链 · 冲突 fail closed</span>
            </div>
          </div>

          <div>
            <div className={SECTION_LABEL}>Capability imports · 显式引入，禁隐式多继承</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {entry.capabilityImports.length > 0 ? (
                entry.capabilityImports.map((c) => (
                  <span key={c} className={CHIP}>{c}</span>
                ))
              ) : (
                <span className="text-[11px] text-text-faint">—</span>
              )}
            </div>
          </div>

          <div>
            <div className={SECTION_LABEL}>Template selections · 物化时横向取用模板库</div>
            {entry.selections.length > 0 ? (
              <div className="mt-1.5 overflow-x-auto">
                <table className="min-w-[620px] text-left text-[11px]">
                  <thead>
                    <tr className="text-[10px] text-text-faint">
                      <th className="py-0.5 pr-2 font-normal">slot</th>
                      <th className="py-0.5 pr-2 font-normal">template</th>
                      <th className="py-0.5 pr-2 font-normal">物化为</th>
                      <th className="py-0.5 font-normal">locales</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entry.selections.map((s) => (
                      <tr key={s.slot} className="border-t border-border/60">
                        <td className="py-1 pr-2 font-mono text-text">{s.slot}</td>
                        <td className="max-w-[180px] truncate py-1 pr-2 font-mono text-text-muted" title={s.templateRef}>
                          {shortRef(s.templateRef)}
                        </td>
                        <td className="py-1 pr-2 font-mono text-text-muted">{s.materializeAs}</td>
                        <td className="py-1">
                          <LocaleBadges locales={s.locales} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-1.5 text-[11px] text-text-faint">无本层覆盖，全部继承自父链</p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <button onClick={() => setMenuOpen((v) => !v)} className={`${ACTION_BTN} flex items-center gap-1`}>
                安装到…
                <CaretDown className={`text-[11px] ${menuOpen ? "rotate-180" : ""}`} />
              </button>
              {menuOpen && (
                <div className="absolute left-0 top-full z-10 mt-1 w-28 rounded-md border border-border bg-surface-raised py-1 shadow-lg">
                  {(["project", "user"] as const).map((scope) => (
                    <button
                      key={scope}
                      onClick={() => act(`已安装到 ${scope}（模拟）`)}
                      className="block w-full px-2.5 py-1 text-left font-mono text-[11px] text-text-muted hover:bg-surface hover:text-text"
                    >
                      {scope}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button disabled={builtin} title={builtin ? "内置不可卸载" : undefined} onClick={() => act("已卸载（模拟）")} className={ACTION_BTN}>
              卸载
            </button>
            {!builtin && (
              <button onClick={() => act("已还原（模拟）")} className={ACTION_BTN}>还原</button>
            )}
            {note && <span className="text-[11px] text-accent">{note}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
