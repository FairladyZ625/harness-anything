import { createHash, type Hash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import type { AuthorityProductionRepoScan } from "../../../application/src/index.ts";
import { readAuthorityGitBytes } from "./authority-publication-evidence.ts";

export function createAuthorityProductionScanner(input: {
  readonly authoredRoot: string;
}): { readonly scan: () => Promise<AuthorityProductionRepoScan> } {
  const authoredRoot = path.resolve(input.authoredRoot);
  return {
    scan: async () => {
      const headCommit = readCutoverGitText(authoredRoot, ["rev-parse", "HEAD"]);
      const headTree = readCutoverGitText(authoredRoot, ["rev-parse", "HEAD^{tree}"]);
      const index = readAuthorityGitBytes(authoredRoot, "ls-files", "-s", "-z");
      const status = readAuthorityGitBytes(authoredRoot,
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files=all",
        "--ignored=matching"
      );
      const diff = readAuthorityGitBytes(authoredRoot, "diff", "--no-ext-diff", "--binary", "HEAD", "--");
      const untracked = readAuthorityGitBytes(authoredRoot, "ls-files", "--others", "--exclude-standard", "--directory", "--no-empty-directory", "-z");
      const ignored = readAuthorityGitBytes(authoredRoot, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "-z");
      const untrackedDigest = selectedPathInventoryDigest(authoredRoot, untracked, "ha/authority-cutover-untracked-inventory/v1\0");
      const ignoredDigest = selectedPathInventoryDigest(authoredRoot, ignored, "ha/authority-cutover-ignored-inventory/v1\0");
      return {
        schema: "authority-production-repo-scan/v1",
        headCommit,
        headTree,
        indexDigest: bytesDigest("ha/authority-cutover-git-index/v1\0", [index]),
        workingTreeDigest: bytesDigest("ha/authority-cutover-git-worktree/v1\0", [
          status,
          diff,
          Buffer.from(untrackedDigest, "hex"),
          Buffer.from(ignoredDigest, "hex")
        ]),
        rawLocal: rawLocalObservation(authoredRoot)
      };
    }
  };
}

function rawLocalObservation(authoredRoot: string): AuthorityProductionRepoScan["rawLocal"] {
  const candidate = path.join(authoredRoot, "raw-local");
  try {
    const stat = lstatSync(candidate);
    const kind = stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : "other";
    const targetDigest = stat.isSymbolicLink()
      ? bytesDigest("ha/authority-cutover-raw-local-link/v1\0", [Buffer.from(readlinkSync(candidate), "utf8")])
      : null;
    return {
      kind,
      mode: stat.mode,
      targetDigest,
      treeDigest: selectedPathInventoryDigest(authoredRoot, Buffer.from("raw-local\0", "utf8"), "ha/authority-cutover-raw-local-tree/v1\0")
    };
  } catch (error) {
    if (isMissing(error)) return { kind: "missing", mode: null, targetDigest: null, treeDigest: null };
    throw error;
  }
}

function selectedPathInventoryDigest(root: string, nulPaths: Uint8Array, domain: string): string {
  const hash = createHash("sha256").update(domain, "utf8");
  const selected = Buffer.from(nulPaths).toString("utf8").split("\0")
    .filter(Boolean)
    .map((entry) => entry.endsWith("/") ? entry.slice(0, -1) : entry)
    .sort();
  for (const relativePath of selected) updateInventoryEntry(hash, root, relativePath);
  return hash.digest("hex");
}

function updateInventoryEntry(hash: Hash, root: string, relativePath: string): void {
  const absolutePath = path.join(root, relativePath);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absolutePath);
  } catch (error) {
    if (isMissing(error)) {
      updateFramed(hash, Buffer.from(relativePath, "utf8"));
      updateFramed(hash, Buffer.from("missing", "utf8"));
      return;
    }
    throw error;
  }
  const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
  updateFramed(hash, Buffer.from(relativePath, "utf8"));
  updateFramed(hash, Buffer.from(`${kind}\0${stat.mode}\0${stat.size}`, "utf8"));
  if (kind === "symlink") {
    updateFramed(hash, Buffer.from(readlinkSync(absolutePath), "utf8"));
    return;
  }
  if (kind === "file") {
    updateFramed(hash, readFileSync(absolutePath));
    return;
  }
  if (kind === "directory") {
    for (const child of readdirSync(absolutePath).sort()) {
      updateInventoryEntry(hash, root, path.posix.join(relativePath.replaceAll(path.sep, "/"), child));
    }
  }
}

function updateFramed(hash: Hash, value: Uint8Array): void {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(value.byteLength));
  hash.update(size).update(value);
}

function readCutoverGitText(root: string, args: ReadonlyArray<string>): string {
  return readAuthorityGitBytes(root, ...args).toString("utf8").trim();
}

function bytesDigest(domain: string, values: ReadonlyArray<Uint8Array>): string {
  const hash = createHash("sha256").update(domain, "utf8");
  for (const value of values) {
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(value.byteLength));
    hash.update(size).update(value);
  }
  return hash.digest("hex");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOENT";
}
