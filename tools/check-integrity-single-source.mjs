import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { listWorktreeFiles } from "./gates/git.mjs";

// Authorities are declared where the canonical implementations live: a
// `// @canonical-substrate <symbol> ...` marker line in each authority file
// (ADR-0022 D3/D6; dec_F5B2CBF8B45042B6DA2824A7FA/CH2b). The gate only reads
// markers, never defines the symbol list itself. Symbol list parsing stops at
// the first non-identifier token, so trailing prose stays legal.
const markerTag = "@canonical-substrate";
const markerLinePattern = /\/\/\s*@canonical-substrate\b([^\n]*)/gu;
const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

const root = process.cwd();
const sourceFile = /\.(?:ts|tsx|mts|js|jsx|mjs)$/;
const violations = [];

const scannedFiles = listWorktreeFiles(root, ["packages"]).filter((file) => sourceFile.test(file));
if (scannedFiles.length === 0)
  throw new Error("check-integrity-single-source: required scan root packages has no source files");

const fileTexts = new Map();
for (const rel of scannedFiles) fileTexts.set(rel, await readFile(path.join(root, rel), "utf8"));

const authorities = collectMarkerAuthorities();
if (authorities.size === 0) {
  throw new Error(
    `check-integrity-single-source: no ${markerTag} declarations found under packages; ` +
      "removing every marker would silently drop single-source protection",
  );
}

for (const [symbol, claims] of authorities) {
  if (claims.size > 1) {
    violations.push(`${markerTag} claims for ${symbol} in multiple files: ${[...claims].sort().join(", ")}`);
  }
  for (const claim of claims) {
    if (!findDefinedSymbols(fileTexts.get(claim), new Set([symbol])).has(symbol)) {
      violations.push(`${claim}: ${markerTag} marker does not define ${symbol} in this file`);
    }
  }
}

const allSymbols = new Set(authorities.keys());
for (const rel of scannedFiles) {
  const text = fileTexts.get(rel);
  const candidates = new Set([...allSymbols].filter((symbol) => text.includes(symbol)));
  if (candidates.size > 0) {
    for (const symbol of findDefinedSymbols(text, candidates)) {
      if (authorities.get(symbol).has(rel)) continue;
      violations.push(
        `${rel}: duplicate ${symbol} implementation; import from ${[...authorities.get(symbol)].sort()[0]}`,
      );
    }
  }
  // Structural duplicate detection independent of names: the stable payload
  // hash pipeline may only be spelled out in the stableStringify authority.
  const hashAuthority = authorities.get("stableStringify");
  if (!hashAuthority?.has(rel) && /createHash\(\s*["']sha256["']\s*\)\.update\(\s*stableStringify\(/u.test(text)) {
    violations.push(
      `${rel}: duplicate stable payload hash implementation; import from packages/kernel/src/integrity/stable-hash.ts`,
    );
  }
}

if (violations.length > 0) {
  console.error("Integrity single-source violations found:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Integrity single-source check passed.");

function collectMarkerAuthorities() {
  const claims = new Map();
  for (const rel of scannedFiles) {
    for (const match of fileTexts.get(rel).matchAll(markerLinePattern)) {
      const symbols = [];
      for (const token of match[1].split(/\s+/u)) {
        if (token === "") continue;
        if (!identifierPattern.test(token)) break;
        symbols.push(token);
      }
      if (symbols.length === 0) {
        violations.push(`${rel}: ${markerTag} marker declares no symbols`);
        continue;
      }
      for (const symbol of symbols) {
        if (!claims.has(symbol)) claims.set(symbol, new Set());
        claims.get(symbol).add(rel);
      }
    }
  }
  return claims;
}

// Definitions live in more shapes than a regex sees: function/class
// declarations, variable initializers, class methods, object-literal function
// properties, class fields holding arrow/function values, and accessors. Class
// fields and accessors are not optional coverage: arrow-valued class fields are
// the dominant local style under packages/*/src, so a reimplementation written
// that way would otherwise be invisible. Plain data properties (e.g. a
// `sha256Bytes` counter), shorthand forwarding (`{ stablePayloadHash }`) and
// field-to-field forwarding (`stableStringify = this.forwarded`) bind the name
// without implementing it, so they stay legal.
function findDefinedSymbols(text, symbols) {
  const defined = new Set();
  const source = ts.createSourceFile("gate-scan.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  visit(source);
  return defined;

  function visit(node) {
    const name = definitionName(node);
    if (name !== null && symbols.has(name)) defined.add(name);
    ts.forEachChild(node, visit);
  }

  function definitionName(node) {
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      return node.name?.text ?? null;
    }
    if (ts.isVariableDeclaration(node)) return ts.isIdentifier(node.name) ? node.name.text : null;
    if (ts.isMethodDeclaration(node)) {
      return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
    }
    if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
    }
    if (ts.isPropertyAssignment(node)) {
      if (!ts.isIdentifier(node.name) && !ts.isStringLiteral(node.name)) return null;
      return isFunctionValue(node.initializer) ? node.name.text : null;
    }
    if (ts.isPropertyDeclaration(node)) {
      if (!ts.isIdentifier(node.name) && !ts.isStringLiteral(node.name)) return null;
      return node.initializer !== undefined && isFunctionValue(node.initializer) ? node.name.text : null;
    }
    return null;
  }

  // `f = (v) => …` and `f = function (v) {…}` are the two direct forms; a type
  // assertion or parentheses around either one does not change what it is.
  function isFunctionValue(node) {
    let current = node;
    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
    }
    return ts.isArrowFunction(current) || ts.isFunctionExpression(current);
  }
}
