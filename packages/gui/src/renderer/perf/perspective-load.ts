import type { ViewId } from "../shell-config.tsx";

/**
 * Perspective-gated data requirements.
 * App bootstrap must only eagerly fetch what the current view needs.
 * Cross-perspective data is idle-prefetched after first-usable and cancelled
 * on perspective/repo switch.
 */
export type PerspectiveDataNeed = "tasks" | "triadic" | "catalog" | "executionEvidence";

const ALWAYS: ReadonlyArray<PerspectiveDataNeed> = ["catalog"];

const VIEW_NEEDS: Readonly<Record<ViewId, ReadonlyArray<PerspectiveDataNeed>>> = {
  home: ["tasks"],
  overview: ["tasks", "triadic"],
  board: ["tasks", "triadic"],
  decisions: ["triadic"],
  decisionPool: ["triadic", "tasks"],
  factTriage: ["triadic"],
  executions: ["executionEvidence"],
  graph: ["tasks", "triadic"],
  presets: ["catalog"],
  adapters: ["catalog"],
  settings: [],
};

export function needsForView(view: ViewId): ReadonlySet<PerspectiveDataNeed> {
  const needs = new Set<PerspectiveDataNeed>(ALWAYS);
  for (const need of VIEW_NEEDS[view] ?? []) needs.add(need);
  return needs;
}

export function viewNeeds(view: ViewId, need: PerspectiveDataNeed): boolean {
  return needsForView(view).has(need);
}

/** Views whose first-usable depends on tasks projection. */
export function tasksRequired(view: ViewId): boolean {
  return viewNeeds(view, "tasks");
}

export function triadicRequired(view: ViewId): boolean {
  return viewNeeds(view, "triadic");
}

export function executionEvidenceRequired(view: ViewId): boolean {
  return viewNeeds(view, "executionEvidence");
}
