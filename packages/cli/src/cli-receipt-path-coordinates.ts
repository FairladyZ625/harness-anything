/**
 * Output side of the CLI path coordinate: every caller-facing path is repository-relative.
 *
 * The daemon read model keeps the ledger's canonical `packagePath` and adds the workspace spelling
 * beside it (`workspacePackagePath`) so GUI consumers that need canonical keys are unaffected. This
 * boundary prints only `workspacePackagePath` plus `ledgerPackagePath`; the canonical `packagePath`
 * name is deleted from the caller's receipt, matching the input rule: a path copied from a receipt
 * pastes back into an input flag from the same root.
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
  if (
    typeof evidence === "string" &&
    evidence.startsWith("{") &&
    (evidence.includes('"workspacePackagePath"') || typeof scoped.workspacePackagePath === "string")
  ) {
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

function rewritePackagePaths(value: unknown, pairs: readonly PackagePathPair[], translatePathFields = false): unknown {
  if (Array.isArray(value)) return value.map((nested) => rewritePackagePaths(nested, pairs, translatePathFields));
  if (!isRecord(value)) return value;
  const pair = packagePathPair(value),
    rewritten: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    // Guidance descriptors are already resolved to the caller's coordinate by their producer and are
    // read by argument name (`textArg(args, "packagePath")`), so the receipt rename must not reach
    // inside them.
    if (key === "guidance") rewritten[key] = nested;
    else if (key === "workspacePackagePath") rewritten[key] = nested;
    else if (key === "ledgerPackagePath") rewritten[key] = nested;
    else if (key === "packagePath") {
      // The old name carried the canonical key into the caller's coordinate before this boundary
      // swapped it. It is deleted, not aliased: a consumer that still reads `packagePath` now gets
      // undefined and fails at its own call site instead of silently resolving the wrong root.
      const workspace = typeof nested === "string" ? (pair?.workspace ?? rewritePath(nested, pairs)) : nested;
      if (nested === null || (typeof nested === "string" && workspace !== nested)) {
        rewritten.workspacePackagePath = workspace;
        if (typeof nested === "string") rewritten.ledgerPackagePath = nested;
      } else if (pairs.length > 0) rewritten.workspacePackagePath = workspace;
      // With no workspace pair the boundary did not produce this field, so the old name is dropped
      // rather than resurrected; a consumer that still reads `packagePath` sees undefined.
    } else if (key === "path" && translatePathFields && typeof nested === "string")
      rewritten[key] = rewritePath(nested, pairs);
    else if (key === "submission")
      // A frozen content-addressed value must keep the exact fields the digest covered.
      rewritten[key] = nested;
    else if (key === "resultDocumentClaim" || key === "artifacts")
      rewritten[key] = rewritePackagePaths(nested, pairs, true);
    else rewritten[key] = rewritePackagePaths(nested, pairs, translatePathFields);
  }
  if (pair !== null) {
    rewritten.workspacePackagePath = pair.workspace;
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
  for (const { canonical, workspace } of pairs) {
    if (rewritten === canonical) rewritten = workspace;
    else if (rewritten.startsWith(`${canonical}/`)) rewritten = `${workspace}${rewritten.slice(canonical.length)}`;
  }
  return rewritten;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
