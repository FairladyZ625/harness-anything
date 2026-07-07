import type { PresetEntry, PresetSource } from "../../model/types";

export type TabId = "preset" | "vertical" | "templates";

export const TABS: { id: TabId; label: string }[] = [
  { id: "preset", label: "Preset" },
  { id: "vertical", label: "Vertical" },
  { id: "templates", label: "模板库" },
];

export const SOURCE_SECTIONS: { source: PresetSource; label: string; hint: string }[] = [
  { source: "project", label: "project", hint: "项目级 · 优先级最高" },
  { source: "user", label: "user", hint: "用户级" },
  { source: "builtin", label: "builtin", hint: "内置 · 不可卸载" },
];

export const FLOW_STEPS = ["Vertical", "Preset", "物化文档", "Refs/Events", "投影重建"];

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
