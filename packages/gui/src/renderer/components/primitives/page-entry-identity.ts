import type { AppLocation } from "../../navigation/viewHistory.ts";
import { decisionDetailLocation } from "../../navigation/decisionReviewRoutes.ts";

/** Filters and preview drawers do not replace the page being entered. */
export function pageEntryIdentity(projectId: string, location: AppLocation): string {
  const { view, selectedId, focusedEntityRef } = location;
  let entity: string | null = null;
  if (selectedId) entity = selectedId;
  else if (view === "workspace") entity = location.scopeRootTaskId ?? null;
  else if (view === "decisionDetail") entity = decisionDetailLocation(focusedEntityRef)?.decisionId ?? null;
  else if (
    ["factDetail", "presets", "entities", "sessions", "agentSquad", "providers", "schedules", "daemonObserve"].includes(
      view,
    )
  ) {
    entity = focusedEntityRef?.split("/").slice(0, 2).join("/") ?? null;
  }
  return JSON.stringify([projectId, selectedId ? "task" : view, entity]);
}
