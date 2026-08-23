import { unregisterDaemonRepo, type InvalidDaemonRegistryRepo } from "../../kernel/src/index.ts";
import { hostCodedError } from "./daemon-host-errors.ts";
import { type RepoCell, type RepoCellStatus } from "./repo-cell.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

export function requiredCell(
  cells: Map<string, RepoCell>,
  warming: Map<string, RepoCellStatus>,
  unavailable: Map<string, RepoCellStatus>,
  repoId: string,
): RepoCell {
  const cell = cells.get(repoId);
  if (!cell)
    throw hostCodedError(
      warming.has(repoId) ? "repo_warming" : unavailable.has(repoId) ? "repo_unavailable" : "repo_namespace_unknown",
      warming.has(repoId)
        ? `Repository ${repoId} is still warming; wait for its background attachment to complete.`
        : (unavailable.get(repoId)?.lastError ?? `Unknown repo namespace: ${repoId}.`),
    );
  return cell;
}

export function invalidRepoId(repo: InvalidDaemonRegistryRepo): string {
  return repo.repoId ?? `invalid-registry-entry-${repo.entryIndex + 1}`;
}

export function invalidRegistryStatus(repo: InvalidDaemonRegistryRepo): RepoCellStatus {
  return {
    repoId: invalidRepoId(repo),
    rootDir: repo.canonicalRoot ?? "<invalid>",
    mode: repo.mode ?? null,
    state: "unavailable",
    generation: null,
    queueDepth: null,
    recoveryMs: null,
    lastError: repo.error,
    causeClass: "infrastructure",
  };
}

export function invalidRegistrySystemRow(repo: InvalidDaemonRegistryRepo) {
  const disabled = repo.state === "disabled";
  return {
    repoId: invalidRepoId(repo),
    displayName: repo.displayName ?? invalidRepoId(repo),
    canonicalRoot: repo.canonicalRoot ?? "<invalid>",
    authoredBranch: repo.authoredBranch ?? "<invalid>",
    registrationState: disabled ? ("disabled" as const) : ("enabled" as const),
    cellState: disabled ? ("not_loaded" as const) : ("unavailable" as const),
    generation: null,
    queueDepth: null,
    lockState: disabled ? ("not_applicable" as const) : ("unknown" as const),
    recoveryMs: null,
    lastError: repo.error,
    unavailableReason: repo.error,
  };
}

export function publicRegistryRepo(repo: ReturnType<typeof unregisterDaemonRepo>["repo"]) {
  if (!("raw" in repo)) return repo;
  return {
    repoId: invalidRepoId(repo),
    canonicalRoot: repo.canonicalRoot ?? null,
    displayName: repo.displayName ?? null,
    authoredBranch: repo.authoredBranch ?? null,
    mode: repo.mode ?? null,
    state: repo.state ?? null,
    registeredAt: repo.registeredAt ?? null,
    unavailableReason: repo.error,
  };
}

export function localOnly(auth: DaemonAuthenticationContext): void {
  if (auth.transportKind !== "unix-socket" || auth.assignmentBinding)
    throw hostCodedError("local_transport_required", "This control is available only through the local session token.");
}

export function requiredText(value: unknown, field: string): string {
  if (typeof value === "string" && value.length) return value;
  throw hostCodedError("invalid_request", `${field} is required.`);
}
