/**
 * Map daemon-status/v2 `repos[]` onto the renderer Project summary used by the
 * project switcher / home grid. This is the runtime source of truth for the
 * multi-project list — MOCK_PROJECTS must not feed the switcher.
 */
import type { EngineId, Project } from "./types.ts";
import type { DaemonRepoStatus } from "./daemon-status.ts";
import { t } from "../i18n/core.ts";

export type ProjectRepoState = NonNullable<Project["repoState"]>;

export interface ProjectFromRepoOptions {
  readonly preset?: string;
  readonly engines?: ReadonlyArray<EngineId>;
  readonly watermarkAt?: string;
}

/** True when the operator may route reads to this repo (attached only). */
export function isRepoSelectable(repo: DaemonRepoStatus): boolean {
  return repo.state === "attached";
}

/** Human label for a daemon repo row. */
export function repoDisplayName(repo: DaemonRepoStatus): string {
  const named = repo.displayName?.trim();
  return named && named.length > 0 ? named : repo.repoId;
}

/** Build one Project summary from a daemon repo status row. */
export function projectFromDaemonRepo(
  repo: DaemonRepoStatus,
  options: ProjectFromRepoOptions = {}
): Project {
  return {
    id: repo.repoId,
    name: repoDisplayName(repo),
    path: repo.canonicalRoot || t("renderer.taskAdapter.localLedger"),
    preset: options.preset ?? t("renderer.app.notConfigured"),
    engines: options.engines ? [...options.engines] : ["local"],
    watermarkAt: options.watermarkAt ?? new Date(0).toISOString(),
    repoState: repo.state,
    lockPath: repo.lock.path,
    lastError:
      repo.lastError ??
      repo.lastMaterializerError ??
      repo.lastReconcileError?.message ??
      null
  };
}

/** Map full `repos[]` to Project summaries (order preserved). */
export function projectsFromDaemonRepos(
  repos: ReadonlyArray<DaemonRepoStatus>,
  options: ProjectFromRepoOptions = {}
): Project[] {
  return repos.map((repo) => projectFromDaemonRepo(repo, options));
}

/**
 * Resolve the active repoId for routing.
 * Preference: explicit selection if still registered → requestedRepo → first attached → first row.
 */
export function resolveActiveRepoId(
  repos: ReadonlyArray<DaemonRepoStatus>,
  selectedRepoId: string | null | undefined,
  requestedRepoId: string | null | undefined
): string | null {
  if (selectedRepoId && repos.some((repo) => repo.repoId === selectedRepoId)) {
    return selectedRepoId;
  }
  if (requestedRepoId && repos.some((repo) => repo.repoId === requestedRepoId)) {
    return requestedRepoId;
  }
  const attached = repos.find((repo) => repo.state === "attached");
  if (attached) return attached.repoId;
  return repos[0]?.repoId ?? null;
}

/** i18n key for a daemon repo state badge. */
export function repoStateI18nKey(state: ProjectRepoState | undefined): string {
  switch (state) {
    case "attached":
      return "components.appSidebar.repoStateAttached";
    case "unavailable":
      return "components.appSidebar.repoStateUnavailable";
    case "detaching":
      return "components.appSidebar.repoStateDetaching";
    case "detached":
      return "components.appSidebar.repoStateDetached";
    default:
      return "components.appSidebar.repoStateUnknown";
  }
}
