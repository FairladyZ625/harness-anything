#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  loadPackageBoundaryContract,
  ownerForFile,
  productionSourceFiles,
  resolveRelativePackage
} from "./package-boundary-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = loadPackageBoundaryContract(root);
const { write, packageIds, fromRef } = parseArgs(process.argv.slice(2));
const selected = packageIds.length === 0 ? new Set(Object.keys(contract.packages)) : new Set(packageIds);
for (const id of selected) {
  if (!contract.packages[id]) throw new Error(`unknown package id: ${id}`);
}

let changedFiles = 0;
let changedSpecifiers = 0;
for (const file of productionSourceFiles(root, contract)) {
  const sourcePackage = ownerForFile(contract, file);
  if (!sourcePackage || !selected.has(sourcePackage.id)) continue;
  const absolute = path.join(root, file);
  const source = fromRef === undefined
    ? readFileSync(absolute, "utf8")
    : execFileSync("git", ["show", `${fromRef}:${file}`], { cwd: root, encoding: "utf8" });
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const edits = [];
  const visit = (node) => {
    const literal = moduleLiteral(node);
    if (literal && literal.text.startsWith(".")) {
      const targetPackage = resolveRelativePackage(contract, file, literal.text);
      if (targetPackage && targetPackage.id !== sourcePackage.id) {
        edits.push({
          start: literal.getStart(sourceFile) + 1,
          end: literal.getEnd() - 1,
          value: publicSpecifier(targetPackage, file, literal.text)
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (edits.length === 0) continue;
  const rewritten = edits.sort((left, right) => right.start - left.start)
    .reduce((text, edit) => `${text.slice(0, edit.start)}${edit.value}${text.slice(edit.end)}`, source);
  if (write) writeFileSync(absolute, rewritten, "utf8");
  changedFiles += 1;
  changedSpecifiers += edits.length;
}

console.log(`${write ? "Rewrote" : "Would rewrite"} ${changedSpecifiers} cross-package specifiers in ${changedFiles} files.`);

function moduleLiteral(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier;
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
    return node.argument.literal;
  }
  if (
    ts.isCallExpression(node) &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0]) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  ) {
    return node.arguments[0];
  }
  return undefined;
}

function parseArgs(args) {
  const packageIds = [];
  let write = false;
  let fromRef;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--write") { write = true; continue; }
    if (args[index] === "--package" && args[index + 1]) { packageIds.push(args[index + 1]); index += 1; continue; }
    if (args[index] === "--from-ref" && args[index + 1]) { fromRef = args[index + 1]; index += 1; continue; }
    throw new Error(`unknown option: ${args[index]}`);
  }
  return { write, packageIds, fromRef };
}

function publicSpecifier(targetPackage, importer, relativeSpecifier) {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), relativeSpecifier));
  const normalizedTarget = `./${resolved.slice(`${targetPackage.root}/`.length)}`.replace(/\.(?:js|ts)$/u, ".ts");
  if (normalizedTarget === "./src/index.ts") return targetPackage.name;
  const registration = contract.deepSubpaths.find((entry) => entry.package === targetPackage.id && entry.target === normalizedTarget);
  if (!registration) throw new Error(`unregistered deep subpath target from ${importer}: ${relativeSpecifier}`);
  return `${targetPackage.name}${registration.subpath.slice(1)}`;
}
