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
const literalKinds = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
]);

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
export function scanOntologyText(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length)
    throw new Error(`${file}: cannot scan invalid source: ${source.parseDiagnostics[0].messageText}`);
  const candidates = [],
    occurrences = new Map();
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
    candidates.push({
      id: occurrence === 1 ? identity : `${identity}:${occurrence}`,
      category,
      kind,
      file,
      line: lineNumber(source, node.getStart(source)),
      symbol: symbol || "<module>",
      name,
      reason,
    });
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
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
      hash.update(`:${node.text}`);
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
    if (ts.isIdentifier(node) && policyName.test(node.text)) facts.policyNames += 1;
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
      policyName.test(ownName) &&
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
  const files = listWorktreeFiles(rootDir, ["packages", "tools"]).filter(
    (file) =>
      /\.[cm]?[jt]sx?$/u.test(file) &&
      !/\.d\.[cm]?ts$/u.test(file) &&
      !/\.(?:test|spec|vitest)\.[cm]?[jt]sx?$/u.test(file) &&
      !/(?:^|\/)(?:tests?|__tests__|fixtures?|__fixtures__|node_modules|dist|build|coverage)\//u.test(file),
  );
  return {
    filesScanned: files.length,
    candidates: files.flatMap((file) => scanOntologyText(file, readFileSync(path.join(rootDir, file), "utf8"))),
  };
}
