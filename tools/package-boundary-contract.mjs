import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export function loadPackageBoundaryContract(root) {
  const contract = JSON.parse(readFileSync(path.join(root, "tools/package-boundaries.json"), "utf8"));
  if (contract.schema !== "harness-anything/package-boundaries/v1") {
    throw new Error(`unsupported package boundary schema: ${String(contract.schema)}`);
  }
  const entries = Object.entries(contract.packages ?? {});
  if (entries.length === 0) throw new Error("package boundary contract must declare packages");
  const ids = new Set(entries.map(([id]) => id));
  for (const [id, pkg] of entries) {
    if (!pkg.name || !pkg.root || !Array.isArray(pkg.allowedDependencies)) {
      throw new Error(`invalid package boundary entry: ${id}`);
    }
    for (const dependency of pkg.allowedDependencies) {
      if (!ids.has(dependency)) throw new Error(`${id} allows unknown package id: ${dependency}`);
    }
  }
  for (const entry of contract.deepSubpaths ?? []) {
    if (!entry.package || !entry.subpath || !entry.target || !entry.owner || !entry.sunset || !Number.isInteger(entry.maxProductionConsumers) || entry.maxProductionConsumers < 0) {
      throw new Error("every deep subpath registration requires package, subpath, target, owner, sunset, and a non-negative maxProductionConsumers ratchet");
    }
    if (!ids.has(entry.package)) throw new Error(`deep subpath references unknown package id: ${entry.package}`);
  }
  return contract;
}

export function packageEntries(contract) {
  return Object.entries(contract.packages).map(([id, value]) => ({ id, ...value }));
}

export function ownerForFile(contract, file) {
  const normalized = file.split(path.sep).join("/");
  return packageEntries(contract)
    .sort((left, right) => right.root.length - left.root.length)
    .find((pkg) => normalized === pkg.root || normalized.startsWith(`${pkg.root}/`));
}

export function packageForSpecifier(contract, specifier) {
  return packageEntries(contract).find((pkg) => specifier === pkg.name || specifier.startsWith(`${pkg.name}/`));
}

export function resolveRelativePackage(contract, importer, specifier) {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  return ownerForFile(contract, target);
}

export function moduleSpecifiers(file, source) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const values = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      values.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      values.push(node.argument.literal.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      values.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return values;
}

export function sourcePathSpecifiers(file, source) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const values = [];
  const moduleLiterals = new Set();
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      moduleLiterals.add(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      moduleLiterals.add(node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      moduleLiterals.add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const collect = (node) => {
    if (ts.isStringLiteral(node) && !moduleLiterals.has(node) && node.text.startsWith(".") && node.text.includes("/src/")) values.push(node.text);
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  return values;
}

export function productionSourceFiles(root, contract) {
  return packageEntries(contract).flatMap((pkg) => walk(path.join(root, pkg.root)))
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .filter((file) => file.includes("/src/") && /\.(?:c|m)?(?:j|t)sx?$/u.test(file))
    .filter((file) => !/(?:^|\/)(?:test|tests|fixtures|__tests__)(?:\/|$)/u.test(file))
    .filter((file) => !/\.(?:test|spec)\.(?:c|m)?(?:j|t)sx?$/u.test(file))
    .sort();
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : walk(entryPath);
    return entry.isFile() ? [entryPath] : [];
  });
}
