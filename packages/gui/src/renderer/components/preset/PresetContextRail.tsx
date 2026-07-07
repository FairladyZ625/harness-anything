import { ArrowRight } from "@phosphor-icons/react";
import type { PresetEntry } from "../../model/types";
import { MOCK_TEMPLATES, MOCK_VERTICALS } from "../../model/mock";
import { CHIP, SECTION_LABEL, chainOf, shortRef } from "./shared";
import type { TabId } from "./shared";

export function PresetContextRail({
  activePreset,
  focusedPreset,
  all,
  tab,
}: {
  activePreset: PresetEntry;
  focusedPreset: PresetEntry;
  all: PresetEntry[];
  tab: TabId;
}) {
  const chain = chainOf(focusedPreset, all);
  const vertical = MOCK_VERTICALS.find((v) => v.id === focusedPreset.vertical);
  const directSelections = focusedPreset.selections.length;
  const inheritedCount = Math.max(
    0,
    chain.slice(1).reduce((sum, p) => sum + p.selections.length, 0),
  );
  const selectedTemplates = new Set(focusedPreset.selections.map((s) => s.templateRef));
  const templateCoverage = MOCK_TEMPLATES.filter((t) => selectedTemplates.has(t.ref));

  return (
    <aside className="sticky top-4 hidden self-start rounded-lg border border-border bg-surface px-3 py-3 lg:block">
      <div className="flex items-center justify-between gap-2">
        <span className={SECTION_LABEL}>上下文</span>
        <span className="rounded bg-accent/15 px-1.5 py-px font-mono text-[10px] text-accent">{tab}</span>
      </div>

      <div className="mt-3 border-b border-border pb-3">
        <div className="text-[10px] text-text-faint">当前激活</div>
        <div className="mt-1 font-mono text-[13px] font-semibold text-text">{activePreset.id}</div>
        <div className="mt-1 text-[11px] text-text-muted">{activePreset.description}</div>
      </div>

      <div className="border-b border-border py-3">
        <div className="text-[10px] text-text-faint">焦点 preset</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[13px] font-semibold text-text">{focusedPreset.id}</span>
          <span className="rounded border border-accent/60 px-1.5 py-px font-mono text-[10px] text-accent">
            {focusedPreset.vertical}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          <span className={CHIP}>{focusedPreset.source}</span>
          <span className={CHIP}>v{focusedPreset.version}</span>
          {focusedPreset.profile && <span className={CHIP}>profile: {focusedPreset.profile}</span>}
        </div>
      </div>

      <div className="border-b border-border py-3">
        <div className="text-[10px] text-text-faint">继承链</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {chain.map((p, i) => (
            <span key={p.id} className="flex items-center gap-1.5">
              {i > 0 && <ArrowRight className="text-[11px] text-text-faint" />}
              <span className={i === 0 ? "font-mono text-[11px] text-accent" : CHIP}>{p.id}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="border-b border-border py-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="font-mono text-[17px] font-semibold text-text">{vertical?.slots.length ?? 0}</div>
            <div className="text-[10px] text-text-faint">vertical slots</div>
          </div>
          <div>
            <div className="font-mono text-[17px] font-semibold text-text">{directSelections}</div>
            <div className="text-[10px] text-text-faint">本层覆盖</div>
          </div>
        </div>
        <div className="mt-2 text-[11px] text-text-muted">
          父链可继承 {inheritedCount} 个 template selection；statusMapping 仍归 Engine。
        </div>
      </div>

      <div className="border-b border-border py-3">
        <div className="text-[10px] text-text-faint">Capabilities</div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {focusedPreset.capabilityImports.length > 0 ? (
            focusedPreset.capabilityImports.map((c) => (
              <span key={c} className={CHIP}>{c}</span>
            ))
          ) : (
            <span className="text-[11px] text-text-faint">—</span>
          )}
        </div>
      </div>

      <div className="pt-3">
        <div className="text-[10px] text-text-faint">本层模板</div>
        {focusedPreset.selections.length > 0 ? (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {focusedPreset.selections.slice(0, 3).map((s) => (
              <div key={s.slot} className="min-w-0">
                <div className="truncate font-mono text-[11px] text-text">{s.slot}</div>
                <div className="truncate font-mono text-[10px] text-text-faint">{shortRef(s.templateRef)}</div>
              </div>
            ))}
            {focusedPreset.selections.length > 3 && (
              <div className="text-[10px] text-text-faint">+{focusedPreset.selections.length - 3} more</div>
            )}
          </div>
        ) : (
          <div className="mt-1.5 text-[11px] text-text-faint">无本层覆盖，读取父链</div>
        )}
        {tab === "templates" && (
          <div className="mt-2 text-[10px] text-text-faint">
            当前焦点直接命中模板库 {templateCoverage.length} 条
          </div>
        )}
      </div>
    </aside>
  );
}
