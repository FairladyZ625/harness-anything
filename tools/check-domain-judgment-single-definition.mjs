#!/usr/bin/env node
/**
 * Cross-aggregate judgment single-definition ratchet (DDD slice 3).
 * Authority: dec_399F48E3547D831F1199F51E84 CH1 and the DDD blueprint;
 * dec_6B963E9B83AE4AC73FB0A61E81 CH2 for the projected fact `invalidated` field;
 * dec_6B912A63D279A922FA1288536D CH2 for authored-document readiness.
 * dec_BEFCF7D0484E901F187C2C8EC6 CH1/CH2 for the review reverify route and owner-verify boundary.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { loadOntologyClosureSnapshot } from "./gates/ontology-gate-lib.mjs";
import { judgmentImportResolver } from "./domain-judgment-consumers.mjs";
import { authoredReadinessFindings } from "./domain-judgment-authored-readiness.mjs";
import { listWorktreeFiles } from "./gates/git.mjs";

const DISPATCH_OBSERVATION_BASELINE = "tools/gate-allowlists/dispatch-lifecycle-observation.json",
  OBSERVATION_BASELINE_SCHEMA = "harness-anything/gate-allowlist/v1";

// Legacy declarations remain enforced while S2 moves their owners into EntityKindContract.
const judgments = [
  {
    id: "forwardingIntent",
    canonical: "packages/daemon/src/fleet/forwarding-intent.ts",
    symbol: "forwardingIntentIssue",
    declaration: "function",
  },
];
const requiredConsumers = new Map([
  ["packages/kernel/src/domain/task-lifecycle-review-transitions.ts", "closeoutReadiness("],
  ["packages/kernel/src/domain/completion-readiness.ts", "closeoutReadiness("],
  ["packages/storage/src/projection/sqlite-task-source.ts", "domainCloseoutReadiness("],
  ["packages/storage/src/projection/fact-event-projection.ts", "factLiveness("],
  ["packages/storage/src/projection/cold-rebuild-source.ts#liveness", "factLiveness("],
  ["packages/daemon/src/repo-cell.ts#closeout", "closeoutReadiness("],
  ["packages/daemon/src/repo-cell.ts#blocking", "blockingOf("],
  ["packages/kernel/src/domain/task-action-capability.ts", "canStartExecution("],
  [
    "packages/daemon/src/protocol/daemon-protocol-vocabulary.ts#generated-start",
    "// daemon-status-vocabulary:generated:start",
  ],
  ["packages/daemon/src/protocol/daemon-protocol-vocabulary.ts#task", "export const taskStatusWords = ["],
  ["packages/daemon/src/protocol/daemon-protocol-vocabulary.ts#decision", "export const decisionStateWords = ["],
  ["packages/daemon/src/protocol/daemon-protocol-vocabulary.ts#fact", "export const factLivenessWords = ["],
  ["packages/kernel/src/domain/task-pr-body.ts", "missingChineseCloseoutSections("],
  ["packages/daemon/src/repo-cell-submit.ts", "missingChineseCloseoutSections("],
  ["packages/daemon/src/transition-document-access.ts", "assertTransitionDocumentReady("],
  ["packages/kernel/src/domain/task-lifecycle-review-transitions.ts#reverify", "reviewReverifyRoute("],
  ["packages/kernel/src/domain/completion-readiness.ts#reverify", "reviewReverifyRoute("],
  ["packages/daemon/src/task-review-dispatch.ts", "reviewReverifyRoute("],
  ["packages/daemon/src/fleet/forwarding-port.ts", "forwardingIntentIssue("],
  ["packages/daemon/src/fleet/center-listener.ts", "forwardingIntentIssue("],
  ["packages/daemon/src/daemon-host-repository-api.ts", "forwardingIntentForAction("],
  ["packages/daemon/src/daemon-host-open.ts", "forwardingIntentForAction("],
]);
/**
 * Whether a finding is re-reviewed is judged only by the kernel route (dec_BEFCF7D0 CH1). Outside the
 * kernel a finding's `reverify` value may be parsed, shape-checked, and displayed, never compared.
 */
const REVERIFY_COMPARISON = /\.reverify\s*(?:===|!==|==|!=|\?\?|\|\|)|(?:===|!==|==|!=)\s*[\w$.?]*\.reverify\b/u;

export function checkDomainJudgmentSingleDefinition(
  root = process.cwd(),
  kinds = loadOntologyClosureSnapshot(root).kinds,
) {
  const findings = [],
    files = listWorktreeFiles(root, ["packages", "tools"]).filter(
      (rel) =>
        /\.(?:ts|tsx|mts|js|jsx|mjs)$/u.test(rel) &&
        !/(?:^|\/)(?:test|tests|fixtures)\//u.test(rel) &&
        !/\.(?:test|spec|vitest)\.[cm]?[jt]sx?$/u.test(rel),
    );
  const bodies = new Map(files.map((file) => [file, readFileSync(path.join(root, file), "utf8")])),
    registered = kinds.flatMap((kind) =>
      (kind.judgments ?? []).map((judgment) => {
        const [canonical, symbol] = judgment.symbol.split("#");
        return { ...judgment, canonical, symbol, declaration: judgment.declaration ?? "function" };
      }),
    );
  const importsJudgment = judgmentImportResolver(root, bodies);
  const definitions = new Map();
  for (const [file, body] of bodies) {
    const source = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true);
    const visit = (node, parents = []) => {
      const name = node.name && ts.isIdentifier(node.name) ? node.name.text : "",
        named =
          ts.isFunctionDeclaration(node) ||
          ts.isVariableDeclaration(node) ||
          ts.isPropertyAssignment(node) ||
          ts.isClassDeclaration(node) ||
          ts.isMethodDeclaration(node),
        symbols = named && name ? [...parents, name] : parents;
      const declaration =
        (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body
          ? "function"
          : (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer
            ? ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)
              ? "function"
              : "const"
            : null;
      if (declaration && node.name && ts.isIdentifier(node.name)) {
        const key = `${declaration}:${node.name.text}`;
        definitions.set(key, [...(definitions.get(key) ?? []), file]);
        if (symbols.length > 1) {
          const qualified = `${declaration}:${symbols.join(".")}`;
          definitions.set(qualified, [...(definitions.get(qualified) ?? []), file]);
        }
      }
      ts.forEachChild(node, (child) => visit(child, symbols));
    };
    visit(source);
  }
  for (const judgment of [...judgments, ...registered]) {
    const hits = definitions.get(`${judgment.declaration === "const" ? "const" : "function"}:${judgment.symbol}`) ?? [];
    if (hits.length !== 1 || hits[0] !== judgment.canonical)
      findings.push(
        `${judgment.id}: expected one definition of ${judgment.symbol} at ${judgment.canonical}; ` +
          `found ${hits.length ? hits.join(", ") : "none"}`,
      );
  }
  for (const contract of kinds.flatMap((kind) => kind.sourceContracts ?? [])) {
    const [file, symbol] = contract.symbol.split("#"),
      hits = (definitions.get(`function:${symbol}`) ?? []).filter((found) => found === file);
    if (hits.length !== 1)
      findings.push(`${contract.id}: source contract must resolve to one codec/adapter owner at ${contract.symbol}`);
  }
  for (const judgment of registered) {
    for (const file of judgment.consumers) {
      const body = bodies.get(file) ?? "",
        source = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true),
        names = new Set(file === judgment.canonical ? [judgment.symbol] : []);
      for (const node of source.statements) {
        if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue;
        const bindings = node.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        for (const binding of bindings.elements)
          if (!binding.isTypeOnly && importsJudgment(file, binding.name.text, judgment.canonical, judgment.symbol))
            names.add(binding.name.text);
      }
      let called = false;
      const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text))
          called = true;
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (!called) findings.push(`${file}: must consume named domain judgment ${judgment.id}`);
    }
    for (const rule of judgment.consumerRules ?? []) {
      const scope = new RegExp(rule.pathPattern, "u"),
        pattern = new RegExp(rule.pattern, rule.flags ?? "u");
      for (const [file, body] of bodies)
        if (file !== judgment.canonical && scope.test(file) && pattern.test(body))
          findings.push(`${file}: ${judgment.id}: ${rule.reason}`);
    }
  }
  for (const [key, call] of requiredConsumers) {
    const file = key.split("#")[0];
    if (!(bodies.get(file) ?? "").includes(call))
      findings.push(`${file}: must consume named domain judgment ${call.slice(0, -1)}`);
  }
  for (const file of files) {
    if (
      !/^packages\/(?:daemon|cli|gui|application|storage)\//u.test(file) ||
      /^packages\/daemon\/src\/protocol\//u.test(file)
    )
      continue;
    if (REVERIFY_COMPARISON.test(readFileSync(path.join(root, file), "utf8")))
      findings.push(`${file}: judges a finding's reverify outside the kernel reviewReverifyRoute`);
  }
  const taskAdapter = read(root, "packages/gui/src/renderer/task-adapter.ts"),
    triadic = read(root, "packages/gui/src/renderer/triadic-data.ts");
  const daemonDispatch = read(root, "packages/daemon/src/repo-cell-action-dispatch.ts"),
    taskSurface = read(root, "packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts");
  if (/function\s+(?:deriveBlocking|closeoutReadiness|gateResults)\s*\(/u.test(taskAdapter))
    findings.push("packages/gui/src/renderer/task-adapter.ts: recomputes closeout or blocking judgment");
  if (!/invalidated:\s*row\.invalidated\b/u.test(triadic))
    findings.push(
      "packages/gui/src/renderer/triadic-data.ts: must consume the projected fact `invalidated` field (row.invalidated)",
    );
  for (const [file, body] of bodies)
    if (file.startsWith("packages/gui/") && /===\s*"superseded_fact"|"superseded_fact"\s*===/u.test(body))
      findings.push(`${file}: compares the fact liveness word instead of reading the projected invalidated field`);
  if (
    /preview\s*&&\s*!current\.snapshot\.task|preview\s*&&\s*current\.snapshot\.lease|isTerminalStatus\(current\.snapshot\.task\.status\)/u.test(
      daemonDispatch,
    )
  )
    findings.push("packages/daemon/src/repo-cell-action-dispatch.ts: carries a second Task startability preview");
  if (/(?:requiredWhen|allowedWhen):\s*\{\s*field:\s*"status"/su.test(taskSurface))
    findings.push(
      "packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts: projects cancellation eligibility into the CLI",
    );
  findings.push(...authoredReadinessFindings(root));
  findings.push(
    ...checkDispatchLifecycleObservationSites(
      scanDispatchLifecycleObservationSites(root),
      readDispatchObservationBaseline(root),
    ),
  );
  return findings;
}

export function scanDispatchLifecycleObservationSites(root = process.cwd()) {
  const sites = [],
    files = listWorktreeFiles(root, ["packages"]).filter(
      (rel) =>
        /\.(?:ts|tsx|mts|js|jsx|mjs)$/u.test(rel) &&
        /(?:^|\/)src\//u.test(rel) &&
        // The kernel domain is the single home of these judgments; everything else reads its port.
        !rel.startsWith("packages/kernel/src/domain/") &&
        !/(?:^|\/)(?:test|tests|fixtures)\//u.test(rel) &&
        !/\.(?:test|spec|vitest)\.[cm]?[jt]sx?$/u.test(rel),
    );
  for (const rel of files) {
    const body = readFileSync(path.join(root, rel), "utf8"),
      source = ts.createSourceFile(rel, body, ts.ScriptTarget.Latest, true, scriptKind(rel));
    const pidProbes = new Set(["runtimePidIsAlive"]);
    for (const statement of source.statements) {
      const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
      if (bindings && ts.isNamedImports(bindings))
        for (const binding of bindings.elements)
          if ((binding.propertyName ?? binding.name).text === "runtimePidIsAlive") pidProbes.add(binding.name.text);
    }
    const reported = new Set();
    const add = (node, symbol, kind) => {
      const fingerprint = createHash("sha256")
        .update(`${rel}\0${symbol}\0${kind}\0${node.getText(source).replace(/\s+/gu, " ").trim()}`)
        .digest("hex");
      if (reported.has(fingerprint)) return;
      reported.add(fingerprint);
      sites.push({ path: rel, symbol, kind, fingerprint });
    };
    scanLocalObservationJudgments(source, pidProbes, add);
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["has", "get"].includes(node.expression.name.text) &&
        trailingName(node.expression.expression) === "processes"
      )
        add(judgmentContextNode(node), enclosingSymbol(node), "process-table-probe");
      if (ts.isBinaryExpression(node) && equalityOperators.has(node.operatorToken.kind)) {
        const names = [trailingName(node.left), trailingName(node.right)];
        if (
          names.some((name) => name === "groupPhase" || name === "phase") &&
          [node.left, node.right].some((value) => ts.isStringLiteralLike(value) && value.text === "awaiting_ruling")
        )
          add(judgmentContextNode(node), enclosingSymbol(node), "ruling-phase-branch");
      }
      if (ts.isReturnStatement(node) && node.expression) {
        const text = node.expression.getText(source),
          fnText = enclosingFunction(node)?.getText(source) ?? text;
        if (/(?:process[_-]lost|processLost)/u.test(text) && /(?:terminal|outcome|closed)/iu.test(`${text} ${fnText}`))
          add(node, enclosingSymbol(node), "process-lost-terminal-return");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites.sort(compareObservationSite);
}

/** Resolve local values by TS binding identity, including callbacks, destructuring and `x = value`.
 * Only local boolean predicates and callback bodies are followed; imports and object producers are not.
 * Cycles (survivor resampling) terminate. This is a local dependency scan, not lifecycle logic.
 */
function localObservationDependencies(source) {
  const options = { noLib: true, noResolve: true },
    host = ts.createCompilerHost(options);
  host.getSourceFile = (file) => (file === source.fileName ? source : undefined);
  const checker = ts.createProgram([source.fileName], options, host).getTypeChecker(),
    assignments = new Map(),
    symbolOf = (node) =>
      ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
  const collect = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const symbol = symbolOf(node.left);
      if (symbol) assignments.set(symbol, [...(assignments.get(symbol) ?? []), node.right]);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  return (expression) => {
    const nodes = new Set();
    const visit = (node) => {
      if (!node || nodes.has(node) || ts.isTypeNode(node) || ts.isFunctionLike(node)) return;
      nodes.add(node);
      // Accepted observation shape is an output boundary. A sibling business use of its
      // original local value is still scanned independently, never exempted by this object.
      if (ts.isObjectLiteralExpression(node) && isDispatchObservationObject(node)) return;
      // Shape validation accepts every old wire state; it cannot discriminate lifecycle state.
      if (ts.isTypeOfExpression(node)) return;
      if (
        ts.isCallExpression(node) &&
        trailingName(node.expression) === "statusWord" &&
        trailingName(node.arguments[0]) === "factLivenessWords"
      )
        return;
      if (
        ["dispatched,exhausted,null,scheduled", "exited,live,stale,unknown"].includes(
          observationShapeWords(node, symbolOf).join(","),
        )
      )
        return;
      if (ts.isIdentifier(node) && isValueReference(node)) {
        const symbol = symbolOf(node);
        for (const declaration of symbol?.declarations ?? []) {
          if (
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer &&
            !ts.isFunctionLike(declaration.initializer)
          )
            visit(declaration.initializer);
          if (ts.isBindingElement(declaration)) {
            nodes.add(declaration);
            visit(declaration.initializer);
            visit(declaration.parent.parent.initializer);
          }
        }
        for (const value of assignments.get(symbol) ?? []) visit(value);
      }
      if (ts.isCallExpression(node)) {
        visit(node.expression);
        for (const argument of node.arguments) {
          if (!ts.isFunctionLike(argument)) {
            visit(argument);
            if (["filter", "some", "every"].includes(trailingName(node.expression)) && ts.isIdentifier(argument)) {
              const callback = symbolOf(argument);
              for (const declaration of callback?.declarations ?? []) {
                const fn = ts.isFunctionDeclaration(declaration)
                  ? declaration
                  : ts.isVariableDeclaration(declaration) && ts.isFunctionLike(declaration.initializer)
                    ? declaration.initializer
                    : null;
                if (fn?.body) visit(fn.body);
              }
            }
          } else if (argument.body && !ts.isBlock(argument.body)) visit(argument.body);
          else if (argument.body) {
            const returns = (child) => {
              if (ts.isReturnStatement(child)) visit(child.expression);
              else if (!ts.isFunctionLike(child)) ts.forEachChild(child, returns);
            };
            returns(argument.body);
          }
        }
        const resultType = checker.getTypeAtLocation(node),
          returnsBoolean = (resultType.flags & ts.TypeFlags.BooleanLike) !== 0,
          called = returnsBoolean ? symbolOf(unwrappedExpression(node.expression)) : undefined;
        for (const declaration of called?.declarations ?? []) {
          const fn = ts.isFunctionDeclaration(declaration)
            ? declaration
            : ts.isVariableDeclaration(declaration) && ts.isFunctionLike(declaration.initializer)
              ? declaration.initializer
              : null;
          if (!fn?.body || ts.isObjectLiteralExpression(fn.body)) continue;
          const returned = [];
          const collectReturns = (child) => {
            if (ts.isReturnStatement(child) && child.expression) returned.push(child.expression);
            else if (!ts.isFunctionLike(child)) ts.forEachChild(child, collectReturns);
          };
          if (ts.isBlock(fn.body)) collectReturns(fn.body);
          if (returned.length > 0 && returned.every(ts.isObjectLiteralExpression)) continue;
          visit(fn.body);
        }
      } else ts.forEachChild(node, visit);
    };
    visit(expression);
    return [...nodes];
  };
}

function scanLocalObservationJudgments(source, pidProbes, add) {
  if (!/runtimePidIsAlive|fallbackState|fallbackSchedule|fallback_state|\bliveness\b|\bprocess\b/u.test(source.text))
    return;
  const dependencies = localObservationDependencies(source),
    samplingConditions = new Set();
  const kindsOf = (expression) => {
    const kinds = new Set();
    for (const node of dependencies(expression)) {
      if (insideDispatchObservationPayload(node)) continue;
      const name = ts.isBindingElement(node)
        ? propertyName(node.propertyName ?? node.name)
        : ts.isIdentifier(node) && !isValueReference(node)
          ? null
          : trailingName(node);
      if (pidProbes.has(name)) kinds.add("runtimePidIsAlive");
      if (["fallbackState", "fallbackSchedule", "fallback_state"].includes(name)) kinds.add("fallback-state-branch");
      if (name === "liveness") kinds.add("liveness-comparison");
      if (
        name === "exited" &&
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isBindingElement(node)) &&
        dependencies(ts.isBindingElement(node) ? node.parent.parent.initializer : node.expression).some(
          (part) => trailingName(part) === "process",
        )
      )
        kinds.add("stream-process-terminal-return");
    }
    return kinds;
  };
  const report = (node, expression, returnSinkOnly = false) => {
    if (insideDispatchObservationPayload(node) || directLegacyFallbackProjection(node)) return;
    for (let current = node; current && !ts.isFunctionLike(current); current = current.parent)
      if (
        ts.isIfStatement(current) &&
        isObservationEmission(current.thenStatement) &&
        (!current.elseStatement || isObservationEmission(current.elseStatement))
      )
        return;
    for (const kind of kindsOf(expression))
      if (
        (!returnSinkOnly ||
          kind === "fallback-state-branch" ||
          (kind !== "liveness-comparison" && returnStatementAncestor(node) !== null)) &&
        (kind !== "stream-process-terminal-return" ||
          !ts.isConditionalExpression(node) ||
          dependencies(node.whenTrue)
            .concat(dependencies(node.whenFalse))
            .some(
              (value) =>
                value.kind === ts.SyntaxKind.TrueKeyword ||
                value.kind === ts.SyntaxKind.FalseKeyword ||
                (ts.isStringLiteralLike(value) &&
                  ["running", "unknown", "succeeded", "failed", "cancelled"].includes(value.text)),
            ))
      )
        add(judgmentContextNode(node), enclosingSymbol(node), kind);
  };
  const visit = (node) => {
    const loopTest = ts.isForStatement(node) ? node.condition : ts.isWhileStatement(node) ? node.expression : null;
    if (loopTest) {
      const statements = ts.isBlock(node.statement) ? node.statement.statements : [node.statement];
      // Only the stop-proof shape may use survivor count for bounded resampling: fixed
      // attempt loop, positive survivor length, delay, then refresh that survivor set.
      const test = unwrappedExpression(loopTest),
        left =
          ts.isBinaryExpression(test) && test.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
            ? test.left
            : null,
        right =
          ts.isBinaryExpression(test) && test.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
            ? test.right
            : null,
        survivorCount =
          left &&
          ts.isBinaryExpression(left) &&
          left.operatorToken.kind === ts.SyntaxKind.GreaterThanToken &&
          ts.isNumericLiteral(left.right) &&
          Number(left.right.text) === 0 &&
          ts.isPropertyAccessExpression(left.left) &&
          left.left.name.text === "length" &&
          ts.isIdentifier(left.left.expression)
            ? left.left.expression.text
            : null,
        counter =
          right &&
          ts.isBinaryExpression(right) &&
          right.operatorToken.kind === ts.SyntaxKind.LessThanToken &&
          ts.isIdentifier(right.left) &&
          !dependencies(right.right).some(
            (part) =>
              pidProbes.has(trailingName(part)) ||
              ["liveness", "fallbackState", "fallbackSchedule", "exited"].includes(trailingName(part)),
          )
            ? right.left.text
            : null,
        boundedCounter =
          ts.isForStatement(node) &&
          counter !== null &&
          node.initializer &&
          ts.isVariableDeclarationList(node.initializer) &&
          node.initializer.declarations.some(
            (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === counter,
          ) &&
          node.incrementor &&
          ((ts.isPostfixUnaryExpression(node.incrementor) &&
            node.incrementor.operator === ts.SyntaxKind.PlusPlusToken &&
            ts.isIdentifier(node.incrementor.operand) &&
            node.incrementor.operand.text === counter) ||
            (ts.isBinaryExpression(node.incrementor) &&
              ts.isIdentifier(node.incrementor.left) &&
              node.incrementor.left.text === counter &&
              node.incrementor.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
              ts.isNumericLiteral(node.incrementor.right) &&
              Number(node.incrementor.right.text) === 1));
      const delay =
          statements[0] &&
          ts.isExpressionStatement(statements[0]) &&
          ts.isAwaitExpression(statements[0].expression) &&
          ts.isCallExpression(statements[0].expression.expression) &&
          trailingName(statements[0].expression.expression.expression) === "delay",
        refresh =
          statements[1] &&
          ts.isExpressionStatement(statements[1]) &&
          ts.isBinaryExpression(statements[1].expression) &&
          statements[1].expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(statements[1].expression.left) &&
          statements[1].expression.left.text === survivorCount &&
          ts.isCallExpression(statements[1].expression.right) &&
          trailingName(statements[1].expression.right.expression) === "filter" &&
          dependencies(statements[1].expression.right).some((part) => pidProbes.has(trailingName(part)));
      if (survivorCount !== null && boundedCounter && delay && refresh && statements.length === 2)
        samplingConditions.add(loopTest);
    }
    if (
      ts.isConditionalExpression(node) ||
      (ts.isIfStatement(node) &&
        !(
          isObservationEmission(node.thenStatement) &&
          (!node.elseStatement || isObservationEmission(node.elseStatement))
        ))
    )
      report(node, node.expression ?? node.condition);
    if (ts.isBinaryExpression(node) && !samplingConditions.has(enclosingLoopCondition(node))) {
      const operator = node.operatorToken.kind;
      if (
        equalityOperators.has(operator) ||
        [
          ts.SyntaxKind.LessThanToken,
          ts.SyntaxKind.LessThanEqualsToken,
          ts.SyntaxKind.GreaterThanToken,
          ts.SyntaxKind.GreaterThanEqualsToken,
        ].includes(operator)
      )
        report(node, node);
      if (
        [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(operator) ||
        // Null normalization preserves the raw observation; its later use is still traced.
        (operator === ts.SyntaxKind.QuestionQuestionToken &&
          (node.right.kind !== ts.SyntaxKind.NullKeyword || !directLegacyFallbackProjection(node)))
      )
        report(node, node, true);
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
      report(node, node.operand);
    if (ts.isCallExpression(node) && ["Boolean", "some", "every", "includes"].includes(trailingName(node.expression)))
      report(node, node);
    if (loopTest && !samplingConditions.has(loopTest)) report(node, loopTest);
    if (
      ts.isSwitchStatement(node) &&
      spoolObservationSwitch(node, dependencies) === null &&
      !node.caseBlock.clauses.every((clause) =>
        clause.statements.every((statement) => ts.isBreakStatement(statement) || isObservationEmission(statement)),
      )
    )
      report(node, node.expression);
    // A directly returned PID boolean (including a local alias) is itself a business verdict;
    // raw filtered PID arrays/counts and DTO fields have no such boolean transformation.
    const fn = enclosingFunction(node),
      callback = fn?.parent;
    if ((ts.isReturnStatement(node) && node.expression) || (ts.isArrowFunction(node) && !ts.isBlock(node.body))) {
      const result = ts.isArrowFunction(node) ? node.body : node.expression;
      const owner = ts.isArrowFunction(node) ? node : fn,
        parent = ts.isArrowFunction(node) ? node.parent : callback;
      // A filter predicate returns an observation to its caller. Judge the array result's use.
      if (
        !(
          parent &&
          ts.isCallExpression(parent) &&
          ["filter", "some", "every"].includes(trailingName(parent.expression))
        )
      )
        for (const value of dependencies(result))
          if (
            ts.isCallExpression(value) &&
            enclosingFunction(value) === owner &&
            (ts.isIdentifier(unwrappedExpression(value.expression)) || pidProbes.has(trailingName(value.expression))) &&
            kindsOf(value.expression).has("runtimePidIsAlive")
          )
            report(node, value);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function isValueReference(node) {
  const parent = node.parent;
  return (
    !(ts.isPropertyAccessExpression(parent) && parent.name === node) &&
    !(
      (ts.isPropertyAssignment(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isBindingElement(parent) ||
        ts.isFunctionDeclaration(parent)) &&
      parent.name === node
    ) &&
    !ts.isImportSpecifier(parent)
  );
}

/** Extract literal words for a shape decoder; this function makes no lifecycle decision. */
function observationShapeWords(node, symbolOf) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== "includes"
  )
    return [];
  let list = node.expression.expression;
  const seen = new Set();
  while (ts.isIdentifier(list) && !seen.has(list)) {
    seen.add(list);
    const declaration = symbolOf(list)?.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return [];
    list = declaration.initializer;
  }
  if (!ts.isArrayLiteralExpression(list)) return [];
  const words = list.elements.map((element) =>
    ts.isStringLiteralLike(element) ? element.text : element.kind === ts.SyntaxKind.NullKeyword ? "null" : "<other>",
  );
  return [...new Set(words)].sort();
}

function returnStatementAncestor(node) {
  for (let parent = node.parent; parent && !ts.isFunctionLike(parent); parent = parent.parent)
    if (ts.isReturnStatement(parent)) return parent;
  return null;
}

/** The previous-version DTO may return only the nullable raw fallback value.
 * This exception covers the exact output field, never an intermediate/business object.
 */
function directLegacyFallbackProjection(node) {
  const value = unwrappedExpression(node),
    source = ts.isBinaryExpression(value) ? unwrappedExpression(value.left) : null,
    property = value.parent,
    object = property?.parent;
  return (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    value.right.kind === ts.SyntaxKind.NullKeyword &&
    source &&
    (ts.isPropertyAccessExpression(source) || ts.isElementAccessExpression(source)) &&
    trailingName(source) === "fallbackState" &&
    property &&
    ts.isPropertyAssignment(property) &&
    propertyName(property.name) === "fallbackState" &&
    property.initializer === value &&
    object &&
    ts.isObjectLiteralExpression(object) &&
    object.parent &&
    ts.isReturnStatement(object.parent) &&
    object.parent.expression === object &&
    /Previous-version protocol output; remove 2026-12-07\./u.test(object.parent.getFullText())
  );
}

/** The raw spool observer may reread an empty chunk and emit process-loss evidence.
 * Every statement is checked: adding a resource call/assignment or a value return ends
 * this boundary. It does not exempt another use of the same observation elsewhere.
 */
function spoolObservationSwitch(node, dependencies) {
  const switched = unwrappedExpression(node.expression),
    liveValue =
      ts.isConditionalExpression(switched) && ts.isPropertyAccessExpression(unwrappedExpression(switched.whenTrue))
        ? unwrappedExpression(switched.whenTrue)
        : null;
  if (
    !ts.isConditionalExpression(switched) ||
    trailingName(switched.condition) !== "runtimeSessionId" ||
    trailingName(switched.whenFalse) !== "undefined" ||
    !liveValue ||
    liveValue.name.text !== "liveness" ||
    !ts.isPropertyAccessExpression(liveValue.expression) ||
    liveValue.expression.name.text !== "payload" ||
    trailingName(liveValue.expression.expression) !== "livenessEvent" ||
    !dependencies(switched.whenTrue).some((value) => trailingName(value) === "livenessEvent")
  )
    return null;
  const buffers = new Set(),
    lossRecords = [],
    observations = [];
  const statementOnly = (statement) => {
    if (ts.isBlock(statement)) return statement.statements.every(statementOnly);
    if (ts.isBreakStatement(statement)) return true;
    if (ts.isReturnStatement(statement)) return !statement.expression;
    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations.every(
        (declaration) => declaration.initializer && ts.isTemplateExpression(declaration.initializer),
      );
    if (ts.isIfStatement(statement))
      return (
        ts.isBinaryExpression(statement.expression) &&
        statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        ts.isPropertyAccessExpression(statement.expression.left) &&
        statement.expression.left.name.text === "length" &&
        buffers.has(statement.expression.left.expression.getText()) &&
        statement.expression.right.getText() === "0" &&
        statementOnly(statement.thenStatement) &&
        (!statement.elseStatement || statementOnly(statement.elseStatement))
      );
    if (!ts.isExpressionStatement(statement)) return false;
    const expression = statement.expression;
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(expression.left) &&
      ts.isCallExpression(expression.right) &&
      trailingName(expression.right.expression) === "readRuntimeWorkerChunk"
    ) {
      buffers.add(expression.left.text);
      return true;
    }
    if (isObservationEmission(statement)) {
      lossRecords.push(statement);
      return true;
    }
    if (
      ts.isCallExpression(expression) &&
      trailingName(expression.expression) === "emitExit" &&
      expression.arguments.length === 3 &&
      trailingName(expression.arguments[2]) === "payload"
    ) {
      observations.push(statement);
      return true;
    }
    return false;
  };
  return node.caseBlock.clauses.every((clause) => clause.statements.every(statementOnly)) &&
    buffers.size > 0 &&
    lossRecords.length > 0 &&
    observations.length > 0
    ? node
    : null;
}

function isObservationEmission(node) {
  if (ts.isBlock(node)) return node.statements.length > 0 && node.statements.every(isObservationEmission);
  if (
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    trailingName(node.expression.expression) === "appendRuntimeWorkerRecord"
  ) {
    const record = node.expression.arguments.at(-1);
    return (
      record &&
      ts.isObjectLiteralExpression(record) &&
      record.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          propertyName(property.name) === "kind" &&
          ts.isStringLiteralLike(property.initializer) &&
          ["process_lost", "process_exit"].includes(property.initializer.text),
      )
    );
  }
  return (
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    trailingName(node.expression.expression) === "push" &&
    node.expression.arguments.length > 0 &&
    node.expression.arguments.every(
      (argument) => ts.isObjectLiteralExpression(argument) && isDispatchObservationObject(argument),
    )
  );
}

function enclosingLoopCondition(node) {
  let current = node;
  while (current.parent && !ts.isFunctionLike(current.parent)) {
    const parent = current.parent;
    const loopTest = ts.isForStatement(parent)
      ? parent.condition
      : ts.isWhileStatement(parent)
        ? parent.expression
        : null;
    if (loopTest === current) {
      return current;
    }
    current = parent;
  }
  return null;
}

/** dec_AEB05951 CH4/CH6 slice 7: the retired debt inventory can never authorize a judgment. */
export function checkDispatchLifecycleObservationSites(sites, baseline) {
  const findings = [],
    entries = observationEntries(baseline);
  if (entries === null)
    findings.push(`${DISPATCH_OBSERVATION_BASELINE}: invalid or missing dispatch observation baseline`);
  else if (entries.length !== 0)
    findings.push(`${DISPATCH_OBSERVATION_BASELINE}: zero exemptions required; remove every baseline entry`);
  for (const site of sites)
    findings.push(
      `${site.path}#${site.symbol}: forbidden ${site.kind} judgment (${site.fingerprint}); consume readDispatchLifecycle`,
    );
  return findings;
}

/** Keep the B13-classified inventory present and permanently empty. */
function observationEntries(baseline) {
  return baseline?.schema === OBSERVATION_BASELINE_SCHEMA && Array.isArray(baseline.entries?.observationSites)
    ? baseline.entries.observationSites
    : null;
}

function readDispatchObservationBaseline(root) {
  const file = path.join(root, DISPATCH_OBSERVATION_BASELINE);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

function insideDispatchObservationPayload(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isObjectLiteralExpression(parent) && isDispatchObservationObject(parent)) return true;
    if (ts.isFunctionLike(parent)) return false;
  }
  return false;
}

function isDispatchObservationObject(node) {
  const observationType = (value) =>
    ts.isStringLiteralLike(value)
      ? ["runtime_session_liveness_changed", "runtime_session_exited"].includes(value.text)
      : ts.isConditionalExpression(value) && observationType(value.whenTrue) && observationType(value.whenFalse);
  return node.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      propertyName(property.name) === "type" &&
      observationType(property.initializer),
  );
}

const equalityOperators = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** `a.b.liveness`, `a?.liveness`, and a bare `liveness` all end in the name `liveness`. */
function trailingName(node) {
  if (!node) return null;
  const current = unwrappedExpression(node);
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (ts.isElementAccessExpression(current) && ts.isStringLiteralLike(current.argumentExpression))
    return current.argumentExpression.text;
  return null;
}

function unwrappedExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  )
    current = current.expression;
  return current;
}

function enclosingFunction(node) {
  for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionLike(parent)) return parent;
  return null;
}

function enclosingSymbol(node) {
  let foundFunction = false;
  for (let current = node; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    foundFunction = true;
    if (current.name && ts.isIdentifier(current.name)) return current.name.text;
    if (ts.isMethodDeclaration(current) || ts.isMethodSignature(current))
      return propertyName(current.name) ?? "<method>";
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && current.parent) {
      if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name))
        return current.parent.name.text;
      if (ts.isPropertyAssignment(current.parent)) return propertyName(current.parent.name) ?? "<property>";
    }
  }
  return foundFunction ? "<anonymous>" : "<module>";
}

function judgmentContextNode(node) {
  for (let parent = node.parent; parent && !ts.isFunctionLike(parent); parent = parent.parent)
    if (
      ts.isBinaryExpression(parent) ||
      ts.isIfStatement(parent) ||
      ts.isConditionalExpression(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isReturnStatement(parent)
    )
      return parent;
  return node;
}

function compareObservationSite(left, right) {
  return observationKey(left).localeCompare(observationKey(right));
}

function observationKey(entry) {
  return `${entry.path}|${entry.symbol}|${entry.kind}|${entry.fingerprint}`;
}

function propertyName(node) {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null;
}

function scriptKind(file) {
  return file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : file.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : file.endsWith(".js") || file.endsWith(".mjs")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
}

function read(root, rel) {
  try {
    return readFileSync(path.join(root, rel), "utf8");
  } catch {
    return "";
  }
}
async function main() {
  const findings = checkDomainJudgmentSingleDefinition();
  if (findings.length) {
    console.error("Domain judgment single-definition check failed:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exit(1);
  }
  console.log(
    "Domain judgment single-definition check passed (legacy and registry judgments resolve to their canonical domain services; authored-document reads use the projection port; dispatch observation boundary requires zero exemptions).",
  );
}
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();
