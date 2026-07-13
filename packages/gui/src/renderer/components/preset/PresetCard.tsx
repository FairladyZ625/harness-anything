import { ArrowRight, CaretDown } from "@phosphor-icons/react";
import type { PresetEntry } from "../../model/types";
import { CHIP, SECTION_LABEL, chainOf, shortRef } from "./shared";
import { LocaleBadges } from "./LocaleBadges";
import { t } from "../../i18n/index.tsx";

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
  const chain = chainOf(entry, all);

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
          {entry.title ?? entry.id}
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className="shrink-0 rounded border border-accent/60 px-1.5 py-px font-mono text-[10px] text-accent">
            {entry.vertical}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-text-faint">
            v{entry.version}
          </span>
          {entry.profile && <span className={`shrink-0 ${CHIP}`}>{t("components.presetCard.profileValue", { profile: entry.profile })}</span>}
          {active && (
            <span className="shrink-0 rounded bg-accent px-1.5 py-px text-[10px] text-accent-fg">
              {t("components.presetCard.activating")}</span>
          )}
          {!entry.valid && (
            <span className="shrink-0 rounded border border-danger/60 px-1.5 py-px font-mono text-[10px] text-danger">
              {t("components.presetCard.invalidIssueCount", { count: entry.issueCount })}
            </span>
          )}
        </span>
        <span className="hidden min-w-[12rem] max-w-[25rem] flex-1 truncate text-[11px] text-text-muted lg:block">
          {entry.kind ?? t("components.presetCard.manifestUnavailable")}
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
            <div className={SECTION_LABEL}>{t("components.presetCard.inheritanceChain")}</div>
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
              <span className="ml-1 text-[10px] text-text-faint">{t("components.presetCard.singleParentChainConflictFailClosed")}</span>
            </div>
          </div>

          <div>
            <div className={SECTION_LABEL}>{t("components.presetCard.capabilityImportsExplicitIntroductionProhibitingImplicitMultiple")}</div>
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
            <div className={SECTION_LABEL}>{t("components.presetCard.templateSelectionsHorizontalAccessTemplateLibraryDuring")}</div>
            {entry.selections.length > 0 ? (
              <div className="mt-1.5 overflow-x-auto">
                <table className="min-w-[620px] text-left text-[11px]">
                  <thead>
                    <tr className="text-[10px] text-text-faint">
                      <th className="py-0.5 pr-2 font-normal">{t("components.presetCard.slot")}</th>
                      <th className="py-0.5 pr-2 font-normal">{t("components.presetCard.template")}</th>
                      <th className="py-0.5 pr-2 font-normal">{t("components.presetCard.materializedAs")}</th>
                      <th className="py-0.5 font-normal">{t("components.presetCard.locales")}</th>
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
              <p className="mt-1.5 text-[11px] text-text-faint">{t("components.presetCard.noCoverageLayerAllInheritedFromParent")}</p>
            )}
          </div>

          <p className="text-[10px] text-text-faint">{t("components.presetCard.readOnlySnapshotInstallationUninstallationStillManaged")}</p>
        </div>
      )}
    </div>
  );
}
