import type { VerticalInfo, TemplateInfo } from "../../model/types";
import { CHIP, SECTION_LABEL, shortRef } from "./shared";
import { LocaleBadges } from "./LocaleBadges";

export function VerticalCard({ v }: { v: VerticalInfo }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-[13px] font-semibold">{v.title}</span>
        <span className="font-mono text-[11px] text-text-faint">v{v.version}</span>
        <span className="min-w-[14rem] flex-1 text-[11px] text-text-muted">{v.id}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className={SECTION_LABEL}>entityKinds</span>
        {v.entityKinds.map((k) => (
          <span key={k.id} className={CHIP} title={`${k.kind}${k.contractEntity ? " · 承重" : ""}`}>
            {k.id}
            <span className="ml-1 text-text-faint">
              ·{k.kind}
              {k.contractEntity ? "·承重" : ""}
            </span>
          </span>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {v.templateSlots.map((slot) => <span key={slot} className={CHIP}>{slot}</span>)}
      </div>
      <p className="mt-2 text-[10px] text-text-faint">
        Vertical 不定义 statusMapping；新增 vertical 不得改 kernel entity
      </p>
    </div>
  );
}

export function TemplateCard({
  t,
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
          title={t.ref}
        >
          {shortRef(t.ref)}
        </span>
        <span className={CHIP}>{t.documentKind}</span>
        <span className="font-mono text-[11px] text-text-faint">v{t.version}</span>
        <LocaleBadges locales={t.locales} warnMissingZh />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className={SECTION_LABEL}>usedBy</span>
        {t.usedByPresetIds.map((id) => (
          <button
            key={id}
            onClick={() => onJumpToPreset(id)}
            className={`${CHIP} hover:bg-surface-raised hover:text-text`}
          >
            {id}
          </button>
        ))}
        {t.usedByPresetIds.length === 0 && <span className="text-[11px] text-text-faint">未被当前解析后的 preset 直接选用</span>}
      </div>
    </div>
  );
}
