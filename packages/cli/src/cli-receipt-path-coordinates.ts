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
 * Lifecycle and rematerialization receipts name ledger documents without a package pair. The daemon
 * adds the authored root's spelling (`workspacePathPrefix`) to those receipts; this boundary prefixes
 * the document fields with it and drops the transport marker. The thin CLI must not import the kernel
 * layout module, so the prefix is data the receipt carries, not a layout lookup performed here.
 */
type Receipt = Readonly<Record<string, unknown>>;
type PackagePathPair = { readonly canonical: string; readonly workspace: string };

// Receipt fields whose values are ledger document keys in the daemon's authored coordinate. This is
// receipt shape, not a command list: every producer that names these fields gets the same boundary
// translation, including a lifecycle or rematerialization receipt added later.
const DOCUMENT_PATH_FIELDS = [
  "changedPaths",
  "destination",
  "documentPath",
  "dispatchPath",
  "paths",
  "reportPath",
  "unchangedPaths",
  "conflictPaths",
] as const;
const LIFECYCLE_FILES_EVIDENCE = /^(?<head>event-object:[^;]*);files:(?<files>.*)$/su;
const WORKSPACE_PATH_PREFIX = "workspacePathPrefix";

export function translateReceiptPathCoordinates(receipt: Receipt): Receipt {
  const scoped = translateDocumentCoordinates(receipt);
  if (scoped.ok !== true) return scoped;
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
 * Lifecycle and rematerialization receipts carry the authored root's workspace spelling. The daemon
 * keeps the authored key it indexes by; this boundary prefixes the document fields and removes the
 * marker so it never becomes part of the caller's contract.
 */
function translateDocumentCoordinates(receipt: Receipt): Receipt {
  const diagnostic = receipt.diagnostic,
    prefix = receipt[WORKSPACE_PATH_PREFIX] ?? (isRecord(diagnostic) ? diagnostic[WORKSPACE_PATH_PREFIX] : undefined);
  if (typeof prefix !== "string" || prefix === "") return receipt;
  const { [WORKSPACE_PATH_PREFIX]: _prefix, diagnostic: _diagnostic, ...rest } = receipt,
    translate = (document: string): string => workspaceDocument(prefix, document),
    translated = rewriteDocumentPathFields(rest, translate) as Record<string, unknown>,
    evidence = translateEvidence(rest.evidence, translate);
  if (isRecord(diagnostic)) {
    const { [WORKSPACE_PATH_PREFIX]: _diagnosticPrefix, ...documentPathDiagnostic } = diagnostic;
    translated.diagnostic = rewriteDocumentPathFields(documentPathDiagnostic, translate);
  }
  return evidence === rest.evidence ? translated : { ...translated, evidence };
}

function workspaceDocument(prefix: string, document: string): string {
  if (document === "" || document.startsWith("/") || document === ".." || document.startsWith("../")) return document;
  return document === prefix || document.startsWith(`${prefix}/`) ? document : `${prefix}/${document}`;
}

function rewriteDocumentPathFields(value: unknown, translate: (document: string) => string): unknown {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((nested) => rewriteDocumentPathFields(nested, translate));
  if (!isRecord(value)) return value;
  const rewritten: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    // `ledgerPackagePath` is the canonical value the caller's machine readers may key by.
    if (key === "ledgerPackagePath") rewritten[key] = nested;
    else if (key === "ruling" && isRecord(nested) && typeof nested.path === "string")
      rewritten[key] = { ...nested, path: translate(nested.path) };
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
  // Only a report carrying both markers is parsed; a document body that merely starts with `{`
  // is not this receipt and keeps its bytes.
  if (!evidence.startsWith("{") || !evidence.includes('"writeStatus"') || !evidence.includes('"targets"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(evidence);
  } catch (error) {
    throw new Error("rematerialization evidence is not valid JSON", { cause: error });
  }
  return isRecord(parsed) && Array.isArray(parsed.targets) && typeof parsed.writeStatus === "string" ? parsed : null;
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
