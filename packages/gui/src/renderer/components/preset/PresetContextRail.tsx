import { ArrowRight } from "@phosphor-icons/react";
import type { PresetEntry, TemplateInfo, VerticalInfo } from "../../model/types";
import { CHIP, SECTION_LABEL, chainOf, shortRef } from "./shared";
import type { TabId } from "./shared";
import { t } from "../../i18n/index.tsx";

export function PresetContextRail({
  activePreset,
  focusedPreset,
  all,
  verticals,
  templates,
  tab,
}: {
  activePreset: PresetEntry;
  focusedPreset: PresetEntry;
  all: PresetEntry[];
  verticals: VerticalInfo[];
  templates: TemplateInfo[];
  tab: TabId;
}) {
  const chain = chainOf(focusedPreset, all);
  const vertical = verticals.find((v) => v.id === focusedPreset.vertical);
  const directSelections = focusedPreset.selections.length;
  const inheritedCount = Math.max(
    0,
    chain.slice(1).reduce((sum, p) => sum + p.selections.length, 0),
  );
  const selectedTemplates = new Set(focusedPreset.selections.map((s) => s.templateRef));
  const templateCoverage = templates.filter((t) => selectedTemplates.has(t.ref));

  return (
    <aside className="sticky top-4 hidden self-start rounded-lg border border-border bg-surface px-3 py-3 lg:block">
      <div className="flex items-center justify-between gap-2">
        <span className={SECTION_LABEL}>{t("components.presetContextRail.context")}</span>
        <span className="rounded bg-accent/15 px-1.5 py-px font-mono text-[10px] text-accent">{tab}</span>
      </div>

      <div className="mt-3 border-b border-border pb-3">
        <div className="text-[10px] text-text-faint">{t("components.presetContextRail.currentlyActive")}</div>
        <div className="mt-1 font-mono text-[13px] font-semibold text-text">{activePreset.id}</div>
        <div className="mt-1 text-[11px] text-text-muted">{activePreset.title ?? t("components.presetContextRail.untitled")}</div>
      </div>

      <div className="border-b border-border py-3">
        <div className="text-[10px] text-text-faint">{t("components.presetContextRail.focusPreset")}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[13px] font-semibold text-text">{focusedPreset.id}</span>
          <span className="rounded border border-accent/60 px-1.5 py-px font-mono text-[10px] text-accent">
            {focusedPreset.vertical}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          <span className={CHIP}>{focusedPreset.source}</span>
          <span className={CHIP}>v{focusedPreset.version}</span>
          {focusedPreset.profile && <span className={CHIP}>{t("components.presetContextRail.profileValue", { profile: focusedPreset.profile })}</span>}
        </div>
      </div>

      <div className="border-b border-border py-3">
        <div className="text-[10px] text-text-faint">{t("components.presetContextRail.inheritanceChain")}</div>
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
            <div className="font-mono text-[17px] font-semibold text-text">{vertical?.templateSlots.length ?? 0}</div>
            <div className="text-[10px] text-text-faint">{t("components.presetContextRail.verticalSlots")}</div>
          </div>
          <div>
            <div className="font-mono text-[17px] font-semibold text-text">{directSelections}</div>
            <div className="text-[10px] text-text-faint">{t("components.presetContextRail.layerCovers")}</div>
          </div>
        </div>
        <div className="mt-2 text-[11px] text-text-muted">
          {t("components.presetContextRail.parentChainCanInherited")}{inheritedCount} {t("components.presetContextRail.templateSelectionStatusMappingStillBelongsEngine")}</div>
      </div>

      <div className="border-b border-border py-3">
        <div className="text-[10px] text-text-faint">{t("components.presetContextRail.capabilities")}</div>
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
        <div className="text-[10px] text-text-faint">{t("components.presetContextRail.templateLayer")}</div>
        {focusedPreset.selections.length > 0 ? (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {focusedPreset.selections.slice(0, 3).map((s) => (
              <div key={s.slot} className="min-w-0">
                <div className="truncate font-mono text-[11px] text-text">{s.slot}</div>
                <div className="truncate font-mono text-[10px] text-text-faint">{shortRef(s.templateRef)}</div>
              </div>
            ))}
            {focusedPreset.selections.length > 3 && (
              <div className="text-[10px] text-text-faint">{t("components.presetContextRail.moreCount", { count: focusedPreset.selections.length - 3 })}</div>
            )}
          </div>
        ) : (
          <div className="mt-1.5 text-[11px] text-text-faint">{t("components.presetContextRail.noCoverageLayerReadParentChain")}</div>
        )}
        {tab === "templates" && (
          <div className="mt-2 text-[10px] text-text-faint">
            {t("components.presetContextRail.currentFocusDirectlyHitsTemplateLibrary")}{templateCoverage.length} {t("components.presetContextRail.article")}</div>
        )}
      </div>
    </aside>
  );
}
