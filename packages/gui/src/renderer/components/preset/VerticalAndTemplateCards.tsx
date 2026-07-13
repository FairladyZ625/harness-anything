import type { VerticalInfo, TemplateInfo } from "../../model/types";
import { CHIP, SECTION_LABEL, shortRef } from "./shared";
import { LocaleBadges } from "./LocaleBadges";
import { t } from "../../i18n/index.tsx";

export function VerticalCard({ v }: { v: VerticalInfo }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-[13px] font-semibold">{v.title}</span>
        <span className="font-mono text-[11px] text-text-faint">v{v.version}</span>
        <span className="min-w-[14rem] flex-1 text-[11px] text-text-muted">{v.id}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className={SECTION_LABEL}>{t("components.verticalAndTemplateCards.entityKinds")}</span>
        {v.entityKinds.map((k) => (
          <span key={k.id} className={CHIP} title={`${k.kind}${k.contractEntity ? t("components.verticalAndTemplateCards.loadBearing") : ""}`}>
            {k.id}
            <span className="ml-1 text-text-faint">
              ·{k.kind}
              {k.contractEntity ? t("components.verticalAndTemplateCards.loadBearing2") : ""}
            </span>
          </span>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {v.templateSlots.map((slot) => <span key={slot} className={CHIP}>{slot}</span>)}
      </div>
      <p className="mt-2 text-[10px] text-text-faint">
        {t("components.verticalAndTemplateCards.verticalDoesNotDefineStatusMappingAddingVertical")}</p>
    </div>
  );
}

export function TemplateCard({
  t: template,
  onJumpToPreset,
}: {
  t: TemplateInfo;
  onJumpToPreset: (id: string) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="max-w-full break-all font-mono text-[12px] font-semibold sm:max-w-[260px] sm:truncate"
          title={template.ref}
        >
          {shortRef(template.ref)}
        </span>
        <span className={CHIP}>{template.documentKind}</span>
        <span className="font-mono text-[11px] text-text-faint">v{template.version}</span>
        <LocaleBadges locales={template.locales} warnMissingZh />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className={SECTION_LABEL}>{t("components.verticalAndTemplateCards.usedBy")}</span>
        {template.usedByPresetIds.map((id) => (
          <button
            key={id}
            onClick={() => onJumpToPreset(id)}
            className={`${CHIP} hover:bg-surface-raised hover:text-text`}
          >
            {id}
          </button>
        ))}
        {template.usedByPresetIds.length === 0 && <span className="text-[11px] text-text-faint">{t("components.verticalAndTemplateCards.notDirectlySelectedByCurrentlyParsedPreset")}</span>}
      </div>
    </div>
  );
}
