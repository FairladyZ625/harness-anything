import type { DocGroup } from "./types.ts";
import { t } from "../i18n/core.ts";

export function inferDocGroup(path: string): DocGroup {
  const lower = path.toLowerCase();
  if (lower.includes("contract") || lower === "index.md") return "required";
  if (lower.includes("plan") || lower.includes("roadmap") || lower.includes("task-plan")) return "plan";
  if (lower.includes("design") || lower.includes("adr") || lower.includes("architecture")) return "design";
  if (lower.includes("progress")) return "progress";
  if (lower.includes("closeout") || lower.includes("verification") || lower.includes("verify")) return "closeout";
  if (lower.includes("evidence") || lower.includes("fact") || lower.includes("lesson")) return "evidence";
  return "progress";
}

export function isRequiredDocGroup(group: DocGroup): boolean {
  return group === "required" || group === "closeout";
}

export function docGroupLabel(group: DocGroup): string {
  return t(`model.docGroups.${group}`);
}
