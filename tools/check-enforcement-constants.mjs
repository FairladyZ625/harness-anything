#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { resolveEnforcementConstant } from "./enforcement-constants.mjs";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "..");
const LITERAL_AUDIT_POLICY = "forbid-derived-count-and-sequence";

export function checkEnforcementConstants(root = DEFAULT_ROOT) {
  const findings = [];
  const manifestPath = path.join(root, "tools/gate-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return result([`cannot read gate manifest: ${error.message}`], 0);
  }

  const declarations = manifest.enforcementConstants;
  if (!Array.isArray(declarations) || declarations.length === 0) {
    return result(["gate manifest must declare a non-empty enforcementConstants array"], 0);
  }

  const seenIds = new Set();
  for (const declaration of declarations) {
    const prefix = typeof declaration?.id === "string" ? declaration.id : "<missing-id>";
    validateDeclaration(declaration, prefix, seenIds, findings);
    if (findings.some((finding) => finding.startsWith(`${prefix}:`))) continue;

    let resolved;
    try {
      resolved = resolveEnforcementConstant(
        manifest,
        declaration.id,
        (relativePath) => readFileSync(path.join(root, relativePath), "utf8")
      );
    } catch (error) {
      findings.push(`${prefix}: authority resolution failed: ${error.message}`);
      continue;
    }

    for (const consumer of declaration.consumers) {
      auditConsumer(root, declaration.id, consumer, resolved, findings);
    }
  }
  return result(findings, declarations.length);
}

function validateDeclaration(declaration, prefix, seenIds, findings) {
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
    findings.push(`${prefix}: declaration must be an object`);
    return;
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(declaration.id ?? "")) {
    findings.push(`${prefix}: id must be kebab-case`);
  } else if (seenIds.has(declaration.id)) {
    findings.push(`${prefix}: id is duplicated`);
  } else {
    seenIds.add(declaration.id);
  }
  if (typeof declaration.description !== "string" || declaration.description.trim() === "") {
    findings.push(`${prefix}: description must be a non-empty string`);
  }
  if (declaration.valueType !== "positive-integer-sequence") {
    findings.push(`${prefix}: valueType must be positive-integer-sequence`);
  }
  const authority = declaration.authority;
  if (authority?.kind !== "workflow-matrix") {
    findings.push(`${prefix}: authority.kind must be workflow-matrix`);
  }
  for (const field of ["path", "job", "matrixKey"]) {
    if (typeof authority?.[field] !== "string" || authority[field].trim() === "") {
      findings.push(`${prefix}: authority.${field} must be a non-empty string`);
    }
  }
  if (declaration.literalAudit !== LITERAL_AUDIT_POLICY) {
    findings.push(`${prefix}: literalAudit must be ${LITERAL_AUDIT_POLICY}`);
  }
  if (!Array.isArray(declaration.consumers) || declaration.consumers.length === 0) {
    findings.push(`${prefix}: consumers must be a non-empty array`);
  } else if (declaration.consumers.some((consumer) => typeof consumer !== "string" || consumer.trim() === "")) {
    findings.push(`${prefix}: every consumer must be a non-empty path string`);
  } else if (new Set(declaration.consumers).size !== declaration.consumers.length) {
    findings.push(`${prefix}: consumers must not contain duplicate paths`);
  }
}

function auditConsumer(root, id, consumer, resolved, findings) {
  const consumerPath = path.join(root, consumer);
  if (!existsSync(consumerPath)) {
    findings.push(`${id}: consumer does not exist: ${consumer}`);
    return;
  }
  const source = readFileSync(consumerPath, "utf8");
  const sourceFile = ts.createSourceFile(consumer, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (!hasManifestResolution(sourceFile, id)) {
    findings.push(`${id}: ${consumer} does not resolve this declaration from gate-manifest`);
  }

  const derivedCount = resolved.length;
  visit(sourceFile, (node) => {
    if (ts.isNumericLiteral(node) && Number(node.text) === derivedCount) {
      findings.push(`${id}: bare derived count ${derivedCount} in ${location(sourceFile, node)}`);
    }
    if (ts.isArrayLiteralExpression(node)) {
      const values = node.elements.map((element) => ts.isNumericLiteral(element) ? Number(element.text) : null);
      if (values.length === resolved.length && values.every((value, index) => value === resolved[index])) {
        findings.push(`${id}: bare derived sequence [${resolved.join(", ")}] in ${location(sourceFile, node)}`);
      }
    }
  });
}

function hasManifestResolution(sourceFile, id) {
  let found = false;
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const name = ts.isIdentifier(node.expression)
      ? node.expression.text
      : ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : null;
    if (name !== "resolveEnforcementConstant" && name !== "loadEnforcementConstant") return;
    if (node.arguments.some((argument) => ts.isStringLiteral(argument) && argument.text === id)) found = true;
  });
  return found;
}

function visit(node, inspect) {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}

function location(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${position.line + 1}:${position.character + 1}`;
}

function result(findings, declarations) {
  return { ok: findings.length === 0, findings, declarations };
}

function parseArgs(argv) {
  const rootIndex = argv.indexOf("--root");
  if (rootIndex === -1) return { root: DEFAULT_ROOT };
  if (argv[rootIndex + 1] === undefined) throw new Error("--root requires a path");
  return { root: path.resolve(argv[rootIndex + 1]) };
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const audit = checkEnforcementConstants(root);
  if (!audit.ok) {
    for (const finding of audit.findings) console.error(`enforcement constant audit: ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Enforcement constant audit passed: ${audit.declarations} declaration(s).`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
