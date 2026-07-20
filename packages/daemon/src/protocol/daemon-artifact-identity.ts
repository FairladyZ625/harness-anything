// @slice-activation PLT-Boundary W1 exposes this module through the package root API.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

export interface DaemonArtifactIdentity {
  readonly artifactRoot: string;
  readonly identity: string;
  readonly fileCount: number;
  readonly elapsedMs: number;
}

const compiledArtifactExtensions = new Set([".js", ".json", ".mjs", ".cjs"]);
const sourceArtifactExtensions = new Set([...compiledArtifactExtensions, ".ts", ".mts", ".cts", ".tsx"]);
const sourcePackageRoots = [
  "packages/cli/src",
  "packages/kernel/src",
  "packages/application/src",
  "packages/api-contracts/src",
  "packages/daemon/src",
  "packages/adapters/github-issues/src",
  "packages/adapters/local/src",
  "packages/adapters/multica/src"
] as const;
const identityDomain = Buffer.from("harness-anything/daemon-artifact-identity/v2\0", "utf8");

export function calculateDaemonArtifactIdentity(entrypoint: string): DaemonArtifactIdentity {
  const started = process.hrtime.bigint();
  const artifactRoot = resolveDaemonArtifactRoot(entrypoint);
  const files = artifactFiles(entrypoint, artifactRoot);
  const digest = createHash("sha256");
  digest.update(identityDomain);
  for (const relativePath of files) {
    const pathBytes = Buffer.from(relativePath, "utf8");
    const content = readFileSync(path.join(artifactRoot, ...relativePath.split("/")));
    const framing = Buffer.allocUnsafe(12);
    framing.writeUInt32BE(pathBytes.length, 0);
    framing.writeBigUInt64BE(BigInt(content.length), 4);
    digest.update(framing.subarray(0, 4));
    digest.update(pathBytes);
    digest.update(framing.subarray(4));
    digest.update(content);
  }
  return {
    artifactRoot,
    identity: `sha256:${digest.digest("hex")}`,
    fileCount: files.length,
    elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000
  };
}

export function resolveDaemonArtifactRoot(entrypoint: string): string {
  const resolvedEntrypoint = realpathSync(entrypoint);
  let current = path.dirname(resolvedEntrypoint);
  while (true) {
    if (path.basename(current) === "dist") return current;
    if (isCliSourceRoot(current)) return path.dirname(path.dirname(path.dirname(current)));
    const parent = path.dirname(current);
    if (parent === current) return path.dirname(resolvedEntrypoint);
    current = parent;
  }
}

function artifactFiles(entrypoint: string, root: string): ReadonlyArray<string> {
  const resolvedEntrypoint = realpathSync(entrypoint);
  if (isCliSourceEntrypoint(resolvedEntrypoint, root)) {
    return filesBelowRoots(root, sourcePackageRoots, sourceArtifactExtensions);
  }
  const extensions = sourceArtifactExtensions.has(path.extname(resolvedEntrypoint))
    && !compiledArtifactExtensions.has(path.extname(resolvedEntrypoint))
    ? sourceArtifactExtensions
    : compiledArtifactExtensions;
  return filesBelowRoots(root, ["."], extensions);
}

function filesBelowRoots(
  root: string,
  relativeRoots: ReadonlyArray<string>,
  extensions: ReadonlySet<string>
): ReadonlyArray<string> {
  const files: string[] = [];
  const pending = relativeRoots
    .map((relativeRoot) => path.join(root, ...relativeRoot.split("/")))
    .filter((candidate) => existsDirectory(candidate));
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile()
        || !extensions.has(path.extname(entry.name))
        || entry.name.endsWith(".d.ts")) continue;
      files.push(path.relative(root, absolutePath).split(path.sep).join("/"));
    }
  }
  files.sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  return files;
}

function isCliSourceEntrypoint(entrypoint: string, artifactRoot: string): boolean {
  return path.dirname(entrypoint) === path.join(artifactRoot, "packages", "cli", "src");
}

function isCliSourceRoot(candidate: string): boolean {
  return path.basename(candidate) === "src"
    && path.basename(path.dirname(candidate)) === "cli"
    && path.basename(path.dirname(path.dirname(candidate))) === "packages";
}

function existsDirectory(candidate: string): boolean {
  return existsSync(candidate);
}
