#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  directObjectStringProperties,
  exitCodeFor,
  findVariable,
  lineNumber,
  loadActionCoverageSnapshot,
  parseCommonArgs,
  parseTypeScript,
} from "./ontology-gate-lib.mjs";

const entityRefPath = "packages/kernel/src/domain/entity-ref.ts";
const declarationPath = "packages/kernel/src/domain/action-declaration.ts";

export function auditKindAuthority(rootDir = process.cwd()) {
  // The registry is evaluated, not parsed: a factory-made contract is as real as a literal row.
  const snapshot = loadActionCoverageSnapshot(rootDir);
  const canonicalKinds = [...new Set(snapshot.kinds)].sort();
  const coverage = actionCoverage(snapshot);
  const tables = [];

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

  return { canonicalKinds, coverage, tables, findings: [...coverage.findings, ...tables.map(formatTable)] };
}

/**
 * Two independent anchors meet at the ActionDeclaration: every durable effect the registry can
 * execute and every non-read protocol ingress must name a declared action, and every declared
 * executable action must keep a protocol ingress. The only non-literal mappings are typed by the
 * kernel itself: a compiled event belongs to its policy action, and the artifact CRUD ingresses
 * resolve to a compiled Artifact kind's own scope at runtime.
 */
export function actionCoverage(snapshot) {
  const declared = new Map(snapshot.declarations.map((entry) => [entry.kind, entry])),
    generated = new Set(snapshot.artifactIngress),
    ingress = new Set(snapshot.ingress.map((entry) => entry.kind)),
    findings = [],
    exceptions = [];
  for (const effect of snapshot.effects) {
    const label = `${effect.kind}/${effect.action}`;
    if (declared.has(effect.ingress) || generated.has(effect.ingress)) {
      if (!ingress.has(effect.ingress))
        findings.push(`${label}: durable effect ${effect.ingress} has no protocol ingress`);
    } else if (effect.implementation === "compiled-event" && declared.has(effect.policyAction))
      // An event the runtime emits while executing a declared action is that action's effect.
      exceptions.push(`${label}: compiled event emitted under declared action ${effect.policyAction}`);
    else findings.push(`${label}: durable effect ${effect.ingress} has no ActionDeclaration`);
  }
  for (const kind of [...ingress].sort()) {
    if (declared.has(kind)) continue;
    if (generated.has(kind))
      exceptions.push(`${kind}: generated Artifact ingress (${declarationPath} artifactActionIngressKinds)`);
    else findings.push(`${kind}: protocol ingress has no ActionDeclaration`);
  }
  for (const entry of snapshot.declarations)
    if (entry.executionClass !== "repo-read" && !ingress.has(entry.kind))
      findings.push(
        `${entry.kind}: declared ${entry.residency} ${entry.executionClass} action has no protocol ingress`,
      );
  return { findings, exceptions };
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
    console.log(`typed action coverage exceptions (${result.coverage.exceptions.length}):`);
    for (const exception of result.coverage.exceptions) console.log(`- ${exception}`);
    console.log(`action coverage findings (${result.coverage.findings.length}):`);
    for (const finding of result.coverage.findings) console.log(`- ${finding}`);
    console.log(`registry-external kind tables (${result.tables.length}):`);
    for (const finding of result.findings) console.log(`- ${finding}`);
    return exitCodeFor(mode, result.findings.length);
  } catch (error) {
    console.error(`G0-1 ontology-kind-authority: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
