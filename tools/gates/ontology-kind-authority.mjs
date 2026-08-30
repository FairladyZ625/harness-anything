#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  directObjectStringProperties,
  exitCodeFor,
  findVariable,
  lineNumber,
  parseCommonArgs,
  parseTypeScript,
} from "./ontology-gate-lib.mjs";

const registryPath = "packages/kernel/src/domain/entity-kind-registry.ts";
const legacyRegistryPath = "packages/kernel/src/entity/registry-contract.ts";
const entityRefPath = "packages/kernel/src/domain/entity-ref.ts";

export function auditKindAuthority(rootDir = process.cwd()) {
  const canonicalSource = parseTypeScript(rootDir, registryPath);
  const canonicalDeclaration = findVariable(canonicalSource, "entityKindContracts");
  if (!canonicalDeclaration?.initializer) throw new Error(`${registryPath}: entityKindContracts is missing`);
  const canonicalRows = directObjectStringProperties(canonicalDeclaration.initializer, "kind");
  const canonicalKinds = [...new Set(canonicalRows.map(({ value }) => value))].sort();
  const tables = [];

  const legacySource = parseTypeScript(rootDir, legacyRegistryPath);
  const legacy = findTypeAlias(legacySource, "KernelEntityKind");
  if (legacy) {
    tables.push({
      file: legacyRegistryPath,
      line: lineNumber(legacySource, legacy.getStart(legacySource)),
      name: "KernelEntityKind",
      kinds: [...new Set(stringLiterals(legacy.type))].sort(),
    });
  }

  const refSource = parseTypeScript(rootDir, entityRefPath);
  const authorities = findVariable(refSource, "entityKindRefAuthorities");
  if (authorities?.initializer) {
    tables.push({
      file: entityRefPath,
      line: lineNumber(refSource, authorities.getStart(refSource)),
      name: "entityKindRefAuthorities",
      kinds: [
        ...new Set(directObjectStringProperties(authorities.initializer, "kind").map(({ value }) => value)),
      ].sort(),
    });
  }
  const refKind = findTypeAlias(refSource, "EntityRefKind");
  const specialKinds = refKind ? [...new Set(stringLiterals(refKind.type))].sort() : [];
  if (refKind && specialKinds.length) {
    tables.push({
      file: entityRefPath,
      line: lineNumber(refSource, refKind.getStart(refSource)),
      name: "EntityRefKind special cases",
      kinds: specialKinds,
    });
  }

  return { canonicalKinds, tables, findings: tables.map(formatTable) };
}

function findTypeAlias(sourceFile, name) {
  return sourceFile.statements.find(
    (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
  );
}

function stringLiterals(node) {
  if (ts.isUnionTypeNode(node)) return node.types.flatMap(stringLiterals);
  return ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal) ? [node.literal.text] : [];
}

function formatTable(table) {
  return `${table.file}:${table.line} ${table.name} = [${table.kinds.join(", ")}]`;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { rootDir, mode } = parseCommonArgs(argv);
    const result = auditKindAuthority(rootDir);
    console.log(`G0-1 ontology-kind-authority: ${mode}`);
    console.log(`canonical registry kinds (${result.canonicalKinds.length}): ${result.canonicalKinds.join(", ")}`);
    console.log(`registry-external kind tables (${result.tables.length}):`);
    for (const finding of result.findings) console.log(`- ${finding}`);
    return exitCodeFor(mode, result.findings.length);
  } catch (error) {
    console.error(`G0-1 ontology-kind-authority: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
