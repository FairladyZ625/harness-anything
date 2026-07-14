#!/usr/bin/env node

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);

export function probeProductionConsumers(options) {
  const root = path.resolve(options.root);
  const definitions = options.definitions.map((definition) => normalizeDefinition(root, definition));
  const definitionKeys = new Set(definitions.map((definition) => definition.key));
  const excluded = new Set([
    ...definitions.map((definition) => definition.file),
    ...options.excludes.map((file) => normalizeRelativePath(file))
  ]);
  const consumerFiles = discoverConsumerFiles(root, options.consumerRoots)
    .filter((file) => !excluded.has(relativePath(root, file)));

  if (consumerFiles.length === 0) {
    throw new Error("no production TypeScript files found under the declared consumer roots");
  }
  for (const definition of definitions) {
    if (!existsSync(path.join(root, definition.file))) {
      throw new Error(`definition file does not exist: ${definition.file}`);
    }
  }

  const rootNames = [...new Set([
    ...consumerFiles,
    ...definitions.map((definition) => path.join(root, definition.file))
  ])];
  const program = ts.createProgram({
    rootNames,
    options: {
      allowImportingTsExtensions: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext
    }
  });
  const checker = program.getTypeChecker();
  assertDefinitionsExist(program, checker, root, definitions);

  const matchesByConsumer = new Map();
  for (const file of consumerFiles) {
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) continue;
    const matches = importedDefinitionKeys(sourceFile, checker, root, definitions);
    if (matches.size > 0) matchesByConsumer.set(relativePath(root, file), matches);
  }

  const activated = evaluateMatches(matchesByConsumer, definitionKeys, options.match, options.sameConsumer);
  return {
    activated,
    match: options.match,
    sameConsumer: options.sameConsumer,
    definitions: [...definitionKeys],
    consumers: [...matchesByConsumer].map(([file, matches]) => ({ file, matches: [...matches] }))
  };
}

function normalizeDefinition(root, definition) {
  const separator = definition.lastIndexOf("#");
  const kindSeparator = definition.indexOf(":");
  if (kindSeparator <= 0 || separator <= kindSeparator + 1 || separator === definition.length - 1) {
    throw new Error(`invalid --definition ${JSON.stringify(definition)}; expected value|any:path#symbol`);
  }
  const importKind = definition.slice(0, kindSeparator);
  if (importKind !== "value" && importKind !== "any") {
    throw new Error(`invalid import kind ${JSON.stringify(importKind)} in --definition`);
  }
  const file = normalizeRelativePath(definition.slice(kindSeparator + 1, separator));
  const symbol = definition.slice(separator + 1);
  if (!/^[$A-Z_a-z][$\w]*$/u.test(symbol)) {
    throw new Error(`invalid definition symbol ${JSON.stringify(symbol)}`);
  }
  if (path.isAbsolute(file) || file.startsWith("../")) {
    throw new Error(`definition must stay inside the repository: ${file}`);
  }
  const absolute = path.resolve(root, file);
  if (!isWithin(root, absolute)) throw new Error(`definition escapes repository root: ${file}`);
  return { file, symbol, importKind, key: `${file}#${symbol}` };
}

function discoverConsumerFiles(root, consumerRoots) {
  const files = [];
  for (const consumerRoot of consumerRoots) {
    const relativeRoot = normalizeRelativePath(consumerRoot);
    const absoluteRoot = path.resolve(root, relativeRoot);
    if (!isWithin(root, absoluteRoot)) throw new Error(`consumer root escapes repository root: ${consumerRoot}`);
    walk(absoluteRoot, files);
  }
  return [...new Set(files)].sort();

  function walk(directory, output) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath, output);
      } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name)) && isProductionSource(root, entryPath)) {
        output.push(entryPath);
      }
    }
  }
}

function isProductionSource(root, file) {
  const segments = relativePath(root, file).split("/");
  return segments[0] === "packages" && segments.includes("src");
}

function assertDefinitionsExist(program, checker, root, definitions) {
  for (const definition of definitions) {
    const sourceFile = program.getSourceFile(path.join(root, definition.file));
    if (!sourceFile?.symbol) throw new Error(`cannot load definition module: ${definition.file}`);
    const exported = checker.getExportsOfModule(sourceFile.symbol)
      .find((symbol) => symbol.getName() === definition.symbol);
    if (!exported) throw new Error(`definition export not found: ${definition.key}`);
  }
}

function importedDefinitionKeys(sourceFile, checker, root, definitions) {
  const matches = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const bindings = statement.importClause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const symbol = checker.getSymbolAtLocation(element.name);
      if (!symbol) continue;
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const matchingDefinition = definitions.find((definition) => symbolMatchesDefinition(target, definition, root));
      if (!matchingDefinition) continue;
      const typeOnly = statement.importClause.isTypeOnly || element.isTypeOnly;
      if (matchingDefinition.importKind === "value" && typeOnly) continue;
      matches.add(matchingDefinition.key);
    }
  }
  return matches;
}

function symbolMatchesDefinition(symbol, definition, root) {
  if (symbol.getName() !== definition.symbol) return false;
  return (symbol.declarations ?? []).some((declaration) =>
    relativePath(root, declaration.getSourceFile().fileName) === definition.file
  );
}

function evaluateMatches(matchesByConsumer, definitionKeys, match, sameConsumer) {
  const requiredCount = definitionKeys.size;
  if (sameConsumer) {
    for (const matches of matchesByConsumer.values()) {
      if (match === "all" && matches.size === requiredCount) return true;
      if (match === "any" && matches.size > 0) return true;
    }
    return false;
  }
  const union = new Set([...matchesByConsumer.values()].flatMap((matches) => [...matches]));
  return match === "all" ? union.size === requiredCount : union.size > 0;
}

export function parseProbeArgs(argv) {
  const options = {
    root: process.cwd(),
    definitions: [],
    consumerRoots: [],
    excludes: [],
    match: "all",
    sameConsumer: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--root", "--definition", "--consumer-root", "--exclude", "--match"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--root") options.root = value;
      if (arg === "--definition") options.definitions.push(value);
      if (arg === "--consumer-root") options.consumerRoots.push(value);
      if (arg === "--exclude") options.excludes.push(value);
      if (arg === "--match") options.match = value;
      index += 1;
      continue;
    }
    if (arg === "--same-consumer") {
      options.sameConsumer = true;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  if (options.definitions.length === 0) throw new Error("at least one --definition is required");
  if (options.consumerRoots.length === 0) throw new Error("at least one --consumer-root is required");
  if (options.match !== "all" && options.match !== "any") throw new Error("--match must be all or any");
  return options;
}

function normalizeRelativePath(value) {
  return value.split(path.sep).join("/").replace(/^\.\//u, "");
}

function relativePath(root, file) {
  return path.relative(root, path.resolve(file)).split(path.sep).join("/");
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function printProbeResult(result) {
  const label = result.activated ? "activated" : "inactive";
  console.log(`[staged-activation probe] ${label}; consumers=${result.consumers.length}`);
  for (const consumer of result.consumers) {
    console.log(`- ${consumer.file}: ${consumer.matches.join(", ")}`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = probeProductionConsumers(parseProbeArgs(process.argv.slice(2)));
    printProbeResult(result);
    process.exitCode = result.activated ? 0 : 1;
  } catch (error) {
    console.error(`[staged-activation probe] error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
