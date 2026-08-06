// @slice-activation PLT-Boundary W1 exposes this module through the package root API.
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHarnessLayout } from "../layout/index.ts";
import { isExclusiveCreateConflict } from "../local/local-layout-file-system.ts";

export const daemonRegistrySchema = "harness-daemon-registry/v1";

interface DaemonRegistryMutationLockRecord {
  readonly schema: "daemon-registry-mutation-lock/v1";
  readonly ownerToken: string;
}

export type DaemonRepoState = "enabled" | "disabled";

export interface DaemonRegistryRepo {
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly displayName: string;
  readonly state: DaemonRepoState;
  readonly registeredAt: string;
  readonly authorityManifestPath?: string;
  readonly runtimeRegistrationId?: string;
  readonly daemonGeneration?: number;
}

export interface DaemonRegistry {
  readonly schema: typeof daemonRegistrySchema;
  readonly repos: ReadonlyArray<DaemonRegistryRepo>;
  readonly machineId?: string;
  readonly daemonGeneration?: number;
}

export interface DaemonRegistryRuntimeProjection {
  readonly repoId: string;
  readonly runtimeRegistrationId: string;
  readonly daemonGeneration: number;
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
  readonly mutationLockStaleMs?: number;
}

export interface DaemonRegistryRegisterInput extends DaemonRegistryOptions {
  readonly canonicalRoot: string;
  readonly repoId?: string;
  readonly displayName?: string;
  readonly authorityManifestPath?: string;
}

export interface DaemonRegistryMutationResult {
  readonly registry: DaemonRegistry;
  readonly repo: DaemonRegistryRepo;
  readonly registryPath: string;
  readonly changed: boolean;
  readonly warnings: ReadonlyArray<string>;
}

export interface DaemonRegistryRegistrationProjection {
  readonly registry: DaemonRegistry;
  readonly repo: DaemonRegistryRepo;
  readonly changed: boolean;
}

export function daemonRegistryPaths(options: DaemonRegistryOptions = {}): DaemonRegistryPaths {
  const userRoot = path.resolve(options.userRoot ?? path.join(os.homedir(), ".harness"));
  return {
    userRoot,
    registryPath: path.join(userRoot, "registry.json"),
    reposRoot: path.join(userRoot, "repos")
  };
}

export function readDaemonRegistry(options: DaemonRegistryOptions = {}): DaemonRegistry {
  const { registryPath } = daemonRegistryPaths(options);
  if (!existsSync(registryPath)) return emptyDaemonRegistry();
  const decoded = JSON.parse(readFileSync(registryPath, "utf8")) as unknown;
  return decodeDaemonRegistry(decoded, registryPath);
}

export function registerDaemonRepo(input: DaemonRegistryRegisterInput): DaemonRegistryMutationResult {
  const paths = daemonRegistryPaths(input);
  const projected = withDaemonRegistryMutationLock(input, () => {
    const registry = readDaemonRegistry(input);
    const next = projectDaemonRepoRegistration(registry, input);
    if (next.changed) writeDaemonRegistry(next.registry, input);
    return next;
  });
  const warnings = syncConvenienceLink(projected.repo, input);
  return { ...projected, registryPath: paths.registryPath, warnings };
}

/** Replace the current operational registration snapshot; the generation record remains authoritative. */
export function publishDaemonRegistryRuntimeProjection(input: {
  readonly userRoot: string;
  readonly machineId: string;
  readonly daemonGeneration: number;
  readonly registrations: ReadonlyArray<DaemonRegistryRuntimeProjection>;
}): DaemonRegistry {
  if (input.machineId.length === 0 || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) {
    throw new Error("invalid daemon registry runtime projection generation axes");
  }
  const seenRepoIds = new Set<string>();
  for (const registration of input.registrations) {
    if (registration.repoId.length === 0 || !isUuid(registration.runtimeRegistrationId)
      || registration.daemonGeneration !== input.daemonGeneration || seenRepoIds.has(registration.repoId)) {
      throw new Error("invalid daemon registry runtime registration projection");
    }
    seenRepoIds.add(registration.repoId);
  }
  return withDaemonRegistryMutationLock(input, () => {
    const current = readDaemonRegistry(input);
    if (current.daemonGeneration !== undefined && current.daemonGeneration > input.daemonGeneration) return current;
    if (current.daemonGeneration === input.daemonGeneration
      && current.machineId !== undefined && current.machineId !== input.machineId) {
      throw new Error("daemon registry runtime projection machine identity changed within one generation");
    }
    const registrations = new Map(input.registrations.map((entry) => [entry.repoId, entry]));
    const next = sortDaemonRegistry({
      schema: daemonRegistrySchema,
      machineId: input.machineId,
      daemonGeneration: input.daemonGeneration,
      repos: current.repos.map((repo) => {
        const registration = repo.state === "enabled" ? registrations.get(repo.repoId) : undefined;
        const { runtimeRegistrationId: _runtimeRegistrationId, daemonGeneration: _daemonGeneration, ...stable } = repo;
        return registration ? {
          ...stable,
          runtimeRegistrationId: registration.runtimeRegistrationId,
          daemonGeneration: registration.daemonGeneration
        } : stable;
      })
    });
    if (JSON.stringify(current) !== JSON.stringify(next)) writeDaemonRegistry(next, input);
    return next;
  });
}

export function projectDaemonRepoRegistration(
  registry: DaemonRegistry,
  input: DaemonRegistryRegisterInput
): DaemonRegistryRegistrationProjection {
  const canonicalRoot = canonicalHarnessRoot(input.canonicalRoot);
  const displayName = input.displayName ?? path.basename(canonicalRoot);
  const explicitRepoId = input.repoId ? normalizeExplicitRepoId(input.repoId) : undefined;
  const existingByRoot = registry.repos.find((repo) => repo.canonicalRoot === canonicalRoot);

  if (existingByRoot) {
    if (explicitRepoId && existingByRoot.repoId !== explicitRepoId) {
      throw new Error(`canonical root is already registered as repoId "${existingByRoot.repoId}"`);
    }
    const repo = {
      ...existingByRoot,
      displayName,
      state: "enabled" as const,
      ...(input.authorityManifestPath ? { authorityManifestPath: canonicalAuthorityManifestPath(input.authorityManifestPath) } : {})
    };
    const next = replaceRepo(registry, repo);
    const changed = !daemonRepoEquals(existingByRoot, repo);
    return { registry: next, repo, changed };
  }

  const repoId = explicitRepoId ?? generateRepoId(displayName, canonicalRoot, registry.repos);
  const conflictingRepo = registry.repos.find((repo) => repo.repoId === repoId);
  if (conflictingRepo) {
    throw new Error(`repoId "${repoId}" is already registered for ${conflictingRepo.canonicalRoot}`);
  }

  const repo: DaemonRegistryRepo = {
    repoId,
    canonicalRoot,
    displayName,
    state: "enabled",
    registeredAt: (input.now ?? (() => new Date()))().toISOString(),
    ...(input.authorityManifestPath ? { authorityManifestPath: canonicalAuthorityManifestPath(input.authorityManifestPath) } : {})
  };
  const next = sortDaemonRegistry({ ...registry, repos: [...registry.repos, repo] });
  return { registry: next, repo, changed: true };
}

export function unregisterDaemonRepo(repoId: string, options: DaemonRegistryOptions = {}): DaemonRegistryMutationResult {
  const paths = daemonRegistryPaths(options);
  const mutation = withDaemonRegistryMutationLock(options, () => {
    const registry = readDaemonRegistry(options);
    const normalizedRepoId = normalizeExplicitRepoId(repoId);
    const existing = registry.repos.find((repo) => repo.repoId === normalizedRepoId);
    if (!existing) throw new Error(`repoId "${normalizedRepoId}" is not registered`);
    const repo = { ...existing, state: "disabled" as const };
    const next = replaceRepo(registry, repo);
    const changed = !daemonRepoEquals(existing, repo);
    if (changed) writeDaemonRegistry(next, options);
    return { registry: next, repo, changed };
  });
  const { registry, repo, changed } = mutation;
  const warnings = removeConvenienceLink(repo, options);
  return { registry, repo, registryPath: paths.registryPath, changed, warnings };
}

export function resolveDaemonRepoByRoot(rootDir: string, options: DaemonRegistryOptions = {}): DaemonRegistryRepo | undefined {
  const canonicalRoot = canonicalHarnessRoot(rootDir);
  return readDaemonRegistry(options).repos.find((repo) => repo.canonicalRoot === canonicalRoot);
}

function emptyDaemonRegistry(): DaemonRegistry {
  return { schema: daemonRegistrySchema, repos: [] };
}

function decodeDaemonRegistry(value: unknown, source: string): DaemonRegistry {
  if (!isDaemonRegistryRecord(value) || value.schema !== daemonRegistrySchema || !Array.isArray(value.repos)) {
    throw new Error(`invalid daemon registry at ${source}`);
  }
  const machineId = value.machineId === undefined
    ? undefined
    : typeof value.machineId === "string" && value.machineId.length > 0 ? value.machineId : null;
  const daemonGeneration = value.daemonGeneration === undefined
    ? undefined
    : typeof value.daemonGeneration === "number" && Number.isSafeInteger(value.daemonGeneration) && value.daemonGeneration > 0
      ? value.daemonGeneration
      : null;
  if (machineId === null || daemonGeneration === null
    || (machineId === undefined) !== (daemonGeneration === undefined)) {
    throw new Error(`invalid daemon registry at ${source}`);
  }
  const repos = value.repos.map((entry) => decodeDaemonRegistryRepo(entry, source));
  if (repos.some((repo) => repo.runtimeRegistrationId !== undefined)
    && (machineId === undefined || daemonGeneration === undefined)) {
    throw new Error(`invalid daemon registry at ${source}`);
  }
  if (daemonGeneration !== undefined
    && repos.some((repo) => repo.daemonGeneration !== undefined && repo.daemonGeneration !== daemonGeneration)) {
    throw new Error(`invalid daemon registry at ${source}`);
  }
  return sortDaemonRegistry({
    schema: daemonRegistrySchema,
    repos,
    ...(machineId ? { machineId } : {}),
    ...(daemonGeneration ? { daemonGeneration } : {})
  });
}

function decodeDaemonRegistryRepo(value: unknown, source: string): DaemonRegistryRepo {
  if (!isDaemonRegistryRecord(value)) throw new Error(`invalid daemon registry repo entry at ${source}`);
  const repoId = typeof value.repoId === "string" ? normalizeExplicitRepoId(value.repoId) : undefined;
  const canonicalRoot = typeof value.canonicalRoot === "string" ? path.resolve(value.canonicalRoot) : undefined;
  const displayName = typeof value.displayName === "string" && value.displayName.length > 0 ? value.displayName : undefined;
  const state = value.state === "enabled" || value.state === "disabled" ? value.state : undefined;
  const registeredAt = typeof value.registeredAt === "string" && value.registeredAt.length > 0 ? value.registeredAt : undefined;
  const authorityManifestPath = value.authorityManifestPath === undefined
    ? undefined
    : typeof value.authorityManifestPath === "string" && path.isAbsolute(value.authorityManifestPath)
      ? value.authorityManifestPath
      : null;
  const runtimeRegistrationId = value.runtimeRegistrationId === undefined
    ? undefined
    : typeof value.runtimeRegistrationId === "string" && isUuid(value.runtimeRegistrationId)
      ? value.runtimeRegistrationId
      : null;
  const daemonGeneration = value.daemonGeneration === undefined
    ? undefined
    : typeof value.daemonGeneration === "number" && Number.isSafeInteger(value.daemonGeneration) && value.daemonGeneration > 0
      ? value.daemonGeneration
      : null;
  if (!repoId || !canonicalRoot || !displayName || !state || !registeredAt || authorityManifestPath === null
    || runtimeRegistrationId === null || daemonGeneration === null
    || (runtimeRegistrationId === undefined) !== (daemonGeneration === undefined)) {
    throw new Error(`invalid daemon registry repo entry at ${source}`);
  }
  return {
    repoId,
    canonicalRoot,
    displayName,
    state,
    registeredAt,
    ...(authorityManifestPath ? { authorityManifestPath } : {}),
    ...(runtimeRegistrationId ? { runtimeRegistrationId } : {}),
    ...(daemonGeneration ? { daemonGeneration } : {})
  };
}

function canonicalAuthorityManifestPath(manifestPath: string): string {
  const absolute = path.resolve(manifestPath);
  if (!existsSync(absolute)) throw new Error(`authority manifest is missing: ${absolute}`);
  return realpathSync.native(absolute);
}

function writeDaemonRegistry(registry: DaemonRegistry, options: DaemonRegistryOptions): void {
  const { userRoot, registryPath } = daemonRegistryPaths(options);
  mkdirSync(userRoot, { recursive: true });
  const tempPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(sortDaemonRegistry(registry), null, 2)}\n`, "utf8");
  renameSync(tempPath, registryPath);
}

function canonicalHarnessRoot(rootDir: string): string {
  const realRoot = existsSync(path.resolve(rootDir)) ? realpathSync.native(path.resolve(rootDir)) : invalidCanonicalRoot(rootDir);
  const layout = resolveHarnessLayout(realRoot);
  if (!layout.configPath || !existsSync(layout.configPath)) {
    throw new Error(`canonicalRoot must be an initialized harness repository: ${rootDir}`);
  }
  return realpathSync.native(layout.rootDir);
}

function generateRepoId(displayName: string, canonicalRoot: string, repos: ReadonlyArray<DaemonRegistryRepo>): string {
  const base = safeRepoId(displayName);
  if (!repos.some((repo) => repo.repoId === base)) return base;
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

function safeRepoId(value: string): string {
  const sanitized = value.toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
  const prefixed = /^[a-z]/u.test(sanitized) ? sanitized : `repo-${sanitized}`;
  return prefixed.slice(0, 63).replace(/-+$/gu, "") || "repo";
}

function sortDaemonRegistry(registry: DaemonRegistry): DaemonRegistry {
  return {
    schema: daemonRegistrySchema,
    ...(registry.machineId !== undefined ? { machineId: registry.machineId } : {}),
    ...(registry.daemonGeneration !== undefined ? { daemonGeneration: registry.daemonGeneration } : {}),
    repos: [...registry.repos].sort((left, right) =>
      left.repoId.localeCompare(right.repoId) || left.canonicalRoot.localeCompare(right.canonicalRoot))
  };
}

function replaceRepo(registry: DaemonRegistry, replacement: DaemonRegistryRepo): DaemonRegistry {
  return sortDaemonRegistry({
    ...registry,
    repos: registry.repos.map((repo) => repo.repoId === replacement.repoId ? replacement : repo)
  });
}

function withDaemonRegistryMutationLock<T>(options: DaemonRegistryOptions, mutate: () => T): T {
  const { userRoot, registryPath } = daemonRegistryPaths(options);
  const lockPath = `${registryPath}.lock`;
  const staleMs = options.mutationLockStaleMs ?? 30_000;
  const ownerToken = randomBytes(12).toString("hex");
  mkdirSync(userRoot, { recursive: true });
  const deadline = Date.now() + 5_000;
  while (true) {
    if (Date.now() >= deadline) throw new Error(`timed out acquiring daemon registry mutation lock: ${lockPath}`);
    try {
      mkdirSync(lockPath);
      if (createDaemonRegistryMutationLockRecord(lockPath, ownerToken)) break;
    } catch (error) {
      if (!isExclusiveCreateConflict(error, options.platform)) throw error;
      if (registryLockIsStale(lockPath, staleMs)) {
        try {
          rmSync(lockPath, { recursive: true });
        } catch {
          // Another contender recovered or replaced the stale lock.
        }
        continue;
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try {
    return mutate();
  } finally {
    releaseDaemonRegistryMutationLock(lockPath, ownerToken);
  }
}

function createDaemonRegistryMutationLockRecord(lockPath: string, ownerToken: string): boolean {
  const record = {
    schema: "daemon-registry-mutation-lock/v1",
    ownerToken
  } satisfies DaemonRegistryMutationLockRecord;
  try {
    // Acquisition completes at the exclusive record write; stale recovery may replace the directory after mkdir.
    writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "EEXIST" || code === "ENOENT") return false;
    throw error;
  }
}

function releaseDaemonRegistryMutationLock(lockPath: string, ownerToken: string): void {
  const record = readDaemonRegistryMutationLockRecord(lockPath);
  // Missing, unreadable, or replaced records cannot prove ownership and are left to stale recovery.
  if (record?.ownerToken === ownerToken) rmSync(lockPath, { recursive: true, force: true });
}

function readDaemonRegistryMutationLockRecord(lockPath: string): DaemonRegistryMutationLockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8")) as unknown;
    return isDaemonRegistryRecord(parsed)
      && parsed.schema === "daemon-registry-mutation-lock/v1"
      && typeof parsed.ownerToken === "string"
      ? { schema: "daemon-registry-mutation-lock/v1", ownerToken: parsed.ownerToken }
      : null;
  } catch {
    return null;
  }
}

function registryLockIsStale(lockPath: string, staleMs: number): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function syncConvenienceLink(repo: DaemonRegistryRepo, options: DaemonRegistryOptions): ReadonlyArray<string> {
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

function removeConvenienceLink(repo: DaemonRegistryRepo, options: DaemonRegistryOptions): ReadonlyArray<string> {
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
  return left.repoId === right.repoId
    && left.canonicalRoot === right.canonicalRoot
    && left.displayName === right.displayName
    && left.state === right.state
    && left.registeredAt === right.registeredAt
    && left.authorityManifestPath === right.authorityManifestPath
    && left.runtimeRegistrationId === right.runtimeRegistrationId
    && left.daemonGeneration === right.daemonGeneration;
}

function isDaemonRegistryRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidCanonicalRoot(rootDir: string): never {
  throw new Error(`canonicalRoot must be an initialized harness repository: ${rootDir}`);
}
