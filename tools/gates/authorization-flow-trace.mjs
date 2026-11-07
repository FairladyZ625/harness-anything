// Ingress-to-effect authorization trace (G-A). One walk per protocol descriptor follows the
// request from the transport entry with the descriptor's method and action kind folded into
// branch conditions. A route is authorized when a decision for this action is produced from an
// AuthorizationPort call, a denial exits, and only then does the effect run with the decision
// flowing into it. Extraction and renaming keep that flow, so no production name or source text
// is compared here.
import ts from "typescript";
import { bindArguments, isFunctionNode, makeEvaluator, unwrap } from "./authorization-flow-graph.mjs";

const maxWalkDepth = 60;

function eachOwnNode(body, visit) {
  (function walk(node) {
    if (node !== body && isFunctionNode(node)) return;
    visit(node);
    ts.forEachChild(node, walk);
  })(body);
}

function containsLiteral(node, text) {
  let found = false;
  (function walk(current) {
    if (ts.isStringLiteralLike(current) && current.text === text) found = true;
    else ts.forEachChild(current, walk);
  })(node);
  return found;
}

function conjuncts(node) {
  const current = unwrap(node);
  return ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ? [...conjuncts(current.left), ...conjuncts(current.right)]
    : [current];
}

function comparesField(term, field, operator, expected) {
  if (!ts.isBinaryExpression(term) || term.operatorToken.kind !== operator) return false;
  const left = unwrap(term.left),
    right = unwrap(term.right);
  if (!ts.isPropertyAccessExpression(left) || left.name.text !== field) return false;
  return expected === true
    ? right.kind === ts.SyntaxKind.TrueKeyword
    : ts.isStringLiteralLike(right) && right.text === expected;
}

// An allowed decision built without a port call is only the declared socket-owner exception:
// a local transport, the socket owner, and a non-canonical writer, all on the same condition.
function underSocketOwnerProof(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (isFunctionNode(current)) return false;
    if (!ts.isIfStatement(current)) continue;
    const terms = conjuncts(current.expression);
    if (
      terms.some((term) => comparesField(term, "source", ts.SyntaxKind.EqualsEqualsEqualsToken, "local")) &&
      terms.some((term) => comparesField(term, "daemonSocketOwner", ts.SyntaxKind.EqualsEqualsEqualsToken, true)) &&
      terms.some((term) => comparesField(term, "scope", ts.SyntaxKind.ExclamationEqualsEqualsToken, "canonical"))
    )
      return true;
  }
  return false;
}

// `then` when a true condition means the request did not arrive over the local socket, `else`
// when a false one does: the authentication context's transport discriminant against the local
// transport. A guard is this test with an exit on its non-local side.
function nonLocalPolarity(condition) {
  const node = unwrap(condition);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = nonLocalPolarity(node.operand);
    return inner === "then" ? "else" : inner === "else" ? "then" : null;
  }
  if (!ts.isBinaryExpression(node)) return null;
  const operator = node.operatorToken.kind;
  if (operator === ts.SyntaxKind.BarBarToken)
    return [node.left, node.right].some((side) => nonLocalPolarity(side) === "then") ? "then" : null;
  if (operator === ts.SyntaxKind.AmpersandAmpersandToken)
    return [node.left, node.right].some((side) => nonLocalPolarity(side) === "else") ? "else" : null;
  if (comparesField(node, "transportKind", ts.SyntaxKind.ExclamationEqualsEqualsToken, "unix-socket")) return "then";
  if (comparesField(node, "transportKind", ts.SyntaxKind.EqualsEqualsEqualsToken, "unix-socket")) return "else";
  return null;
}

const nullish = (expression) => {
  const node = unwrap(expression);
  return (
    !node ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined") ||
    ts.isVoidExpression(node)
  );
};

let fileOf = (node) => node.getSourceFile().fileName;

function where(node) {
  const source = node.getSourceFile();
  return `${fileOf(node)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
}

function parameterUsed(parameter, fn) {
  const names = new Set();
  (function collect(name) {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) collect(element.name);
  })(parameter.name);
  let used = false;
  (function walk(node) {
    if (ts.isIdentifier(node) && names.has(node.text) && node.parent !== parameter) used = true;
    else ts.forEachChild(node, walk);
  })(fn.body);
  return used;
}

export function makeAuthorizationTracer(graph, anchors) {
  fileOf = graph.fileOf;
  const neutral = makeEvaluator(graph, { constants: {}, functions: {} }),
    producerCache = new Map(),
    predicateCache = new Map();

  const resolvedFunctions = (expression) =>
    neutral
      .evaluate(expression, new Map())
      .filter((value) => value.fn)
      .map((value) => value.node);

  // The AuthorizationPort members as the kernel declares them; a same-named method on any other
  // type (a host, a replication source) is not a policy decision.
  const portMembers = new Map();
  for (const { file, name } of anchors.ports)
    for (const [key, member] of graph.interfaceMembers(file, name)) {
      const members = portMembers.get(key) ?? new Set();
      members.add(member);
      portMembers.set(key, members);
    }
  const portCalls = new Map(),
    decisionCallbacks = new Map();

  /** A callback whose own type receives the kernel AuthorizationDecision is the guarded effect. */
  function decisionCallback(parameter) {
    if (!decisionCallbacks.has(parameter))
      decisionCallbacks.set(
        parameter,
        anchors.decision ? graph.takesInterface(parameter, anchors.decision.file, anchors.decision.name) : false,
      );
    return decisionCallbacks.get(parameter);
  }

  function isPortCall(node) {
    if (portCalls.has(node)) return portCalls.get(node);
    const callee = unwrap(node.expression),
      key = ts.isPropertyAccessExpression(callee) ? callee.name.text : null,
      members = key === null ? undefined : portMembers.get(key),
      signatures = members ? graph.memberSignature(callee) : null,
      port = Boolean(
        signatures &&
          [...signatures].some(
            (declaration) => members.has(declaration) || graph.implementsMember(declaration, key, members),
          ),
      );
    portCalls.set(node, port);
    return port;
  }

  function declaredIn(tainted, identifier) {
    const binding = graph.lookup(identifier.text, identifier);
    return binding ? tainted.has(binding.declaration ?? binding.parameter) : false;
  }

  /** Whether an expression's value is data-dependent on an authorization decision. */
  function derived(expression, tainted) {
    const node = unwrap(expression);
    if (!node) return false;
    if (ts.isIdentifier(node)) return declaredIn(tainted, node);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      return derived(node.expression, tainted);
    if (ts.isConditionalExpression(node)) return derived(node.whenTrue, tainted) || derived(node.whenFalse, tainted);
    if (ts.isObjectLiteralExpression(node))
      return node.properties.some((property) =>
        ts.isSpreadAssignment(property)
          ? derived(property.expression, tainted)
          : ts.isPropertyAssignment(property)
            ? derived(property.initializer, tainted)
            : ts.isShorthandPropertyAssignment(property) && declaredIn(tainted, property.name),
      );
    if (ts.isCallExpression(node)) {
      if (isPortCall(node)) return true;
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "then")
        return derived(callee.expression, tainted);
      return decisionCall(node, tainted);
    }
    return false;
  }

  /** Whether a value handed to a call may be the decision: `decided ?? fallback` still carries it. */
  function spends(expression, tainted, depth) {
    const node = unwrap(expression);
    if (!node || depth > 4) return false;
    if (derived(node, tainted)) return true;
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)
    )
      return spends(node.left, tainted, depth + 1) || spends(node.right, tainted, depth + 1);
    if (ts.isIdentifier(node)) {
      const binding = graph.lookup(node.text, node);
      return binding?.kind === "var" && binding.declaration.initializer
        ? spends(binding.declaration.initializer, tainted, depth + 1)
        : false;
    }
    if (ts.isCallExpression(node) || ts.isObjectLiteralExpression(node))
      return ts.isCallExpression(node)
        ? node.arguments.some((argument) => spends(argument, tainted, depth + 1)) || derived(node, tainted)
        : node.properties.some((property) =>
            ts.isSpreadAssignment(property)
              ? spends(property.expression, tainted, depth + 1)
              : ts.isPropertyAssignment(property)
                ? spends(property.initializer, tainted, depth + 1)
                : ts.isShorthandPropertyAssignment(property) && spends(property.name, tainted, depth + 1),
          );
    return false;
  }

  function decisionCall(node, tainted) {
    if (isPortCall(node)) return true;
    if (node.arguments.some((argument) => derived(argument, tainted))) return true;
    return resolvedFunctions(unwrap(node.expression)).some(producesDecision);
  }

  function taint(declaration, tainted) {
    if (declaration.initializer && derived(declaration.initializer, tainted)) tainted.add(declaration);
  }

  /** Every return is a port-evaluated decision, a denial, or the socket-owner exception. */
  function producesDecision(fn) {
    if (producerCache.has(fn)) return producerCache.get(fn);
    producerCache.set(fn, false);
    const tainted = new Set();
    let evaluated = false,
      undecided = false;
    const inspect = (result, anchor) => {
      if (result && derived(result, tainted)) evaluated = true;
      else if (
        !result ||
        !(
          (containsLiteral(result, "denied") && !containsLiteral(result, "allowed")) ||
          (containsLiteral(result, "allowed") && underSocketOwnerProof(anchor))
        )
      )
        undecided = true;
    };
    if (fn.body && ts.isBlock(fn.body))
      eachOwnNode(fn.body, (node) => {
        if (ts.isVariableDeclaration(node)) taint(node, tainted);
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const target = unwrap(node.left);
          if (ts.isIdentifier(target) && derived(node.right, tainted)) {
            const binding = graph.lookup(target.text, target);
            if (binding?.declaration) tainted.add(binding.declaration);
          }
        }
        if (ts.isReturnStatement(node)) inspect(node.expression, node);
      });
    else if (fn.body) inspect(fn.body, fn.body);
    const proven = evaluated && !undecided;
    producerCache.set(fn, proven);
    return proven;
  }

  /** `then` when a true condition means denied, `else` when a false condition means denied. */
  function denialPolarity(condition, tainted) {
    const node = unwrap(condition);
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      const inner = denialPolarity(node.operand, tainted);
      return inner === "then" ? "else" : inner === "else" ? "then" : null;
    }
    if (ts.isCallExpression(node))
      return resolvedFunctions(unwrap(node.expression)).some(allowPredicate) ? "else" : null;
    if (!ts.isBinaryExpression(node)) return null;
    const left = unwrap(node.left),
      right = unwrap(node.right);
    if (!ts.isPropertyAccessExpression(left) || left.name.text !== "outcome" || !ts.isStringLiteralLike(right))
      return null;
    if (!derived(left.expression, tainted)) return null;
    const equal = node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken,
      unequal = node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    if (!equal && !unequal) return null;
    if (right.text === "denied") return equal ? "then" : "else";
    return right.text === "allowed" ? (equal ? "else" : "then") : null;
  }

  /** A boolean answer that is true exactly for an allowed decision. */
  function allowPredicate(fn) {
    if (predicateCache.has(fn)) return predicateCache.get(fn);
    predicateCache.set(fn, false);
    const tainted = new Set();
    let allowed = false,
      undecided = false;
    if (fn.body && ts.isBlock(fn.body))
      eachOwnNode(fn.body, (node) => {
        if (ts.isVariableDeclaration(node)) taint(node, tainted);
        if (!ts.isReturnStatement(node)) return;
        const value = unwrap(node.expression);
        if (value?.kind === ts.SyntaxKind.FalseKeyword) return;
        if (value && denialPolarity(value, tainted) === "else") allowed = true;
        else undecided = true;
      });
    const proven = allowed && !undecided;
    predicateCache.set(fn, proven);
    return proven;
  }

  // A branch chosen by the authorization port itself (a bootstrap window decided by asking the
  // port whether anyone holds the authority) is a policy outcome, not a bypass of it.
  const portReaching = new Map();
  function reachesPort(fn, depth) {
    if (!fn.body || depth > 3) return false;
    if (portReaching.has(fn)) return portReaching.get(fn);
    portReaching.set(fn, false);
    let found = false;
    eachOwnNode(fn.body, (node) => {
      if (!found && ts.isCallExpression(node))
        found =
          isPortCall(node) || resolvedFunctions(unwrap(node.expression)).some((inner) => reachesPort(inner, depth + 1));
    });
    portReaching.set(fn, found);
    return found;
  }

  function portDecided(condition, tainted) {
    if (!condition) return false;
    if (derived(condition, tainted)) return true;
    let found = false;
    (function walk(node) {
      if (found || isFunctionNode(node)) return;
      if (ts.isIdentifier(node) && declaredIn(tainted, node)) found = true;
      else if (ts.isCallExpression(node))
        found = isPortCall(node) || resolvedFunctions(unwrap(node.expression)).some((fn) => reachesPort(fn, 0));
      if (!found) ts.forEachChild(node, walk);
    })(unwrap(condition));
    return found;
  }

  /** Trace one descriptor from the transport entries. */
  function traceDescriptor(descriptor) {
    const facts = {
        method: descriptor.method,
        kind: descriptor.kind,
        commandClass: descriptor.commandClass,
        fields: descriptor.fields ?? {},
        authorityModule: anchors.authorityModule,
        constants: anchors.constants,
        functions: anchors.functions,
      },
      evaluator = makeEvaluator(graph, facts),
      report = { authorized: [], local: [], violations: [], unresolved: [], decisionKinds: new Set() },
      memo = new Map(),
      frameKeys = new WeakMap(),
      frameIds = new Map(),
      guardCalls = new Map(),
      stack = [];

    const newState = () => ({
      alive: true,
      authorized: false,
      effect: false,
      local: false,
      consumed: false,
      tainted: new Set(),
      refusals: new Set(),
      decisionKind: null,
    });
    const clone = (state) => ({ ...state, tainted: new Set(state.tainted), refusals: new Set(state.refusals) });
    // Calls whose result is non-null exactly when the request is not local (a refusal value).
    const refusalCalls = new WeakSet();
    const join = (left, right) => {
      const live = [left, right].filter((state) => state.alive);
      if (live.length === 0) return { ...left, alive: false };
      return {
        alive: true,
        authorized: live.every((state) => state.authorized),
        effect: live.some((state) => state.effect),
        local: live.every((state) => state.local),
        // Spent on some path: what is still pending after the meeting point is the unspent rest.
        consumed: live.some((state) => state.consumed),
        tainted: new Set([...left.tainted, ...right.tainted]),
        refusals: new Set([...left.refusals].filter((declaration) => right.refusals.has(declaration))),
        decisionKind: live.every((state) => sameSubject(state.decisionKind, live[0].decisionKind))
          ? live[0].decisionKind
          : null,
      };
    };

    // What a produced decision answers for: whether its policy input carries this request (the
    // route's own data edge into authorization) and, when it folds, the policy action kind.
    function decisionSubject(call, env, depth = 0) {
      if (depth > 6) return { kind: null, routed: false };
      const [argument] = call.arguments;
      let kind = null;
      if (argument)
        for (const access of [
          propertyOf(argument, "kind"),
          propertyOf(propertyOf(argument, "action"), "kind"),
          propertyOf(argument, "action"),
        ]) {
          const folded = access && evaluator.fold(access, env);
          if (folded && typeof folded.value === "string") {
            kind = folded.value;
            break;
          }
        }
      const carried = call.arguments.some((input) => carriesRequest(input, env));
      if (carried && kind !== null) return { kind, routed: true };
      let evaluatedKind = null;
      for (const value of evaluator.evaluate(unwrap(call.expression), env)) {
        if (!value.fn || !value.node.body) continue;
        let inner = null;
        eachOwnNode(value.node.body, (node) => {
          if (inner === null && ts.isCallExpression(node) && node !== call && decisionCall(node, new Set()))
            inner = decisionSubject(node, bindArguments(value, call.arguments, env), depth + 1);
        });
        if (inner?.routed || (carried && inner?.kind)) return { kind: kind ?? inner.kind, routed: true };
        evaluatedKind ??= inner?.kind ?? null;
      }
      // A decision over stored state still answers for the action its port call evaluated.
      return { kind: kind ?? evaluatedKind, routed: carried };
    }

    function carriesRequest(expression, env) {
      const node = unwrap(expression);
      if (!node) return false;
      if (ts.isObjectLiteralExpression(node))
        return node.properties.some((property) =>
          ts.isSpreadAssignment(property)
            ? carriesRequest(property.expression, env)
            : ts.isPropertyAssignment(property)
              ? carriesRequest(property.initializer, env)
              : ts.isShorthandPropertyAssignment(property) && carriesRequest(property.name, env),
        );
      if (ts.isIdentifier(node)) {
        const binding = graph.lookup(node.text, node);
        if (binding?.kind === "var" && binding.declaration.initializer)
          return carriesRequest(binding.declaration.initializer, env) || evaluator.provenance(node, env) !== null;
      }
      if (ts.isCallExpression(node) && node.arguments.some((input) => carriesRequest(input, env))) return true;
      return evaluator.provenance(node, env) !== null;
    }

    function propertyOf(expression, key) {
      if (!expression) return undefined;
      const node = unwrap(expression);
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of [...node.properties].reverse()) {
          if (ts.isPropertyAssignment(property) && property.name.getText().replace(/"/gu, "") === key)
            return property.initializer;
          if (ts.isShorthandPropertyAssignment(property) && property.name.text === key) return property.name;
          if (ts.isSpreadAssignment(property)) {
            // `...(cond ? { a } : {})` cannot supply the key; any other spread might.
            if (lacksKey(property.expression, key)) continue;
            return ts.factory.createPropertyAccessExpression(property.expression, key);
          }
        }
        return undefined;
      }
      return syntheticAccess(node, key);
    }

    function lacksKey(expression, key) {
      const node = unwrap(expression);
      if (ts.isConditionalExpression(node)) return lacksKey(node.whenTrue, key) && lacksKey(node.whenFalse, key);
      return (
        ts.isObjectLiteralExpression(node) &&
        node.properties.every((property) => !ts.isSpreadAssignment(property) && property.name?.getText() !== key)
      );
    }

    function syntheticAccess(node, key) {
      const access = ts.factory.createPropertyAccessExpression(node, key);
      ts.setTextRange(access, node);
      Object.defineProperty(access, "parent", { value: node.parent });
      return access;
    }

    // Dominance is per path. Where branches meet, the code after the meeting point is reached by
    // every live branch; if one of them carries this route's authorization and another does not,
    // that other branch reaches what follows (the effect) without it. A branch that exits (a denial
    // return, a throw, an early response) is not live and does not count.
    const partialJoins = new Set();
    // An authorization already spent on its own effect inside the branch (a publication that
    // authorizes, exits on denial and writes) guards nothing after the meeting point.
    function checkJoin(node, before, branches, condition) {
      if (before.authorized) return;
      const live = branches.filter((branch) => branch.alive);
      if (
        !live.some(
          (branch) => branch.authorized && !branch.consumed && branch.decisionKind?.kind === descriptor.kind,
        ) ||
        !live.some((branch) => !branch.authorized)
      )
        return;
      const at = where(node);
      if (partialJoins.has(at) || portDecided(condition, before.tainted)) return;
      partialJoins.add(at);
      report.violations.push(`${at}: a branch reaches the code after it without the ${descriptor.kind} authorization`);
    }

    const sameSubject = (left, right) => left?.kind === right?.kind && left?.routed === right?.routed;
    const label = (subject) => subject?.kind ?? "request";

    function recordDecision(node, env, state, call) {
      const binding = ts.isIdentifier(node) ? graph.lookup(node.text, node) : null;
      if (binding?.declaration) state.tainted.add(binding.declaration);
      const subject = call ? decisionSubject(call, env) : null;
      if (subject?.kind) report.decisionKinds.add(subject.kind);
      if (call) checkCut(call, env, subject);
      state.decisionKind = subject;
    }

    // The kernel decision records the repository cut it was evaluated at (`evaluatedAtCut`). For a
    // canonical action, a cut that folds to a constant under the route's own bindings is not the
    // current cut: the decision would answer for a fixed revision, whatever the repository head is
    // when the effect runs. Host- and runtime-local actions have no canonical cut to read.
    const fixedCuts = new Set();
    function checkCut(call, env, subject) {
      if (!descriptor.canonicalCut || subject?.kind !== descriptor.kind) return;
      const fixed = fixedCutOf(call, env, 0, new Set());
      if (fixed && !fixedCuts.has(fixed)) {
        fixedCuts.add(fixed);
        report.violations.push(fixed);
      }
    }

    function fixedCutOf(call, env, depth, seen) {
      if (depth > 8) return null;
      const callee = unwrap(call.expression);
      if (ts.isPropertyAccessExpression(callee) && ["then", "catch", "finally"].includes(callee.name.text)) {
        const receiver = unwrap(callee.expression);
        return ts.isCallExpression(receiver) ? fixedCutOf(receiver, env, depth + 1, seen) : null;
      }
      if (ts.isPropertyAccessExpression(callee) && callee.getText() === "Object.freeze")
        return cutIn(call.arguments[0], env, depth + 1, seen);
      for (const value of evaluator.evaluate(callee, env)) {
        if (!value.fn || !value.node.body || seen.has(value.node)) continue;
        seen.add(value.node);
        const inner = bindArguments(value, call.arguments, env),
          returns = [];
        if (ts.isBlock(value.node.body))
          eachOwnNode(value.node.body, (node) => {
            if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression);
          });
        else returns.push(value.node.body);
        for (const result of returns) {
          const fixed = cutIn(result, inner, depth + 1, seen);
          if (fixed) return fixed;
        }
      }
      return null;
    }

    function cutIn(expression, env, depth, seen) {
      const node = unwrap(expression);
      if (!node || depth > 8) return null;
      if (ts.isConditionalExpression(node))
        return cutIn(node.whenTrue, env, depth + 1, seen) ?? cutIn(node.whenFalse, env, depth + 1, seen);
      if (ts.isCallExpression(node)) return fixedCutOf(node, env, depth + 1, seen);
      if (ts.isIdentifier(node)) {
        const binding = graph.lookup(node.text, node);
        return binding?.kind === "var" && binding.trail.length === 0 && binding.declaration.initializer
          ? cutIn(binding.declaration.initializer, env, depth + 1, seen)
          : null;
      }
      if (!ts.isObjectLiteralExpression(node)) return null;
      const cut = propertyOf(node, "evaluatedAtCut");
      if (!cut) return null;
      const folded = evaluator.fold(cut, env);
      return folded
        ? `${where(cut)}: the ${descriptor.kind} decision is evaluated at the fixed cut ${JSON.stringify(folded.value)}`
        : null;
    }

    function visit(expression, env, state) {
      const node = unwrap(expression);
      if (!node || isFunctionNode(node) || !state.alive) return;
      if (ts.isConditionalExpression(node)) {
        visit(node.condition, env, state);
        const folded = evaluator.fold(node.condition, env);
        if (folded) return visit(folded.value ? node.whenTrue : node.whenFalse, env, state);
        const left = clone(state),
          right = clone(state);
        visit(node.whenTrue, env, left);
        visit(node.whenFalse, env, right);
        checkJoin(node, state, [left, right], node.condition);
        Object.assign(state, join(left, right));
        return;
      }
      if (ts.isCallExpression(node)) return visitCall(node, env, state);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        visit(node.right, env, state);
        const target = unwrap(node.left),
          right = unwrap(node.right);
        if (ts.isIdentifier(target) && derived(right, state.tainted))
          recordDecision(target, env, state, ts.isCallExpression(right) ? right : null);
        return;
      }
      ts.forEachChild(node, (child) => visit(child, env, state));
    }

    function carriesRoute(argument, env) {
      const node = unwrap(argument);
      if (!node) return false;
      if (ts.isIdentifier(node)) {
        const binding = graph.lookup(node.text, node);
        if (binding?.kind === "param") return env.has(binding.parameter);
        return binding?.kind === "var" && binding.declaration.initializer
          ? carriesRoute(binding.declaration.initializer, env)
          : false;
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
        return carriesRoute(node.expression, env);
      if (ts.isObjectLiteralExpression(node))
        return node.properties.some((property) =>
          ts.isSpreadAssignment(property)
            ? carriesRoute(property.expression, env)
            : ts.isShorthandPropertyAssignment(property)
              ? carriesRoute(property.name, env)
              : ts.isPropertyAssignment(property) && carriesRoute(property.initializer, env),
        );
      if (ts.isCallExpression(node)) return node.arguments.some((inner) => carriesRoute(inner, env));
      if (ts.isConditionalExpression(node))
        return carriesRoute(node.whenTrue, env) || carriesRoute(node.whenFalse, env);
      return false;
    }

    function functionArgument(argument, env) {
      const node = unwrap(argument);
      if (isFunctionNode(node)) return true;
      if (!ts.isIdentifier(node)) return false;
      const binding = graph.lookup(node.text, node);
      if (binding?.kind === "fn") return true;
      if (binding?.kind === "param")
        return (
          Boolean(env.get(binding.parameter)?.expression) && evaluator.evaluate(node, env).some((value) => value.fn)
        );
      return binding?.kind === "var" && isFunctionNode(unwrap(binding.declaration.initializer));
    }

    function visitCall(node, env, state) {
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "then") {
        visit(callee.expression, env, state);
        const [resolved] = node.arguments;
        for (const value of resolved ? evaluator.evaluate(resolved, env) : [])
          if (value.fn) walkFunction(value, bindArguments(value, [callee.expression], env), clone(state));
        return;
      }
      if (ts.isPropertyAccessExpression(callee) && ["catch", "finally"].includes(callee.name.text))
        return visit(callee.expression, env, state);
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
        visit(callee.expression, env, state);
      for (const argument of node.arguments) visit(argument, env, state);
      if (isPortCall(node)) return;
      const values = evaluator.evaluate(callee, env);
      const boundParameter = ts.isIdentifier(callee) ? graph.lookup(callee.text, callee) : null,
        decisionData = state.authorized && node.arguments.some((argument) => derived(argument, state.tainted));
      for (const value of values) {
        if (value.broken) {
          if (state.effect || decisionData) report.violations.push(`${where(node)}: ${value.broken}`);
          else report.unresolved.push(`${where(node)}: ${value.broken}`);
        }
      }
      const functions = values.filter((value) => value.fn);
      if (state.authorized && node.arguments.some((argument) => spends(argument, state.tainted, 0)))
        state.consumed = true;
      // A declared local-transport route continues past its transport guard into resolved code.
      if (descriptor.localTransport && state.local && functions.length > 0 && !state.localReported) {
        state.localReported = true;
        report.local.push(`${where(node)}: runs only after the local-transport exit`);
      }
      // A local function handed to an external scheduler (Promise.all, Array.from, map) runs.
      if (functions.length === 0 && values.some((value) => value.external !== undefined))
        for (const argument of node.arguments)
          for (const value of functionArgument(argument, env) ? evaluator.evaluate(argument, env) : [])
            if (value.fn) walkFunction(value, new Map(value.env), clone(state));
      if (
        state.effect &&
        decisionData &&
        functions.length === 0 &&
        !values.some((value) => value.external !== undefined) &&
        routedFrame(env)
      )
        report.violations.push(`${where(node)}: the authorized effect does not resolve`);
      // A traced effect that receives the routed decision after its denial exit is authorized.
      if (decisionData && state.decisionKind?.kind === descriptor.kind && functions.length > 0 && !state.reported) {
        state.reported = true;
        report.authorized.push(`${where(node)}: ${label(state.decisionKind)} decision flows into the effect`);
      }
      let allAuthorized = functions.length > 0,
        enforcedSubject = null;
      const walked = [];
      for (const value of functions) {
        if (allowPredicate(value.node)) {
          allAuthorized = false;
          continue;
        }
        if (producesDecision(value.node)) {
          // A producer that itself exits on denial is an enforcer: what follows it is authorized.
          const outcome = walkFunction(value, bindArguments(value, node.arguments, env), {
            ...newState(),
            effect: state.effect,
          });
          if (outcome.authorizedReturn) {
            enforcedSubject = decisionSubject(node, env);
            checkCut(node, env, enforcedSubject);
          } else allAuthorized = false;
          continue;
        }
        if (boundParameter?.kind === "param" && env.get(boundParameter.parameter)?.expression) {
          invokeCallback(boundParameter.parameter, value, node, env, state);
          allAuthorized = false;
          continue;
        }
        const descend =
          state.effect ||
          // An immediately invoked function runs in this frame; a closure over the route carries it.
          isFunctionNode(callee) ||
          (value.env.size > 0 && routedFrame(value.env)) ||
          node.arguments.some((argument) => carriesRoute(argument, env) || functionArgument(argument, env)) ||
          // A declared local-transport route follows the authentication context into its guard.
          (descriptor.localTransport && node.arguments.some((argument) => graph.carriesTransport(argument)));
        if (!descend) {
          allAuthorized = false;
          continue;
        }
        const inner = clone(state);
        inner.authorized = false;
        inner.consumed = false;
        const outcome = walkFunction(value, bindArguments(value, node.arguments, env), inner);
        walked.push(outcome);
        if (!outcome.authorizedReturn) allAuthorized = false;
        else {
          state.decisionKind = outcome.decisionKind;
          if (outcome.consumedReturn) state.consumed = true;
        }
      }
      if (walked.length > 0 && walked.length === functions.length) {
        // A callee that returns only past its own local-transport exit leaves this frame local.
        if (walked.every((outcome) => outcome.localReturn)) state.local = true;
        // A callee answering null only on the local side is a refusal: `if (refusal) exit`.
        else if (walked.every((outcome) => outcome.refusal)) refusalCalls.add(node);
      }
      // A callee whose every return passed its own denial exit authorizes what follows it.
      if (allAuthorized && !state.authorized) {
        state.authorized = true;
        if (enforcedSubject) {
          state.decisionKind = enforcedSubject;
          if (enforcedSubject.kind) report.decisionKinds.add(enforcedSubject.kind);
        }
        // A host enforcer has no effect callback, so it must answer for this exact action kind.
        if (state.decisionKind?.kind === descriptor.kind)
          report.authorized.push(`${where(node)}: ${label(state.decisionKind)} enforced before the effect`);
      }
    }

    /** A frame is on the traced route when one of its bindings carries the request. */
    function routedFrame(env) {
      for (const bound of env.values())
        if (bound.root || evaluator.provenance(bound.expression, bound.env)) return true;
      return false;
    }

    function invokeCallback(parameter, value, call, env, state) {
      // Grouped per guard frame: a non-durable branch of another command is not this route's bypass.
      const group = `${frameKeys.get(env) ?? 0}`,
        frames = guardCalls.get(parameter) ?? new Map(),
        calls = frames.get(group) ?? { routed: routedFrame(env), calls: [] };
      calls.calls.push({ authorized: state.authorized, at: where(call), carried: false, parameter });
      frames.set(group, calls);
      guardCalls.set(parameter, frames);
      const next = bindArguments(value, call.arguments, env),
        inner = clone(state);
      if (state.authorized) {
        const carried = value.node.parameters.filter(
          (_parameter, index) => call.arguments[index] && derived(call.arguments[index], state.tainted),
        );
        if (carried.length > 0) {
          calls.calls.at(-1).carried = true;
          state.consumed = true;
          if (!carried.some((candidate) => parameterUsed(candidate, value.node)))
            report.violations.push(`${where(value.node)}: the authorization decision does not reach the effect`);
          for (const candidate of carried) inner.tainted.add(candidate);
          inner.effect = true;
          if (state.decisionKind?.routed && state.decisionKind.kind === descriptor.kind)
            report.authorized.push(
              `${where(value.node)}: ${label(state.decisionKind)} decision flows into the effect callback`,
            );
        }
      }
      walkFunction(value, next, inner);
    }

    function walkStatement(statement, env, state, frame) {
      if (!statement || !state.alive) return;
      if (ts.isBlock(statement)) for (const child of statement.statements) walkStatement(child, env, state, frame);
      else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!declaration.initializer) continue;
          visit(declaration.initializer, env, state);
          if (refusalCalls.has(unwrap(declaration.initializer))) state.refusals.add(declaration);
          if (derived(declaration.initializer, state.tainted)) {
            state.tainted.add(declaration);
            const call = producerCallIn(declaration.initializer, env);
            if (call) {
              state.decisionKind = decisionSubject(call, env);
              checkCut(call, env, state.decisionKind);
            }
          }
        }
      } else if (ts.isExpressionStatement(statement)) visit(statement.expression, env, state);
      else if (ts.isReturnStatement(statement)) {
        visit(statement.expression, env, state);
        if (state.alive)
          frame.returns.push({
            authorized: state.authorized,
            consumed: state.consumed,
            decisionKind: state.decisionKind,
            local: state.local,
            nullish: nullish(statement.expression),
          });
        state.alive = false;
      } else if (ts.isThrowStatement(statement)) state.alive = false;
      else if (ts.isIfStatement(statement)) walkIf(statement, env, state, frame);
      else if (ts.isTryStatement(statement)) {
        walkStatement(statement.tryBlock, env, state, frame);
        if (statement.finallyBlock) walkStatement(statement.finallyBlock, env, clone(state), frame);
      } else if (ts.isSwitchStatement(statement)) walkSwitch(statement, env, state, frame);
      else if (
        ts.isForOfStatement(statement) ||
        ts.isForStatement(statement) ||
        ts.isForInStatement(statement) ||
        ts.isWhileStatement(statement)
      )
        walkStatement(statement.statement, env, clone(state), frame);
    }

    /** The producing call of a decision expression, through a folded or decision-only choice. */
    function producerCallIn(expression, env) {
      const node = unwrap(expression);
      if (ts.isCallExpression(node)) return node;
      if (!ts.isConditionalExpression(node)) return null;
      const folded = evaluator.fold(node.condition, env);
      if (folded) return producerCallIn(folded.value ? node.whenTrue : node.whenFalse, env);
      return [node.whenTrue, node.whenFalse].map((branch) => producerCallIn(branch, env)).find(Boolean) ?? null;
    }

    function walkIf(statement, env, state, frame) {
      visit(statement.expression, env, state);
      const folded = evaluator.fold(statement.expression, env);
      if (folded)
        return walkStatement(folded.value ? statement.thenStatement : statement.elseStatement, env, state, frame);
      const polarity = denialPolarity(statement.expression, state.tainted),
        transport = nonLocalPolarity(statement.expression) ?? refusalPolarity(statement.expression, state),
        left = clone(state),
        right = clone(state);
      if (transport === "then") right.local = true;
      if (transport === "else") left.local = true;
      if (polarity === "else") left.authorized = true;
      if (polarity === "then") right.authorized = true;
      // A boolean predicate over a decision answers for the action its own port call evaluated.
      const predicate = polarity && predicateCallIn(statement.expression);
      if (predicate) (polarity === "else" ? left : right).decisionKind = decisionSubject(predicate, env);
      walkStatement(statement.thenStatement, env, left, frame);
      walkStatement(statement.elseStatement, env, right, frame);
      // A denial branch that does not exit leaves the denied decision live after the test.
      if (polarity === "then" && left.alive) right.authorized = state.authorized;
      if (polarity === "else" && right.alive) left.authorized = state.authorized;
      // A non-local branch that does not exit leaves the request's transport unproven.
      if (transport === "then" && left.alive) right.local = state.local;
      if (transport === "else" && right.alive) left.local = state.local;
      checkJoin(statement, state, [left, right], statement.expression);
      Object.assign(state, join(left, right));
      // A denial exit for this exact routed action authorizes everything after the test.
      if (polarity && state.alive && state.authorized && !state.reported) reportExactExit(statement, state);
    }

    function refusalPolarity(condition, state) {
      const node = unwrap(condition);
      if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
        return refusalPolarity(node.operand, state) === "then" ? "else" : null;
      if (!ts.isIdentifier(node)) return null;
      const binding = graph.lookup(node.text, node);
      return binding?.declaration && state.refusals.has(binding.declaration) ? "then" : null;
    }

    function predicateCallIn(condition) {
      const node = unwrap(condition);
      if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
        return predicateCallIn(node.operand);
      return ts.isCallExpression(node) && resolvedFunctions(unwrap(node.expression)).some(allowPredicate) ? node : null;
    }

    function reportExactExit(node, state) {
      if (state.decisionKind?.kind !== descriptor.kind) return;
      state.reported = true;
      report.authorized.push(`${where(node)}: ${label(state.decisionKind)} denial exits before the effect`);
    }

    function walkSwitch(statement, env, state, frame) {
      visit(statement.expression, env, state);
      const folded = evaluator.fold(statement.expression, env);
      const clauses = statement.caseBlock.clauses,
        matched = folded
          ? clauses.some(
              (clause) => ts.isCaseClause(clause) && evaluator.fold(clause.expression, env)?.value === folded.value,
            )
          : false,
        // Without a taken case or a default, control continues after the switch.
        fallsThrough = !clauses.some(ts.isDefaultClause) && !matched;
      let merged = fallsThrough ? clone(state) : { ...state, alive: false };
      const branches = [merged];
      for (const clause of clauses) {
        if (folded && ts.isCaseClause(clause)) {
          const label = evaluator.fold(clause.expression, env);
          if (label && label.value !== folded.value) continue;
        }
        if (folded && matched && ts.isDefaultClause(clause)) continue;
        const branch = clone(state);
        for (const child of clause.statements) {
          if (ts.isBreakStatement(child)) break;
          walkStatement(child, env, branch, frame);
        }
        branches.push(branch);
        merged = join(merged, branch);
      }
      checkJoin(statement, state, branches, statement.expression);
      Object.assign(state, merged);
    }

    // A walk is reused only for the same function under the same bindings: a parameter is keyed
    // by its request provenance or by its expression and the binding frame's own parameter shape
    // (one level of calling context), so a closure bound under the request and the same closure
    // bound under an unrelated caller are separate walks without unbounded context growth.
    function parameterShape(value, env, withFrames) {
      return value.node.parameters
        .map((parameter) => {
          const bound = env.get(parameter);
          if (!bound) return "-";
          if (bound.root) return "request";
          const tag = evaluator.provenance(bound.expression, bound.env) ?? "",
            site = `${tag}:${bound.expression.pos}:${graph.fileOf(bound.expression)}`;
          return withFrames ? `${site}@${frameKeys.get(bound.env) ?? 0}` : site;
        })
        .join(",");
    }

    function signature(value, env, state) {
      return `${state.authorized ? 1 : 0}${state.effect ? 1 : 0}${state.local ? 1 : 0}|${frameKeys.get(value.env) ?? 0}|${parameterShape(value, env, true)}`;
    }

    function internFrame(env, value) {
      // The captured frame is part of the identity: closures nest lexically, so this stays bounded.
      const text = `${value.node.pos}:${graph.fileOf(value.node)}|${frameKeys.get(value.env) ?? 0}|${parameterShape(value, env, false)}`;
      if (!frameIds.has(text)) frameIds.set(text, frameIds.size + 1);
      frameKeys.set(env, frameIds.get(text));
    }

    function walkFunction(value, env, state) {
      const fn = value.node,
        none = {
          authorizedReturn: false,
          consumedReturn: false,
          decisionKind: null,
          localReturn: false,
          refusal: false,
        };
      if (!fn.body || stack.includes(fn) || stack.length > maxWalkDepth) return none;
      const key = signature(value, env, state);
      const seen = memo.get(fn) ?? new Map();
      if (seen.has(key)) return seen.get(key);
      seen.set(key, none);
      memo.set(fn, seen);
      internFrame(env, value);
      stack.push(fn);
      const frame = { returns: [] };
      if (ts.isBlock(fn.body)) {
        walkStatement(fn.body, env, state, frame);
        if (state.alive)
          frame.returns.push({
            authorized: state.authorized,
            consumed: state.consumed,
            decisionKind: state.decisionKind,
            local: state.local,
            nullish: true,
          });
      } else {
        visit(fn.body, env, state);
        frame.returns.push({
          authorized: state.authorized,
          consumed: state.consumed,
          decisionKind: state.decisionKind,
          local: state.local,
          nullish: nullish(fn.body),
        });
      }
      stack.pop();
      const result = {
        authorizedReturn: frame.returns.length > 0 && frame.returns.every((entry) => entry.authorized),
        consumedReturn: frame.returns.length > 0 && frame.returns.every((entry) => entry.consumed),
        localReturn: frame.returns.length > 0 && frame.returns.every((entry) => entry.local),
        refusal:
          frame.returns.some((entry) => entry.nullish) &&
          frame.returns.some((entry) => !entry.nullish) &&
          frame.returns.every((entry) => !entry.nullish || entry.local),
        decisionKind: frame.returns.find((entry) => entry.decisionKind)?.decisionKind ?? null,
      };
      seen.set(key, result);
      return result;
    }

    for (const entry of anchors.entries) {
      const env = new Map([[entry.parameters[0], { root: true }]]);
      walkFunction({ fn: true, node: entry, env: new Map() }, env, newState());
    }
    // On the traced route every effect-callback call must follow the denial exit and receive the
    // decision: an earlier call runs the effect before authorization, and a call without the
    // decision leaves the effect independent of it.
    for (const frames of guardCalls.values())
      for (const { routed, calls } of frames.values()) {
        if (!routed) continue;
        for (const call of calls.filter((entry) => decisionCallback(entry.parameter)))
          if (!call.authorized)
            report.violations.push(`${call.at}: the effect callback runs before the authorization denial exit`);
          else if (!call.carried)
            report.violations.push(`${call.at}: the effect callback runs without the authorization decision`);
      }
    return report;
  }

  return { traceDescriptor, producesDecision, allowPredicate };
}
