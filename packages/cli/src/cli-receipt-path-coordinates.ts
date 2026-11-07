/**
 * Output side of the CLI path coordinate: every caller-facing path is repository-relative.
 *
 * The daemon read model keeps the ledger's canonical `packagePath` and adds the workspace spelling
 * beside it (`workspacePackagePath`) so GUI consumers that need canonical keys are unaffected. This
 * boundary swaps the two on the CLI receipt and keeps the canonical value under `ledgerPackagePath`
 * for machine readers, matching the input rule: a path copied from a receipt pastes back into an
 * input flag from the same root.
 *
 * The swap is driven by the daemon-added field, not by a command list: a new receipt that carries the
 * workspace spelling gets the same translation without editing this file. The rewrite is recursive
 * because `task show` nests the same package under `task.packagePath`, progress claims and execution
 * artifacts, and because its human `summary` is rendered from that nested payload.
 *
 * Lifecycle and rematerialization receipts name ledger documents without a package pair. They get the
 * same boundary rule from the authored root's own top-level names, so the daemon keeps the authored
 * key it indexes by and the caller reads the workspace spelling it can paste back into `--path`.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import {
  consumeKnownError,
  documentWorkspacePath,
  resolveHarnessLayout,
  type HarnessLayout,
} from "@harness-anything/kernel";

type Receipt = Readonly<Record<string, unknown>>;
type PackagePathPair = { readonly canonical: string; readonly workspace: string };

// Receipt fields whose values are ledger document keys in the daemon's authored coordinate. This is
// receipt shape, not a command list: every producer that names these fields gets the same boundary
// translation, including a lifecycle or rematerialization receipt added later.
const DOCUMENT_PATH_FIELDS = ["changedPaths", "paths", "unchangedPaths", "conflictPaths"] as const;
const LIFECYCLE_FILES_EVIDENCE = /^(?<head>event-object:[^;]*);files:(?<files>.*)$/su;
// Top-level names under the authored root are what makes a relative string a ledger key rather than
// a repository path (`packages/cli/...`) or a host path. Read once per authored root.
const authoredTopLevelCache = new Map<string, readonly string[]>();

export function translateReceiptPathCoordinates(receipt: Receipt, rootDir?: string): Receipt {
  // A rejected receipt still carries the transition diagnostic the caller must act on, so the
  // diagnostic path is translated before the success-only package rewrite below.
  const diagnosed = rootDir === undefined ? receipt : rewriteDiagnosticDocumentPath(receipt, rootDir);
  if (diagnosed.ok !== true) return diagnosed;
  const scoped = rootDir === undefined ? diagnosed : translateDocumentCoordinates(diagnosed, rootDir);
  const evidence = scoped.evidence;
  let payload: unknown;
  if (typeof evidence === "string" && evidence.startsWith("{") && evidence.includes('"workspacePackagePath"')) {
    try {
      payload = JSON.parse(evidence);
    } catch (error) {
      // A malformed evidence string is the daemon's own contract breach; fail closed rather than
      // printing a half-translated path.
      throw new Error("CLI receipt evidence is not valid JSON", { cause: error });
    }
  }
  const pairs = mergePairs(collectPackagePathPairs(scoped), isRecord(payload) ? collectPackagePathPairs(payload) : []),
    translated = rewritePackagePaths(scoped, pairs) as Receipt;
  return isRecord(payload)
    ? { ...translated, evidence: JSON.stringify(rewritePackagePaths(payload, pairs)) }
    : translated;
}

/**
 * Lifecycle and rematerialization receipts name ledger documents without a `packagePath` pair, so
 * the package swap above cannot see them. The same boundary rule applies: the daemon keeps the
 * authored key it indexes by, and the caller reads the workspace spelling it can paste back in.
 */
function translateDocumentCoordinates(receipt: Receipt, rootDir: string): Receipt {
  const layout = resolveHarnessLayout(rootDir),
    topLevel = authoredTopLevelNames(layout),
    translate = (document: string): string =>
      isAuthoredDocumentPath(document, rootDir, layout, topLevel)
        ? documentWorkspacePath(rootDir, document, layout)
        : document,
    translated = rewriteDocumentPathFields(receipt, translate) as Receipt,
    evidence = translateEvidence(receipt.evidence, translate);
  return evidence === receipt.evidence ? translated : { ...translated, evidence };
}

function rewriteDocumentPathFields(value: unknown, translate: (document: string) => string): unknown {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((nested) => rewriteDocumentPathFields(nested, translate));
  if (!isRecord(value)) return value;
  const rewritten: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    // `ledgerPackagePath` is the canonical value the caller's machine readers may key by.
    if (key === "ledgerPackagePath") rewritten[key] = nested;
    else if ((DOCUMENT_PATH_FIELDS as readonly string[]).includes(key))
      rewritten[key] = rewritePathList(nested, translate);
    else rewritten[key] = rewriteDocumentPathFields(nested, translate);
  }
  return rewritten;
}

function rewritePathList(value: unknown, translate: (document: string) => string): unknown {
  if (typeof value === "string") return translate(value);
  if (Array.isArray(value)) return value.map((nested) => rewritePathList(nested, translate));
  return isRecord(value) ? rewriteDocumentPathFields(value, translate) : value;
}

function translateEvidence(evidence: unknown, translate: (document: string) => string): unknown {
  if (typeof evidence !== "string") return evidence;
  const lifecycle = LIFECYCLE_FILES_EVIDENCE.exec(evidence);
  if (lifecycle?.groups !== undefined)
    return `${lifecycle.groups.head};files:${lifecycle.groups.files!.split(",").map(translate).join(",")}`;
  const report = rematerializationReport(evidence);
  return report === null ? evidence : JSON.stringify(rewriteDocumentPathFields(report, translate));
}

/** A rematerialization report is the one JSON evidence body that carries authored path arrays. */
function rematerializationReport(evidence: string): Record<string, unknown> | null {
  if (!evidence.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(evidence);
  } catch (error) {
    // Any other JSON-looking evidence is not this receipt; leave it byte-for-byte alone.
    consumeKnownError(error);
    return null;
  }
  return isRecord(parsed) && Array.isArray(parsed.targets) && typeof parsed.writeStatus === "string" ? parsed : null;
}

function authoredTopLevelNames(layout: HarnessLayout): readonly string[] {
  const cached = authoredTopLevelCache.get(layout.authoredRoot);
  if (cached !== undefined) return cached;
  let names: string[] = [];
  try {
    names = readdirSync(layout.authoredRoot);
  } catch (error) {
    // A workspace without a ledger has no authored keys to translate; other read failures surface.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    consumeKnownError(error);
  }
  const topLevel = layout.configPath === undefined ? names : [...names, path.basename(layout.configPath)];
  authoredTopLevelCache.set(layout.authoredRoot, topLevel);
  return topLevel;
}

function isAuthoredDocumentPath(
  value: string,
  rootDir: string,
  layout: HarnessLayout,
  topLevel: readonly string[],
): boolean {
  if (value === "" || path.isAbsolute(value) || value === ".." || value.startsWith("../")) return false;
  const workspacePrefix = path.relative(rootDir, layout.authoredRoot).split(path.sep).join("/");
  // Already the workspace spelling (or the workspace root is the ledger root and the two agree).
  if (workspacePrefix === "" || value === workspacePrefix || value.startsWith(`${workspacePrefix}/`)) return false;
  return topLevel.includes(value.split("/")[0]!);
}

/**
 * A transition-readiness diagnostic is rendered by the daemon from the authored key it projected.
 * The CLI boundary prints the same path the caller can paste back into a --path flag.
 */
function rewriteDiagnosticDocumentPath(receipt: Receipt, rootDir: string): Receipt {
  const diagnostic = receipt.diagnostic;
  if (!isRecord(diagnostic) || typeof diagnostic.documentPath !== "string") return receipt;
  return {
    ...receipt,
    diagnostic: { ...diagnostic, documentPath: documentWorkspacePath(rootDir, diagnostic.documentPath) },
  };
}

function collectPackagePathPairs(value: unknown, pairs: PackagePathPair[] = []): PackagePathPair[] {
  if (Array.isArray(value)) {
    for (const nested of value) collectPackagePathPairs(nested, pairs);
    return pairs;
  }
  if (!isRecord(value)) return pairs;
  const canonical = value.packagePath,
    workspace = value.workspacePackagePath;
  if (typeof canonical === "string" && typeof workspace === "string") pairs.push({ canonical, workspace });
  for (const [key, nested] of Object.entries(value))
    if (key !== "ledgerPackagePath") collectPackagePathPairs(nested, pairs);
  return pairs;
}

function mergePairs(left: readonly PackagePathPair[], right: readonly PackagePathPair[]): readonly PackagePathPair[] {
  const byCanonical = new Map<string, string>();
  for (const pair of [...left, ...right]) byCanonical.set(pair.canonical, pair.workspace);
  return [...byCanonical]
    .map(([canonical, workspace]) => ({ canonical, workspace }))
    .sort((one, two) => two.canonical.length - one.canonical.length);
}

function rewritePackagePaths(value: unknown, pairs: readonly PackagePathPair[]): unknown {
  if (typeof value === "string") return rewritePath(value, pairs);
  if (Array.isArray(value)) return value.map((nested) => rewritePackagePaths(nested, pairs));
  if (!isRecord(value)) return value;
  const pair = packagePathPair(value),
    rewritten: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "workspacePackagePath") continue;
    rewritten[key] = key === "ledgerPackagePath" ? nested : rewritePackagePaths(nested, pairs);
  }
  if (pair !== null) {
    rewritten.packagePath = pair.workspace;
    rewritten.ledgerPackagePath = pair.canonical;
  }
  return rewritten;
}

function packagePathPair(value: Record<string, unknown>): PackagePathPair | null {
  const canonical = value.packagePath,
    workspace = value.workspacePackagePath;
  return typeof canonical === "string" && typeof workspace === "string" ? { canonical, workspace } : null;
}

function rewritePath(value: string, pairs: readonly PackagePathPair[]): string {
  let rewritten = value;
  for (const [index, { canonical, workspace }] of pairs.entries()) {
    if (!rewritten.includes(canonical)) continue;
    // Protect the already-workspace spelling first: it contains the canonical spelling as a
    // substring (`harness/tasks/x` contains `tasks/x`), and a blind replace would double the prefix.
    // The marker is index-based, not the path itself, so the canonical replace cannot touch it.
    const protectedWorkspace = `\u0000${index}\u0000`;
    rewritten = rewritten.split(workspace).join(protectedWorkspace);
    rewritten = rewritten.split(canonical).join(workspace);
    rewritten = rewritten.split(protectedWorkspace).join(workspace);
  }
  return rewritten;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
