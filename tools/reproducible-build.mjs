#!/usr/bin/env node
/**
 * Deterministic offline build & reproducibility verification tool (HA-01).
 *
 * Builds workspace deliverables from a pinned Git commit inside clean archive trees with
 * SOURCE_DATE_EPOCH pinned to the commit timestamp, zero network dependency when hydrated
 * from an offline npm cache or verified local mirror, and verifies bit-for-bit identical
 * SHA-256 manifests and deterministic USTAR/gzip archives across two independent builds.
 */
import { execFile as childExecFile, spawnSync } from "node:child_process";
import { hash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { extractTree, resolveRevision } from "./readonly-checkout.mjs";
import { readWorkspacePackages } from "./public-workspaces.mjs";
import { backupName, ownerName, preparePackageExports } from "./package-exports-lifecycle.mjs";
import { mirrorNodeModules } from "../packages/daemon/src/daemon-host/worktree-node-modules-mirror.ts";

const execFile = promisify(childExecFile);

export const REPRODUCIBLE_BUILD_MANIFEST_SCHEMA = "harness-anything/reproducible-build-manifest/v1";

const DEFAULT_IGNORED_SEGMENTS = new Set([".git", "node_modules"]);
const DEFAULT_WORKSPACES = ["@harness-anything/cli"];

const HELP_TEXT = `Usage: node tools/reproducible-build.mjs <build|verify|verify-manifest> [options]

Commands:
  build             Build a deterministic offline bundle and write build-manifest.json
  verify            Run two independent clean builds and prove bit-for-bit reproducibility
  verify-manifest   Verify a built bundle directory offline against its build-manifest.json

Options:
  --repository <dir>        Git repository root (default: cwd)
  --revision <commit>       Commit SHA or ref to build/verify (default: HEAD)
  --out <dir>               Output directory for 'build'
  --archive <file>          Write deterministic .tar.gz archive (for 'build')
  --verify-archive          Also compare deterministic .tar.gz digests (for 'verify')
  --offline-cache <dir>     Pre-populated npm cache directory for air-gapped 'npm ci --offline'
  --mirror-node-modules     Hydrate dependencies from local checkout node_modules mirror
  --no-deps                 Skip dependency hydration (for zero-dependency workspaces)
  --workspace <name>        Target workspace package(s) to build (repeatable; default: @harness-anything/cli)
  --source-date-epoch <sec> Override SOURCE_DATE_EPOCH (defaults to commit timestamp)
  --bundle <dir>            Bundle directory for 'verify-manifest'
  --manifest <file>         Manifest file for 'verify-manifest' (default: <bundle>/build-manifest.json)
  -h, --help                Show this help text`;

function sha256Buffer(buffer) {
  return `sha256:${hash("sha256", buffer, "hex")}`;
}

function sha256String(text) {
  return sha256Buffer(Buffer.from(text, "utf8"));
}

function resolveCommitEpoch(repository, commit) {
  const result = spawnSync("git", ["-C", repository, "show", "-s", "--format=%ct", commit], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Failed to resolve commit timestamp for ${commit}: ${String(result.stderr ?? "").trim()}`);
  }
  const epoch = Number(result.stdout.trim());
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error(`Invalid commit timestamp for ${commit}: ${result.stdout.trim()}`);
  }
  return epoch;
}

function removeBuildInfoFiles(rootDir) {
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (DEFAULT_IGNORED_SEGMENTS.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.name.endsWith(".tsbuildinfo")) unlinkSync(fullPath);
    }
  };
  walk(rootDir);
}

/**
 * Walks rootDir in deterministic POSIX-path order and collects every deliverable entry
 * (regular files with normalized executable mode, plus symbolic links with target).
 * Rejects unsupported filesystem entry types (FIFOs, sockets, devices) fail-closed so
 * manifest, tar.gz archive, and output directory always represent the exact same tree.
 */
function collectDeliverableEntries(rootDir, options = {}) {
  const ignoreSet = new Set(options.ignoreFiles ?? []);
  const ignoredSegments = new Set(options.ignoredSegments ?? []);
  const entries = [];

  const walk = (directory) => {
    const dirEntries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of dirEntries) {
      if (ignoredSegments.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(rootDir, fullPath).split(path.sep).join("/");
      if (ignoreSet.has(relativePath)) continue;
      const stat = lstatSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        const bytes = readFileSync(fullPath);
        const mode = (stat.mode & 0o111) !== 0 ? "0755" : "0644";
        entries.push({
          path: relativePath,
          fullPath,
          type: "file",
          mode,
          size: bytes.length,
          sha256: sha256Buffer(bytes),
          bytes,
        });
      } else if (stat.isSymbolicLink()) {
        const linkTarget = readlinkSync(fullPath);
        entries.push({
          path: relativePath,
          fullPath,
          type: "symlink",
          mode: "0777",
          size: 0,
          linkTarget,
          sha256: sha256String(`symlink:${linkTarget}`),
        });
      } else {
        throw new Error(`Unsupported deliverable entry type at ${relativePath}`);
      }
    }
  };

  walk(rootDir);
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return entries;
}

function manifestEntryFingerprint(entry) {
  const type = entry.type ?? "file";
  const mode = entry.mode ?? "0644";
  if (type === "symlink") {
    return `symlink  ${mode}  ${entry.sha256}  ${entry.path} -> ${entry.linkTarget ?? ""}`;
  }
  return `file  ${mode}  ${entry.sha256}  ${entry.size}  ${entry.path}`;
}

/**
 * Computes a deterministic, sorted SHA-256 manifest covering file type, normalized POSIX
 * executable mode, symlink target, size, and content digest for all deliverable entries.
 */
export function computeDirectoryManifest(rootDir, options = {}) {
  const entries = collectDeliverableEntries(rootDir, options);
  const files = entries.map((entry) =>
    entry.type === "symlink"
      ? {
          path: entry.path,
          type: "symlink",
          mode: entry.mode,
          size: 0,
          linkTarget: entry.linkTarget,
          sha256: entry.sha256,
        }
      : {
          path: entry.path,
          type: "file",
          mode: entry.mode,
          size: entry.size,
          sha256: entry.sha256,
        },
  );
  const canonicalLines = files.map((file) => manifestEntryFingerprint(file)).join("\n");
  const artifactDigest = sha256String(canonicalLines);
  return {
    artifactDigest,
    fileCount: files.length,
    files,
  };
}

/**
 * Emits a bit-for-bit reproducible POSIX USTAR .tar.gz archive in pure Node.js:
 * sorted POSIX paths, regular files and symlinks, normalized executable modes,
 * fixed uid/gid=0, empty uname/gname, fixed mtime=sourceDateEpoch,
 * and normalized gzip header (zero MTIME, OS=0xff).
 */
export function createDeterministicTarGz(rootDir, options = {}) {
  const sourceDateEpoch = Number.isSafeInteger(options.sourceDateEpoch) ? options.sourceDateEpoch : 0;
  const entries = collectDeliverableEntries(rootDir, options);

  const chunks = [];
  for (const entry of entries) {
    const { name, prefix } = splitUstarPath(entry.path);
    if (entry.type === "symlink") {
      if (Buffer.byteLength(entry.linkTarget, "utf8") > 100) {
        throw new Error(
          `Archive symlink target exceeds POSIX USTAR 100-byte limit: ${entry.path} -> ${entry.linkTarget}`,
        );
      }
      const header = buildUstarHeader({
        name,
        prefix,
        typeflag: 0x32,
        mode: 0o777,
        size: 0,
        mtime: sourceDateEpoch,
        linkname: entry.linkTarget,
      });
      chunks.push(header);
      continue;
    }
    const content = entry.bytes;
    const header = buildUstarHeader({
      name,
      prefix,
      typeflag: 0x30,
      mode: Number.parseInt(entry.mode, 8),
      size: content.length,
      mtime: sourceDateEpoch,
      linkname: "",
    });
    chunks.push(header, content);
    const remainder = content.length % 512;
    if (remainder !== 0) chunks.push(Buffer.alloc(512 - remainder));
  }
  // Standard tar end-of-archive marker: two 512-byte zero blocks.
  chunks.push(Buffer.alloc(1024));

  const tarBuffer = Buffer.concat(chunks);
  const gzipped = gzipSync(tarBuffer, { level: 9 });
  // RFC 1952 header: zero MTIME bytes [4..7] and set OS byte [9] = 0xff (unknown) for cross-OS determinism.
  gzipped[4] = 0;
  gzipped[5] = 0;
  gzipped[6] = 0;
  gzipped[7] = 0;
  gzipped[9] = 0xff;
  return gzipped;
}

function isSameOrWithinPath(candidatePath, basePath) {
  const rel = path.relative(basePath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function readBundleManifestMarker(directory) {
  const manifestPath = path.join(directory, "build-manifest.json");
  const stat = lstatSync(manifestPath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    return parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.schema === REPRODUCIBLE_BUILD_MANIFEST_SCHEMA &&
      Array.isArray(parsed.files)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function prepareDeliverableTargetPath(outDir, options = {}) {
  const targetDir = path.resolve(outDir);
  const parentDir = path.dirname(targetDir);
  if (targetDir === parentDir) {
    throw new Error(`Refusing to overwrite filesystem root as output directory: ${targetDir}`);
  }
  const protectedAncestors = [path.resolve(process.cwd()), path.resolve(homedir()), path.resolve(tmpdir())];
  if (options.repository) protectedAncestors.push(path.resolve(options.repository));
  for (const protectedPath of protectedAncestors) {
    if (isSameOrWithinPath(protectedPath, targetDir)) {
      throw new Error(
        `Refusing to replace protected directory or ancestor (${protectedPath}) as --out target: ${targetDir}`,
      );
    }
  }
  if (options.archivePath) {
    const resolvedArchive = path.resolve(options.archivePath);
    if (isSameOrWithinPath(resolvedArchive, targetDir) || isSameOrWithinPath(targetDir, resolvedArchive)) {
      throw new Error(
        `Refusing overlapping --archive (${resolvedArchive}) and --out (${targetDir}) paths; write --archive outside --out.`,
      );
    }
  }
  const existing = lstatSync(targetDir, { throwIfNoEntry: false });
  if (existing) {
    if (!existing.isDirectory()) {
      throw new Error(`Refusing to replace non-directory output path: ${targetDir}`);
    }
    if (lstatSync(path.join(targetDir, ".git"), { throwIfNoEntry: false })) {
      throw new Error(`Refusing to replace Git checkout directory as --out target: ${targetDir}`);
    }
    const entries = readdirSync(targetDir);
    if (entries.length > 0 && readBundleManifestMarker(targetDir) === null) {
      throw new Error(
        `Refusing to replace existing non-empty directory without a valid ${REPRODUCIBLE_BUILD_MANIFEST_SCHEMA} build-manifest.json: ${targetDir}`,
      );
    }
  }
  return targetDir;
}

function writeDeliverableDirectory(stagingDir, outDir, options = {}) {
  const targetDir = prepareDeliverableTargetPath(outDir, options);
  const parentDir = path.dirname(targetDir);
  const entries = collectDeliverableEntries(stagingDir, { ignoredSegments: options.ignoredSegments });
  mkdirSync(parentDir, { recursive: true });
  const tempDir = mkdtempSync(path.join(parentDir, `.${path.basename(targetDir)}.staging-`));
  const backupDir = `${targetDir}.replacing-${process.pid}-${Date.now()}`;
  let swappedOldOut = false;
  let installedNewOut = false;
  try {
    for (const entry of entries) {
      const destination = path.join(tempDir, ...entry.path.split("/"));
      mkdirSync(path.dirname(destination), { recursive: true });
      if (entry.type === "symlink") {
        symlinkSync(entry.linkTarget, destination);
      } else {
        const mode = Number.parseInt(entry.mode, 8);
        writeFileSync(destination, entry.bytes, { mode });
        chmodSync(destination, mode);
      }
    }
    if (lstatSync(targetDir, { throwIfNoEntry: false })) {
      renameSync(targetDir, backupDir);
      swappedOldOut = true;
    }
    renameSync(tempDir, targetDir);
    installedNewOut = true;
    if (swappedOldOut) {
      rmSync(backupDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  } catch (error) {
    if (swappedOldOut && !installedNewOut && lstatSync(backupDir, { throwIfNoEntry: false })) {
      renameSync(backupDir, targetDir);
    }
    throw error;
  } finally {
    if (!installedNewOut && lstatSync(tempDir, { throwIfNoEntry: false })) {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  }
}

function splitUstarPath(posixPath) {
  if (Buffer.byteLength(posixPath, "utf8") <= 100) {
    return { name: posixPath, prefix: "" };
  }
  let splitAt = posixPath.lastIndexOf("/");
  while (splitAt > 0) {
    const prefix = posixPath.slice(0, splitAt);
    const name = posixPath.slice(splitAt + 1);
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) {
      return { name, prefix };
    }
    splitAt = posixPath.lastIndexOf("/", splitAt - 1);
  }
  throw new Error(`Archive path exceeds POSIX USTAR 255-byte limit: ${posixPath}`);
}

function buildUstarHeader({ name, prefix, typeflag = 0x30, mode, size, mtime, linkname = "" }) {
  const header = Buffer.alloc(512, 0);
  writeAscii(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtime);
  header.fill(0x20, 148, 156); // checksum placeholder spaces
  header[156] = typeflag; // '0' regular file, '2' symbolic link
  if (linkname) writeAscii(header, 157, 100, linkname);
  writeAscii(header, 257, 6, "ustar\0");
  writeAscii(header, 263, 2, "00");
  writeAscii(header, 345, 155, prefix);

  let checksum = 0;
  for (let i = 0; i < 512; i += 1) checksum += header[i];
  writeOctal(header, 148, 7, checksum);
  header[155] = 0x20;
  return header;
}

function writeAscii(buffer, offset, maxLength, text) {
  const bytes = Buffer.from(text, "utf8");
  bytes.copy(buffer, offset, 0, Math.min(bytes.length, maxLength));
}

function writeOctal(buffer, offset, width, value) {
  const digits = Math.max(0, Math.floor(value))
    .toString(8)
    .padStart(width - 1, "0")
    .slice(-(width - 1));
  Buffer.from(digits, "ascii").copy(buffer, offset);
  buffer[offset + width - 1] = 0;
}

async function runCommand(command, args, cwd, env) {
  const useCmd = process.platform === "win32" && command === "npm";
  const actualCommand = useCmd ? "npm.cmd" : command;
  try {
    await execFile(actualCommand, args, {
      cwd,
      env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 600_000,
      ...(useCmd ? { shell: true } : {}),
    });
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const detail = [stderr, stdout].filter(Boolean).join("\n");
    throw new Error(detail ? `Command failed: ${command} ${args.join(" ")}\n${detail}` : String(error));
  }
}

function rebindWorkspaceLinks(stagingDir) {
  for (const pkg of readWorkspacePackages(stagingDir)) {
    const linkPath = path.join(stagingDir, "node_modules", ...pkg.manifest.name.split("/"));
    const parentDir = path.dirname(linkPath);
    mkdirSync(parentDir, { recursive: true });
    if (!lstatSync(parentDir).isDirectory()) {
      throw new Error(`Refusing to rebind workspace link through non-directory parent: ${parentDir}`);
    }
    if (lstatSync(linkPath, { throwIfNoEntry: false })) {
      rmSync(linkPath, { recursive: true, force: true });
    }
    const targetPath = path.join(stagingDir, pkg.directory);
    symlinkSync(path.relative(parentDir, targetPath), linkPath, process.platform === "win32" ? "junction" : "dir");
  }
}

async function buildWorkspacesInOrder(stagingDir, targetWorkspaces, env) {
  const packages = readWorkspacePackages(stagingDir);
  const byName = new Map(packages.map((entry) => [entry.manifest.name, entry]));
  const built = new Set();

  const buildOne = async (name) => {
    if (built.has(name)) return;
    const entry = byName.get(name);
    if (!entry) return;
    built.add(name);
    const deps = { ...entry.manifest.dependencies, ...entry.manifest.optionalDependencies };
    for (const depName of Object.keys(deps).sort()) {
      await buildOne(depName);
    }
    const script = entry.manifest.scripts?.["build:publish"]
      ? "build:publish"
      : entry.manifest.scripts?.build
        ? "build"
        : null;
    if (script) {
      await runCommand("npm", ["run", script, "--workspace", name], stagingDir, env);
    }
  };

  for (const target of targetWorkspaces) {
    if (!byName.has(target)) {
      throw new Error(`Workspace package not found in commit tree: ${target}`);
    }
    await buildOne(target);
  }

  for (const name of built) {
    const entry = byName.get(name);
    if (!entry?.manifest.publishConfig?.exports) continue;
    const directory = path.join(stagingDir, entry.directory);
    preparePackageExports(directory);
    for (const marker of [backupName, ownerName]) {
      const markerPath = path.join(directory, marker);
      if (existsSync(markerPath)) unlinkSync(markerPath);
    }
  }

  removeBuildInfoFiles(stagingDir);
  return [...built].sort();
}

export async function buildReproducibleBundle(options) {
  const repository = path.resolve(options.repository ?? process.cwd());
  const revision = options.revision ?? "HEAD";
  const resolved = resolveRevision(repository, revision);
  if (!resolved.ok) throw new Error(resolved.detail);
  const { commit } = resolved;

  const sourceDateEpoch =
    options.sourceDateEpoch !== undefined ? Number(options.sourceDateEpoch) : resolveCommitEpoch(repository, commit);
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
    throw new Error(`Invalid SOURCE_DATE_EPOCH: ${options.sourceDateEpoch}`);
  }

  const targetWorkspaces =
    options.targetWorkspaces && options.targetWorkspaces.length > 0 ? options.targetWorkspaces : DEFAULT_WORKSPACES;
  const dependencyMode = options.dependencyMode ?? (options.offlineCacheDir ? "offline-cache" : "mirror");

  if (options.outputDir) {
    prepareDeliverableTargetPath(options.outputDir, {
      repository,
      archivePath: options.archivePath,
    });
  }

  const staging = mkdtempSync(path.join(tmpdir(), "ha-repro-stage-"));
  try {
    const extracted = extractTree(repository, commit, staging);
    if (!extracted.ok) throw new Error(extracted.detail);

    const lockPath = path.join(staging, "package-lock.json");
    if (!existsSync(lockPath)) {
      throw new Error("package-lock.json is required for reproducible offline builds.");
    }
    const lockfileSha256 = sha256Buffer(readFileSync(lockPath));

    const buildEnv = {
      ...process.env,
      ...(options.env ?? {}),
      SOURCE_DATE_EPOCH: String(sourceDateEpoch),
      TZ: "UTC",
      LC_ALL: "C",
      LANG: "C",
      NODE_ENV: "production",
      HARNESS_BUILD_COMMIT: commit,
      ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
    };

    if (dependencyMode === "offline-cache") {
      if (!options.offlineCacheDir || !existsSync(path.resolve(options.offlineCacheDir))) {
        throw new Error(`Offline npm cache directory does not exist: ${options.offlineCacheDir}`);
      }
      // Explicitly include locked devDependencies (e.g. TypeScript compiler) during offline install:
      // NODE_ENV=production or npm_config_omit=dev would otherwise omit dev:true packages in package-lock.json.
      const installEnv = { ...buildEnv };
      delete installEnv.NODE_ENV;
      delete installEnv.npm_config_omit;
      delete installEnv.NPM_CONFIG_OMIT;
      await runCommand(
        "npm",
        [
          "ci",
          "--offline",
          "--include=dev",
          "--cache",
          path.resolve(options.offlineCacheDir),
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        staging,
        installEnv,
      );
    } else if (dependencyMode === "mirror") {
      const store = path.join(repository, "node_modules");
      if (!existsSync(store)) {
        throw new Error(`Local node_modules not found at ${store}; provide --offline-cache or run npm ci first.`);
      }
      mirrorNodeModules(repository, staging);
      rebindWorkspaceLinks(staging);
    } else if (dependencyMode !== "none") {
      throw new Error(`Unsupported dependencyMode: ${dependencyMode}`);
    }

    const builtWorkspaces = await buildWorkspacesInOrder(staging, targetWorkspaces, buildEnv);

    // Strip node_modules before manifest calculation so the output bundle contains only deterministic sources & dist.
    const stagedNodeModules = path.join(staging, "node_modules");
    if (existsSync(stagedNodeModules)) {
      rmSync(stagedNodeModules, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }

    const computed = computeDirectoryManifest(staging, {
      ignoreFiles: ["build-manifest.json"],
      ignoredSegments: DEFAULT_IGNORED_SEGMENTS,
    });
    const manifest = {
      schema: REPRODUCIBLE_BUILD_MANIFEST_SCHEMA,
      commit,
      sourceDateEpoch,
      lockfileSha256,
      targetWorkspaces: [...targetWorkspaces],
      builtWorkspaces,
      artifactDigest: computed.artifactDigest,
      fileCount: computed.fileCount,
      files: computed.files,
    };
    const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(path.join(staging, "build-manifest.json"), manifestJson, "utf8");

    let archiveSha256 = null;
    if (options.archivePath || options.createArchive) {
      const archiveBytes = createDeterministicTarGz(staging, {
        sourceDateEpoch,
        ignoredSegments: DEFAULT_IGNORED_SEGMENTS,
      });
      archiveSha256 = sha256Buffer(archiveBytes);
      if (options.archivePath) {
        const destinationArchive = path.resolve(options.archivePath);
        mkdirSync(path.dirname(destinationArchive), { recursive: true });
        writeFileSync(destinationArchive, archiveBytes);
      }
    }

    if (options.outputDir) {
      writeDeliverableDirectory(staging, path.resolve(options.outputDir), {
        repository,
        archivePath: options.archivePath,
        ignoredSegments: DEFAULT_IGNORED_SEGMENTS,
      });
    }

    return {
      ok: true,
      commit,
      sourceDateEpoch,
      lockfileSha256,
      artifactDigest: manifest.artifactDigest,
      archiveSha256,
      fileCount: manifest.fileCount,
      manifest,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

export async function verifyReproducibleBuild(options) {
  // Pin a mutable ref (e.g. HEAD or a branch) to one immutable commit SHA before running both builds.
  const repository = path.resolve(options.repository ?? process.cwd());
  const resolved = resolveRevision(repository, options.revision ?? "HEAD");
  if (!resolved.ok) throw new Error(resolved.detail);
  const pinnedCommit = resolved.commit;
  const sourceDateEpoch =
    options.sourceDateEpoch !== undefined
      ? Number(options.sourceDateEpoch)
      : resolveCommitEpoch(repository, pinnedCommit);

  const pinnedOptions = {
    ...options,
    repository,
    revision: pinnedCommit,
    sourceDateEpoch,
    outputDir: undefined,
    archivePath: undefined,
  };
  const buildA = await buildReproducibleBundle(pinnedOptions);
  const buildB = await buildReproducibleBundle(pinnedOptions);

  const differences = [];
  const mapA = new Map(buildA.manifest.files.map((file) => [file.path, manifestEntryFingerprint(file)]));
  const mapB = new Map(buildB.manifest.files.map((file) => [file.path, manifestEntryFingerprint(file)]));
  const allPaths = [...new Set([...mapA.keys(), ...mapB.keys()])].sort();

  for (const filePath of allPaths) {
    const fingerprintA = mapA.get(filePath) ?? null;
    const fingerprintB = mapB.get(filePath) ?? null;
    if (fingerprintA !== fingerprintB) {
      differences.push({ path: filePath, buildA: fingerprintA, buildB: fingerprintB });
    }
  }

  const archiveMatches =
    !options.createArchive || (buildA.archiveSha256 !== null && buildA.archiveSha256 === buildB.archiveSha256);
  const ok = differences.length === 0 && buildA.artifactDigest === buildB.artifactDigest && archiveMatches;

  return {
    ok,
    commit: pinnedCommit,
    sourceDateEpoch: buildA.sourceDateEpoch,
    artifactDigest: buildA.artifactDigest,
    archiveSha256: buildA.archiveSha256,
    fileCount: buildA.fileCount,
    builds: [
      { artifactDigest: buildA.artifactDigest, archiveSha256: buildA.archiveSha256, fileCount: buildA.fileCount },
      { artifactDigest: buildB.artifactDigest, archiveSha256: buildB.archiveSha256, fileCount: buildB.fileCount },
    ],
    differences,
  };
}

export function verifyBuildManifest(options) {
  const bundleDir = path.resolve(options.bundleDir);
  const manifestPath = path.resolve(options.manifestPath ?? path.join(bundleDir, "build-manifest.json"));
  const errors = [];

  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    return { ok: false, errors: [`Missing build manifest: ${manifestPath}`] };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.schema !== REPRODUCIBLE_BUILD_MANIFEST_SCHEMA) {
    errors.push(`Unsupported build manifest schema: ${String(manifest?.schema)}`);
  }
  if (!Array.isArray(manifest?.files)) {
    errors.push("Build manifest files array is missing.");
    return { ok: false, errors };
  }

  // Delivered bundles must be walked strictly with zero ignored directory segments (e.g. injected node_modules/.git).
  const actual = computeDirectoryManifest(bundleDir, {
    ignoreFiles: ["build-manifest.json"],
    ignoredSegments: [],
  });
  const expectedMap = new Map();
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || entry.path.length === 0) {
      errors.push("Build manifest contains an entry without a valid string path.");
      continue;
    }
    if (expectedMap.has(entry.path)) {
      errors.push(`duplicate manifest entry: ${entry.path}`);
      continue;
    }
    expectedMap.set(entry.path, entry);
  }
  const actualMap = new Map(actual.files.map((entry) => [entry.path, entry]));

  if (manifest.fileCount !== manifest.files.length || manifest.fileCount !== actual.fileCount) {
    errors.push(
      `fileCount mismatch: manifest declares ${String(manifest.fileCount)}, lists ${manifest.files.length} entries, filesystem has ${actual.fileCount}`,
    );
  }

  for (const [filePath, expected] of expectedMap) {
    const found = actualMap.get(filePath);
    if (!found) {
      errors.push(`missing file: ${filePath}`);
      continue;
    }
    const expectedType = expected.type ?? "file";
    const expectedMode = expected.mode ?? "0644";
    if (found.type !== expectedType) {
      errors.push(`type mismatch for ${filePath}: expected ${expectedType}, got ${found.type}`);
      continue;
    }
    if (found.mode !== expectedMode) {
      errors.push(`mode mismatch for ${filePath}: expected ${expectedMode}, got ${found.mode}`);
    }
    if (expectedType === "symlink") {
      if (found.linkTarget !== expected.linkTarget) {
        errors.push(
          `symlink target mismatch for ${filePath}: expected ${String(expected.linkTarget)}, got ${found.linkTarget}`,
        );
      }
      if (found.size !== expected.size) {
        errors.push(`size mismatch for symlink ${filePath}: expected ${String(expected.size)}, got ${found.size}`);
      }
      if (found.sha256 !== expected.sha256) {
        errors.push(
          `digest mismatch for symlink ${filePath}: expected ${String(expected.sha256)}, got ${found.sha256}`,
        );
      }
      continue;
    }
    if (found.size !== expected.size) {
      errors.push(`size mismatch for ${filePath}: expected ${String(expected.size)}, got ${found.size}`);
    }
    if (found.sha256 !== expected.sha256) {
      errors.push(`digest mismatch for ${filePath}: expected ${String(expected.sha256)}, got ${found.sha256}`);
    }
  }
  for (const filePath of actualMap.keys()) {
    if (!expectedMap.has(filePath)) {
      errors.push(`unexpected extra file: ${filePath}`);
    }
  }
  if (actual.artifactDigest !== manifest.artifactDigest) {
    errors.push(`root artifactDigest mismatch: expected ${manifest.artifactDigest}, got ${actual.artifactDigest}`);
  }

  return {
    ok: errors.length === 0,
    commit: manifest.commit ?? null,
    artifactDigest: actual.artifactDigest,
    fileCount: actual.fileCount,
    errors,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      repository: { type: "string" },
      revision: { type: "string" },
      out: { type: "string" },
      archive: { type: "string" },
      "verify-archive": { type: "boolean" },
      "offline-cache": { type: "string" },
      "mirror-node-modules": { type: "boolean" },
      "no-deps": { type: "boolean" },
      workspace: { type: "string", multiple: true },
      "source-date-epoch": { type: "string" },
      bundle: { type: "string" },
      manifest: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP_TEXT);
    return values.help ? 0 : 2;
  }

  const command = positionals[0];
  const dependencyMode = values["no-deps"]
    ? "none"
    : values["offline-cache"]
      ? "offline-cache"
      : values["mirror-node-modules"]
        ? "mirror"
        : "mirror";

  if (command === "build") {
    if (!values.out && !values.archive) {
      throw new Error("build requires --out <dir> and/or --archive <file>.");
    }
    const result = await buildReproducibleBundle({
      repository: values.repository,
      revision: values.revision,
      outputDir: values.out,
      archivePath: values.archive,
      offlineCacheDir: values["offline-cache"],
      dependencyMode,
      targetWorkspaces: values.workspace,
      ...(values["source-date-epoch"] !== undefined ? { sourceDateEpoch: Number(values["source-date-epoch"]) } : {}),
    });
    console.log(
      JSON.stringify(
        {
          ok: result.ok,
          command: "build",
          commit: result.commit,
          sourceDateEpoch: result.sourceDateEpoch,
          artifactDigest: result.artifactDigest,
          archiveSha256: result.archiveSha256,
          fileCount: result.fileCount,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (command === "verify") {
    const result = await verifyReproducibleBuild({
      repository: values.repository,
      revision: values.revision,
      offlineCacheDir: values["offline-cache"],
      dependencyMode,
      targetWorkspaces: values.workspace,
      createArchive: Boolean(values["verify-archive"]),
      ...(values["source-date-epoch"] !== undefined ? { sourceDateEpoch: Number(values["source-date-epoch"]) } : {}),
    });
    console.log(JSON.stringify({ command: "verify", ...result }, null, 2));
    return result.ok ? 0 : 1;
  }

  if (command === "verify-manifest") {
    if (!values.bundle) throw new Error("verify-manifest requires --bundle <dir>.");
    const result = verifyBuildManifest({ bundleDir: values.bundle, manifestPath: values.manifest });
    console.log(JSON.stringify({ command: "verify-manifest", ...result }, null, 2));
    return result.ok ? 0 : 1;
  }

  throw new Error(`Unknown command: ${command}\n${HELP_TEXT}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
