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
 */
import { documentWorkspacePath } from "@harness-anything/kernel";

type Receipt = Readonly<Record<string, unknown>>;
type PackagePathPair = { readonly canonical: string; readonly workspace: string };

export function translateReceiptPathCoordinates(receipt: Receipt, rootDir?: string): Receipt {
  // A rejected receipt still carries the transition diagnostic the caller must act on, so the
  // diagnostic path is translated before the success-only package rewrite below.
  const diagnosed = rootDir === undefined ? receipt : rewriteDiagnosticDocumentPath(receipt, rootDir);
  if (diagnosed.ok !== true) return diagnosed;
  const evidence = diagnosed.evidence;
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
  const pairs = mergePairs(
      collectPackagePathPairs(diagnosed),
      isRecord(payload) ? collectPackagePathPairs(payload) : [],
    ),
    translated = rewritePackagePaths(diagnosed, pairs) as Receipt;
  return isRecord(payload)
    ? { ...translated, evidence: JSON.stringify(rewritePackagePaths(payload, pairs)) }
    : translated;
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
