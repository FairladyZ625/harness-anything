import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const extensions = /\.(?:ts|tsx|mts|js|jsx|mjs)$/u;

export async function productionSourceFiles(root, excluded = new Set()) {
  const roots = [path.join(root, "packages"), path.join(root, "tools")];
  const files = [];
  for (const sourceRoot of roots) await walk(sourceRoot, files);
  return files
    .map((file) => ({ file, relative: slash(path.relative(root, file)) }))
    .filter(({ relative }) => isProductionSource(relative) && !excluded.has(relative))
    .sort((left, right) => left.relative.localeCompare(right.relative));
}

async function walk(directory, files) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (["node_modules", "dist", "out", "coverage"].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, files);
    else if (extensions.test(entry.name)) files.push(full);
  }
}

function isProductionSource(relative) {
  if (/^packages\/[^/]+\/src\//u.test(relative)) return !isTest(relative);
  if (!relative.startsWith("tools/")) return false;
  return relative.startsWith("tools/gates/") && !relative.startsWith("tools/gates/test/") && !isTest(relative);
}

function isTest(relative) {
  return /(?:^|\/)(?:test|tests|fixtures|__fixtures__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(relative);
}

export async function parsedSource(entry) {
  const text = await readFile(entry.file, "utf8");
  const kind = /\.tsx$/u.test(entry.file)
    ? ts.ScriptKind.TSX
    : /\.ts$/u.test(entry.file)
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  return { ...entry, text, source: ts.createSourceFile(entry.file, text, ts.ScriptTarget.Latest, true, kind) };
}

export function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

export function functionName(node) {
  for (let current = node; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if ((ts.isFunctionExpression(current) || ts.isArrowFunction(current)) && current.parent) {
      if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name))
        return current.parent.name.text;
      if (ts.isPropertyAssignment(current.parent)) return current.parent.name.getText();
      if (ts.isMethodDeclaration(current.parent) && current.parent.name) return current.parent.name.getText();
    }
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText();
  }
  return "<module>";
}

export function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

export function loadEntries(document, section, fields) {
  if (document?.schema !== "harness-anything/gate-allowlist/v1") throw new Error("invalid allowlist schema");
  const entries = document?.entries?.[section];
  if (!Array.isArray(entries)) throw new Error(`allowlist missing entries.${section}`);
  for (const [index, entry] of entries.entries()) {
    for (const field of fields) {
      if (typeof entry[field] !== "string" || entry[field].trim() === "") {
        throw new Error(`entries.${section}[${index}] missing ${field}`);
      }
    }
  }
  return entries;
}

export function exactSync(actualKeys, entries, keyOf, allowlistPath) {
  const expected = new Set(entries.map(keyOf));
  const actual = new Set(actualKeys);
  const missing = [...actual].filter((key) => !expected.has(key));
  const stale = [...expected].filter((key) => !actual.has(key));
  if (missing.length || stale.length) {
    const lines = [
      ...missing.map((key) => `unlisted: ${key}`),
      ...stale.map((key) => `stale: ${key}`),
      `update ${allowlistPath} with the required rationale fields`,
    ];
    throw new Error(lines.join("\n"));
  }
}

export function slash(value) {
  return value.split(path.sep).join("/");
}
