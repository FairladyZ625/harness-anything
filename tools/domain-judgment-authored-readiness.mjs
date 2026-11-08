/**
 * Authored-document readiness ratchet for the domain-judgment single-definition gate.
 * Authority: dec_6B912A63D279A922FA1288536D CH2 — readiness of a task plan or other authored
 * document is judged once, in the kernel (`assessTransitionDocument` and its asserting form in
 * packages/kernel/src/domain/transition-document-readiness.ts), over the canonical body a read
 * port supplies. An adapter in daemon, application, or CLI production code that reads the
 * authored file itself and then judges it — with the kernel function or with a predicate of its
 * own — is a second readiness authority.
 *
 * The scan is per named scope. A scope "reads authored bytes" when it calls a filesystem read
 * directly, or calls a same-file function that does (transitively). Two site kinds are recorded:
 *   - `local-read-kernel-readiness`: the scope reads bytes and hands them to the kernel judgment.
 *   - `local-readiness-derivation`: the scope reads bytes and decides readiness without the kernel.
 * Existing sites are frozen in the baseline and may only be removed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { authoredDocumentReadinessBaseline } from "./gate-allowlists/authored-document-readiness-baseline.mjs";
import { git, listWorktreeFiles } from "./gates/git.mjs";

export const AUTHORED_READINESS_BASELINE = "tools/gate-allowlists/authored-document-readiness-baseline.mjs";
const BASELINE_SCHEMA = "authored-document-readiness-baseline/v1";
const SCOPES = Object.freeze(["packages/daemon/src", "packages/application/src", "packages/cli/src"]);
const FS_READS = new Set(["readFileSync", "readFile"]);
const KERNEL_READINESS = new Set(["assessTransitionDocument", "assertTransitionDocumentReady"]);
const READINESS_WORDS = new Set(["ready", "not_ready"]);
const READINESS_BINDING = /^(?:is|plan|doc|document|content)?ready$/iu;

export function scanAuthoredReadinessSites(root = process.cwd()) {
  const sites = [];
  for (const rel of listWorktreeFiles(root, [...SCOPES]).filter(
    (file) =>
      /\.(?:ts|tsx|mts|js|jsx|mjs)$/u.test(file) &&
      !/(?:^|\/)(?:test|tests|fixtures)\//u.test(file) &&
      !/\.(?:test|spec|vitest)\.[cm]?[jt]sx?$/u.test(file),
  ))
    sites.push(...scanFile(rel, readFileSync(path.join(root, rel), "utf8")));
  return sites.sort((left, right) => siteKey(left).localeCompare(siteKey(right)));
}

function scanFile(rel, body) {
  const source = ts.createSourceFile(rel, body, ts.ScriptTarget.Latest, true, scriptKind(rel)),
    scopes = new Map(),
    scopeOf = (symbol) => {
      if (!scopes.has(symbol)) scopes.set(symbol, { reads: false, calls: new Set(), kernel: [], derived: [] });
      return scopes.get(symbol);
    };
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression),
        scope = scopeOf(enclosingSymbol(node));
      if (callee !== null && FS_READS.has(callee)) scope.reads = true;
      else if (callee !== null && KERNEL_READINESS.has(callee)) scope.kernel.push(node);
      else if (callee !== null && ts.isIdentifier(node.expression)) scope.calls.add(callee);
    }
    if (ts.isReturnStatement(node) && node.expression && readinessLiteral(node.expression))
      scopeOf(enclosingSymbol(node)).derived.push(node);
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
        node.operatorToken.kind,
      ) &&
      ((readinessLiteral(node.left) && !projectionReadStatus(node.right)) ||
        (readinessLiteral(node.right) && !projectionReadStatus(node.left)))
    )
      scopeOf(enclosingSymbol(node)).derived.push(node);
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) &&
      node.initializer &&
      booleanJudgment(node.initializer) &&
      READINESS_BINDING.test(propertyName(node.name) ?? "")
    )
      scopeOf(enclosingSymbol(node)).derived.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  // A scope reads authored bytes when it reads the filesystem itself or through a same-file helper.
  let changed = true;
  while (changed) {
    changed = false;
    for (const scope of scopes.values())
      if (!scope.reads && [...scope.calls].some((callee) => scopes.get(callee)?.reads)) {
        scope.reads = true;
        changed = true;
      }
  }
  const sites = [],
    add = (nodes, symbol, kind) =>
      sites.push({
        path: rel,
        symbol,
        kind,
        fingerprint: createHash("sha256")
          .update(`${rel}\0${symbol}\0${kind}`)
          .update(nodes.map((node) => `\0${node.getText(source).replace(/\s+/gu, " ").trim()}`).join(""))
          .digest("hex"),
      });
  for (const [symbol, scope] of scopes) {
    if (!scope.reads) continue;
    // One site per scope: dataflow from the read to each judgment call is not traced, so the
    // scope, not the call, is the unit that must stop reading authored bytes.
    if (scope.kernel.length > 0) add(scope.kernel, symbol, "local-read-kernel-readiness");
    else if (scope.derived.length > 0) add(scope.derived, symbol, "local-readiness-derivation");
  }
  return sites;
}

export function checkAuthoredReadinessSites(sites, baseline, priorBaseline = null) {
  const findings = [],
    entries = Array.isArray(baseline?.entries) ? baseline.entries : [],
    allowed = countEntries(entries, siteKey);
  if (baseline?.schema !== BASELINE_SCHEMA)
    findings.push(`${AUTHORED_READINESS_BASELINE}: invalid or missing authored-document readiness baseline`);
  for (const site of sites) {
    const key = siteKey(site),
      remaining = allowed.get(key) ?? 0;
    if (remaining === 0)
      findings.push(
        `${site.path}#${site.symbol}: new ${site.kind} authored-document readiness judgment (${site.fingerprint}); ` +
          "read the canonical body through the projection port and judge it with the kernel assessTransitionDocument",
      );
    else allowed.set(key, remaining - 1);
  }
  for (const [key, count] of allowed)
    if (count > 0) findings.push(`${AUTHORED_READINESS_BASELINE}: stale baseline entry should be removed: ${key}`);
  // Growth is counted per scope and kind, so re-fingerprinting an edited site is not growth.
  if (priorBaseline !== null) {
    const prior = countEntries(priorBaseline, scopeKey);
    for (const [key, count] of countEntries(entries, scopeKey))
      if (count > (prior.get(key) ?? 0))
        findings.push(`${AUTHORED_READINESS_BASELINE}: baseline may only shrink; added ${key}`);
  }
  return findings;
}

export function authoredReadinessFindings(root, baseline = authoredDocumentReadinessBaseline) {
  return checkAuthoredReadinessSites(scanAuthoredReadinessSites(root), baseline, previousBaselineEntries(root));
}

/** The baseline module text, generated from the scanner so N0 is the scan's own output. */
export function renderAuthoredReadinessBaseline(root = process.cwd()) {
  const entries = scanAuthoredReadinessSites(root)
    .map((site) =>
      [
        "    {",
        ...["path", "symbol", "kind", "fingerprint"].map((key) => `      ${key}: ${JSON.stringify(site[key])},`),
        "    },",
      ].join("\n"),
    )
    .join("\n");
  return [
    "// Authored-document readiness sites frozen by dec_6B912A63D279A922FA1288536D CH2.",
    "// Generated by `node tools/check-domain-judgment-single-definition.mjs --print-authored-readiness-baseline`.",
    "// Entries may only be removed: migrate a site to the canonical read port, then delete its row.",
    "export const authoredDocumentReadinessBaseline = Object.freeze({",
    `  schema: "${BASELINE_SCHEMA}",`,
    "  entries: Object.freeze([",
    entries,
    "  ]),",
    "});",
    "",
  ].join("\n");
}

function previousBaselineEntries(root) {
  let text;
  try {
    text = git(root, ["show", `${process.env.PR_BASE_SHA ?? "origin/main"}:${AUTHORED_READINESS_BASELINE}`]);
  } catch {
    // No base ref, or the baseline predates the base: the shrink check has nothing to compare.
    return null;
  }
  // The base revision's module is evaluated as data in an empty context; it imports nothing.
  const sandbox = {};
  runInNewContext(text.replace(/^\s*export\s+const\s+authoredDocumentReadinessBaseline\s*=/mu, "baseline ="), sandbox);
  const previous = sandbox.baseline;
  return previous?.schema === BASELINE_SCHEMA && Array.isArray(previous.entries) ? previous.entries : [];
}

function countEntries(entries, key) {
  const counts = new Map();
  for (const entry of entries) counts.set(key(entry), (counts.get(key(entry)) ?? 0) + 1);
  return counts;
}

function siteKey(entry) {
  return `${entry.path}|${entry.symbol}|${entry.kind}|${entry.fingerprint}`;
}

function scopeKey(entry) {
  return `${entry.path}|${entry.symbol}|${entry.kind}`;
}

function readinessLiteral(node) {
  return ts.isStringLiteralLike(node) && READINESS_WORDS.has(node.text);
}

const BOOLEAN_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);
const BOOLEAN_PROBES = new Set(["includes", "test", "startsWith", "endsWith", "some", "every"]);

// A readiness binding is a judgment only when it is computed as a boolean, not a promise or handle.
function booleanJudgment(node) {
  const expression = ts.isParenthesizedExpression(node) ? node.expression : node;
  return (
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) ||
    (ts.isBinaryExpression(expression) && BOOLEAN_OPERATORS.has(expression.operatorToken.kind)) ||
    (ts.isCallExpression(expression) && BOOLEAN_PROBES.has(calleeName(expression.expression) ?? ""))
  );
}

// `read.status === "ready"` asks whether a projection read caught up, not whether a document is ready.
function projectionReadStatus(node) {
  return ts.isPropertyAccessExpression(node) && node.name.text === "status";
}

function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function enclosingSymbol(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    if (current.name && ts.isIdentifier(current.name)) return current.name.text;
    if (ts.isMethodDeclaration(current)) return propertyName(current.name) ?? "<method>";
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && current.parent) {
      if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name))
        return current.parent.name.text;
      if (ts.isPropertyAssignment(current.parent)) return propertyName(current.parent.name) ?? "<property>";
    }
  }
  return "<module>";
}

function propertyName(node) {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null;
}

function scriptKind(file) {
  return file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : file.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$/u.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
}
