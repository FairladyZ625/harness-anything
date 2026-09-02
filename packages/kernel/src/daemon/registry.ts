import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { consumeKnownError } from "../error-consumption.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { makeLocalVersionControlSystem, resolveLedgerGitLayout } from "../composition/index.ts";
import { daemonRepoModes, type DaemonRepoMode } from "./repo-mode.ts";

export { daemonRepoModes } from "./repo-mode.ts";
export type { DaemonRepoMode } from "./repo-mode.ts";

export const daemonRegistrySchema = "harness-daemon-registry/v2";

export type DaemonRepoState = "enabled" | "disabled";
export type DaemonConnectionKind = "local" | "remote-endpoint" | "fleet-center";

export interface DaemonRegistryConnection {
  readonly id: string;
  readonly kind: DaemonConnectionKind;
  readonly displayName: string;
  readonly state: DaemonRepoState;
  readonly endpoint?: string;
}

export interface DaemonRegistryRepo {
  readonly repoId: string;
  readonly canonicalRoot: string | null;
  readonly displayName: string;
  readonly authoredBranch: string | null;
  readonly mode: DaemonRepoMode;
  readonly connectionId: string;
  readonly state: DaemonRepoState;
  readonly registeredAt: string;
}
type LocalDaemonRegistryRepo = DaemonRegistryRepo & {
  readonly canonicalRoot: string;
  readonly authoredBranch: string;
};
export interface InvalidDaemonRegistryRepo {
  readonly entryIndex: number;
  readonly repoId?: string;
  readonly canonicalRoot?: string | null;
  readonly displayName?: string;
  readonly authoredBranch?: string | null;
  readonly mode?: DaemonRepoMode;
  readonly connectionId?: string;
  readonly state?: DaemonRepoState;
  readonly registeredAt?: string;
  readonly error: string;
  readonly raw: unknown;
}
export interface DaemonRegistry {
  readonly schema: typeof daemonRegistrySchema;
  readonly connections: ReadonlyArray<DaemonRegistryConnection>;
  readonly repos: ReadonlyArray<DaemonRegistryRepo>;
  readonly invalidRepos: ReadonlyArray<InvalidDaemonRegistryRepo>;
}

export interface DaemonRegistryPaths {
  readonly userRoot: string;
  readonly registryPath: string;
  readonly reposRoot: string;
}

export interface DaemonRegistryOptions {
  readonly userRoot?: string;
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
  readonly createConvenienceLinks?: boolean;
}

export interface DaemonRegistryRegisterInput extends DaemonRegistryOptions {
  readonly canonicalRoot?: string;
  readonly repoId?: string;
  readonly displayName?: string;
  readonly mode?: DaemonRepoMode;
  readonly connectionId?: string;
  readonly endpoint?: string;
}

export interface DaemonRegistryRepoUpdateInput extends DaemonRegistryOptions {
  readonly repoId: string;
  readonly displayName?: string;
  readonly mode?: DaemonRepoMode;
  readonly connectionId?: string;
  readonly endpoint?: string;
  readonly state?: DaemonRepoState;
}

export interface DaemonRegistryConnectionInput extends DaemonRegistryOptions {
  readonly id?: string;
  readonly kind?: Exclude<DaemonConnectionKind, "local">;
  readonly displayName?: string;
  readonly endpoint: string;
}

export interface DaemonRegistryConnectionUpdateInput extends DaemonRegistryOptions {
  readonly id: string;
  readonly displayName?: string;
  readonly endpoint?: string;
  readonly state?: DaemonRepoState;
}

export interface DaemonRegistryMutationResult<TRepo = DaemonRegistryRepo> {
  readonly registry: DaemonRegistry;
  readonly repo: TRepo;
  readonly registryPath: string;
  readonly changed: boolean;
  readonly warnings: ReadonlyArray<string>;
}

export interface DaemonRegistryConnectionMutationResult {
  readonly registry: DaemonRegistry;
  readonly connection: DaemonRegistryConnection;
  readonly registryPath: string;
  readonly changed: boolean;
}

export function daemonRegistryPaths(options: DaemonRegistryOptions = {}): DaemonRegistryPaths {
  const userRoot = path.resolve(options.userRoot ?? path.join(os.homedir(), ".harness"));
  return {
    userRoot,
    registryPath: path.join(userRoot, "registry.json"),
    reposRoot: path.join(userRoot, "repos"),
  };
}

export function readDaemonRegistry(options: DaemonRegistryOptions = {}): DaemonRegistry {
  const { registryPath } = daemonRegistryPaths(options);
  if (!existsSync(registryPath)) return emptyDaemonRegistry();
  const decoded = JSON.parse(readFileSync(registryPath, "utf8")) as unknown;
  if (isDaemonRegistryRecord(decoded) && decoded.schema === "harness-daemon-registry/v1") {
    const upgraded = decodeDaemonRegistry(upgradeDaemonRegistryV1(decoded, registryPath), registryPath);
    writeDaemonRegistry(upgraded, options);
    return upgraded;
  }
  return decodeDaemonRegistry(decoded, registryPath);
}

export function registerDaemonRepo(
  input: DaemonRegistryRegisterInput,
): DaemonRegistryMutationResult<DaemonRegistryRepo> {
  const paths = daemonRegistryPaths(input);
  let registry = readDaemonRegistry(input);
  const requestedMode = normalizeRepoMode(input.mode ?? "local"),
    remoteProxy = requestedMode === "remote-proxy",
    canonicalRoot = remoteProxy ? null : canonicalHarnessRoot(requiredCanonicalRoot(input.canonicalRoot)),
    displayName = input.displayName ?? (canonicalRoot === null ? input.repoId : path.basename(canonicalRoot));
  if (!displayName) throw new Error("displayName is required when registering a remote-proxy repository");
  const explicitRepoId = input.repoId ? normalizeExplicitRepoId(input.repoId) : undefined;
  if (remoteProxy && !explicitRepoId) throw new Error("repoId is required when registering a remote-proxy repository");
  const existingByRoot = canonicalRoot
      ? registry.repos.find((repo) => repo.canonicalRoot === canonicalRoot)
      : undefined,
    invalidByRoot = canonicalRoot
      ? registry.invalidRepos.find((repo) => repo.canonicalRoot === canonicalRoot)
      : undefined;
  const warnings: Array<string> = [];

  if (invalidByRoot)
    throw new Error(
      `canonical root has an invalid daemon registry entry${invalidByRoot.repoId ? ` for repoId "${invalidByRoot.repoId}"` : ""}; unregister it before registering the root again`,
    );

  if (existingByRoot) {
    if (explicitRepoId && existingByRoot.repoId !== explicitRepoId) {
      throw new Error(`canonical root is already registered as repoId "${existingByRoot.repoId}"`);
    }
    const repo = {
      ...existingByRoot,
      displayName,
      mode: requestedMode,
      state: "enabled" as const,
    };
    const next = replaceRepo(registry, repo);
    const changed = !daemonRepoEquals(existingByRoot, repo);
    if (changed) writeDaemonRegistry(next, input);
    warnings.push(...syncConvenienceLink(repo as LocalDaemonRegistryRepo, input));
    return { registry: next, repo, registryPath: paths.registryPath, changed, warnings };
  }

  const reservedRepoIds = [
    ...registry.repos.map(({ repoId }) => repoId),
    ...registry.invalidRepos.flatMap(({ repoId }) => (repoId ? [repoId] : [])),
  ];
  const repoId = explicitRepoId ?? generateRepoId(displayName, canonicalRoot!, reservedRepoIds);
  const conflictingRepo = registry.repos.find((repo) => repo.repoId === repoId && repo.state === "enabled");
  if (conflictingRepo) {
    if (remoteProxy && conflictingRepo.mode === "remote-proxy") {
      const routed = resolveRegistrationConnection(registry, {
          mode: requestedMode,
          connectionId: input.connectionId ?? conflictingRepo.connectionId,
          endpoint: input.endpoint,
        }),
        repo: DaemonRegistryRepo = {
          ...conflictingRepo,
          displayName,
          connectionId: routed.connection.id,
          state: "enabled",
        },
        next = replaceRepo(routed.registry, repo),
        changed = !daemonRepoEquals(conflictingRepo, repo) || routed.registry !== registry;
      if (changed) writeDaemonRegistry(next, input);
      return { registry: next, repo, registryPath: paths.registryPath, changed, warnings };
    }
    throw new Error(
      `repoId "${repoId}" is already registered for ${conflictingRepo.canonicalRoot ?? conflictingRepo.connectionId}`,
    );
  }
  if (registry.invalidRepos.some((repo) => repo.repoId === repoId && repo.state !== "disabled"))
    throw new Error(`repoId "${repoId}" has an invalid daemon registry entry; unregister it before reusing the id`);

  const connection = resolveRegistrationConnection(registry, {
    mode: requestedMode,
    connectionId: input.connectionId,
    endpoint: input.endpoint,
  });
  registry = connection.registry;
  const repo: DaemonRegistryRepo = {
    repoId,
    canonicalRoot,
    displayName,
    authoredBranch: canonicalRoot === null ? null : defaultAuthoredBranch(canonicalRoot),
    mode: requestedMode,
    connectionId: connection.connection.id,
    state: "enabled",
    registeredAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  const next = sortDaemonRegistry({
    ...registry,
    repos: [...registry.repos.filter((existing) => existing.repoId !== repoId), repo],
    invalidRepos: registry.invalidRepos.filter((existing) => existing.repoId !== repoId),
  });
  writeDaemonRegistry(next, input);
  if (repo.canonicalRoot !== null) warnings.push(...syncConvenienceLink(repo as LocalDaemonRegistryRepo, input));
  return { registry: next, repo, registryPath: paths.registryPath, changed: true, warnings };
}

export function updateDaemonRepo(
  input: DaemonRegistryRepoUpdateInput,
): DaemonRegistryMutationResult<DaemonRegistryRepo> {
  const paths = daemonRegistryPaths(input),
    registry = readDaemonRegistry(input),
    repoId = normalizeExplicitRepoId(input.repoId),
    existing = registry.repos.find((repo) => repo.repoId === repoId);
  if (!existing) throw new Error(`repoId "${repoId}" is not registered`);
  const mode = input.mode === undefined ? existing.mode : normalizeRepoMode(input.mode);
  if ((existing.mode === "remote-proxy") !== (mode === "remote-proxy"))
    throw new Error("remote-proxy repositories cannot switch to or from a workspace-backed mode");
  const routed =
    input.connectionId !== undefined || input.endpoint !== undefined
      ? resolveRegistrationConnection(registry, {
          mode,
          connectionId: input.connectionId ?? (input.endpoint === undefined ? existing.connectionId : undefined),
          endpoint: input.endpoint,
        })
      : {
          registry,
          connection: requiredConnection(registry, existing.connectionId),
        };
  const repo: DaemonRegistryRepo = {
      ...existing,
      displayName: input.displayName ?? existing.displayName,
      mode,
      connectionId: routed.connection.id,
      state: input.state ?? existing.state,
    },
    next = replaceRepo(routed.registry, repo),
    changed = !daemonRepoEquals(existing, repo) || routed.registry !== registry;
  if (changed) writeDaemonRegistry(next, input);
  return { registry: next, repo, registryPath: paths.registryPath, changed, warnings: [] };
}

export function registerDaemonConnection(input: DaemonRegistryConnectionInput): DaemonRegistryConnectionMutationResult {
  const paths = daemonRegistryPaths(input),
    registry = readDaemonRegistry(input),
    endpoint = normalizeRemoteEndpoint(input.endpoint),
    id = normalizeConnectionId(input.id ?? remoteEndpointConnectionId(endpoint)),
    byEndpoint = registry.connections.find(
      (connection) => connection.kind === "remote-endpoint" && connection.endpoint === endpoint,
    ),
    existing = registry.connections.find((connection) => connection.id === id),
    connection: DaemonRegistryConnection = {
      id: byEndpoint?.id ?? id,
      kind: input.kind ?? "remote-endpoint",
      displayName: input.displayName ?? byEndpoint?.displayName ?? existing?.displayName ?? endpoint,
      endpoint,
      state: "enabled",
    };
  if (connection.kind !== "remote-endpoint") throw new Error("only remote-endpoint connections can be registered");
  if (existing && existing.kind !== connection.kind)
    throw new Error(`connection "${id}" is already registered as ${existing.kind}`);
  if (existing && existing.endpoint !== endpoint)
    throw new Error(`connection "${id}" is already registered for ${existing.endpoint ?? existing.kind}`);
  const previous = byEndpoint ?? existing,
    next = replaceConnection(registry, connection),
    changed = !previous || !daemonConnectionEquals(previous, connection);
  if (changed) writeDaemonRegistry(next, input);
  return { registry: next, connection, registryPath: paths.registryPath, changed };
}

export function updateDaemonConnection(
  input: DaemonRegistryConnectionUpdateInput,
): DaemonRegistryConnectionMutationResult {
  const paths = daemonRegistryPaths(input),
    registry = readDaemonRegistry(input),
    id = normalizeConnectionId(input.id),
    existing = requiredConnection(registry, id),
    endpoint = input.endpoint === undefined ? existing.endpoint : normalizeRemoteEndpoint(input.endpoint);
  if (existing.kind === "local") throw new Error("the implicit local connection cannot be updated");
  if (
    endpoint !== undefined &&
    registry.connections.some(
      (connection) => connection.id !== id && connection.kind === "remote-endpoint" && connection.endpoint === endpoint,
    )
  )
    throw new Error(`endpoint "${endpoint}" is already registered by another connection`);
  const connection: DaemonRegistryConnection = {
      ...existing,
      displayName: input.displayName ?? existing.displayName,
      state: input.state ?? existing.state,
      ...(endpoint === undefined ? {} : { endpoint }),
    },
    next = replaceConnection(registry, connection),
    changed = !daemonConnectionEquals(existing, connection);
  if (changed) writeDaemonRegistry(next, input);
  return { registry: next, connection, registryPath: paths.registryPath, changed };
}

export function removeDaemonConnection(
  connectionId: string,
  options: DaemonRegistryOptions = {},
): DaemonRegistryConnectionMutationResult {
  const paths = daemonRegistryPaths(options),
    registry = readDaemonRegistry(options),
    id = normalizeConnectionId(connectionId),
    existing = requiredConnection(registry, id);
  if (existing.kind === "local") throw new Error("the implicit local connection cannot be removed");
  if (registry.repos.some((repo) => repo.connectionId === id && repo.state === "enabled"))
    throw new Error(`connection "${id}" still has enabled repositories`);
  const connection = { ...existing, state: "disabled" as const },
    next = replaceConnection(registry, connection),
    changed = existing.state !== "disabled";
  if (changed) writeDaemonRegistry(next, options);
  return { registry: next, connection, registryPath: paths.registryPath, changed };
}

export function unregisterDaemonRepo(
  repoId: string,
  options: DaemonRegistryOptions = {},
): DaemonRegistryMutationResult<DaemonRegistryRepo | InvalidDaemonRegistryRepo> {
  const paths = daemonRegistryPaths(options);
  const registry = readDaemonRegistry(options);
  const normalizedRepoId = normalizeExplicitRepoId(repoId);
  const existing = registry.repos.find((repo) => repo.repoId === normalizedRepoId);
  const invalid = registry.invalidRepos.find((repo) => repo.repoId === normalizedRepoId);
  if (!existing && !invalid) throw new Error(`repoId "${normalizedRepoId}" is not registered`);
  if (invalid) {
    const raw = isDaemonRegistryRecord(invalid.raw) ? { ...invalid.raw, state: "disabled" } : invalid.raw,
      repo = { ...invalid, state: "disabled" as const, raw },
      next = replaceInvalidRepo(registry, repo),
      changed = invalid.state !== "disabled";
    if (changed) writeDaemonRegistry(next, options);
    const warnings = invalid.canonicalRoot
      ? removeConvenienceLink({ repoId: normalizedRepoId, canonicalRoot: invalid.canonicalRoot }, options)
      : [];
    return { registry: next, repo, registryPath: paths.registryPath, changed, warnings };
  }
  const valid = existing!;
  const repo = { ...valid, state: "disabled" as const };
  const next = replaceRepo(registry, repo);
  const changed = !daemonRepoEquals(valid, repo);
  if (changed) writeDaemonRegistry(next, options);
  const warnings = repo.canonicalRoot === null ? [] : removeConvenienceLink(repo as LocalDaemonRegistryRepo, options);
  return { registry: next, repo, registryPath: paths.registryPath, changed, warnings };
}

export function resolveDaemonRepoByRoot(
  rootDir: string,
  options: DaemonRegistryOptions = {},
): DaemonRegistryRepo | undefined {
  const canonicalRoot = canonicalHarnessRoot(rootDir);
  return readDaemonRegistry(options).repos.find((repo) => repo.canonicalRoot === canonicalRoot);
}

function emptyDaemonRegistry(): DaemonRegistry {
  return { schema: daemonRegistrySchema, connections: [localConnection()], repos: [], invalidRepos: [] };
}

function decodeDaemonRegistry(value: unknown, source: string): DaemonRegistry {
  if (
    !isDaemonRegistryRecord(value) ||
    value.schema !== daemonRegistrySchema ||
    !Array.isArray(value.connections) ||
    !Array.isArray(value.repos)
  ) {
    throw new Error(`invalid daemon registry at ${source}`);
  }
  const connections = value.connections.map((entry) => decodeDaemonRegistryConnection(entry, source));
  if (!connections.some((connection) => connection.id === "local" && connection.kind === "local"))
    throw new Error(`invalid daemon registry at ${source}: missing implicit local connection`);
  if (new Set(connections.map((connection) => connection.id)).size !== connections.length)
    throw new Error(`invalid daemon registry at ${source}: duplicate connection id`);
  const repos: DaemonRegistryRepo[] = [],
    invalidRepos: InvalidDaemonRegistryRepo[] = [];
  value.repos.forEach((entry, entryIndex) => {
    try {
      repos.push(decodeDaemonRegistryRepo(entry, source, connections));
    } catch (error) {
      consumeKnownError(error);
      invalidRepos.push(
        invalidDaemonRegistryRepo(entry, entryIndex, error instanceof Error ? error.message : String(error)),
      );
    }
  });
  return sortDaemonRegistry({ schema: daemonRegistrySchema, connections, repos, invalidRepos });
}

function upgradeDaemonRegistryV1(value: Record<string, unknown>, source: string): Record<string, unknown> {
  if (!Array.isArray(value.repos)) throw new Error(`invalid daemon registry at ${source}`);
  return {
    schema: daemonRegistrySchema,
    connections: [localConnection()],
    repos: value.repos
      .map((repo) =>
        isDaemonRegistryRecord(repo)
          ? {
              ...repo,
              mode: repo.mode ?? "local",
              connectionId: "local",
            }
          : repo,
      )
      .sort(compareRegistryEntries),
  };
}

function decodeDaemonRegistryConnection(value: unknown, source: string): DaemonRegistryConnection {
  if (!isDaemonRegistryRecord(value)) throw new Error(`invalid daemon registry connection at ${source}`);
  const id = typeof value.id === "string" ? normalizeConnectionId(value.id) : undefined,
    kind = ["local", "remote-endpoint", "fleet-center"].includes(String(value.kind))
      ? (value.kind as DaemonConnectionKind)
      : undefined,
    displayName = typeof value.displayName === "string" && value.displayName.length > 0 ? value.displayName : undefined,
    state = value.state === "enabled" || value.state === "disabled" ? value.state : undefined,
    endpoint = typeof value.endpoint === "string" ? normalizeRemoteEndpoint(value.endpoint) : undefined;
  if (!id || !kind || !displayName || !state) throw new Error(`invalid daemon registry connection at ${source}`);
  if (kind === "local" && (id !== "local" || endpoint !== undefined))
    throw new Error(`invalid local daemon registry connection at ${source}`);
  if (kind === "remote-endpoint" && endpoint === undefined)
    throw new Error(`invalid remote endpoint daemon registry connection at ${source}`);
  return { id, kind, displayName, state, ...(endpoint ? { endpoint } : {}) };
}

function decodeDaemonRegistryRepo(
  value: unknown,
  source: string,
  connections: ReadonlyArray<DaemonRegistryConnection>,
): DaemonRegistryRepo {
  if (!isDaemonRegistryRecord(value)) throw new Error(`invalid daemon registry repo entry at ${source}`);
  const repoId = typeof value.repoId === "string" ? normalizeExplicitRepoId(value.repoId) : undefined;
  const canonicalRoot =
    value.canonicalRoot === null
      ? null
      : typeof value.canonicalRoot === "string"
        ? path.resolve(value.canonicalRoot)
        : undefined;
  const displayName =
    typeof value.displayName === "string" && value.displayName.length > 0 ? value.displayName : undefined;
  const authoredBranch =
    value.authoredBranch === null
      ? null
      : typeof value.authoredBranch === "string" && validBranch(value.authoredBranch)
        ? value.authoredBranch
        : undefined;
  const mode = daemonRepoModes.includes(value.mode as DaemonRepoMode) ? (value.mode as DaemonRepoMode) : undefined;
  const connectionId = typeof value.connectionId === "string" ? normalizeConnectionId(value.connectionId) : undefined,
    connection = connections.find((candidate) => candidate.id === connectionId);
  const state = value.state === "enabled" || value.state === "disabled" ? value.state : undefined;
  const registeredAt =
    typeof value.registeredAt === "string" && value.registeredAt.length > 0 ? value.registeredAt : undefined;
  const invalid = [
    ["repoId", repoId],
    ["canonicalRoot", canonicalRoot],
    ["displayName", displayName],
    ["authoredBranch", authoredBranch],
    ["mode", mode],
    ["connectionId", connectionId],
    ["connection", connection],
    ["state", state],
    ["registeredAt", registeredAt],
  ]
    .filter(([field, item]) => item === undefined || (field !== "canonicalRoot" && field !== "authoredBranch" && !item))
    .map(([field]) => field);
  if (invalid.length)
    throw new Error(`invalid daemon registry repo entry at ${source}: missing or invalid ${invalid.join(", ")}`);
  if (mode === "remote-proxy") {
    if (canonicalRoot !== null || authoredBranch !== null || connection?.kind !== "remote-endpoint")
      throw new Error(`invalid remote-proxy daemon registry repo entry at ${source}`);
  } else if (canonicalRoot === null || authoredBranch === null)
    throw new Error(`invalid workspace-backed daemon registry repo entry at ${source}`);
  return {
    repoId: repoId!,
    canonicalRoot: canonicalRoot!,
    displayName: displayName!,
    authoredBranch: authoredBranch!,
    mode: mode!,
    connectionId: connectionId!,
    state: state!,
    registeredAt: registeredAt!,
  };
}

function invalidDaemonRegistryRepo(value: unknown, entryIndex: number, error: string): InvalidDaemonRegistryRepo {
  if (!isDaemonRegistryRecord(value)) return { entryIndex, error, raw: value };
  let repoId: string | undefined;
  if (typeof value.repoId === "string")
    try {
      repoId = normalizeExplicitRepoId(value.repoId);
    } catch (cause) {
      consumeKnownError(cause);
      repoId = undefined;
    }
  const canonicalRoot =
      value.canonicalRoot === null
        ? null
        : typeof value.canonicalRoot === "string"
          ? path.resolve(value.canonicalRoot)
          : undefined,
    displayName = typeof value.displayName === "string" && value.displayName.length > 0 ? value.displayName : undefined,
    authoredBranch =
      value.authoredBranch === null
        ? null
        : typeof value.authoredBranch === "string" && validBranch(value.authoredBranch)
          ? value.authoredBranch
          : undefined,
    mode = daemonRepoModes.includes(value.mode as DaemonRepoMode) ? (value.mode as DaemonRepoMode) : undefined,
    connectionId = typeof value.connectionId === "string" ? value.connectionId : undefined,
    state = value.state === "enabled" || value.state === "disabled" ? value.state : undefined,
    registeredAt =
      typeof value.registeredAt === "string" && value.registeredAt.length > 0 ? value.registeredAt : undefined;
  return {
    entryIndex,
    ...(repoId ? { repoId } : {}),
    ...(canonicalRoot !== undefined ? { canonicalRoot } : {}),
    ...(displayName ? { displayName } : {}),
    ...(authoredBranch !== undefined ? { authoredBranch } : {}),
    ...(mode ? { mode } : {}),
    ...(connectionId ? { connectionId } : {}),
    ...(state ? { state } : {}),
    ...(registeredAt ? { registeredAt } : {}),
    error,
    raw: value,
  };
}

function writeDaemonRegistry(registry: DaemonRegistry, options: DaemonRegistryOptions): void {
  const { userRoot, registryPath } = daemonRegistryPaths(options);
  mkdirSync(userRoot, { recursive: true });
  const tempPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  const sorted = sortDaemonRegistry(registry),
    persisted = {
      schema: sorted.schema,
      connections: sorted.connections,
      repos: [...sorted.repos, ...sorted.invalidRepos.map(({ raw }) => raw)].sort(compareRegistryEntries),
    };
  writeFileSync(tempPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  renameSync(tempPath, registryPath);
}

function canonicalHarnessRoot(rootDir: string): string {
  const realRoot = existsSync(path.resolve(rootDir))
    ? realpathSync.native(path.resolve(rootDir))
    : invalidCanonicalRoot(rootDir);
  const layout = resolveHarnessLayout(realRoot);
  if (!layout.configPath || !existsSync(layout.configPath)) {
    throw new Error(`canonicalRoot must be an initialized harness repository: ${rootDir}`);
  }
  return realpathSync.native(layout.rootDir);
}

function generateRepoId(displayName: string, canonicalRoot: string, repoIds: ReadonlyArray<string>): string {
  const base = safeRepoId(displayName);
  if (!repoIds.includes(base)) return base;
  const suffix = createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 8);
  const truncated = base.slice(0, Math.max(1, 63 - suffix.length - 1)).replace(/-+$/gu, "") || "repo";
  return `${truncated}-${suffix}`;
}

function normalizeExplicitRepoId(repoId: string): string {
  const normalized = safeRepoId(repoId);
  if (normalized !== repoId) {
    throw new Error("repoId must use lowercase letters, numbers, and hyphens, and start with a letter");
  }
  return normalized;
}

function normalizeRepoMode(mode: DaemonRepoMode): DaemonRepoMode {
  if (!daemonRepoModes.includes(mode)) throw new Error(`mode must be one of ${daemonRepoModes.join(", ")}`);
  return mode;
}

function resolveRegistrationConnection(
  registry: DaemonRegistry,
  input: {
    readonly mode: DaemonRepoMode;
    readonly connectionId?: string;
    readonly endpoint?: string;
  },
): { readonly registry: DaemonRegistry; readonly connection: DaemonRegistryConnection } {
  if (input.mode !== "remote-proxy") {
    if (input.endpoint !== undefined) throw new Error("endpoint is available only for remote-proxy repositories");
    const connection = requiredConnection(registry, input.connectionId ?? "local");
    if (connection.kind === "remote-endpoint")
      throw new Error("workspace-backed repositories cannot use a remote-endpoint connection");
    return { registry, connection };
  }
  if (input.endpoint !== undefined) {
    const endpoint = normalizeRemoteEndpoint(input.endpoint),
      existingByEndpoint = registry.connections.find(
        (connection) => connection.kind === "remote-endpoint" && connection.endpoint === endpoint,
      );
    if (input.connectionId !== undefined) {
      const requested = requiredConnection(registry, input.connectionId);
      if (requested.kind !== "remote-endpoint" || requested.endpoint !== endpoint)
        throw new Error("connection and endpoint must identify the same remote endpoint");
      return { registry, connection: requested };
    }
    if (existingByEndpoint) {
      if (existingByEndpoint.state !== "enabled") throw new Error(`connection "${existingByEndpoint.id}" is disabled`);
      return { registry, connection: existingByEndpoint };
    }
    const connection: DaemonRegistryConnection = {
      id: remoteEndpointConnectionId(endpoint),
      kind: "remote-endpoint",
      displayName: endpoint,
      endpoint,
      state: "enabled",
    };
    return { registry: replaceConnection(registry, connection), connection };
  }
  if (input.connectionId === undefined) throw new Error("remote-proxy registration requires endpoint or connectionId");
  const connection = requiredConnection(registry, input.connectionId);
  if (connection.kind !== "remote-endpoint")
    throw new Error("remote-proxy repositories require a remote-endpoint connection");
  if (connection.state !== "enabled") throw new Error(`connection "${connection.id}" is disabled`);
  return { registry, connection };
}

function requiredConnection(registry: DaemonRegistry, connectionId: string): DaemonRegistryConnection {
  const id = normalizeConnectionId(connectionId),
    connection = registry.connections.find((candidate) => candidate.id === id);
  if (!connection) throw new Error(`connection "${id}" is not registered`);
  return connection;
}

function localConnection(): DaemonRegistryConnection {
  return { id: "local", kind: "local", displayName: "This device", state: "enabled" };
}

function normalizeConnectionId(connectionId: string): string {
  return normalizeExplicitRepoId(connectionId);
}

function remoteEndpointConnectionId(endpoint: string): string {
  return `remote-${createHash("sha256").update(endpoint).digest("hex").slice(0, 12)}`;
}

export function normalizeRemoteEndpoint(endpoint: string): string {
  const candidate = endpoint.trim();
  if (!candidate) throw new Error("endpoint is required");
  if (candidate.startsWith("tcp://")) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch (error) {
      consumeKnownError(error);
      throw new Error("endpoint must be tcp://host:port or an absolute socket path");
    }
    if (
      url.protocol !== "tcp:" ||
      !url.hostname ||
      !url.port ||
      url.username ||
      url.password ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search ||
      url.hash
    )
      throw new Error("endpoint must be tcp://host:port or an absolute socket path");
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new Error("TCP endpoint port must be between 1 and 65535");
    return `tcp://${url.host}`;
  }
  if (/^\\\\\.\\pipe\\/u.test(candidate)) return candidate;
  if (!path.isAbsolute(candidate)) throw new Error("endpoint must be tcp://host:port or an absolute socket path");
  return path.resolve(candidate);
}

function requiredCanonicalRoot(rootDir: string | undefined): string {
  if (rootDir) return rootDir;
  throw new Error("canonicalRoot is required for workspace-backed repositories");
}

function safeRepoId(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
  const prefixed = /^[a-z]/u.test(sanitized) ? sanitized : `repo-${sanitized}`;
  return prefixed.slice(0, 63).replace(/-+$/gu, "") || "repo";
}

function sortDaemonRegistry(registry: DaemonRegistry): DaemonRegistry {
  return {
    schema: daemonRegistrySchema,
    connections: [...registry.connections].sort((left, right) => left.id.localeCompare(right.id)),
    repos: [...registry.repos].sort(
      (left, right) =>
        left.repoId.localeCompare(right.repoId) ||
        (left.canonicalRoot ?? left.connectionId).localeCompare(right.canonicalRoot ?? right.connectionId),
    ),
    invalidRepos: [...registry.invalidRepos].sort((left, right) => left.entryIndex - right.entryIndex),
  };
}

function compareRegistryEntries(left: unknown, right: unknown): number {
  const key = (entry: unknown) =>
    isDaemonRegistryRecord(entry) && typeof entry.repoId === "string" ? entry.repoId : "~";
  return key(left).localeCompare(key(right));
}

function replaceRepo(registry: DaemonRegistry, replacement: DaemonRegistryRepo): DaemonRegistry {
  return sortDaemonRegistry({
    ...registry,
    repos: registry.repos.map((repo) => (repo.repoId === replacement.repoId ? replacement : repo)),
  });
}

function replaceConnection(registry: DaemonRegistry, replacement: DaemonRegistryConnection): DaemonRegistry {
  const found = registry.connections.some((connection) => connection.id === replacement.id);
  return sortDaemonRegistry({
    ...registry,
    connections: found
      ? registry.connections.map((connection) => (connection.id === replacement.id ? replacement : connection))
      : [...registry.connections, replacement],
  });
}

function replaceInvalidRepo(registry: DaemonRegistry, replacement: InvalidDaemonRegistryRepo): DaemonRegistry {
  return sortDaemonRegistry({
    ...registry,
    invalidRepos: registry.invalidRepos.map((repo) =>
      repo.entryIndex === replacement.entryIndex ? replacement : repo,
    ),
  });
}

function syncConvenienceLink(repo: LocalDaemonRegistryRepo, options: DaemonRegistryOptions): ReadonlyArray<string> {
  if (options.createConvenienceLinks === false) return [];
  const { reposRoot } = daemonRegistryPaths(options);
  const linkPath = path.join(reposRoot, repo.repoId);
  try {
    mkdirSync(reposRoot, { recursive: true });
    if (existsSync(linkPath)) {
      const current = realpathSync.native(linkPath);
      return current === repo.canonicalRoot ? [] : [`repo convenience path already exists: ${linkPath}`];
    }
    symlinkSync(repo.canonicalRoot, linkPath, (options.platform ?? process.platform) === "win32" ? "junction" : "dir");
    return [];
  } catch (error) {
    return [`could not create repo convenience link: ${error instanceof Error ? error.message : String(error)}`];
  }
}

function removeConvenienceLink(
  repo: Pick<LocalDaemonRegistryRepo, "repoId" | "canonicalRoot">,
  options: DaemonRegistryOptions,
): ReadonlyArray<string> {
  if (options.createConvenienceLinks === false) return [];
  const { reposRoot } = daemonRegistryPaths(options);
  const linkPath = path.join(reposRoot, repo.repoId);
  try {
    if (!existsSync(linkPath)) return [];
    const stat = lstatSync(linkPath);
    const current = realpathSync.native(linkPath);
    if (stat.isSymbolicLink() && current === repo.canonicalRoot) {
      rmSync(linkPath, { recursive: true, force: true });
      return [];
    }
    return [`repo convenience path does not point at registered root: ${linkPath}`];
  } catch (error) {
    return [`could not remove repo convenience link: ${error instanceof Error ? error.message : String(error)}`];
  }
}

function daemonRepoEquals(left: DaemonRegistryRepo, right: DaemonRegistryRepo): boolean {
  return (
    left.repoId === right.repoId &&
    left.canonicalRoot === right.canonicalRoot &&
    left.displayName === right.displayName &&
    left.authoredBranch === right.authoredBranch &&
    left.mode === right.mode &&
    left.connectionId === right.connectionId &&
    left.state === right.state &&
    left.registeredAt === right.registeredAt
  );
}

function daemonConnectionEquals(left: DaemonRegistryConnection, right: DaemonRegistryConnection): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.displayName === right.displayName &&
    left.state === right.state &&
    left.endpoint === right.endpoint
  );
}

function defaultAuthoredBranch(canonicalRoot: string): string {
  const vcs = makeLocalVersionControlSystem(),
    repoRoot = resolveLedgerGitLayout(canonicalRoot).rootDir,
    branch = vcs.originHeadBranch(repoRoot) ?? vcs.currentBranch(repoRoot);
  if (!branch || !validBranch(branch))
    throw new Error(`canonicalRoot must have an attached default Git branch: ${repoRoot}`);
  return branch;
}
function validBranch(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("-") &&
    !value.includes("..") &&
    !/[~^:?*[\\\s]/u.test(value) &&
    !value.endsWith("/") &&
    !value.endsWith(".lock")
  );
}

function isDaemonRegistryRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidCanonicalRoot(rootDir: string): never {
  throw new Error(`canonicalRoot must be an initialized harness repository: ${rootDir}`);
}
