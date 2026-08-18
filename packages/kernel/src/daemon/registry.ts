import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { consumeKnownError } from "../error-consumption.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { makeLocalVersionControlSystem, resolveLedgerGitLayout } from "../composition/index.ts";

export const daemonRegistrySchema = "harness-daemon-registry/v1";

export type DaemonRepoState = "enabled" | "disabled";
export const daemonRepoModes = Object.freeze(["local", "remote-center", "remote-edge"] as const);
export type DaemonRepoMode = (typeof daemonRepoModes)[number];

export interface DaemonRegistryRepo { readonly repoId: string; readonly canonicalRoot: string; readonly displayName: string; readonly authoredBranch: string; readonly mode: DaemonRepoMode; readonly state: DaemonRepoState; readonly registeredAt: string }
export interface InvalidDaemonRegistryRepo { readonly entryIndex: number; readonly repoId?: string; readonly canonicalRoot?: string; readonly displayName?: string; readonly authoredBranch?: string; readonly mode?: DaemonRepoMode; readonly state?: DaemonRepoState; readonly registeredAt?: string; readonly error: string; readonly raw: unknown }
export interface DaemonRegistry { readonly schema: typeof daemonRegistrySchema; readonly repos: ReadonlyArray<DaemonRegistryRepo>; readonly invalidRepos: ReadonlyArray<InvalidDaemonRegistryRepo> }

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
  readonly canonicalRoot: string;
  readonly repoId?: string;
  readonly displayName?: string;
  readonly mode?: DaemonRepoMode;
}

export interface DaemonRegistryMutationResult<TRepo = DaemonRegistryRepo> { readonly registry: DaemonRegistry; readonly repo: TRepo; readonly registryPath: string; readonly changed: boolean; readonly warnings: ReadonlyArray<string> }

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

export function registerDaemonRepo(input: DaemonRegistryRegisterInput): DaemonRegistryMutationResult<DaemonRegistryRepo> {
  const paths = daemonRegistryPaths(input);
  const registry = readDaemonRegistry(input);
  const canonicalRoot = canonicalHarnessRoot(input.canonicalRoot);
  const displayName = input.displayName ?? path.basename(canonicalRoot);
  const requestedMode = input.mode === undefined ? undefined : normalizeRepoMode(input.mode);
  const explicitRepoId = input.repoId ? normalizeExplicitRepoId(input.repoId) : undefined;
  const existingByRoot = registry.repos.find((repo) => repo.canonicalRoot === canonicalRoot);
  const invalidByRoot = registry.invalidRepos.find((repo) => repo.canonicalRoot === canonicalRoot);
  const warnings: Array<string> = [];

  if (invalidByRoot) throw new Error(`canonical root has an invalid daemon registry entry${invalidByRoot.repoId ? ` for repoId "${invalidByRoot.repoId}"` : ""}; unregister it before registering the root again`);

  if (existingByRoot) {
    if (explicitRepoId && existingByRoot.repoId !== explicitRepoId) {
      throw new Error(`canonical root is already registered as repoId "${existingByRoot.repoId}"`);
    }
    const repo = {
      ...existingByRoot,
      displayName,
      mode: requestedMode ?? existingByRoot.mode,
      state: "enabled" as const
    };
    const next = replaceRepo(registry, repo);
    const changed = !daemonRepoEquals(existingByRoot, repo);
    if (changed) writeDaemonRegistry(next, input);
    warnings.push(...syncConvenienceLink(repo, input));
    return { registry: next, repo, registryPath: paths.registryPath, changed, warnings };
  }

  const reservedRepoIds = [...registry.repos.map(({ repoId }) => repoId), ...registry.invalidRepos.flatMap(({ repoId }) => repoId ? [repoId] : [])];
  const repoId = explicitRepoId ?? generateRepoId(displayName, canonicalRoot, reservedRepoIds);
  const conflictingRepo = registry.repos.find((repo) => repo.repoId === repoId && repo.state === "enabled");
  if (conflictingRepo) {
    throw new Error(`repoId "${repoId}" is already registered for ${conflictingRepo.canonicalRoot}`);
  }
  if (registry.invalidRepos.some((repo) => repo.repoId === repoId && repo.state !== "disabled")) throw new Error(`repoId "${repoId}" has an invalid daemon registry entry; unregister it before reusing the id`);

  const repo: DaemonRegistryRepo = {
    repoId,
    canonicalRoot,
    displayName,
    authoredBranch: defaultAuthoredBranch(canonicalRoot),
    mode: requestedMode ?? "local",
    state: "enabled",
    registeredAt: (input.now ?? (() => new Date()))().toISOString()
  };
  const next = sortDaemonRegistry({ ...registry, repos: [...registry.repos.filter((existing) => existing.repoId !== repoId), repo], invalidRepos: registry.invalidRepos.filter((existing) => existing.repoId !== repoId) });
  writeDaemonRegistry(next, input);
  warnings.push(...syncConvenienceLink(repo, input));
  return { registry: next, repo, registryPath: paths.registryPath, changed: true, warnings };
}

export function unregisterDaemonRepo(repoId: string, options: DaemonRegistryOptions = {}): DaemonRegistryMutationResult<DaemonRegistryRepo | InvalidDaemonRegistryRepo> {
  const paths = daemonRegistryPaths(options);
  const registry = readDaemonRegistry(options);
  const normalizedRepoId = normalizeExplicitRepoId(repoId);
  const existing = registry.repos.find((repo) => repo.repoId === normalizedRepoId);
  const invalid = registry.invalidRepos.find((repo) => repo.repoId === normalizedRepoId);
  if (!existing && !invalid) throw new Error(`repoId "${normalizedRepoId}" is not registered`);
  if (invalid) {
    const raw = isDaemonRegistryRecord(invalid.raw) ? { ...invalid.raw, state: "disabled" } : invalid.raw, repo = { ...invalid, state: "disabled" as const, raw }, next = replaceInvalidRepo(registry, repo), changed = invalid.state !== "disabled";
    if (changed) writeDaemonRegistry(next, options);
    const warnings = invalid.canonicalRoot ? removeConvenienceLink({ repoId: normalizedRepoId, canonicalRoot: invalid.canonicalRoot }, options) : [];
    return { registry: next, repo, registryPath: paths.registryPath, changed, warnings };
  }
  const valid = existing!;
  const repo = { ...valid, state: "disabled" as const };
  const next = replaceRepo(registry, repo);
  const changed = !daemonRepoEquals(valid, repo);
  if (changed) writeDaemonRegistry(next, options);
  const warnings = removeConvenienceLink(repo, options);
  return { registry: next, repo, registryPath: paths.registryPath, changed, warnings };
}

export function resolveDaemonRepoByRoot(rootDir: string, options: DaemonRegistryOptions = {}): DaemonRegistryRepo | undefined {
  const canonicalRoot = canonicalHarnessRoot(rootDir);
  return readDaemonRegistry(options).repos.find((repo) => repo.canonicalRoot === canonicalRoot);
}

function emptyDaemonRegistry(): DaemonRegistry {
  return { schema: daemonRegistrySchema, repos: [], invalidRepos: [] };
}

function decodeDaemonRegistry(value: unknown, source: string): DaemonRegistry {
  if (!isDaemonRegistryRecord(value) || value.schema !== daemonRegistrySchema || !Array.isArray(value.repos)) {
    throw new Error(`invalid daemon registry at ${source}`);
  }
  const repos: DaemonRegistryRepo[] = [], invalidRepos: InvalidDaemonRegistryRepo[] = []; value.repos.forEach((entry, entryIndex) => { try { repos.push(decodeDaemonRegistryRepo(entry, source)); } catch (error) { consumeKnownError(error); invalidRepos.push(invalidDaemonRegistryRepo(entry, entryIndex, error instanceof Error ? error.message : String(error))); } });
  return sortDaemonRegistry({ schema: daemonRegistrySchema, repos, invalidRepos });
}

function decodeDaemonRegistryRepo(value: unknown, source: string): DaemonRegistryRepo {
  if (!isDaemonRegistryRecord(value)) throw new Error(`invalid daemon registry repo entry at ${source}`);
  const repoId = typeof value.repoId === "string" ? normalizeExplicitRepoId(value.repoId) : undefined;
  const canonicalRoot = typeof value.canonicalRoot === "string" ? path.resolve(value.canonicalRoot) : undefined;
  const displayName = typeof value.displayName === "string" && value.displayName.length > 0 ? value.displayName : undefined;
  const authoredBranch = typeof value.authoredBranch === "string" && validBranch(value.authoredBranch) ? value.authoredBranch : undefined;
  const mode = value.mode === undefined ? "local" : daemonRepoModes.includes(value.mode as DaemonRepoMode) ? value.mode as DaemonRepoMode : undefined;
  const state = value.state === "enabled" || value.state === "disabled" ? value.state : undefined;
  const registeredAt = typeof value.registeredAt === "string" && value.registeredAt.length > 0 ? value.registeredAt : undefined;
  const invalid = [["repoId", repoId], ["canonicalRoot", canonicalRoot], ["displayName", displayName], ["authoredBranch", authoredBranch], ["mode", mode], ["state", state], ["registeredAt", registeredAt]].filter(([, item]) => !item).map(([field]) => field);
  if (invalid.length) throw new Error(`invalid daemon registry repo entry at ${source}: missing or invalid ${invalid.join(", ")}`);
  return { repoId: repoId!, canonicalRoot: canonicalRoot!, displayName: displayName!, authoredBranch: authoredBranch!, mode: mode!, state: state!, registeredAt: registeredAt! };
}

function invalidDaemonRegistryRepo(value: unknown, entryIndex: number, error: string): InvalidDaemonRegistryRepo {
  if (!isDaemonRegistryRecord(value)) return { entryIndex, error, raw: value };
  let repoId: string | undefined; if (typeof value.repoId === "string") try { repoId = normalizeExplicitRepoId(value.repoId); } catch (cause) { consumeKnownError(cause); repoId = undefined; }
  const canonicalRoot = typeof value.canonicalRoot === "string" ? path.resolve(value.canonicalRoot) : undefined, displayName = typeof value.displayName === "string" && value.displayName.length > 0 ? value.displayName : undefined, authoredBranch = typeof value.authoredBranch === "string" && validBranch(value.authoredBranch) ? value.authoredBranch : undefined, mode = daemonRepoModes.includes(value.mode as DaemonRepoMode) ? value.mode as DaemonRepoMode : undefined, state = value.state === "enabled" || value.state === "disabled" ? value.state : undefined, registeredAt = typeof value.registeredAt === "string" && value.registeredAt.length > 0 ? value.registeredAt : undefined;
  return { entryIndex, ...(repoId ? { repoId } : {}), ...(canonicalRoot ? { canonicalRoot } : {}), ...(displayName ? { displayName } : {}), ...(authoredBranch ? { authoredBranch } : {}), ...(mode ? { mode } : {}), ...(state ? { state } : {}), ...(registeredAt ? { registeredAt } : {}), error, raw: value };
}

function writeDaemonRegistry(registry: DaemonRegistry, options: DaemonRegistryOptions): void {
  const { userRoot, registryPath } = daemonRegistryPaths(options);
  mkdirSync(userRoot, { recursive: true });
  const tempPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  const sorted = sortDaemonRegistry(registry), persisted = { schema: sorted.schema, repos: [...sorted.repos, ...sorted.invalidRepos.map(({ raw }) => raw)].sort(compareRegistryEntries) };
  writeFileSync(tempPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
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
    repos: [...registry.repos].sort((left, right) =>
      left.repoId.localeCompare(right.repoId) || left.canonicalRoot.localeCompare(right.canonicalRoot)),
    invalidRepos: [...registry.invalidRepos].sort((left, right) => left.entryIndex - right.entryIndex)
  };
}

function compareRegistryEntries(left: unknown, right: unknown): number {
  const key = (entry: unknown) => isDaemonRegistryRecord(entry) && typeof entry.repoId === "string" ? entry.repoId : "~";
  return key(left).localeCompare(key(right));
}

function replaceRepo(registry: DaemonRegistry, replacement: DaemonRegistryRepo): DaemonRegistry {
  return sortDaemonRegistry({
    ...registry,
    repos: registry.repos.map((repo) => repo.repoId === replacement.repoId ? replacement : repo)
  });
}

function replaceInvalidRepo(registry: DaemonRegistry, replacement: InvalidDaemonRegistryRepo): DaemonRegistry {
  return sortDaemonRegistry({ ...registry, invalidRepos: registry.invalidRepos.map((repo) => repo.entryIndex === replacement.entryIndex ? replacement : repo) });
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

function removeConvenienceLink(repo: Pick<DaemonRegistryRepo, "repoId" | "canonicalRoot">, options: DaemonRegistryOptions): ReadonlyArray<string> {
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
    && left.authoredBranch === right.authoredBranch
    && left.mode === right.mode
    && left.state === right.state
    && left.registeredAt === right.registeredAt;
}

function defaultAuthoredBranch(canonicalRoot: string): string { const vcs = makeLocalVersionControlSystem(), repoRoot = resolveLedgerGitLayout(canonicalRoot).rootDir, branch = vcs.originHeadBranch(repoRoot) ?? vcs.currentBranch(repoRoot); if (!branch || !validBranch(branch)) throw new Error(`canonicalRoot must have an attached default Git branch: ${repoRoot}`); return branch; }
function validBranch(value: string): boolean { return value.length > 0 && !value.startsWith("-") && !value.includes("..") && !/[~^:?*[\\\s]/u.test(value) && !value.endsWith("/") && !value.endsWith(".lock"); }

function isDaemonRegistryRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidCanonicalRoot(rootDir: string): never { throw new Error(`canonicalRoot must be an initialized harness repository: ${rootDir}`); }
