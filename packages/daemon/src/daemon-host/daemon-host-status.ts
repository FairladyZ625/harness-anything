import {
  readDaemonRegistry,
  unbindDaemonRepo,
  type DaemonRepoMode,
  type InvalidDaemonRegistryRepo,
} from "@harness-anything/kernel";
import { daemonBuildStamp } from "./build-identity.ts";
import { daemonErrorMessage, hostCodedError } from "./daemon-host-errors.ts";
import type { DaemonControlReceipt } from "./gui-s3-control.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { currentDaemonProtocolVersion } from "./protocol/version.ts";
import { causeClassOf } from "./repo-cell.ts";
import { type RepoCell, type RepoCellStatus } from "./repo-cell-types.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

export function unavailableStatus(
  repoId: string,
  rootDir: string,
  mode: DaemonRepoMode,
  error: unknown,
): RepoCellStatus {
  return {
    repoId,
    rootDir,
    mode,
    state: "unavailable",
    generation: null,
    queueDepth: null,
    recoveryMs: null,
    materialization: null,
    lastError: daemonErrorMessage(error),
    causeClass: causeClassOf(error),
  };
}

export function warmingStatus(repo: {
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly mode: DaemonRepoMode;
}): RepoCellStatus {
  return {
    repoId: repo.repoId,
    rootDir: repo.canonicalRoot,
    mode: repo.mode,
    state: "warming",
    generation: null,
    queueDepth: null,
    recoveryMs: null,
    materialization: null,
    lastError: null,
    causeClass: null,
    attach: {
      phase: "opening",
      applied: null,
      total: null,
      watermark: null,
    },
  };
}

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
        ? warmingMessage(repoId, warming.get(repoId)!)
        : (unavailable.get(repoId)?.lastError ?? `Unknown repo namespace: ${repoId}.`),
    );
  return cell;
}

function warmingMessage(repoId: string, status: RepoCellStatus): string {
  const attach = status.attach;
  if (attach?.phase === "catching-up" && attach.applied !== null && attach.total !== null)
    return `Repository ${repoId} is still warming; waiting for projection catch-up (${attach.applied}/${attach.total} events applied).`;
  return `Repository ${repoId} is still warming; waiting for ${attach?.phase ?? "background attachment"} to complete.`;
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
    materialization: null,
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
    connectionId: repo.connectionId ?? "<invalid>",
    mode: repo.mode ?? "local",
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

export function publicRegistryRepo(repo: ReturnType<typeof unbindDaemonRepo>["repo"]) {
  if (!("raw" in repo)) return repo;
  return {
    repoId: invalidRepoId(repo),
    canonicalRoot: repo.canonicalRoot ?? null,
    displayName: repo.displayName ?? null,
    authoredBranch: repo.authoredBranch ?? null,
    mode: repo.mode ?? null,
    connectionId: repo.connectionId ?? null,
    state: repo.state ?? null,
    registeredAt: repo.registeredAt ?? null,
    unavailableReason: repo.error,
  };
}

export function localOnly(auth: DaemonAuthenticationContext): void {
  if (auth.transportKind !== "unix-socket" || auth.nodePrincipal)
    throw hostCodedError("local_transport_required", "This control is available only through the local session token.");
}

export function requiredText(value: unknown, field: string): string {
  if (typeof value === "string" && value.length) return value;
  throw hostCodedError("invalid_request", `${field} is required.`);
}

export function buildDaemonSystemStatus(input: {
  readonly userRoot: string;
  readonly auth: DaemonAuthenticationContext;
  readonly endpoint?: string;
  readonly startedAt: string;
  readonly point: () => { readonly daemonId: string; readonly pid: number; readonly startedAt: string };
  readonly latestControl: DaemonControlReceipt | null;
  readonly cells: ReadonlyMap<string, RepoCell>;
  readonly warming: ReadonlyMap<string, RepoCellStatus>;
  readonly unavailable: ReadonlyMap<string, RepoCellStatus>;
  readonly nodeAutoClaim: JsonObject;
}): JsonObject {
  localOnly(input.auth);
  const registry = readDaemonRegistry({ userRoot: input.userRoot }),
    observedAt = new Date().toISOString(),
    validRows = registry.repos.map((repo) => {
      const status =
          input.cells.get(repo.repoId)?.status() ??
          input.warming.get(repo.repoId) ??
          input.unavailable.get(repo.repoId),
        disabled = repo.state === "disabled",
        proxy = repo.mode === "remote-proxy",
        attached = status?.state === "attached",
        warmingUp = status?.state === "warming";
      return {
        repoId: repo.repoId,
        displayName: repo.displayName,
        canonicalRoot: repo.canonicalRoot,
        authoredBranch: repo.authoredBranch,
        registrationState: repo.state,
        connectionId: repo.connectionId,
        mode: repo.mode,
        cellState: disabled || proxy ? "not_loaded" : attached ? "attached" : warmingUp ? "warming" : "unavailable",
        generation: disabled ? null : (status?.generation ?? null),
        queueDepth: disabled ? null : (status?.queueDepth ?? null),
        lockState: disabled || proxy ? "not_applicable" : attached ? "held" : "unknown",
        recoveryMs: disabled ? null : (status?.recoveryMs ?? null),
        lastError: disabled ? null : (status?.lastError ?? null),
        unavailableReason:
          disabled || proxy || attached || warmingUp ? null : (status?.lastError ?? "unknown / not projected"),
      };
    }),
    invalidRows = registry.invalidRepos.map(invalidRegistrySystemRow);
  return {
    schema: "gui-system-status/v1",
    ok: true,
    observedAt,
    daemon: {
      ...input.point(),
      protocolVersion: currentDaemonProtocolVersion,
      uptimeMs: Math.max(0, Date.parse(observedAt) - Date.parse(input.startedAt)),
      endpoint: input.endpoint ?? input.auth.endpoint ?? "local-unix-socket",
      build: {
        version: process.env.npm_package_version ?? "0.0.0",
        commitSha: daemonBuildStamp().commit,
      },
      activeControl: input.latestControl
        ? {
            kind: input.latestControl.kind,
            operationId: input.latestControl.operationId,
            phase: input.latestControl.phase,
            requestedAt: input.latestControl.requestedAt,
            error: input.latestControl.error,
          }
        : null,
    },
    repos: [...validRows, ...invalidRows].sort((a, b) => a.repoId.localeCompare(b.repoId)),
    nodeAutoClaim: input.nodeAutoClaim,
  };
}
