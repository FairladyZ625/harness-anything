#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const defaultApplicationPath = "packages/application/src/index.ts";
const allowedExternalTypeReferences = new Set([
  "Array",
  "Effect",
  "Extract",
  "Omit",
  "Partial",
  "Pick",
  "Promise",
  "Readonly",
  "ReadonlyArray",
  "Record"
]);
const allowedMappableKernelTypeReferences = new Set([
  "DomainStatus",
  "ProjectionWarning",
  "TaskProjectionRow"
]);

export function evaluateServiceMappability(root = process.cwd(), options = {}) {
  const applicationPath = options.applicationPath ?? defaultApplicationPath;
  const absolutePath = path.join(root, applicationPath);
  if (!existsSync(absolutePath)) {
    return [`${applicationPath}: missing application service entrypoint`];
  }

  const sourceText = readFileSync(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(applicationPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = collectDeclarations(sourceFile);
  const serviceInterface = declarations.interfaces.get("LocalControllerService");
  if (!serviceInterface) return [`${applicationPath}: missing LocalControllerService interface`];

  const violations = [];
  const referencedTypes = new Set();

  for (const member of serviceInterface.members) {
    if (!ts.isPropertySignature(member) || !member.type || !ts.isFunctionTypeNode(member.type) || !ts.isIdentifier(member.name)) {
      violations.push(`${applicationPath}: LocalControllerService members must be readonly function properties`);
      continue;
    }
    const methodName = member.name.text;
    for (const parameter of member.type.parameters) {
      if (!parameter.type) {
        violations.push(`${applicationPath}: ${methodName} parameter ${parameter.name.getText(sourceFile)} must have an explicit named type`);
        continue;
      }
      inspectTypeNode(parameter.type, {
        sourceFile,
        applicationPath,
        context: `${methodName} parameter ${parameter.name.getText(sourceFile)}`,
        referencedTypes,
        violations
      });
    }
    if (!member.type.type) {
      violations.push(`${applicationPath}: ${methodName} must have an explicit return type`);
      continue;
    }
    inspectTypeNode(member.type.type, {
      sourceFile,
      applicationPath,
      context: `${methodName} return`,
      referencedTypes,
      violations
    });
  }

  const checkedTypes = new Set();
  for (const typeName of referencedTypes) {
    inspectReferencedType(typeName, declarations, checkedTypes, {
      sourceFile,
      applicationPath,
      referencedTypes,
      violations
    });
  }

  return violations;
}

function collectDeclarations(sourceFile) {
  const interfaces = new Map();
  const typeAliases = new Map();

  function visit(node) {
    if (ts.isInterfaceDeclaration(node)) interfaces.set(node.name.text, node);
    if (ts.isTypeAliasDeclaration(node)) typeAliases.set(node.name.text, node);
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { interfaces, typeAliases };
}

function inspectReferencedType(typeName, declarations, checkedTypes, context) {
  if (allowedExternalTypeReferences.has(typeName) || allowedMappableKernelTypeReferences.has(typeName) || checkedTypes.has(typeName)) return;
  checkedTypes.add(typeName);

  const interfaceDeclaration = declarations.interfaces.get(typeName);
  if (interfaceDeclaration) {
    for (const heritage of interfaceDeclaration.heritageClauses ?? []) {
      for (const inheritedType of heritage.types) {
        inspectTypeNode(inheritedType, {
          ...context,
          context: `${typeName} extends`
        });
      }
    }
    for (const member of interfaceDeclaration.members) {
      if (ts.isPropertySignature(member) && member.type) {
        inspectTypeNode(member.type, {
          ...context,
          context: `${typeName}.${member.name.getText(context.sourceFile)}`
        });
      }
    }
    return;
  }

  const typeAlias = declarations.typeAliases.get(typeName);
  if (typeAlias) {
    inspectTypeNode(typeAlias.type, {
      ...context,
      context: typeName
    });
    return;
  }

  context.violations.push(`${context.applicationPath}: ${typeName} is referenced by LocalControllerService but has no local mappability declaration`);
}

function inspectTypeNode(typeNode, context) {
  if (typeNode.kind === ts.SyntaxKind.AnyKeyword || typeNode.kind === ts.SyntaxKind.UnknownKeyword) {
    context.violations.push(`${context.applicationPath}: ${context.context} uses ${typeNode.getText(context.sourceFile)}; Service surfaces must be mappable`);
    return;
  }
  if (ts.isTypeLiteralNode(typeNode)) {
    context.violations.push(`${context.applicationPath}: ${context.context} uses an inline object type; name the Service contract type`);
    return;
  }
  if (ts.isFunctionTypeNode(typeNode)) {
    context.violations.push(`${context.applicationPath}: ${context.context} uses an inline function type outside the Service method boundary`);
    return;
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText(context.sourceFile);
    context.referencedTypes.add(typeName);
    for (const argument of typeNode.typeArguments ?? []) inspectTypeNode(argument, context);
    return;
  }
  if (ts.isExpressionWithTypeArguments(typeNode)) {
    const typeName = typeNode.expression.getText(context.sourceFile);
    context.referencedTypes.add(typeName);
    for (const argument of typeNode.typeArguments ?? []) inspectTypeNode(argument, context);
    return;
  }
  if (ts.isArrayTypeNode(typeNode)) {
    inspectTypeNode(typeNode.elementType, context);
    return;
  }
  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    for (const childType of typeNode.types) inspectTypeNode(childType, context);
    return;
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    inspectTypeNode(typeNode.type, context);
    return;
  }
  if (ts.isTupleTypeNode(typeNode)) {
    for (const element of typeNode.elements) inspectTypeNode(element, context);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = evaluateServiceMappability();
  if (violations.length > 0) {
    console.error("Service mappability check failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }
  console.log("Service mappability check passed.");
}
