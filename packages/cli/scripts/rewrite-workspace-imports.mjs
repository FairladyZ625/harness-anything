#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(cliRoot, "../..");
const distRoot = path.join(cliRoot, "dist");
const contract = JSON.parse(readFileSync(path.join(repoRoot, "tools/package-boundaries.json"), "utf8"));
const packages = Object.entries(contract.packages).map(([id, pkg]) => ({ id, ...pkg }));
const packageByName = [...packages].sort((left, right) => right.name.length - left.name.length);
const deepSubpaths = new Map(contract.deepSubpaths.map((entry) => [`${entry.package}:${entry.subpath}`, entry.target]));

let rewrittenFiles = 0;
let rewrittenSpecifiers = 0;
for (const file of walk(distRoot).filter((candidate) => /\.(?:js|d\.ts)$/u.test(candidate))) {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const edits = [];
  const visit = (node) => {
    const literal = moduleLiteral(node);
    if (literal) {
      const target = resolveWorkspaceTarget(literal.text);
      if (target) edits.push({ start: literal.getStart(sourceFile) + 1, end: literal.getEnd() - 1, value: relativeModule(file, target) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (edits.length === 0) continue;
  const rewritten = edits.sort((left, right) => right.start - left.start)
    .reduce((text, edit) => `${text.slice(0, edit.start)}${edit.value}${text.slice(edit.end)}`, source);
  writeFileSync(file, rewritten, "utf8");
  rewrittenFiles += 1;
  rewrittenSpecifiers += edits.length;
}

console.log(`Rewrote ${rewrittenSpecifiers} workspace import specifiers in ${rewrittenFiles} CLI distribution files.`);

function resolveWorkspaceTarget(specifier) {
  const pkg = packageByName.find((candidate) => specifier === candidate.name || specifier.startsWith(`${candidate.name}/`));
  if (!pkg) return undefined;
  const subpath = specifier.slice(pkg.name.length);
  let target;
  if (!subpath) {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, pkg.root, "package.json"), "utf8"));
    const rootExport = manifest.exports?.["."];
    target = typeof rootExport === "string" ? rootExport : rootExport?.default;
  } else {
    target = deepSubpaths.get(`${pkg.id}:.${subpath}`);
  }
  if (!target) throw new Error(`cannot resolve workspace package export in CLI distribution: ${specifier}`);
  const outputRoot = path.join(distRoot, pkg.root.slice("packages/".length));
  return path.join(outputRoot, target.replace(/^\.\//u, "").replace(/\.ts$/u, ".js"));
}

function relativeModule(importer, target) {
  const relative = path.relative(path.dirname(importer), target).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function moduleLiteral(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) return node.argument.literal;
  if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return node.arguments[0];
  return undefined;
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(entryPath) : entry.isFile() ? [entryPath] : [];
  });
}
