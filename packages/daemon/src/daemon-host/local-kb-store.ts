// Host-local private KB store (dec_D75C5F36D3E0C4D2346D4B3961 CH1/CH2/CH4):
// stores managed `local-private` Document Bundles under `<userRoot>/local-kb/<repoId>/` and
// scans declarative external local Markdown directory mounts (`readonly` / `readwrite`).
// Strictly host-local: writes ZERO records to CanonicalEventStore or Fleet replication streams.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  KB_DOCUMENT_BUNDLE_SCHEMA,
  countMarkdownLines,
  isValidKbDocId,
  isValidKbMountId,
  parseKbMarkdownFrontmatter,
  parseMarkdownOutline,
  tryNormalizeRelativePosixPath,
  validateKbDocumentBundleV1,
  validateKbDocumentManifestV1,
  type KbDocumentAssetRefV1,
  type KbDocumentBundleV1,
  type KbDocumentManifestV1,
  type KbMountDeclarationV1,
  type KbMountMode,
  type LocalKbStorePort,
  type LocalKbWriteInput,
} from "@harness-anything/kernel/internal/domain/kb-document-bundle.ts";
import { sha256Bytes, sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import {
  localLedgerBackupFileSystem,
  localRuntimeStateFileSystem,
} from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import { writeFileDurably } from "@harness-anything/storage";

const REPO_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MARKDOWN_EXT_PATTERN = /\.(?:md|markdown)$/iu;
const SKIPPED_MOUNT_DIRS = new Set([".git", "node_modules", ".obsidian", ".trash"]);

export class LocalKbStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalKbStoreError";
    this.code = code;
  }
}

function assertNotSymlink(targetPath: string, label: string): void {
  const stat = lstatSync(targetPath, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) {
    throw new LocalKbStoreError("kb_path_escape", `${label} cannot traverse a symbolic link.`);
  }
}

function normalizeForContainment(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInsideRoot(canonicalRoot: string, candidatePath: string): boolean {
  const root = normalizeForContainment(canonicalRoot);
  const candidate = normalizeForContainment(candidatePath);
  if (candidate === root) return true;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate.startsWith(prefix);
}

function assertNoSymlinkSegments(canonicalRoot: string, relativePosixPath: string): string {
  const segments = relativePosixPath.split("/").filter(Boolean);
  let current = canonicalRoot;
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new LocalKbStoreError("kb_path_escape", "Path traversal segments are not permitted.");
    }
    current = path.join(current, segment);
    assertNotSymlink(current, `Mounted KB path (${relativePosixPath})`);
  }
  if (!isPathInsideRoot(canonicalRoot, current)) {
    throw new LocalKbStoreError("kb_path_escape", `Path "${relativePosixPath}" escapes the mount root.`);
  }
  return current;
}

function localKbRepoDir(userRoot: string, repoId: string): string {
  if (!REPO_ID_PATTERN.test(repoId)) {
    throw new LocalKbStoreError("invalid_field", "Repository id cannot name a local KB directory.");
  }
  const kbRoot = path.join(userRoot, "local-kb");
  const repoDir = path.join(kbRoot, repoId);
  assertNotSymlink(kbRoot, "Local KB root");
  assertNotSymlink(repoDir, "Local KB repository directory");
  return repoDir;
}

function localKbBundlesDir(userRoot: string, repoId: string): string {
  const repoDir = localKbRepoDir(userRoot, repoId);
  const bundlesDir = path.join(repoDir, "bundles");
  assertNotSymlink(bundlesDir, "Local KB bundles directory");
  return bundlesDir;
}

function localKbMountsFile(userRoot: string, repoId: string): string {
  const repoDir = localKbRepoDir(userRoot, repoId);
  const mountsFile = path.join(repoDir, "mounts.json");
  assertNotSymlink(mountsFile, "Local KB mounts file");
  return mountsFile;
}

function readManagedBundle(userRoot: string, repoId: string, docId: string): KbDocumentBundleV1 | null {
  if (!isValidKbDocId(docId)) return null;
  const bundleDir = path.join(localKbBundlesDir(userRoot, repoId), docId);
  assertNotSymlink(bundleDir, `Local KB bundle ${docId}`);
  const manifestPath = path.join(bundleDir, "manifest.json");
  assertNotSymlink(manifestPath, `Local KB manifest ${docId}`);
  if (!existsSync(manifestPath)) return null;
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  const errors = validateKbDocumentBundleV1(raw);
  if (errors.length > 0) {
    throw new LocalKbStoreError("invalid_store", `Local KB bundle ${docId} is invalid: ${errors.join("; ")}`);
  }
  const bundle = raw as KbDocumentBundleV1;
  if (bundle.docId !== docId || bundle.scope !== "local") {
    throw new LocalKbStoreError("invalid_store", `Local KB bundle ${docId} identity mismatch.`);
  }
  return bundle;
}

function listManagedBundles(userRoot: string, repoId: string): readonly KbDocumentBundleV1[] {
  const bundlesDir = localKbBundlesDir(userRoot, repoId);
  if (!existsSync(bundlesDir)) return [];
  const entries = readdirSync(bundlesDir, { withFileTypes: true });
  const results: KbDocumentBundleV1[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    if (!isValidKbDocId(entry.name)) continue;
    const bundle = readManagedBundle(userRoot, repoId, entry.name);
    if (bundle) results.push(bundle);
  }
  return results;
}

function readMountDeclarations(userRoot: string, repoId: string): readonly KbMountDeclarationV1[] {
  const filePath = localKbMountsFile(userRoot, repoId);
  if (!existsSync(filePath)) return [];
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new LocalKbStoreError("invalid_store", "Local KB mounts.json must be an array.");
  }
  return parsed.filter(
    (item): item is KbMountDeclarationV1 =>
      typeof item === "object" &&
      item !== null &&
      isValidKbMountId((item as Record<string, unknown>).mountId) &&
      typeof (item as Record<string, unknown>).rootPath === "string" &&
      ((item as Record<string, unknown>).mode === "readonly" || (item as Record<string, unknown>).mode === "readwrite"),
  );
}

function writeMountDeclarations(userRoot: string, repoId: string, mounts: readonly KbMountDeclarationV1[]): void {
  const filePath = localKbMountsFile(userRoot, repoId);
  localRuntimeStateFileSystem.mkdirp(path.dirname(filePath));
  assertNotSymlink(path.dirname(filePath), "Local KB repository directory");
  writeFileDurably(filePath, `${JSON.stringify(mounts, null, 2)}\n`, 0o600);
}

function deriveSummaryFromMarkdown(markdown: string, frontmatterEndLine: number): string {
  const lines = markdown.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
  let inFence = false;
  for (let i = frontmatterEndLine; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (/^(`{3,}|~{3,})/u.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !trimmed || trimmed.startsWith("#") || trimmed.startsWith("<!--")) continue;
    return trimmed.length > 240 ? `${trimmed.slice(0, 239).trimEnd()}…` : trimmed;
  }
  return "";
}

function buildMountedBundle(
  mount: KbMountDeclarationV1,
  canonicalRoot: string,
  filePath: string,
  relativePosix: string,
  markdown: string,
  updatedAt: string,
): KbDocumentBundleV1 {
  const frontmatter = parseKbMarkdownFrontmatter(markdown);
  const outline = parseMarkdownOutline(markdown);
  const stem = path.posix.basename(relativePosix).replace(MARKDOWN_EXT_PATTERN, "");
  const fallbackDocId = `doc_mnt_${sha256Text(`${mount.mountId}:${relativePosix}`).slice(0, 16)}`;
  const docId = frontmatter.docId ?? fallbackDocId;
  const title = frontmatter.title ?? outline[0]?.heading ?? (stem || relativePosix);
  const summary = frontmatter.summary ?? deriveSummaryFromMarkdown(markdown, frontmatter.frontmatterEndLine);
  const domain = frontmatter.domain ?? mount.domain ?? "local-mount";
  const tags = [...new Set([...(mount.tags ?? []), ...frontmatter.tags])];
  const status = frontmatter.status ?? "active";
  const bytes = new TextEncoder().encode(markdown);
  const digest = sha256Text(markdown);

  // Confirm filePath stayed under canonicalRoot before returning metadata.
  if (!isPathInsideRoot(canonicalRoot, filePath)) {
    throw new LocalKbStoreError("kb_path_escape", `Mounted file ${relativePosix} escaped mount ${mount.mountId}.`);
  }

  return {
    schema: KB_DOCUMENT_BUNDLE_SCHEMA,
    docId,
    scope: "local",
    revision: 1,
    manifest: {
      title,
      aliases: frontmatter.aliases,
      summary,
      domain,
      tags,
      status,
      ...(frontmatter.supersededBy === undefined ? {} : { supersededBy: frontmatter.supersededBy }),
      ...(frontmatter.validFrom === undefined ? {} : { validFrom: frontmatter.validFrom }),
      ...(frontmatter.validTo === undefined ? {} : { validTo: frontmatter.validTo }),
      relations: frontmatter.relations,
      outline,
    },
    source: {
      filename: `source${path.posix.extname(relativePosix) || ".md"}`,
      mediaType: "text/markdown",
      sha256: digest,
      byteLength: bytes.byteLength,
    },
    view: {
      filename: "view.md",
      mediaType: "text/markdown",
      sha256: digest,
      byteLength: bytes.byteLength,
      lineCount: countMarkdownLines(markdown),
    },
    assets: [],
    updatedAt,
    mountId: mount.mountId,
    mountRelativePath: relativePosix,
  };
}

interface ScannedMountedEntry {
  readonly bundle: KbDocumentBundleV1;
  readonly absolutePath: string;
  readonly canonicalRoot: string;
}

function scanMountEntries(mount: KbMountDeclarationV1): readonly ScannedMountedEntry[] {
  const rootStat = statSync(mount.rootPath, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory()) return [];
  const canonicalRoot = realpathSync.native(mount.rootPath);
  const collected: ScannedMountedEntry[] = [];

  const walk = (dirPath: string): void => {
    const entries = readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || SKIPPED_MOUNT_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const realSub = realpathSync.native(fullPath);
        if (!isPathInsideRoot(canonicalRoot, realSub)) continue;
        walk(realSub);
        continue;
      }
      if (!entry.isFile() || !MARKDOWN_EXT_PATTERN.test(entry.name)) continue;
      const realFile = realpathSync.native(fullPath);
      if (!isPathInsideRoot(canonicalRoot, realFile)) continue;
      const relNative = path.relative(canonicalRoot, realFile);
      const relPosix = relNative.split(path.sep).join("/");
      const normalizedRel = tryNormalizeRelativePosixPath(relPosix);
      if (!normalizedRel) continue;
      const stat = statSync(realFile, { throwIfNoEntry: false });
      if (!stat?.isFile()) continue;
      const markdown = readFileSync(realFile, "utf8");
      const bundle = buildMountedBundle(
        mount,
        canonicalRoot,
        realFile,
        normalizedRel,
        markdown,
        stat.mtime.toISOString(),
      );
      collected.push({ bundle, absolutePath: realFile, canonicalRoot });
    }
  };

  walk(canonicalRoot);
  return collected;
}

function scanAllMountEntries(userRoot: string, repoId: string): readonly ScannedMountedEntry[] {
  const mounts = readMountDeclarations(userRoot, repoId);
  const all: ScannedMountedEntry[] = [];
  for (const mount of mounts) {
    all.push(...scanMountEntries(mount));
  }
  return all;
}

export function putLocalKbBundle(userRoot: string, repoId: string, input: LocalKbWriteInput): KbDocumentBundleV1 {
  if (!isValidKbDocId(input.docId)) {
    throw new LocalKbStoreError("invalid_field", `Invalid KB docId "${input.docId}". Expected doc_<id>.`);
  }
  const sourceFilename = input.sourceFilename ?? "source.md";
  if (!/^source\.[A-Za-z0-9._-]+$/u.test(sourceFilename)) {
    throw new LocalKbStoreError("invalid_field", `Invalid source filename "${sourceFilename}".`);
  }
  const sourceMediaType = input.sourceMediaType ?? "text/markdown";
  const encoder = new TextEncoder();
  const viewBytes = encoder.encode(input.viewMarkdown);
  const viewSha = sha256Text(input.viewMarkdown);
  const sourceBytes = input.sourceBytes ?? viewBytes;
  const sourceSha = input.sourceBytes ? sha256Bytes(input.sourceBytes) : viewSha;

  const outline = input.manifest.outline ?? parseMarkdownOutline(input.viewMarkdown);
  const manifest: KbDocumentManifestV1 = {
    title: input.manifest.title,
    aliases: [...input.manifest.aliases],
    summary: input.manifest.summary,
    domain: input.manifest.domain,
    tags: [...input.manifest.tags],
    status: input.manifest.status,
    ...(input.manifest.supersededBy === undefined ? {} : { supersededBy: input.manifest.supersededBy }),
    ...(input.manifest.validFrom === undefined ? {} : { validFrom: input.manifest.validFrom }),
    ...(input.manifest.validTo === undefined ? {} : { validTo: input.manifest.validTo }),
    relations: [...input.manifest.relations],
    outline: [...outline],
  };
  const manifestErrors = validateKbDocumentManifestV1(manifest);
  if (manifestErrors.length > 0) {
    throw new LocalKbStoreError("invalid_field", manifestErrors.join("; "));
  }

  const bundlesDir = localKbBundlesDir(userRoot, repoId);
  const bundleDir = path.join(bundlesDir, input.docId);
  localRuntimeStateFileSystem.mkdirp(bundleDir);
  assertNotSymlink(bundlesDir, "Local KB bundles directory");
  assertNotSymlink(bundleDir, `Local KB bundle ${input.docId}`);

  const current = readManagedBundle(userRoot, repoId, input.docId);
  const currentRevision = current?.revision ?? 0;
  if (input.expectedVersion !== undefined && input.expectedVersion !== currentRevision) {
    throw new LocalKbStoreError(
      "revision_conflict",
      `Local KB document ${input.docId} expected revision ${input.expectedVersion}, current revision is ${currentRevision}.`,
    );
  }

  const assetRefs: KbDocumentAssetRefV1[] = [];
  for (const asset of input.assets ?? []) {
    const normalizedPath = tryNormalizeRelativePosixPath(asset.path);
    if (!normalizedPath) {
      throw new LocalKbStoreError("kb_path_escape", `Invalid asset path "${asset.path}".`);
    }
    if (!normalizedPath.startsWith("assets/")) {
      throw new LocalKbStoreError("invalid_field", `KB asset path must start with "assets/": ${asset.path}`);
    }
    const targetAssetPath = assertNoSymlinkSegments(bundleDir, normalizedPath);
    localRuntimeStateFileSystem.mkdirp(path.dirname(targetAssetPath));
    writeFileDurably(targetAssetPath, asset.body, 0o600);
    assetRefs.push({
      path: normalizedPath,
      mediaType: asset.mediaType,
      sha256: sha256Bytes(asset.body),
      byteLength: asset.body.byteLength,
      ...(asset.page === undefined ? {} : { page: asset.page }),
    });
  }

  const sourcePath = assertNoSymlinkSegments(bundleDir, sourceFilename);
  writeFileDurably(sourcePath, input.sourceBytes ? sourceBytes : input.viewMarkdown, 0o600);

  const viewPath = assertNoSymlinkSegments(bundleDir, "view.md");
  writeFileDurably(viewPath, input.viewMarkdown, 0o600);

  const bundle: KbDocumentBundleV1 = {
    schema: KB_DOCUMENT_BUNDLE_SCHEMA,
    docId: input.docId,
    scope: "local",
    revision: currentRevision + 1,
    manifest,
    source: {
      filename: sourceFilename,
      mediaType: sourceMediaType,
      sha256: sourceSha,
      byteLength: sourceBytes.byteLength,
    },
    view: {
      filename: "view.md",
      mediaType: "text/markdown",
      sha256: viewSha,
      byteLength: viewBytes.byteLength,
      lineCount: countMarkdownLines(input.viewMarkdown),
    },
    assets: assetRefs,
    updatedAt: input.now,
  };
  const bundleErrors = validateKbDocumentBundleV1(bundle);
  if (bundleErrors.length > 0) {
    throw new LocalKbStoreError("invalid_field", bundleErrors.join("; "));
  }
  const manifestPath = assertNoSymlinkSegments(bundleDir, "manifest.json");
  writeFileDurably(manifestPath, `${JSON.stringify(bundle, null, 2)}\n`, 0o600);
  return bundle;
}

export function removeLocalKbBundle(
  userRoot: string,
  repoId: string,
  docId: string,
  options?: { readonly expectedVersion?: number },
): boolean {
  if (!isValidKbDocId(docId)) {
    throw new LocalKbStoreError("invalid_field", `Invalid KB docId "${docId}".`);
  }
  const current = readManagedBundle(userRoot, repoId, docId);
  const currentRevision = current?.revision ?? 0;
  if (options?.expectedVersion !== undefined && options.expectedVersion !== currentRevision) {
    throw new LocalKbStoreError(
      "revision_conflict",
      `Local KB document ${docId} expected revision ${options.expectedVersion}, current revision is ${currentRevision}.`,
    );
  }
  if (current === null) return false;
  const bundleDir = path.join(localKbBundlesDir(userRoot, repoId), docId);
  assertNotSymlink(bundleDir, `Local KB bundle ${docId}`);
  localLedgerBackupFileSystem.remove(bundleDir);
  return true;
}

export function addLocalKbMount(
  userRoot: string,
  repoId: string,
  input: {
    readonly mountId: string;
    readonly rootPath: string;
    readonly mode: KbMountMode;
    readonly domain?: string;
    readonly tags?: readonly string[];
    readonly now: string;
  },
): KbMountDeclarationV1 {
  if (!isValidKbMountId(input.mountId)) {
    throw new LocalKbStoreError(
      "invalid_field",
      `Mount id "${input.mountId}" must be a lowercase slug matching [a-z0-9][a-z0-9_-]{0,63}.`,
    );
  }
  if (input.mode !== "readonly" && input.mode !== "readwrite") {
    throw new LocalKbStoreError("invalid_field", `Mount mode must be "readonly" or "readwrite".`);
  }
  const resolved = path.resolve(input.rootPath);
  const stat = statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) {
    throw new LocalKbStoreError("invalid_field", `Mount path does not exist or is not a directory: ${input.rootPath}`);
  }
  const canonicalRoot = realpathSync.native(resolved);
  const existing = readMountDeclarations(userRoot, repoId).filter((m) => m.mountId !== input.mountId);
  const declaration: KbMountDeclarationV1 = {
    mountId: input.mountId,
    rootPath: canonicalRoot,
    mode: input.mode,
    ...(input.domain ? { domain: input.domain } : {}),
    ...(input.tags && input.tags.length > 0 ? { tags: [...input.tags] } : {}),
    addedAt: input.now,
  };
  writeMountDeclarations(userRoot, repoId, [...existing, declaration]);
  return declaration;
}

export function removeLocalKbMount(userRoot: string, repoId: string, mountId: string): boolean {
  if (!isValidKbMountId(mountId)) {
    throw new LocalKbStoreError("invalid_field", `Invalid mount id "${mountId}".`);
  }
  const existing = readMountDeclarations(userRoot, repoId);
  const filtered = existing.filter((m) => m.mountId !== mountId);
  if (filtered.length === existing.length) return false;
  writeMountDeclarations(userRoot, repoId, filtered);
  return true;
}

export function writeLocalMountedMarkdown(
  userRoot: string,
  repoId: string,
  input: {
    readonly mountId: string;
    readonly relativePath: string;
    readonly markdown: string;
  },
): KbDocumentBundleV1 {
  const mount = readMountDeclarations(userRoot, repoId).find((m) => m.mountId === input.mountId);
  if (!mount) {
    throw new LocalKbStoreError("entity_not_found", `Local KB mount "${input.mountId}" does not exist.`);
  }
  if (mount.mode !== "readwrite") {
    throw new LocalKbStoreError("kb_mount_readonly", `Local KB mount "${input.mountId}" is readonly.`);
  }
  const rootStat = statSync(mount.rootPath, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory()) {
    throw new LocalKbStoreError("invalid_field", `Mount root for "${input.mountId}" is unavailable.`);
  }
  const canonicalRoot = realpathSync.native(mount.rootPath);
  const rawRel = input.relativePath.replace(/\\/gu, "/");
  const normalizedRel = tryNormalizeRelativePosixPath(rawRel);
  if (!normalizedRel) {
    throw new LocalKbStoreError("kb_path_escape", `Mounted path "${input.relativePath}" is not a safe relative path.`);
  }
  if (!MARKDOWN_EXT_PATTERN.test(normalizedRel)) {
    throw new LocalKbStoreError("invalid_field", `Mounted KB file must end with .md or .markdown: ${normalizedRel}`);
  }
  const targetPath = assertNoSymlinkSegments(canonicalRoot, normalizedRel);
  localRuntimeStateFileSystem.mkdirp(path.dirname(targetPath));
  const realParent = realpathSync.native(path.dirname(targetPath));
  if (!isPathInsideRoot(canonicalRoot, realParent)) {
    throw new LocalKbStoreError(
      "kb_path_escape",
      `Mounted target "${normalizedRel}" escapes mount "${mount.mountId}".`,
    );
  }
  assertNotSymlink(targetPath, `Mounted file ${normalizedRel}`);
  writeFileDurably(targetPath, input.markdown, 0o600);
  const realFile = realpathSync.native(targetPath);
  const stat = statSync(realFile);
  return buildMountedBundle(mount, canonicalRoot, realFile, normalizedRel, input.markdown, stat.mtime.toISOString());
}

/** Host-local implementation of `LocalKbStorePort` scoped to `<userRoot>/local-kb/<repoId>/`. */
export function createLocalKbStorePort(userRoot: string, repoId: string): LocalKbStorePort {
  return {
    listBundles: () => {
      const byId = new Map<string, KbDocumentBundleV1>();
      for (const entry of scanAllMountEntries(userRoot, repoId)) {
        byId.set(entry.bundle.docId, entry.bundle);
      }
      for (const managed of listManagedBundles(userRoot, repoId)) {
        byId.set(managed.docId, managed);
      }
      return [...byId.values()].sort((a, b) => a.docId.localeCompare(b.docId));
    },
    getBundle: (docId) => {
      if (!isValidKbDocId(docId)) return null;
      const managed = readManagedBundle(userRoot, repoId, docId);
      if (managed) return managed;
      const mounted = scanAllMountEntries(userRoot, repoId).find((entry) => entry.bundle.docId === docId);
      return mounted?.bundle ?? null;
    },
    readView: (docId) => {
      if (!isValidKbDocId(docId)) return null;
      const managed = readManagedBundle(userRoot, repoId, docId);
      if (managed) {
        const viewPath = path.join(localKbBundlesDir(userRoot, repoId), docId, "view.md");
        assertNotSymlink(viewPath, `Local KB view ${docId}`);
        return existsSync(viewPath) ? readFileSync(viewPath, "utf8") : null;
      }
      const mounted = scanAllMountEntries(userRoot, repoId).find((entry) => entry.bundle.docId === docId);
      if (!mounted) return null;
      assertNotSymlink(mounted.absolutePath, `Mounted KB view ${docId}`);
      const realFile = realpathSync.native(mounted.absolutePath);
      if (!isPathInsideRoot(mounted.canonicalRoot, realFile)) {
        throw new LocalKbStoreError("kb_path_escape", `Mounted KB view ${docId} escapes its mount root.`);
      }
      return readFileSync(realFile, "utf8");
    },
    putBundle: (input) => putLocalKbBundle(userRoot, repoId, input),
    removeBundle: (docId, options) => removeLocalKbBundle(userRoot, repoId, docId, options),
    listMounts: () => readMountDeclarations(userRoot, repoId),
    addMount: (input) => addLocalKbMount(userRoot, repoId, input),
    removeMount: (mountId) => removeLocalKbMount(userRoot, repoId, mountId),
    writeMountedMarkdown: (input) => writeLocalMountedMarkdown(userRoot, repoId, input),
  };
}
