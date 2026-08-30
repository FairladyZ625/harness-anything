#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  exitCodeFor,
  lineNumber,
  loadDurableActionKinds,
  parseCommonArgs,
  parseTypeScript,
  walkTypeScriptFiles,
} from "./ontology-gate-lib.mjs";

const receiptPath = "packages/kernel/src/domain/receipt-domain-registry.ts";
const authorizationPath = "packages/daemon/src/authorization.ts";
const routeSourceExclusion =
  /(?:daemon-protocol-(?:commands|gui-actions|validate)|protocol\.contract|(?:^|-)types?)\.ts$/u;

export function auditDurableActionAuthorization(rootDir = process.cwd(), durableKinds = null) {
  const kinds = durableKinds ?? loadDurableActionKinds(rootDir);
  const analysis = buildCallGraph(rootDir);
  const authority = authorizationAuthority(rootDir, analysis);
  const receipt = receiptAuthorizationContract(rootDir);
  const rows = kinds.map((kind) => ({
    action: kind,
    authorizationPort: authority.ok && actionReachesAuthorization(kind, analysis),
    receiptAuthorizationDecision: receipt.nonNullable,
  }));
  const findings = [
    ...rows
      .filter((row) => !row.authorizationPort)
      .map((row) => `${row.action}: durable execution path does not statically reach AuthorizationPort`),
    ...(receipt.nonNullable
      ? []
      : [`${receipt.file}:${receipt.line} receipt.authorizationDecision is optional or nullable`]),
    ...(authority.ok ? [] : [`${authorizationPath}: authorizeAction no longer calls the typed AuthorizationPort`]),
  ];
  return { rows, findings, receipt, authority };
}

function buildCallGraph(rootDir) {
  const files = [
    ...walkTypeScriptFiles(rootDir, "packages/daemon/src"),
    ...walkTypeScriptFiles(rootDir, "packages/application/src"),
  ];
  const sources = [];
  const functions = new Map();
  for (const file of files) {
    const sourceFile = parseTypeScript(rootDir, file);
    sources.push({ file, sourceFile });
    visit(sourceFile);

    function visit(node) {
      const named = namedFunction(node);
      if (named) {
        const definitions = functions.get(named.name) ?? [];
        definitions.push({ file, sourceFile, body: named.body });
        functions.set(named.name, definitions);
      }
      ts.forEachChild(node, visit);
    }
  }
  return { sources, functions };
}

function namedFunction(node) {
  if (ts.isFunctionDeclaration(node) && node.name && node.body) return { name: node.name.text, body: node.body };
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return { name: node.name.text, body: node.initializer.body };
  }
  if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.body) {
    return { name: node.name.text, body: node.body };
  }
  return null;
}

function authorizationAuthority(rootDir, analysis) {
  const sourceFile = parseTypeScript(rootDir, authorizationPath);
  const typedPort = sourceFile.getText().includes("daemonAuthorizationPort: AuthorizationPort");
  const definitions = analysis.functions.get("authorizeAction") ?? [];
  const callsPort = definitions.some(({ body }) => containsPortAuthorize(body));
  return { ok: typedPort && callsPort };
}

function containsPortAuthorize(node) {
  let found = false;
  visit(node);
  return found;
  function visit(current) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "authorize"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
}

function receiptAuthorizationContract(rootDir) {
  const sourceFile = parseTypeScript(rootDir, receiptPath);
  let member = null;
  visit(sourceFile);
  if (!member) return { file: receiptPath, line: 1, nonNullable: false };
  return {
    file: receiptPath,
    line: lineNumber(sourceFile, member.getStart(sourceFile)),
    nonNullable: !member.questionToken && member.type !== undefined && !typeContainsNullish(member.type),
  };

  function visit(node) {
    if (!member && ts.isInterfaceDeclaration(node) && node.name.text === "WriteReceipt") {
      member = node.members.find(
        (candidate) =>
          ts.isPropertySignature(candidate) &&
          ((ts.isIdentifier(candidate.name) && candidate.name.text === "authorizationDecision") ||
            (ts.isStringLiteral(candidate.name) && candidate.name.text === "authorizationDecision")),
      );
      return;
    }
    ts.forEachChild(node, visit);
  }
}

function typeContainsNullish(node) {
  if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (typeContainsNullish(child)) found = true;
  });
  return found;
}

function actionReachesAuthorization(kind, analysis) {
  const seeds = [];
  for (const { file, sourceFile } of analysis.sources) {
    if (routeSourceExclusion.test(file)) continue;
    visit(sourceFile);
    function visit(node) {
      if (ts.isStringLiteralLike(node) && node.text === kind) seeds.push(routeRegion(node));
      ts.forEachChild(node, visit);
    }
  }
  return seeds.some((seed) => nodeReachesAuthorization(seed, analysis.functions, new Set()));
}

function routeRegion(literal) {
  let current = literal;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) return parent;
    if (ts.isIfStatement(parent) && containsNode(parent.expression, literal)) return parent.thenStatement;
    if (ts.isConditionalExpression(parent) && containsNode(parent.condition, literal)) return parent.whenTrue;
    if (ts.isFunctionLike(parent) && parent.body) return parent.body;
    current = parent;
  }
  return literal;
}

function containsNode(container, target) {
  return target.pos >= container.pos && target.end <= container.end;
}

function nodeReachesAuthorization(node, functions, visiting) {
  const calls = calledNames(node);
  if (calls.has("authorizeAction")) return true;
  for (const name of calls) {
    if (visiting.has(name)) continue;
    const next = new Set(visiting).add(name);
    for (const definition of functions.get(name) ?? []) {
      if (nodeReachesAuthorization(definition.body, functions, next)) return true;
    }
  }
  return false;
}

function calledNames(node) {
  const names = new Set();
  visit(node);
  return names;
  function visit(current) {
    if (ts.isCallExpression(current)) {
      if (ts.isIdentifier(current.expression)) names.add(current.expression.text);
    }
    ts.forEachChild(current, visit);
  }
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { rootDir, mode, fixture } = parseCommonArgs(argv, { allowFixture: true });
    const result = auditDurableActionAuthorization(rootDir, loadDurableActionKinds(rootDir, fixture));
    console.log(`G0-2 ontology-durable-action-authorization: ${mode}`);
    console.log("action | AuthorizationPort | receipt.authorizationDecision");
    for (const row of result.rows) {
      console.log(
        `${row.action} | ${row.authorizationPort ? "traced" : "missing"} | ${row.receiptAuthorizationDecision ? "non-null" : "optional/null"}`,
      );
    }
    console.log(
      `missing authorization paths: ${result.rows.filter((row) => !row.authorizationPort).length}/${result.rows.length}`,
    );
    console.log(
      `receipt contract: ${result.receipt.file}:${result.receipt.line} ${result.receipt.nonNullable ? "non-null" : "optional/null"}`,
    );
    return exitCodeFor(mode, result.findings.length);
  } catch (error) {
    console.error(
      `G0-2 ontology-durable-action-authorization: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
