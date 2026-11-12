import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { listWorktreeFiles } from "./git.mjs";
import { lineNumber } from "./ontology-gate-lib.mjs";

const effects = new Set([
  "append",
  "appendFile",
  "appendFileSync",
  "archive",
  "assign",
  "cancel",
  "claim",
  "complete",
  "create",
  "delete",
  "dispatch",
  "enqueue",
  "execute",
  "import",
  "insert",
  "invoke",
  "publish",
  "remove",
  "retire",
  "rm",
  "rmSync",
  "run",
  "settle",
  "spawn",
  "submit",
  "transition",
  "terminate",
  "unlink",
  "unlinkSync",
  "unassign",
  "update",
  "write",
  "writeFile",
  "writeFileSync",
]);
const judgmentName =
  /^(?:can|cannot|is|has|should|validate|assert|decide|resolve|derive|compute|calculate|check|require|ensure|eligible|allowed|authorized|readiness|coverage|blocking|liveness|admissible|startability)/u;
const domainName =
  /eligible|allowed|authorized|readiness|coverage|blocking|liveness|admissible|startability|validate|assert|decide/iu;
const policyName =
  /policy|tier|timeout|deadline|retry|attempt|backoff|rate|limit|budget|concurr|lease|claim|admission|eligib|allow|deny|quota|threshold|grace|retention|capacity/iu;
const policyWord = new RegExp(`^(?:${policyName.source})`, "iu");
const literalKinds = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
]);

// Tools consume runtime policies as test inputs; their own syntax and execution
// settings are not product defaults. Keep the packages/ detector unchanged.
function policySignal(name, node, file, scopeNames) {
  if (!policyName.test(name)) return false;
  if (!file.startsWith("tools/")) return true;
  // Audited synthetic-load roots; action/judgment scanning still visits every node.
  if (/^tools\/(?:perf|scale|soak|stress)\//u.test(file)) return false;
  const words = name
    .replace(/([a-z])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split("_");
  if (!words.some((word) => policyWord.test(word))) return false;
  if (words.some((word) => /^allow/u.test(word))) return false;
  if (/(?:Names?|Reasons?|Schema|Exempt|Evidence)$/u.test(name)) return false;
  if (
    words.some((word) => /^(?:test|integration|suite|shard)/u.test(word)) &&
    words.some((word) => /^(?:budget|timeout)/u.test(word))
  )
    return false;
  const { parent, initializer } = node;
  if (ts.isIdentifier(node)) {
    // A receiver's name does not configure its fields, nor does a called predicate.
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node)
      return false;
    if (ts.isCallExpression(parent) && parent.expression === node) return false;
    if (
      ts.isPropertyAccessExpression(parent) &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    )
      return false;
    const value = ts.isPropertyAccessExpression(parent) ? parent : node;
    if (
      (ts.isPropertyAccessExpression(value.parent) || ts.isElementAccessExpression(value.parent)) &&
      value.parent.expression === value
    )
      return false;
    if (ts.isTypeOfExpression(value.parent)) return false;
    if (
      ts.isCallExpression(value.parent) &&
      ((value.parent.arguments.length === 1 && value.parent.arguments[0] === value) ||
        nativeCall(value.parent, "Object", "hasOwn", scopeNames))
    )
      return false;
    const comparison = value.parent;
    if (ts.isBinaryExpression(comparison)) {
      const other = comparison.left === value ? comparison.right : comparison.left;
      if (other.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(other) && other.text === "undefined"))
        return false;
      if (ts.isIdentifier(other) || ts.isPropertyAccessExpression(other)) return false;
      if (nativeCall(other, "Date", "now", scopeNames) && other.arguments.length === 0) return false;
      if (ts.isPropertyAccessExpression(value) && ts.isStringLiteralLike(other)) return false;
      if (nonNegativeIntegerDiagnostic(comparison, scopeNames)) return false;
      // A next/previous-iteration comparison must refer to the actual counter.
      if (
        ts.isBinaryExpression(other) &&
        [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(other.operatorToken.kind) &&
        ts.isIdentifier(other.left) &&
        ts.isNumericLiteral(other.right) &&
        other.right.text === "1" &&
        loopCounter(other.left, scopeNames)
      )
        return false;
    }
    if (/^(?:flag|env)[A-Z]/u.test(name) || name === "tier") return false;
    if (loopCounter(node, scopeNames)) return false;
  } else {
    if (ts.isVariableDeclaration(node) && /^[A-Z][A-Z0-9_]*$/u.test(name) && parent.flags & ts.NodeFlags.Const)
      return false;
    if (name === "policy" && initializer && ts.isStringLiteralLike(initializer)) return false;
    if (ts.isVariableDeclaration(node) && loopCounter(node, scopeNames)) return false;
    if (ts.isPropertyAssignment(node)) {
      if (ts.isStringLiteralLike(initializer) && (words.includes("evidence") || /(?:Files|Usages)$/u.test(name)))
        return false;
      if (
        name === "limit" &&
        ts.isObjectLiteralExpression(initializer) &&
        initializer.properties.every((field) => field.name?.getText() === "type")
      )
        return false;
      let owner = parent.parent;
      while (
        ts.isPropertyAssignment(owner) ||
        ts.isObjectLiteralExpression(owner) ||
        ts.isArrayLiteralExpression(owner)
      )
        owner = owner.parent;
      if (ts.isCallExpression(owner) || ts.isNewExpression(owner)) {
        const api = owner.expression.getText().split(".").at(-1);
        if (
          /^(?:spawn|exec(?:File)?)(?:Sync)?$|^DatabaseSync$|^(?:rm|rmdir)(?:Sync)?$|^remove.*Directory(?:Sync)?$/u.test(
            api,
          ) &&
          /^(?:timeout(?:Ms)?|retryDelay(?:Ms)?)$/u.test(name)
        )
          return false;
        if (
          name === "timeout" &&
          owner.arguments?.[0] &&
          ts.isStringLiteralLike(owner.arguments[0]) &&
          owner.arguments[1] &&
          ts.isArrayLiteralExpression(owner.arguments[1]) &&
          parent.properties.some((field) => /^(?:cwd|env|stdio)$/u.test(field.name?.getText()))
        )
          return false;
      }
    }
  }
  return true;
}

// Rejecting a primitive non-negative integer shape into a local diagnostic array
// is validation. An arbitrary integer threshold or an effectful branch is not.
function nonNegativeIntegerDiagnostic(comparison, scopeNames) {
  if (
    comparison.operatorToken.kind !== ts.SyntaxKind.GreaterThanEqualsToken ||
    !ts.isNumericLiteral(comparison.right) ||
    comparison.right.text !== "0"
  )
    return false;
  const conjunction = comparison.parent;
  if (
    !ts.isBinaryExpression(conjunction) ||
    conjunction.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken ||
    conjunction.right !== comparison
  )
    return false;
  const check = conjunction.left;
  if (
    !ts.isCallExpression(check) ||
    !ts.isPropertyAccessExpression(check.expression) ||
    !ts.isIdentifier(check.expression.expression) ||
    check.expression.expression.text !== "Number" ||
    !/^is(?:Safe)?Integer$/u.test(check.expression.name.text) ||
    check.arguments.length !== 1 ||
    check.arguments[0].getText() !== comparison.left.getText()
  )
    return false;
  let rejected = conjunction;
  while (ts.isParenthesizedExpression(rejected.parent)) rejected = rejected.parent;
  if (!ts.isPrefixUnaryExpression(rejected.parent) || rejected.parent.operator !== ts.SyntaxKind.ExclamationToken)
    return false;
  let branch = rejected.parent;
  while (branch.parent && !ts.isIfStatement(branch.parent)) {
    if (!ts.isBinaryExpression(branch.parent) && !ts.isParenthesizedExpression(branch.parent)) return false;
    branch = branch.parent;
  }
  const guard = branch.parent;
  if (!guard || !ts.isIfStatement(guard) || guard.expression !== branch || guard.elseStatement) return false;
  // The entire condition must reject just this primitive shape (optionally a
  // non-empty string alternative), without additional calls or admission terms.
  const numericRejection = rejected.parent;
  if (guard.expression !== numericRejection) {
    if (
      !ts.isBinaryExpression(guard.expression) ||
      guard.expression.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken ||
      guard.expression.left !== numericRejection
    )
      return false;
    const alternative = guard.expression.right;
    if (!ts.isPrefixUnaryExpression(alternative) || alternative.operator !== ts.SyntaxKind.ExclamationToken)
      return false;
    const stringShape = unparenthesized(alternative.operand);
    if (!ts.isBinaryExpression(stringShape) || stringShape.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken)
      return false;
    const type = stringShape.left,
      length = stringShape.right;
    if (
      !ts.isBinaryExpression(type) ||
      type.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
      !ts.isTypeOfExpression(type.left) ||
      type.left.expression.getText() !== comparison.left.getText() ||
      !ts.isStringLiteralLike(type.right) ||
      type.right.text !== "string" ||
      !ts.isBinaryExpression(length) ||
      length.operatorToken.kind !== ts.SyntaxKind.GreaterThanToken ||
      !ts.isNumericLiteral(length.right) ||
      length.right.text !== "0" ||
      !ts.isPropertyAccessExpression(length.left) ||
      length.left.name.text !== "length" ||
      length.left.expression.getText() !== comparison.left.getText()
    )
      return false;
  }
  const body =
    ts.isBlock(guard.thenStatement) && guard.thenStatement.statements.length === 1
      ? guard.thenStatement.statements[0]
      : guard.thenStatement;
  if (!ts.isExpressionStatement(body) || !ts.isCallExpression(body.expression)) return false;
  const call = body.expression;
  if (
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "push" ||
    !ts.isIdentifier(call.expression.expression) ||
    call.arguments.length !== 1 ||
    !ts.isStringLiteralLike(call.arguments[0])
  )
    return false;
  if (!nativeCall(check, "Number", check.expression.name.text, scopeNames)) return false;
  const receiver = call.expression.expression.text;
  for (let scope = guard.parent; scope && !ts.isFunctionLike(scope); scope = scope.parent) {
    const declaration = bindingsAt(scope, scopeNames)?.get(receiver);
    if (declaration)
      return (
        ts.isVariableDeclaration(declaration) &&
        Boolean(declaration.parent.flags & ts.NodeFlags.Const) &&
        Boolean(
          declaration.initializer &&
            ts.isArrayLiteralExpression(declaration.initializer) &&
            declaration.initializer.elements.length === 0,
        )
      );
  }
  return false;
}

function unparenthesized(node) {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function nativeCall(node, receiver, method, scopeNames) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== receiver ||
    node.expression.name.text !== method
  )
    return false;
  for (let scope = node; scope; scope = scope.parent) if (bindingsAt(scope, scopeNames)?.has(receiver)) return false;
  return true;
}

function addBindingNames(node, bindings, declaration) {
  if (ts.isIdentifier(node)) bindings.set(node.text, declaration);
  else if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node))
    for (const element of node.elements)
      if (ts.isBindingElement(element)) addBindingNames(element.name, bindings, declaration);
}

// Direct declarations are cached once per lexical scope, using the same nearest
// binding rule as the authorization source graph, without its cross-file IO.
function bindingsAt(scope, cache) {
  if (
    !(
      ts.isBlock(scope) ||
      ts.isSourceFile(scope) ||
      ts.isFunctionLike(scope) ||
      ts.isCatchClause(scope) ||
      ts.isForStatement(scope) ||
      ts.isForOfStatement(scope) ||
      ts.isForInStatement(scope)
    )
  )
    return null;
  const cached = cache.get(scope);
  if (cached) return cached;
  const bindings = new Map();
  for (const statement of scope.statements ?? []) {
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        addBindingNames(declaration.name, bindings, declaration);
    else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name)
      addBindingNames(statement.name, bindings, statement);
    else if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause;
      if (clause.name) addBindingNames(clause.name, bindings, clause);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        addBindingNames(clause.namedBindings.name, bindings, clause.namedBindings);
      else
        for (const specifier of clause.namedBindings?.elements ?? [])
          addBindingNames(specifier.name, bindings, specifier);
    }
  }
  if (ts.isFunctionLike(scope))
    for (const parameter of scope.parameters) addBindingNames(parameter.name, bindings, parameter);
  if (ts.isFunctionExpression(scope) && scope.name) addBindingNames(scope.name, bindings, scope);
  if (ts.isCatchClause(scope) && scope.variableDeclaration)
    addBindingNames(scope.variableDeclaration.name, bindings, scope.variableDeclaration);
  if (scope.initializer && ts.isVariableDeclarationList(scope.initializer))
    for (const declaration of scope.initializer.declarations) addBindingNames(declaration.name, bindings, declaration);
  cache.set(scope, bindings);
  return bindings;
}

function loopCounter(node, scopeNames) {
  const identifier = ts.isVariableDeclaration(node) ? node.name : node;
  if (!ts.isIdentifier(identifier)) return false;
  if (ts.isPropertyAccessExpression(identifier.parent) && identifier.parent.name === identifier) return false;
  const name = identifier.text;
  for (let owner = node.parent; owner; owner = owner.parent) {
    if (ts.isFunctionLike(owner) || ts.isCaseBlock(owner)) return false;
    const declaration = bindingsAt(owner, scopeNames)?.get(name);
    if (!declaration) continue;
    if (!ts.isForStatement(owner) || !owner.incrementor || !ts.isVariableDeclaration(declaration)) return false;
    const step = owner.incrementor;
    return (
      ((ts.isPrefixUnaryExpression(step) || ts.isPostfixUnaryExpression(step)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(step.operator) &&
        ts.isIdentifier(step.operand) &&
        step.operand.text === name) ||
      (ts.isBinaryExpression(step) &&
        [ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken].includes(step.operatorToken.kind) &&
        ts.isIdentifier(step.left) &&
        step.left.text === name)
    );
  }
  return false;
}

function nameOf(node, source) {
  if (node.name && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))) return node.name.text;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return nameOf(node.parent, source);
  if (ts.isCallExpression(node)) return callName(node);
  return "";
}

function callName(node) {
  if (!ts.isCallExpression(node)) return "";
  const expression = node.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  )
    return expression.argumentExpression.text;
  return "";
}

function isFunction(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  );
}

/** Each node contributes once: subtree facts and a normalized AST Merkle fingerprint.
 * Trivia/positions/quote style are excluded; literal values and AST kinds are retained.
 * The fingerprint replaces repeated subtree text normalization, not a security check.
 */
export function scanOntologyText(file, textOrSource, onCandidate = () => {}) {
  const source =
    typeof textOrSource === "string"
      ? ts.createSourceFile(file, textOrSource, ts.ScriptTarget.Latest, true)
      : textOrSource;
  if (source.parseDiagnostics.length)
    throw new Error(`${file}: cannot scan invalid source: ${source.parseDiagnostics[0].messageText}`);
  const candidates = [],
    occurrences = new Map(),
    scopeNames = new WeakMap();
  const namespace = file.startsWith("packages/")
    ? file
        .split("/")
        .slice(0, file.startsWith("packages/adapters/") ? 3 : 2)
        .join("/")
    : "tools";

  function add(category, kind, name, reason, node, symbol, facts) {
    const identity = `${category}:${namespace}:${file}#${symbol || "<module>"}:${facts.hash}`;
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    const candidate = {
      id: occurrence === 1 ? identity : `${identity}:${occurrence}`,
      category,
      kind,
      file,
      line: lineNumber(source, node.getStart(source)),
      symbol: symbol || "<module>",
      name,
      reason,
    };
    candidates.push(candidate);
    onCandidate(candidate, node);
  }

  function visit(node, parents) {
    const ownName = nameOf(node, source);
    const named =
      ts.isVariableDeclaration(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node);
    const symbols = named && ownName ? [...parents, ownName] : parents;
    const hash = createHash("sha256").update(String(node.kind));
    // Leaf text is semantic (identifiers, operators and literal values), never trivia.
    if (
      ts.isIdentifier(node) ||
      ts.isPrivateIdentifier(node) ||
      ts.isLiteralExpression(node) ||
      ts.isTemplateLiteralToken(node)
    ) {
      const text = ts.isTemplateLiteralToken(node)
        ? [node.text, node.rawText?.replace(/\r\n?/gu, "\n")]
        : ts.isJsxText(node)
          ? node.text.replace(/\r\n?/gu, "\n")
          : node.text;
      // JSON preserves lone UTF-16 code units that UTF-8 would otherwise replace.
      hash.update(`:${JSON.stringify(text)}`);
    }
    const facts = { branches: 0, booleanReturns: 0, effects: 0, literals: 0, policyNames: 0, hash: "" };
    const children = new Map();
    ts.forEachChild(node, (child) => {
      const childFacts = visit(child, symbols);
      children.set(child, childFacts);
      hash.update(childFacts.hash);
      for (const key of ["branches", "booleanReturns", "effects", "literals", "policyNames"])
        facts[key] += childFacts[key];
    });
    const branch = ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isSwitchStatement(node);
    if (branch) facts.branches += 1;
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.expression.kind)
    )
      facts.booleanReturns += 1;
    if (literalKinds.has(node.kind)) facts.literals += 1;
    if (ts.isIdentifier(node) && policySignal(node.text, node, file, scopeNames)) facts.policyNames += 1;
    const method = callName(node);
    if (effects.has(method)) facts.effects += 1;
    facts.hash = hash.digest("hex").slice(0, 32);
    const symbol = symbols.join(".");

    if (ts.isCallExpression(node)) {
      const expression = node.expression,
        args = node.arguments;
      const receiver =
        ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
          ? expression.expression.text
          : "";
      const channel = args[0] && ts.isStringLiteralLike(args[0]) ? args[0].text : "";
      if (
        (receiver === "ipcMain" && ["handle", "on"].includes(method)) ||
        (receiver === "ipcRenderer" && ["invoke", "send"].includes(method))
      )
        add("action", "gui-ipc", method, `${receiver}.${method} registers/invokes GUI IPC`, node, symbol, facts);
      else if (["parentPort", "process"].includes(receiver) && ["on", "once"].includes(method) && channel === "message")
        add(
          "action",
          "worker-callback",
          method,
          `${receiver}.${method}(message) is an execution entry`,
          node,
          symbol,
          facts,
        );
      else if (
        ["setTimeout", "setInterval"].includes(method) &&
        args[0] &&
        isFunction(args[0]) &&
        children.get(args[0])?.effects
      )
        add("action", "scheduled-occurrence", method, `${method} callback contains effect calls`, node, symbol, facts);
      else if (effects.has(method))
        add("action", "effect-call", method, `${method}() may change state or trigger execution`, node, symbol, facts);
    }
    if (isFunction(node) && node.body) {
      const body = children.get(node.body);
      if (judgmentName.test(ownName) && body?.branches && (body.booleanReturns || domainName.test(ownName)))
        add(
          "judgment",
          "business-judgment",
          ownName,
          `predicate-shaped ${ownName}; branches=${body.branches}; booleanReturns=${body.booleanReturns}`,
          node,
          symbol,
          facts,
        );
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) &&
      policySignal(ownName, node, file, scopeNames) &&
      node.initializer
    ) {
      const initializer = node.initializer;
      if (
        literalKinds.has(initializer.kind) ||
        (ts.isObjectLiteralExpression(initializer) && children.get(initializer)?.literals)
      )
        add(
          "policy",
          "policy-value",
          ownName,
          `policy-shaped ${ownName} has literal configuration`,
          node,
          symbol,
          facts,
        );
    }
    if (branch) {
      const condition = ts.isConditionalExpression(node) ? node.condition : node.expression;
      const conditionFacts = children.get(condition);
      if (conditionFacts?.policyNames && conditionFacts.literals)
        add(
          "policy",
          "policy-branch",
          "branch",
          `policy-shaped condition contains a literal: ${source.text.slice(condition.getStart(source), Math.min(condition.end, condition.getStart(source) + 160))}`,
          node,
          symbol,
          facts,
        );
    }
    return facts;
  }
  visit(source, []);
  return candidates;
}

export function scanOntologySources(rootDir) {
  // Exclude acceptance-test roots only; similarly named product src must stay closed.
  const files = listWorktreeFiles(rootDir, ["packages", "tools"]).filter(
    (file) =>
      /\.[cm]?[jt]sx?$/u.test(file) &&
      !/\.d\.[cm]?ts$/u.test(file) &&
      !/\.(?:test|spec|vitest)\.[cm]?[jt]sx?$/u.test(file) &&
      !/(?:^|\/)(?:tests?|__tests__|fixtures?|__fixtures__|node_modules|dist|build|coverage)\//u.test(file) &&
      !/^(?:packages\/gui\/(?:e2e|test-support)|tools\/gui-e2e)\//u.test(file),
  );
  return {
    filesScanned: files.length,
    candidates: files.flatMap((file) => scanOntologyText(file, readFileSync(path.join(rootDir, file), "utf8"))),
  };
}
