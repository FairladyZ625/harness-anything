import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { calculateDaemonArtifactIdentity } from "@harness-anything/daemon";

export const daemonSnapshotManifestSchema = "daemon-snapshot-manifest/v1";

export interface DaemonSnapshotManifest {
  readonly schema: typeof daemonSnapshotManifestSchema;
  readonly version: string;
  readonly sourceRef: string;
  readonly sourceCommit: string;
  readonly sourceDirty: boolean;
  readonly sourceFingerprint: string;
  readonly builtAt: string;
  readonly entrypoint: string;
  readonly contentFingerprint: string;
  readonly artifactFileCount: number;
  readonly runtimePackages: ReadonlyArray<string>;
}

export interface InstalledDaemonSnapshot {
  readonly snapshotDir: string;
  readonly entrypoint: string;
  readonly manifestPath: string;
  readonly manifest: DaemonSnapshotManifest;
  readonly installed: boolean;
}

export interface DaemonSnapshotInstallInput {
  readonly sourceEntrypoint: string;
  readonly userRoot: string;
  readonly ref?: string;
  readonly version?: string;
  readonly now?: () => Date;
}

const workspaceRuntimePackages = [
  "packages/cli",
  "packages/kernel",
  "packages/application",
  "packages/api-contracts",
  "packages/daemon",
  "packages/adapters/github-issues",
  "packages/adapters/local",
  "packages/adapters/multica"
] as const;

export function installDaemonSnapshot(input: DaemonSnapshotInstallInput): InstalledDaemonSnapshot {
  const source = resolveSnapshotSource(input.sourceEntrypoint);
  const sourceRef = input.ref ?? "HEAD";
  if (source.kind === "installed" && input.ref !== undefined && input.ref !== "HEAD") {
    throw new Error("--ref requires a Git source checkout; an installed npm CLI can snapshot only its current release.");
  }
  const sourceCommit = source.kind === "repository"
    ? snapshotGitOutput(source.root, ["rev-parse", `${sourceRef}^{commit}`])
    : installedSourceCommit(source.distRoot);
  const sourceDirty = source.kind === "repository" && input.ref === undefined
    ? snapshotGitOutput(source.root, ["status", "--porcelain"]).length > 0
    : false;
  const sourceFingerprint = sourceDirty
    ? calculateDaemonArtifactIdentity(input.sourceEntrypoint).identity
    : sourceCommit;
  const version = validatedSnapshotVersion(input.version ?? defaultSnapshotVersion(sourceCommit, sourceDirty, sourceFingerprint));
  const snapshotsRoot = path.join(path.resolve(input.userRoot), "daemon-snapshots");
  const snapshotDir = path.join(snapshotsRoot, version);
  const manifestPath = path.join(snapshotDir, "manifest.json");
  const existing = readExistingManifest(manifestPath);
  if (existing) {
    if (existing.sourceCommit !== sourceCommit
      || existing.sourceDirty !== sourceDirty
      || existing.sourceFingerprint !== sourceFingerprint) {
      throw new Error(`daemon snapshot version already belongs to different source bytes: ${version}`);
    }
    const entrypoint = path.join(snapshotDir, ...existing.entrypoint.split("/"));
    const identity = calculateDaemonArtifactIdentity(entrypoint);
    if (identity.identity !== existing.contentFingerprint) {
      throw new Error(`daemon snapshot content fingerprint mismatch: ${snapshotDir}`);
    }
    return { snapshotDir, entrypoint, manifestPath, manifest: existing, installed: false };
  }

  mkdirSync(snapshotsRoot, { recursive: true });
  const staging = mkdtempSync(path.join(snapshotsRoot, `.${version}.`));
  let buildRoot: string | undefined;
  try {
    const build: { readonly distRoot: string; readonly buildRoot?: string } = source.kind === "repository"
      ? buildRepositoryRef(source.root, sourceRef, input.ref === undefined)
      : { distRoot: source.distRoot };
    buildRoot = build.buildRoot;
    cpSync(build.distRoot, path.join(staging, "dist"), { recursive: true, errorOnExist: true });
    const runtimePackages = copyRuntimeDependencyClosure(source.dependencyRoot, staging);
    const entrypoint = path.join(staging, "dist", "cli", "src", "index.js");
    if (!existsSync(entrypoint)) throw new Error(`built daemon entrypoint is missing: ${entrypoint}`);
    const identity = calculateDaemonArtifactIdentity(entrypoint);
    const manifest: DaemonSnapshotManifest = {
      schema: daemonSnapshotManifestSchema,
      version,
      sourceRef,
      sourceCommit,
      sourceDirty,
      sourceFingerprint,
      builtAt: (input.now ?? (() => new Date()))().toISOString(),
      entrypoint: "dist/cli/src/index.js",
      contentFingerprint: identity.identity,
      artifactFileCount: identity.fileCount,
      runtimePackages
    };
    writeFileSync(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(staging, snapshotDir);
    return {
      snapshotDir,
      entrypoint: path.join(snapshotDir, "dist", "cli", "src", "index.js"),
      manifestPath,
      manifest,
      installed: true
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (buildRoot) removeBuildWorktree(source, buildRoot);
  }
}

type SnapshotSource =
  | { readonly kind: "repository"; readonly root: string; readonly dependencyRoot: string }
  | { readonly kind: "installed"; readonly distRoot: string; readonly dependencyRoot: string };

function resolveSnapshotSource(sourceEntrypoint: string): SnapshotSource {
  const resolved = realpathSync(sourceEntrypoint);
  let current = path.dirname(resolved);
  while (true) {
    if (existsSync(path.join(current, ".git")) && existsSync(path.join(current, "packages", "cli", "tsconfig.build.json"))) {
      return { kind: "repository", root: current, dependencyRoot: current };
    }
    if (path.basename(current) === "dist") {
      const packageRoot = path.dirname(current);
      return { kind: "installed", distRoot: current, dependencyRoot: packageRoot };
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`cannot resolve daemon snapshot source from ${sourceEntrypoint}`);
    current = parent;
  }
}

function buildRepositoryRef(
  repositoryRoot: string,
  sourceRef: string,
  useCurrentCheckout: boolean
): { readonly distRoot: string; readonly buildRoot?: string } {
  if (useCurrentCheckout) {
    execFileSync("npm", ["run", "build", "-w", "@harness-anything/cli"], {
      cwd: repositoryRoot,
      stdio: ["ignore", "ignore", "inherit"],
      windowsHide: true
    });
    return { distRoot: path.join(repositoryRoot, "packages", "cli", "dist") };
  }
  const buildRoot = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-snapshot-build-"));
  rmSync(buildRoot, { recursive: true, force: true });
  try {
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", buildRoot, sourceRef], {
      cwd: repositoryRoot,
      stdio: "ignore",
      windowsHide: true
    });
    symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(buildRoot, "node_modules"), "dir");
    execFileSync("npm", ["run", "build", "-w", "@harness-anything/cli"], {
      cwd: buildRoot,
      stdio: ["ignore", "ignore", "inherit"],
      windowsHide: true
    });
    return { distRoot: path.join(buildRoot, "packages", "cli", "dist"), buildRoot };
  } catch (error) {
    removeRepositoryBuildWorktree(repositoryRoot, buildRoot);
    throw error;
  }
}

function removeBuildWorktree(source: SnapshotSource, buildRoot: string): void {
  if (source.kind !== "repository") return;
  removeRepositoryBuildWorktree(source.root, buildRoot);
}

function removeRepositoryBuildWorktree(repositoryRoot: string, buildRoot: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", buildRoot], {
      cwd: repositoryRoot,
      stdio: "ignore",
      windowsHide: true
    });
  } catch {
    rmSync(buildRoot, { recursive: true, force: true });
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: repositoryRoot, stdio: "ignore", windowsHide: true });
    } catch {
      // The primary install error is more useful than best-effort worktree cleanup failure.
    }
  }
}

function copyRuntimeDependencyClosure(dependencyRoot: string, staging: string): ReadonlyArray<string> {
  const packageNames = new Set<string>();
  const pending = externalWorkspaceDependencies(dependencyRoot).map((name) => ({ name, optional: false }));
  while (pending.length > 0) {
    const { name: packageName, optional } = pending.pop()!;
    if (packageNames.has(packageName) || packageName.startsWith("@harness-anything/")) continue;
    let packageDir: string;
    try {
      packageDir = resolveDependencyPackage(dependencyRoot, packageName);
    } catch (error) {
      if (optional) continue;
      throw error;
    }
    packageNames.add(packageName);
    const packageJson = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
      readonly dependencies?: Record<string, string>;
      readonly optionalDependencies?: Record<string, string>;
    };
    pending.push(
      ...Object.keys(packageJson.dependencies ?? {}).map((name) => ({ name, optional: false })),
      ...Object.keys(packageJson.optionalDependencies ?? {}).map((name) => ({ name, optional: true }))
    );
  }
  for (const packageName of [...packageNames].sort()) {
    const source = resolveDependencyPackage(dependencyRoot, packageName);
    const destination = path.join(staging, "node_modules", ...packageName.split("/"));
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, dereference: true, errorOnExist: true });
  }
  return [...packageNames].sort();
}

function externalWorkspaceDependencies(repositoryRoot: string): string[] {
  const dependencies = new Set<string>();
  const installedPackagePath = path.join(repositoryRoot, "package.json");
  if (existsSync(installedPackagePath) && !existsSync(path.join(repositoryRoot, "packages"))) {
    addPackageDependencies(installedPackagePath, dependencies);
  }
  for (const relativeRoot of workspaceRuntimePackages) {
    const packagePath = path.join(repositoryRoot, ...relativeRoot.split("/"), "package.json");
    if (!existsSync(packagePath)) continue;
    addPackageDependencies(packagePath, dependencies);
  }
  dependencies.add("node-pty");
  return [...dependencies];
}

function addPackageDependencies(packagePath: string, dependencies: Set<string>): void {
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
    readonly dependencies?: Record<string, string>;
    readonly optionalDependencies?: Record<string, string>;
  };
  for (const name of [...Object.keys(packageJson.dependencies ?? {}), ...Object.keys(packageJson.optionalDependencies ?? {})]) {
    if (!name.startsWith("@harness-anything/")) dependencies.add(name);
  }
}

function resolveDependencyPackage(dependencyRoot: string, packageName: string): string {
  let current = dependencyRoot;
  while (true) {
    const candidate = path.join(current, "node_modules", ...packageName.split("/"));
    if (existsSync(path.join(candidate, "package.json"))) {
      return lstatSync(candidate).isSymbolicLink() ? realpathSync(candidate) : candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`runtime dependency is not installed: ${packageName}`);
    current = parent;
  }
}

function readExistingManifest(manifestPath: string): DaemonSnapshotManifest | undefined {
  if (!existsSync(manifestPath)) return undefined;
  const value = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<DaemonSnapshotManifest>;
  if (value.schema !== daemonSnapshotManifestSchema
    || typeof value.version !== "string"
    || typeof value.sourceRef !== "string"
    || typeof value.sourceCommit !== "string"
    || typeof value.sourceDirty !== "boolean"
    || typeof value.sourceFingerprint !== "string"
    || typeof value.builtAt !== "string"
    || typeof value.entrypoint !== "string"
    || typeof value.contentFingerprint !== "string"
    || typeof value.artifactFileCount !== "number"
    || !Array.isArray(value.runtimePackages)
    || !value.runtimePackages.every((entry) => typeof entry === "string")) {
    throw new Error(`invalid daemon snapshot manifest: ${manifestPath}`);
  }
  return value as DaemonSnapshotManifest;
}

function installedSourceCommit(distRoot: string): string {
  return calculateDaemonArtifactIdentity(path.join(distRoot, "cli", "src", "index.js"))
    .identity
    .replace("sha256:", "");
}

function defaultSnapshotVersion(sourceCommit: string, dirty: boolean, sourceFingerprint: string): string {
  return `${sourceCommit.slice(0, 12)}${dirty ? `-dirty-${sourceFingerprint.replace("sha256:", "").slice(0, 12)}` : ""}`;
}

function validatedSnapshotVersion(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error("snapshot version must use 1-128 letters, digits, dots, underscores, or hyphens");
  }
  return value;
}

function snapshotGitOutput(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", windowsHide: true }).trim();
}
