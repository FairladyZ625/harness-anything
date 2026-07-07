import { CHIP } from "./shared";

export function LocaleBadges({
  locales,
  warnMissingZh = false,
}: {
  locales: string[];
  warnMissingZh?: boolean;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {locales.map((l) => (
        <span key={l} className={CHIP}>
          {l}
        </span>
      ))}
      {warnMissingZh && !locales.includes("zh-CN") && (
        <span className="rounded border border-stale/60 px-1.5 py-px text-[10px] text-stale">
          缺中文 variant
        </span>
      )}
    </span>
  );
}
