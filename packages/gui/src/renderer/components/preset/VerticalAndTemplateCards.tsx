import type { VerticalInfo, TemplateInfo } from "../../model/types";
import { CHIP, SECTION_LABEL, shortRef } from "./shared";
import { LocaleBadges } from "./LocaleBadges";

export function VerticalCard({ v }: { v: VerticalInfo }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-[13px] font-semibold">{v.name}</span>
        <span className="font-mono text-[11px] text-text-faint">v{v.version}</span>
        <span className="min-w-[14rem] flex-1 text-[11px] text-text-muted">{v.description}</span>
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
      <table className="mt-2 w-full text-left text-[11px]">
        <thead>
          <tr className="text-[10px] text-text-faint">
            <th className="py-0.5 pr-2 font-normal">slot</th>
            <th className="py-0.5 font-normal">required</th>
          </tr>
        </thead>
        <tbody>
          {v.slots.map((s) => (
            <tr key={s.slot} className="border-t border-border/60">
              <td className="py-1 pr-2 font-mono text-text">{s.slot}</td>
              <td className="py-1">
                {s.required ? (
                  <span className="font-mono text-[10px] text-accent">required</span>
                ) : (
                  <span className="font-mono text-[10px] text-text-faint">optional</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
        <span className={CHIP}>{t.kind}</span>
        <span className="font-mono text-[11px] text-text-faint">v{t.version}</span>
        <LocaleBadges locales={t.locales} warnMissingZh />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className={SECTION_LABEL}>usedBy</span>
        {t.usedBy.map((id) => (
          <button
            key={id}
            onClick={() => onJumpToPreset(id)}
            className={`${CHIP} hover:bg-surface-raised hover:text-text`}
          >
            {id}
          </button>
        ))}
        <span className="min-w-[12rem] flex-1 text-[11px] text-text-muted">{t.description}</span>
      </div>
    </div>
  );
}
