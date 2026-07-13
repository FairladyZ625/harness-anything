import type { PresetEntry, PresetSource } from "../../model/types";
import { t } from "../../i18n/core.ts";

export type TabId = "preset" | "vertical" | "templates";

export const TABS: { id: TabId; label: string }[] = [
  { id: "preset", get label() { return t("components.shared.preset"); } },
  { id: "vertical", get label() { return t("components.shared.vertical"); } },
  { id: "templates", get label() { return t("components.shared.templateLibrary"); } },
];

export const SOURCE_SECTIONS: { source: PresetSource; label: string; hint: string }[] = [
  { source: "project", get label() { return t("components.shared.project"); }, get hint() { return t("components.shared.projectLevelHighestPriority"); } },
  { source: "user", get label() { return t("components.shared.user"); }, get hint() { return t("components.shared.userLevel"); } },
  { source: "builtin", get label() { return t("components.shared.builtin"); }, get hint() { return t("components.shared.builtCannotUninstalled"); } },
];

export const flowSteps = () => [
  t("components.shared.vertical"),
  t("components.shared.preset"),
  t("components.shared.materializedDocument"),
  t("components.shared.refsEvents"),
  t("components.shared.projectionReconstruction"),
];

export const ACTION_BTN =
  "rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:bg-surface-raised hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-muted";

export const CHIP =
  "rounded border border-border px-1.5 py-px font-mono text-[10px] text-text-muted";

export const SECTION_LABEL =
  "text-[10px] font-medium uppercase tracking-wide text-text-faint";

export const shortRef = (ref: string) => ref.replace(/^template:\/\//, "");

/** 继承链：单父链回溯，循环安全 */
export function chainOf(entry: PresetEntry, all: PresetEntry[]): PresetEntry[] {
  const byId = new Map(all.map((p) => [p.id, p]));
  const chain = [entry];
  let cur = entry;
  while (cur.extends) {
    const parent = byId.get(cur.extends);
    if (!parent || chain.includes(parent)) break;
    chain.push(parent);
    cur = parent;
  }
  return chain;
}
