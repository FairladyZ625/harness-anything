import { createHash } from "node:crypto";
import path from "node:path";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../../layout/index.ts";
import { localEvidenceFileSystem, localLayoutFileSystem } from "../../local/local-layout-file-system.ts";
import { gitProtectedPaths, makeLocalVersionControlSystem } from "../git/local-version-control-system.ts";
import {
  removeContentAddressedBlob,
  type ContentAddressedBlobRef
} from "./content-addressed-blob-store.ts";

export interface CasGarbageCollectionEntry extends ContentAddressedBlobRef {
  readonly reason: "referenced" | "git-tracked" | "git-history" | "git-unavailable" | "unreferenced" | "digest-mismatch";
}

export interface CasGarbageCollectionReport {
  readonly schema: "cas-garbage-collection/v1";
  readonly mode: "dry-run" | "apply";
  readonly referenced: ReadonlyArray<CasGarbageCollectionEntry>;
  readonly orphans: ReadonlyArray<CasGarbageCollectionEntry>;
  readonly invalid: ReadonlyArray<CasGarbageCollectionEntry>;
  readonly reclaimed: ReadonlyArray<CasGarbageCollectionEntry>;
  readonly before: { readonly objectCount: number; readonly orphanCount: number; readonly invalidCount: number };
  readonly after: { readonly objectCount: number; readonly orphanCount: number; readonly invalidCount: number };
}

export function collectCasGarbage(
  rootInput: HarnessLayoutInput,
  options: { readonly apply?: boolean } = {}
): CasGarbageCollectionReport {
  const before = inspectCas(rootInput);
  const reclaimed: CasGarbageCollectionEntry[] = [];
  if (options.apply) {
    for (const orphan of before.orphans) {
      const current = inspectCas(rootInput);
      if (!current.orphans.some((entry) => entry.ref === orphan.ref)) continue;
      removeContentAddressedBlob(rootInput, orphan);
      reclaimed.push(orphan);
    }
  }
  const after = options.apply ? inspectCas(rootInput) : before;
  return {
    schema: "cas-garbage-collection/v1",
    mode: options.apply ? "apply" : "dry-run",
    referenced: before.referenced,
    orphans: before.orphans,
    invalid: before.invalid,
    reclaimed,
    before: counts(before),
    after: counts(after)
  };
}

function inspectCas(rootInput: HarnessLayoutInput): {
  readonly referenced: ReadonlyArray<CasGarbageCollectionEntry>;
  readonly orphans: ReadonlyArray<CasGarbageCollectionEntry>;
  readonly invalid: ReadonlyArray<CasGarbageCollectionEntry>;
} {
  const layout = resolveHarnessLayout(rootInput);
  const objectsRoot = path.join(layout.authoredRoot, "objects", "sha256");
  const references = referencedCasRefs(layout.authoredRoot, objectsRoot);
  const gitProtection = protectedCasPaths(layout.authoredRoot, objectsRoot);
  const referenced: CasGarbageCollectionEntry[] = [];
  const orphans: CasGarbageCollectionEntry[] = [];
  const invalid: CasGarbageCollectionEntry[] = [];
  for (const absolutePath of listRegularFiles(objectsRoot)) {
    const relative = path.relative(objectsRoot, absolutePath).split(path.sep).join("/");
    if (!/^[0-9a-f]{2}\/[0-9a-f]{62}$/u.test(relative)) continue;
    const sha256 = relative.replace("/", "");
    const bytes = localEvidenceFileSystem.readBytes(absolutePath);
    const ref = path.relative(layout.rootDir, absolutePath).split(path.sep).join("/");
    const descriptor = { ref, sha256, size: bytes.byteLength, mediaType: "application/octet-stream" };
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== sha256) {
      invalid.push({ ...descriptor, reason: "digest-mismatch" });
    } else if (references.has(sha256)) {
      referenced.push({ ...descriptor, reason: "referenced" });
    } else if (!gitProtection) {
      referenced.push({ ...descriptor, reason: "git-unavailable" });
    } else if (gitProtection.tracked.has(gitRelativePath(gitProtection.repoRoot, absolutePath))) {
      referenced.push({ ...descriptor, reason: "git-tracked" });
    } else if (gitProtection.historical.has(gitRelativePath(gitProtection.repoRoot, absolutePath))) {
      referenced.push({ ...descriptor, reason: "git-history" });
    } else {
      orphans.push({ ...descriptor, reason: "unreferenced" });
    }
  }
  return {
    referenced: referenced.sort(byRef),
    orphans: orphans.sort(byRef),
    invalid: invalid.sort(byRef)
  };
}

function referencedCasRefs(authoredRoot: string, objectsRoot: string): ReadonlySet<string> {
  const digests = new Set<string>();
  for (const filePath of listRegularFiles(authoredRoot, objectsRoot)) {
    const text = Buffer.from(localEvidenceFileSystem.readBytes(filePath)).toString("utf8");
    for (const match of text.matchAll(/(?:^|["'\s:])((?:[A-Za-z0-9._-]+\/)*objects\/sha256\/[0-9a-f]{2}\/[0-9a-f]{62})(?=$|["'\s,}])/gu)) {
      const candidate = match[1];
      if (candidate) digests.add(candidate.slice(-65).replace("/", ""));
    }
    for (const match of text.matchAll(/(?:^|[^0-9a-f])([0-9a-f]{64})(?=$|[^0-9a-f])/gu)) {
      if (match[1]) digests.add(match[1]);
    }
  }
  return digests;
}

function protectedCasPaths(
  authoredRoot: string,
  objectsRoot: string
): { readonly repoRoot: string; readonly tracked: ReadonlySet<string>; readonly historical: ReadonlySet<string> } | null {
  const vcs = makeLocalVersionControlSystem();
  const repoRoot = vcs.topLevel(authoredRoot);
  if (!repoRoot) return null;
  const relativeRoot = path.relative(repoRoot, vcs.normalizePath(objectsRoot)).split(path.sep).join("/");
  if (relativeRoot === ".." || relativeRoot.startsWith("../") || path.isAbsolute(relativeRoot)) return null;
  try {
    const protectedPaths = gitProtectedPaths(repoRoot, relativeRoot);
    return { repoRoot, ...protectedPaths };
  } catch {
    return null;
  }
}

function gitRelativePath(repoRoot: string, absolutePath: string): string {
  const normalized = makeLocalVersionControlSystem().normalizePath(absolutePath);
  return path.relative(repoRoot, normalized).split(path.sep).join("/");
}

function listRegularFiles(root: string, excludedRoot?: string): ReadonlyArray<string> {
  if (!localLayoutFileSystem.exists(root)) return [];
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (excludedRoot && path.resolve(current) === path.resolve(excludedRoot)) continue;
    for (const entry of localLayoutFileSystem.readDirents(current)) {
      if (entry.name === ".git") continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolutePath);
      else if (entry.isFile()) files.push(absolutePath);
    }
  }
  return files;
}

function counts(report: {
  readonly referenced: ReadonlyArray<unknown>;
  readonly orphans: ReadonlyArray<unknown>;
  readonly invalid: ReadonlyArray<unknown>;
}) {
  return {
    objectCount: report.referenced.length + report.orphans.length + report.invalid.length,
    orphanCount: report.orphans.length,
    invalidCount: report.invalid.length
  };
}

function byRef(left: CasGarbageCollectionEntry, right: CasGarbageCollectionEntry): number {
  return left.ref.localeCompare(right.ref);
}
