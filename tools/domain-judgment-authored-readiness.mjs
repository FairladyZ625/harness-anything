/**
 * Authored-document read boundary for the domain-judgment gate.
 *
 * Authority: dec_6B912A63D279A922FA1288536D CH2 and the AuthoredDocument
 * design. A task-package authored document is read through the document
 * projection port. A direct filesystem read of a path rooted at the authored
 * task tree is therefore a boundary violation, regardless of the value
 * returned by the caller or the name of its helper.
 *
 * This scanner deliberately does not identify readiness predicates. It
 * follows path provenance into filesystem IO calls and reports the IO call
 * itself. `projection.readDocument(...)` is the port and is not a filesystem
 * call, so projection consumers are the negative control by construction.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { listWorktreeFiles } from "./gates/git.mjs";

export const SCOPES = Object.freeze(["packages/daemon/src", "packages/application/src", "packages/cli/src"]);
export const AUTHORED_READ_KIND = "direct-authored-document-read";

const DIRECT_READS = new Set(["readFileSync", "readFile"]);
const AUTHORED_ROOT_MEMBER = /(?:^|\.)authoredRoot$/u;
const TASK_PATH_NAME = /^(?:task(?:Package|Plan|_plan)|packagePath|sourcePackageRoot|taskRoot|documentPath)$/iu;
const ROOT_PATH_NAME = /^(?:authoredRoot|destinationRoot|materializedRoot)$/iu;
const TASK_SEGMENT =
  /(?:^|[/\\])(?:tasks|task_plan\.md|task-contract\.json|INDEX\.md|closeout\.md|review\.md|artifacts|returns|missions)(?:[/\\]|$)/iu;

export function scanAuthoredReadinessSites(root = process.cwd()) {
  const sites = [];
  for (const rel of listWorktreeFiles(root, SCOPES).filter(
    (file) =>
      /\.(?:ts|tsx|mts|js|jsx|mjs)$/u.test(file) &&
      !/(?:^|\/)(?:test|tests|fixtures)\//u.test(file) &&
      !/\.(?:test|spec|vitest)\.[cm]?[jt]sx?$/u.test(file),
  ))
    sites.push(...scanFile(rel, readFileSync(path.join(root, rel), "utf8")));
  return sites.sort((left, right) => siteKey(left).localeCompare(siteKey(right)));
}

/** Compatibility name retained for the existing single-definition gate. */
export const scanAuthoredDocumentReads = scanAuthoredReadinessSites;

function scanFile(rel, body) {
  const source = ts.createSourceFile(rel, body, ts.ScriptTarget.Latest, true, scriptKind(rel));
  const scopes = new Map(),
    directReadAliases = new Set(),
    callbackBindings = [];
  const scopeOf = (symbol) => {
    if (!scopes.has(symbol))
      scopes.set(symbol, {
        calls: [],
        declarations: [],
        parameters: new Map(),
        parameterNames: [],
        returns: [],
        directReads: [],
      });
    return scopes.get(symbol);
  };
  const visit = (node) => {
    const scope = scopeOf(enclosingSymbol(node));
    if (ts.isFunctionLike(node) && node.parent && ts.isCallExpression(node.parent)) {
      const call = node.parent,
        callbackIndex = call.arguments.findIndex((argument) => argument === node),
        callbackSource = callbackIndex >= 0 ? callbackSourceExpression(call, callbackIndex) : undefined,
        callbackKind = callbackSource === undefined ? null : pathKindExpression(callbackSource, scope, scopes);
      if (node.parameters.length > 0 && ts.isIdentifier(node.parameters[0].name)) {
        const parameter = node.parameters[0];
        callbackBindings.push({
          scope,
          parameter: parameter.name.text,
          source: callbackSource,
          outerScope: scopeOf(enclosingSymbol(call)),
        });
        if (callbackKind !== null) scope.parameters.set(parameter.name.text, callbackKind);
      }
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      if (moduleName === "node:fs" || moduleName === "node:fs/promises") {
        const named = node.importClause?.namedBindings;
        if (named && ts.isNamedImports(named))
          for (const element of named.elements)
            if (
              (element.propertyName?.text ?? element.name.text) === "readFileSync" ||
              (element.propertyName?.text ?? element.name.text) === "readFile"
            )
              directReadAliases.add(element.name.text);
      }
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      scope.parameterNames.push(node.name.text);
      const kind = pathNameKind(node.name.text);
      if (kind !== null) scope.parameters.set(node.name.text, kind);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) scope.declarations.push(node);
    if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
      const declaration = node.initializer.declarations[0];
      if (
        declaration &&
        ts.isIdentifier(declaration.name) &&
        ts.isCallExpression(node.expression) &&
        (calleeName(node.expression.expression) === "fleetMirrorTaskPaths" ||
          pathKindExpression(node.expression.arguments[0], scope, scopes) === "task")
      )
        scope.parameters.set(declaration.name.text, "task");
    }
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      if (callee !== null && !isDirectRead(callee, directReadAliases)) scope.calls.push(node);
      if (callee !== null && isDirectRead(callee, directReadAliases)) {
        scope.directReads.push(node);
      }
    }
    if (ts.isReturnStatement(node) && node.expression) scope.returns.push(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(source);

  // Same-file helper calls carry path provenance just as they carry file-read
  // provenance. An authored path passed into a helper remains authored until
  // the helper returns.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [symbol, scope] of scopes) {
      for (const declaration of scope.declarations) {
        const kind = pathKindExpression(declaration.initializer, scope, scopes);
        if (kind === null || scope.parameters.has(declaration.name.text)) continue;
        if (pathNameKind(declaration.name.text) !== null && scope.parameters.has(declaration.name.text)) continue;
        if (pathNameKind(declaration.name.text) !== null) {
          scope.parameters.set(declaration.name.text, pathNameKind(declaration.name.text));
          changed = true;
          continue;
        }
        if (scope.parameters.get(declaration.name.text) === kind) continue;
        scope.parameters.set(declaration.name.text, kind);
        changed = true;
      }
      for (const call of scope.calls) {
        const callee = calleeName(call.expression),
          calleeScope = callee === null ? undefined : scopes.get(callee);
        if (calleeScope === undefined) continue;
        for (const [index, parameter] of calleeScope.parameterNames.entries()) {
          const kind = pathKindExpression(call.arguments[index], scope, scopes);
          const merged =
            kind === null
              ? calleeScope.parameters.get(parameter)
              : joinPathKinds([calleeScope.parameters.get(parameter), kind]);
          if (merged !== null && calleeScope.parameters.get(parameter) !== merged) {
            calleeScope.parameters.set(parameter, merged);
            changed = true;
          }
        }
      }
      if (symbol && pathNameKind(symbol) !== null && !scope.parameters.has("<named-task-path>")) {
        scope.parameters.set("<named-task-path>", pathNameKind(symbol));
        changed = true;
      }
      for (const binding of callbackBindings) {
        const kind = pathKindExpression(binding.source, binding.outerScope, scopes);
        if (kind !== null && binding.scope.parameters.get(binding.parameter) !== kind) {
          binding.scope.parameters.set(binding.parameter, kind);
          changed = true;
        }
      }
    }
  }

  const sites = [];
  for (const [symbol, scope] of scopes)
    for (const node of scope.directReads)
      if (
        ["task", "root"].includes(pathKindExpression(node.arguments[0], scope, scopes)) &&
        !canonicalPortRead(rel, symbol, node, source)
      )
        sites.push({
          path: rel,
          symbol,
          kind: AUTHORED_READ_KIND,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          call: node.expression.getText(source),
          fingerprint: createHash("sha256")
            .update(`${rel}\0${symbol}\0${AUTHORED_READ_KIND}\0${node.getText(source).replace(/\s+/gu, " ").trim()}`)
            .digest("hex"),
        });
  return sites;

  function pathKindExpression(node, scope, allScopes, seen = new Set()) {
    if (node === undefined) return null;
    const expression = unwrap(node);
    if (ts.isIdentifier(expression)) {
      const known = scope.parameters.get(expression.text) ?? pathNameKind(expression.text);
      if (known !== null && known !== undefined) return known;
      for (const declaration of scope.declarations)
        if (declaration.name.text === expression.text && !seen.has(declaration)) {
          seen.add(declaration);
          const kind = pathKindExpression(declaration.initializer, scope, allScopes, seen);
          if (kind !== null) return kind;
        }
      return null;
    }
    if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
      return taskPathKind(expression.text);
    if (ts.isTemplateExpression(expression))
      return taskPathKind(expression.head.text) === "task" ||
        taskPathKind(expression.head.text) === "task-fragment" ||
        expression.templateSpans.some((span) => pathKindExpression(span.expression, scope, allScopes, seen) === "task")
        ? "task"
        : null;
    if (ts.isPropertyAccessExpression(expression)) {
      if (pathNameKind(expression.name.text) === "task") return "task";
      if (AUTHORED_ROOT_MEMBER.test(expression.getText(source))) return "root";
      return pathKindExpression(expression.expression, scope, allScopes, seen);
    }
    if (ts.isElementAccessExpression(expression))
      return pathKindExpression(expression.expression, scope, allScopes, seen);
    if (ts.isSpreadElement(expression)) return pathKindExpression(expression.expression, scope, allScopes, seen);
    if (ts.isCallExpression(expression)) {
      const callee = calleeName(expression.expression);
      if (ts.isPropertyAccessExpression(expression.expression)) {
        const method = expression.expression.name.text;
        if (["map", "flatMap", "filter"].includes(method))
          return pathKindExpression(expression.expression.expression, scope, allScopes, seen);
      }
      if (["files", "listJsonFiles", "readdirSync", "globSync"].includes(callee ?? "")) {
        const sourceKind = pathKindExpression(expression.arguments[0], scope, allScopes, seen);
        if (sourceKind === "task" || sourceKind === "root") return sourceKind;
      }
      if (callee !== null && /(?:^|\.)(?:join|resolve|normalize|dirname)$/u.test(callee))
        return joinPathKinds(
          expression.arguments.map((argument) => pathKindExpression(argument, scope, allScopes, seen)),
        );
      const calleeScope = callee === null ? undefined : allScopes.get(callee);
      if (calleeScope !== undefined && !seen.has(calleeScope)) {
        seen.add(calleeScope);
        const returnKinds = calleeScope.returns
          .map((returned) => pathKindExpression(returned, calleeScope, allScopes, seen))
          .filter((kind) => kind !== null);
        if (returnKinds.includes("task")) return "task";
        if (returnKinds.includes("root")) return "root";
      }
      return null;
    }
    if (ts.isBinaryExpression(expression))
      return joinPathKinds([
        pathKindExpression(expression.left, scope, allScopes, seen),
        pathKindExpression(expression.right, scope, allScopes, seen),
      ]);
    if (ts.isConditionalExpression(expression))
      return joinPathKinds([
        pathKindExpression(expression.whenTrue, scope, allScopes, seen),
        pathKindExpression(expression.whenFalse, scope, allScopes, seen),
      ]);
    return null;
  }

  function callbackSourceExpression(call, callbackIndex) {
    if (callbackIndex !== 0 || !ts.isPropertyAccessExpression(call.expression)) return undefined;
    if (!new Set(["map", "flatMap", "forEach", "filter"]).has(call.expression.name.text)) return undefined;
    return call.expression.expression;
  }

  function taskPathKind(text) {
    if (!TASK_SEGMENT.test(text)) return null;
    if (/(?:^|[/\\])tasks(?:[/\\]|$)/iu.test(text)) return "task";
    return /(?:^|[/\\])(?:task_plan\.md|task-contract\.json|INDEX\.md|closeout\.md|review\.md|artifacts|returns|missions)(?:[/\\]|$)/iu.test(
      text,
    )
      ? "task-fragment"
      : null;
  }

  function canonicalPortRead(file, symbol, node, parsedSource) {
    return (
      file === "packages/daemon/src/authored-document-read-port.ts" &&
      symbol === "readAuthoredDocumentBytes" &&
      calleeName(node.expression) === "readFileSync" &&
      node.arguments[0]?.getText(parsedSource) === "candidate"
    );
  }
}

export function checkAuthoredReadinessSites(sites) {
  return sites.map(
    (site) =>
      `${site.path}#${site.symbol}:${site.kind}:${site.line}: direct ${site.call} reads an authored task-package document; ` +
      "read the canonical bytes through projection.readDocument",
  );
}

export function authoredReadinessFindings(root) {
  return checkAuthoredReadinessSites(scanAuthoredReadinessSites(root));
}

function siteKey(entry) {
  return `${entry.path}|${entry.symbol}|${entry.kind}|${entry.line}|${entry.fingerprint}`;
}

function pathNameKind(name) {
  if (TASK_PATH_NAME.test(name) || name === "documentPath") return "task";
  if (ROOT_PATH_NAME.test(name)) return "root";
  return null;
}

function joinPathKinds(kinds) {
  if (kinds.includes("task")) return "task";
  if (kinds.includes("root") && kinds.includes("task-fragment")) return "task";
  if (kinds.includes("root")) return "root";
  return null;
}

function isDirectRead(callee, aliases = new Set()) {
  return DIRECT_READS.has(callee) || aliases.has(callee) || /(?:^|\.)(?:readFileSync|readFile)$/u.test(callee);
}

function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.getText().replace(/\?\./gu, ".");
  return null;
}

function enclosingSymbol(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    if (current.name && ts.isIdentifier(current.name)) return current.name.text;
    if (ts.isMethodDeclaration(current)) return propertyName(current.name) ?? "<method>";
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && current.parent) {
      if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name))
        return current.parent.name.text;
      if (ts.isPropertyAssignment(current.parent)) return propertyName(current.parent.name) ?? "<property>";
    }
  }
  return "<module>";
}

function propertyName(node) {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null;
}

function unwrap(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current))
  )
    current = current.expression;
  return current;
}

function scriptKind(file) {
  return file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : file.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$/u.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
}
