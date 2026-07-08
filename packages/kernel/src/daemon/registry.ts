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
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHarnessLayout } from "../layout/index.ts";

export const daemonRegistrySchema = "harness-daemon-registry/v1";

export type DaemonRepoState = "enabled" | "disabled";

export interface DaemonRegistryRepo {
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly displayName: string;
  readonly state: DaemonRepoState;
  readonly registeredAt: string;
}

export interface DaemonRegistry {
  readonly schema: typeof daemonRegistrySchema;
  readonly repos: ReadonlyArray<DaemonRegistryRepo>;
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
  readonly canonicalRoot: string;
  readonly repoId?: string;
  readonly displayName?: string;
}

export interface DaemonRegistryMutationResult {
  readonly registry: DaemonRegistry;
  readonly repo: DaemonRegistryRepo;
  readonly registryPath: string;
  readonly changed: boolean;
  readonly warnings: ReadonlyArray<string>;
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
  const registry = readDaemonRegistry(input);
  const canonicalRoot = canonicalHarnessRoot(input.canonicalRoot);
  const displayName = input.displayName ?? path.basename(canonicalRoot);
  const explicitRepoId = input.repoId ? normalizeExplicitRepoId(input.repoId) : undefined;
  const existingByRoot = registry.repos.find((repo) => repo.canonicalRoot === canonicalRoot);
  const warnings: Array<string> = [];

  if (existingByRoot) {
    if (explicitRepoId && existingByRoot.repoId !== explicitRepoId) {
      throw new Error(`canonical root is already registered as repoId "${existingByRoot.repoId}"`);
    }
    const repo = {
      ...existingByRoot,
      displayName,
      state: "enabled" as const
    };
    const next = replaceRepo(registry, repo);
    const changed = !daemonRepoEquals(existingByRoot, repo);
    if (changed) writeDaemonRegistry(next, input);
    warnings.push(...syncConvenienceLink(repo, input));
    return { registry: next, repo, registryPath: paths.registryPath, changed, warnings };
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
    registeredAt: (input.now ?? (() => new Date()))().toISOString()
  };
  const next = sortDaemonRegistry({ schema: daemonRegistrySchema, repos: [...registry.repos, repo] });
  writeDaemonRegistry(next, input);
  warnings.push(...syncConvenienceLink(repo, input));
  return { registry: next, repo, registryPath: paths.registryPath, changed: true, warnings };
}

export function unregisterDaemonRepo(repoId: string, options: DaemonRegistryOptions = {}): DaemonRegistryMutationResult {
  const paths = daemonRegistryPaths(options);
  const registry = readDaemonRegistry(options);
  const normalizedRepoId = normalizeExplicitRepoId(repoId);
  const existing = registry.repos.find((repo) => repo.repoId === normalizedRepoId);
  if (!existing) throw new Error(`repoId "${normalizedRepoId}" is not registered`);
  const repo = { ...existing, state: "disabled" as const };
  const next = replaceRepo(registry, repo);
  const changed = !daemonRepoEquals(existing, repo);
  if (changed) writeDaemonRegistry(next, options);
  const warnings = removeConvenienceLink(repo, options);
  return { registry: next, repo, registryPath: paths.registryPath, changed, warnings };
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
  return sortDaemonRegistry({
    schema: daemonRegistrySchema,
    repos: value.repos.map((entry) => decodeDaemonRegistryRepo(entry, source))
  });
}

function decodeDaemonRegistryRepo(value: unknown, source: string): DaemonRegistryRepo {
  if (!isDaemonRegistryRecord(value)) throw new Error(`invalid daemon registry repo entry at ${source}`);
  const repoId = typeof value.repoId === "string" ? normalizeExplicitRepoId(value.repoId) : undefined;
  const canonicalRoot = typeof value.canonicalRoot === "string" ? path.resolve(value.canonicalRoot) : undefined;
  const displayName = typeof value.displayName === "string" && value.displayName.length > 0 ? value.displayName : undefined;
  const state = value.state === "enabled" || value.state === "disabled" ? value.state : undefined;
  const registeredAt = typeof value.registeredAt === "string" && value.registeredAt.length > 0 ? value.registeredAt : undefined;
  if (!repoId || !canonicalRoot || !displayName || !state || !registeredAt) {
    throw new Error(`invalid daemon registry repo entry at ${source}`);
  }
  return { repoId, canonicalRoot, displayName, state, registeredAt };
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
    repos: [...registry.repos].sort((left, right) =>
      left.repoId.localeCompare(right.repoId) || left.canonicalRoot.localeCompare(right.canonicalRoot))
  };
}

function replaceRepo(registry: DaemonRegistry, replacement: DaemonRegistryRepo): DaemonRegistry {
  return sortDaemonRegistry({
    schema: daemonRegistrySchema,
    repos: registry.repos.map((repo) => repo.repoId === replacement.repoId ? replacement : repo)
  });
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
    && left.registeredAt === right.registeredAt;
}

function isDaemonRegistryRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidCanonicalRoot(rootDir: string): never {
  throw new Error(`canonicalRoot must be an initialized harness repository: ${rootDir}`);
}
