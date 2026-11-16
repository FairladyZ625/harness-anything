// Ingress-to-effect authorization trace (G-A). One walk per protocol descriptor follows the
// request from the transport entry with the descriptor's method and action kind folded into
// branch conditions. A route is authorized when a decision for this action is produced from an
// AuthorizationPort call, a denial exits, and only then does the effect run with the decision
// flowing into it. Extraction and renaming keep that flow, so no production name or source text
// is compared here.
import ts from "typescript";
import { bindArguments, EMPTY_ENV, isFunctionNode, makeEvaluator, unwrap } from "./authorization-flow-graph.mjs";
import { nodeStart } from "./authorization-gui-source-proof.mjs";
import { processSourceSites, sourceFrameKey, sourceSite } from "./authorization-source-proof.mjs";

const maxWalkDepth = 60;
const ownNodeCache = new WeakMap();

function ownNodes(body) {
  let nodes = ownNodeCache.get(body);
  if (!nodes) {
    nodes = [];
    (function walk(node) {
      if (node !== body && isFunctionNode(node)) return;
      nodes.push(node);
      ts.forEachChild(node, walk);
    })(body);
    ownNodeCache.set(body, nodes);
  }
  return nodes;
}

function eachOwnNode(body, visit) {
  for (const node of ownNodes(body)) visit(node);
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
  const bindFrame = (fn, args, env) => bindArguments(fn, args, env, fn.env, graph.internEnv);
  const where = (node) => {
    const source = node.getSourceFile();
    return `${graph.fileOf(node)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  };
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

  // The kernel session member that answers only for a signed-in person and throws otherwise: the
  // authority of a command that acts on the acting person alone (`own-session`).
  const sessionMembers = new Map();
  for (const { file, name, member } of anchors.sessions ?? []) {
    const declaration = graph.interfaceMembers(file, name).get(member);
    if (!declaration) throw new Error(`${file}: ${name}.${member} is missing`);
    sessionMembers.set(member, new Set([...(sessionMembers.get(member) ?? []), declaration]));
  }
  const sessionCalls = new Map(),
    sessionReturns = new Map();

  /** A function every return of which is the kernel session member's answer, however it is named. */
  function returnsSession(fn, depth) {
    if (!fn.body || depth > 3) return false;
    if (sessionReturns.has(fn)) return sessionReturns.get(fn);
    sessionReturns.set(fn, false);
    const results = [];
    if (ts.isBlock(fn.body))
      eachOwnNode(fn.body, (node) => {
        if (ts.isReturnStatement(node)) results.push(unwrap(node.expression));
      });
    else results.push(unwrap(fn.body));
    const answer =
      results.length > 0 &&
      results.every(
        (result) =>
          result &&
          ts.isCallExpression(result) &&
          (isSessionCall(result) ||
            resolvedFunctions(unwrap(result.expression)).some((inner) => returnsSession(inner, depth + 1))),
      );
    sessionReturns.set(fn, answer);
    return answer;
  }

  /** A callback whose own type receives the kernel AuthorizationDecision is the guarded effect. */
  function decisionCallback(parameter) {
    if (!decisionCallbacks.has(parameter))
      decisionCallbacks.set(
        parameter,
        anchors.decision ? graph.takesInterface(parameter, anchors.decision.file, anchors.decision.name) : false,
      );
    return decisionCallbacks.get(parameter);
  }

  function callsMember(node, memberMap, cache) {
    if (cache.has(node)) return cache.get(node);
    const callee = unwrap(node.expression),
      key = ts.isPropertyAccessExpression(callee) ? callee.name.text : null,
      members = key === null ? undefined : memberMap.get(key),
      signatures = members ? graph.memberSignature(callee) : null,
      port = Boolean(
        signatures &&
          [...signatures].some(
            (declaration) => members.has(declaration) || graph.implementsMember(declaration, key, members),
          ),
      );
    cache.set(node, port);
    return port;
  }
  const isPortCall = (node) => callsMember(node, portMembers, portCalls);
  const isSessionCall = (node) => callsMember(node, sessionMembers, sessionCalls);
  const authorityGraph = anchors.sourceGraph ?? graph;
  const declaredFunction = (anchor) =>
    anchor && authorityGraph.modules.has(anchor.file) && authorityGraph.exportedBinding(anchor.file, anchor.name)?.node;
  const writerQueue = declaredFunction(anchors.writerQueue),
    writerFence = declaredFunction(anchors.writerFence);
  const cutMember =
      anchors.currentCut &&
      authorityGraph.modules.has(anchors.currentCut.file) &&
      authorityGraph.interfaceMembers(anchors.currentCut.file, anchors.currentCut.name).get(anchors.currentCut.member),
    cutMembers = new Map(cutMember ? [[anchors.currentCut.member, new Set([cutMember])]] : []),
    cutCalls = new Map();
  const serviceMembers = new Map();
  for (const { file, name, members } of anchors.services ?? []) {
    if (!authorityGraph.modules.has(file)) continue;
    const declared = authorityGraph.interfaceMembers(file, name);
    for (const member of members) {
      const declaration = declared.get(member);
      if (!declaration) throw new Error(`${file}: ${name}.${member} is missing`);
      serviceMembers.set(member, new Set([...(serviceMembers.get(member) ?? []), declaration]));
    }
  }
  const serviceCalls = new Map(),
    isServiceCall = (node) => serviceMembers.size > 0 && callsMember(node, serviceMembers, serviceCalls);
  // The service's command belongs to its declared lifecycle action, which may differ
  // from the outer queue's action. Derive that relationship from the shared contracts.
  const lifecycleKinds = new Map();
  for (const contract of anchors.constants?.entityKindContracts ?? [])
    for (const { execution } of contract.actionCatalog?.actions ?? []) {
      const command = execution?.lifecycle?.commandType,
        ingress = execution?.ingress;
      if (!command || !anchors.constants.actionDeclarations?.some((action) => action.kind === ingress)) continue;
      lifecycleKinds.set(command, new Set([...(lifecycleKinds.get(command) ?? []), ingress]));
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
    const byDepth = portReaching.get(fn) ?? new Map();
    portReaching.set(fn, byDepth);
    if (byDepth.has(depth)) return byDepth.get(depth);
    byDepth.set(depth, false);
    let found = false;
    eachOwnNode(fn.body, (node) => {
      if (!found && ts.isCallExpression(node))
        found =
          isPortCall(node) || resolvedFunctions(unwrap(node.expression)).some((inner) => reachesPort(inner, depth + 1));
    });
    byDepth.set(depth, found);
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
        strictMembers: (!anchors.sourceGraph || anchors.sourceGraph === graph) && Boolean(descriptor.sources?.length),
      },
      evaluator = makeEvaluator(graph, facts),
      sourceGraph = anchors.sourceGraph ?? graph,
      sourceEvaluator =
        sourceGraph === graph && facts.strictMembers
          ? evaluator
          : makeEvaluator(sourceGraph, { ...facts, strictMembers: true }),
      report = {
        authorized: [],
        local: [],
        session: [],
        violations: [],
        unresolved: [],
        decisionKinds: new Set(),
        sources: new Map(
          (descriptor.sources ?? []).map((source) => [
            source.site,
            { id: source.id, seen: false, ok: true, evidence: [] },
          ]),
        ),
      },
      memo = new Map(),
      guardCalls = new Map(),
      reportedServiceFailures = new Set(),
      deferredFrames = [],
      deferredKeys = new WeakMap(),
      deferredReachability = new WeakMap(),
      enclosedSources = new WeakMap(),
      callbackCarriers = new WeakMap(),
      sourceTargets = [...report.sources.keys()],
      sourceRanges = sourceTargets.map((site) => {
        const [, file, start, end] = /^(.*):(\d+):(\d+)$/u.exec(site);
        return { file, start: Number(start), end: Number(end) };
      }),
      stack = [];

    const newState = () => ({
      alive: true,
      authorized: false,
      effect: false,
      sourceCovered: false,
      writerTurn: false,
      writerFenced: false,
      local: false,
      consumed: false,
      tainted: new Set(),
      sessioned: new Set(),
      refusals: new Set(),
      decisionKind: null,
    });
    const clone = (state) => ({
      ...state,
      tainted: new Set(state.tainted),
      sessioned: new Set(state.sessioned),
      refusals: new Set(state.refusals),
    });
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
        sourceCovered: live.every((state) => state.sourceCovered),
        writerTurn: live.every((state) => state.writerTurn),
        writerFenced: live.every((state) => state.writerFenced),
        serviceSites: new Map(
          [...(live[0].serviceSites ?? [])].filter(([site, kind]) =>
            live.every((state) => state.serviceSites?.get(site) === kind),
          ),
        ),
        // Spent on some path: what is still pending after the meeting point is the unspent rest.
        consumed: live.some((state) => state.consumed),
        tainted: new Set([...left.tainted, ...right.tainted]),
        sessioned: new Set([...left.sessioned, ...right.sessioned]),
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
        for (const node of ownNodes(value.node.body))
          if (ts.isCallExpression(node) && node !== call && decisionCall(node, new Set())) {
            inner = decisionSubject(
              node,
              bindFrame(value, evaluator.expandArguments(call.arguments, env), env),
              depth + 1,
            );
            break;
          }
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
          if (
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
              ? property.name.text
              : property.name.getText().replace(/"/gu, "")) === key
          )
            return property.initializer;
          if (ts.isShorthandPropertyAssignment(property) && property.name.text === key) return property.name;
          if (ts.isSpreadAssignment(property)) {
            // `...(cond ? { a } : {})` cannot supply the key; any other spread might.
            if (lacksKey(property.expression, key)) continue;
            return syntheticAccess(property.expression, key);
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
        node.properties.every(
          (property) =>
            !ts.isSpreadAssignment(property) &&
            (ts.isIdentifier(property.name) ? property.name.text : property.name?.getText()) !== key,
        )
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
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Object" &&
        callee.name.text === "freeze"
      )
        return cutIn(call.arguments[0], env, depth + 1, seen);
      for (const value of evaluator.evaluate(callee, env)) {
        if (!value.fn || !value.node.body || seen.has(value.node)) continue;
        seen.add(value.node);
        const inner = bindFrame(value, evaluator.expandArguments(call.arguments, env), env),
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

    // A value is the acting person's own session when it comes from the kernel session member on
    // this path: its result, a field of it, or a choice whose every live side is one of those.
    function sessionDerived(expression, env, state) {
      const node = unwrap(expression);
      if (!node) return false;
      if (ts.isIdentifier(node)) {
        const binding = graph.lookup(node.text, node);
        return Boolean(binding?.declaration && state.sessioned.has(binding.declaration));
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
        return sessionDerived(node.expression, env, state);
      if (ts.isConditionalExpression(node)) {
        const folded = evaluator.fold(node.condition, env);
        return folded
          ? sessionDerived(folded.value ? node.whenTrue : node.whenFalse, env, state)
          : sessionDerived(node.whenTrue, env, state) && sessionDerived(node.whenFalse, env, state);
      }
      return (
        ts.isCallExpression(node) &&
        (isSessionCall(node) ||
          evaluator.evaluate(unwrap(node.expression), env).some((value) => value.fn && returnsSession(value.node, 0)))
      );
    }

    function ownSessionEffect(call, env, state) {
      const session = call.arguments.map((argument) => sessionDerived(argument, env, state));
      return (
        session.some(Boolean) &&
        call.arguments.some((argument, index) => !session[index] && carriesRoute(argument, env))
      );
    }

    const traceActionChildrenCache = new WeakMap();
    function traceActionChildren(root) {
      let cached = traceActionChildrenCache.get(root);
      if (cached) return cached;
      const list = [];
      const collect = (parent) => {
        ts.forEachChild(parent, (child) => {
          if (ts.isTypeNode(child) || isFunctionNode(child)) return;
          if (
            ts.isConditionalExpression(child) ||
            ts.isCallExpression(child) ||
            (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.EqualsToken)
          ) {
            list.push(child);
            return;
          }
          collect(child);
        });
      };
      collect(root);
      traceActionChildrenCache.set(root, list);
      return list;
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
      for (const action of traceActionChildren(node)) {
        if (!state.alive) break;
        visit(action, env, state);
      }
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

    function shouldDescend(value, node, env, state) {
      const callee = unwrap(node.expression);
      return (
        state.effect ||
        // An immediately invoked function runs in this frame; a closure over the route carries it.
        isFunctionNode(callee) ||
        (value.env.size > 0 && routedFrame(value.env)) ||
        node.arguments.some((argument) => carriesRoute(argument, env) || functionArgument(argument, env)) ||
        // A declared local-transport route follows the authentication context into its guard.
        (descriptor.localTransport && node.arguments.some((argument) => graph.carriesTransport(argument)))
      );
    }

    function visitCall(node, env, state) {
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "then") {
        visit(callee.expression, env, state);
        const [resolved] = node.arguments;
        for (const value of resolved ? evaluator.evaluate(resolved, env) : [])
          if (value.fn)
            walkFunction(
              value,
              bindFrame(value, evaluator.expandArguments([callee.expression], env), env),
              clone(state),
            );
        return;
      }
      if (ts.isPropertyAccessExpression(callee) && ["catch", "finally"].includes(callee.name.text))
        return visit(callee.expression, env, state);
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
        visit(callee.expression, env, state);
      for (const argument of node.arguments) visit(argument, env, state);
      if (isPortCall(node)) return;
      const values = evaluator.evaluate(callee, env);
      const writerFenceName = writerFence?.name?.text;
      if (
        writerFence &&
        !state.writerFenced &&
        (values.some((value) => value.fn && value.node === writerFence) ||
          (values.some(
            (value) =>
              value.unknown ||
              (value.external !== undefined && (!writerFenceName || value.external === writerFenceName)),
          ) &&
            graph.callDeclaration(node) === writerFence))
      )
        state.writerFenced = true;
      const boundParameter = ts.isIdentifier(callee) ? graph.lookup(callee.text, callee) : null,
        decisionData = state.authorized && node.arguments.some((argument) => derived(argument, state.tainted));
      for (const value of values) {
        if (value.broken) {
          if (state.effect || decisionData) report.violations.push(`${where(node)}: ${value.broken}`);
          else report.unresolved.push(`${where(node)}: ${value.broken}`);
        }
      }
      const functions = values.filter((value) => value.fn);
      const serviceCheck =
        descriptor.sources?.length && state.serviceSites?.get(node) !== descriptor.kind && isServiceCall(node)
          ? verifyCarriedServiceCall(node, env, state)
          : null;
      if (serviceCheck && !serviceCheck.ok) {
        const message = `${where(node)}: ${serviceCheck.failure}`;
        if (!reportedServiceFailures.has(message)) {
          reportedServiceFailures.add(message);
          report.violations.push(message);
        }
      }
      const sourceAuthority =
        (!serviceCheck || serviceCheck.ok) &&
        (state.serviceSites?.get(node) === descriptor.kind ||
          state.sourceCovered ||
          (state.effect && state.decisionKind?.kind === descriptor.kind) ||
          (state.authorized && state.decisionKind?.kind === descriptor.kind) ||
          (descriptor.localTransport && state.local) ||
          (descriptor.ownSession && state.sessioned.size > 0));
      if (state.serviceSites?.get(node) === descriptor.kind)
        report.authorized.push(
          `${where(node)}: independent current-cut ${descriptor.kind} decision for the command actor flows through its allowed service proof`,
        );
      const source = report.sources.get(sourceSite(graph, node));
      const observe = (target, allowed, evidence) => {
        target.seen = true;
        target.ok &&= Boolean(allowed);
        target.evidence.push(evidence);
      };
      // Once this call cannot improve any source certificate, even resolving its full-graph
      // callees is redundant. Unguarded calls still challenge previously authorized sources.
      const sourceRequired =
        descriptor.sources?.length &&
        [...report.sources.values()].some((source) => !source.seen || (!sourceAuthority && source.ok));
      const sourceValues = sourceRequired ? sourceEvaluator.evaluate(callee, env) : [];
      const sourceFunctions = sourceRequired ? sourceValues.filter((value) => value.fn) : [];
      const declaredCallee =
        sourceRequired &&
        (sourceFunctions.length === 0 || sourceValues.some((value) => value.unknown)) &&
        sourceGraph.callDeclaration(node);
      if (
        isFunctionNode(declaredCallee) &&
        declaredCallee.body &&
        !sourceFunctions.some((value) => value.node === declaredCallee)
      )
        sourceFunctions.push({ node: declaredCallee, env: EMPTY_ENV });
      // Defer positive discovery to callees the policy walk will actually enter below.
      // This issues no certificate: missed sources still need the full-graph fallback. Unguarded calls
      // must still challenge every previously authorized source through the full graph.
      const policyWalks =
        sourceRequired && sourceAuthority
          ? new Set(
              functions
                .filter(
                  (value) =>
                    !stack.includes(value.node) &&
                    stack.length <= maxWalkDepth &&
                    !allowPredicate(value.node) &&
                    !producesDecision(value.node) &&
                    ((boundParameter?.kind === "param" && env.get(boundParameter.parameter)?.expression) ||
                      shouldDescend(value, node, env, state)),
                )
                .map((value) => value.node),
            )
          : null;
      const deferredSources = [];
      function proveSourceCallee(value) {
        const boundary = !graph.modules.has(graph.fileOf(value.node));
        // Rejection is irreversible; another authorized call cannot repair a bypass. For an
        // authorized call only unseen sources remain; an unguarded call must still challenge
        // any source previously seen only with authority.
        const pendingSources = [...report.sources].filter(
          ([, source]) => !source.seen || (!sourceAuthority && source.ok),
        );
        if ((!sourceAuthority && !boundary) || pendingSources.length === 0) return;
        const sites = processSourceSites(sourceGraph, value.node, {
          evaluator: sourceEvaluator,
          env: bindFrame(value, sourceEvaluator.expandArguments(node.arguments, env), env),
          targets: pendingSources.map(([site]) => site),
        });
        for (const [site, target] of pendingSources)
          if (sites.has(site))
            observe(
              target,
              sourceAuthority,
              `${where(node)}: ${sourceAuthority ? "owner authority" : "unguarded call"} reaches ${site} through its actual callee`,
            );
      }
      for (const value of sourceFunctions) {
        if (policyWalks?.has(value.node) && graph.modules.has(graph.fileOf(value.node))) deferredSources.push(value);
        else proveSourceCallee(value);
      }
      if (state.authorized && node.arguments.some((argument) => spends(argument, state.tainted, 0)))
        state.consumed = true;
      // A declared own-session route hands the effect the request and, as a separate input, the
      // signed-in person it acts for: the identity comes from the session, not from the request.
      if (
        descriptor.ownSession &&
        functions.length > 0 &&
        !state.sessionReported &&
        ownSessionEffect(node, env, state)
      ) {
        state.sessionReported = true;
        report.session.push(`${where(node)}: the signed-in person's own session flows into the effect`);
      }
      // A declared local-transport route continues past its transport guard into resolved code.
      if (descriptor.localTransport && state.local && functions.length > 0 && !state.localReported) {
        state.localReported = true;
        report.local.push(`${where(node)}: runs only after the local-transport exit`);
      }
      // A local function handed to an external scheduler (Promise.all, Array.from, map) runs.
      if (functions.length === 0 && values.some((value) => value.external !== undefined))
        for (const argument of node.arguments)
          for (const value of functionArgument(argument, env) ? evaluator.evaluate(argument, env) : [])
            if (value.fn) walkFunction(value, value.env, clone(state));
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
        // A supplied callback is invoked in this caller's guard frame even when its
        // return value depends on a decision it obtains itself.
        if (boundParameter?.kind === "param" && env.get(boundParameter.parameter)?.expression) {
          invokeCallback(boundParameter.parameter, value, node, env, state, sourceAuthority);
          allAuthorized = false;
          continue;
        }
        if (producesDecision(value.node)) {
          // A producer that itself exits on denial is an enforcer: what follows it is authorized.
          const outcome = walkFunction(value, bindFrame(value, evaluator.expandArguments(node.arguments, env), env), {
            ...newState(),
            effect: state.effect,
          });
          if (outcome.authorizedReturn) {
            enforcedSubject = decisionSubject(node, env);
            checkCut(node, env, enforcedSubject);
          } else allAuthorized = false;
          continue;
        }
        if (!shouldDescend(value, node, env, state)) {
          allAuthorized = false;
          continue;
        }
        const inner = clone(state);
        inner.sourceCovered ||= Boolean(sourceAuthority);
        inner.authorized = false;
        inner.consumed = false;
        const outcome = walkFunction(
          value,
          bindFrame(value, evaluator.expandArguments(node.arguments, env), env),
          inner,
        );
        walked.push(outcome);
        if (!outcome.authorizedReturn) allAuthorized = false;
        else {
          state.decisionKind = outcome.decisionKind;
          if (outcome.consumedReturn) state.consumed = true;
        }
      }
      // A policy callee may not descend to every source. Preserve the full-graph fallback
      // for anything it did not prove, using this call's original authority and argument frame.
      for (const value of deferredSources) proveSourceCallee(value);
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
      if (source) {
        // A service can enforce its own denial exit. Judge that call after tracing its body,
        // while retaining the conjunction across every invocation of the source.
        const covered =
          (!serviceCheck || serviceCheck.ok) &&
          (sourceAuthority || (allAuthorized && state.decisionKind?.kind === descriptor.kind));
        observe(
          source,
          covered,
          `${where(node)}: ${serviceCheck && !serviceCheck.ok ? serviceCheck.failure : covered ? "owner authority dominates this source or its service entry" : "source runs before owner authority"}`,
        );
      }
    }

    /** A frame is on the traced route when one of its bindings carries the request. */
    const routedFrameCache = new WeakMap();
    function routedFrame(env) {
      if (!env || env.size === 0) return false;
      const isCanonical = graph.internEnv?.isCanonical?.(env);
      if (isCanonical && routedFrameCache.has(env)) return routedFrameCache.get(env);
      let routed = false;
      for (const bound of env.values())
        if (
          bound.root ||
          (bound.rest
            ? bound.rest.some((entry) => evaluator.provenance(entry.expression, entry.env))
            : evaluator.provenance(bound.expression, bound.env))
        ) {
          routed = true;
          break;
        }
      if (isCanonical) routedFrameCache.set(env, routed);
      return routed;
    }

    // Resolve a field through immutable aliases, arguments and returned objects. Unknown
    // branches must agree; two opaque values are never equal merely because both are unknown.
    const serviceQueries = new WeakMap(),
      missingServiceField = { node: null, fields: [] };
    function serviceValue(expression, env, fields = [], depth = 0) {
      const node = unwrap(expression);
      if (!node || depth > maxWalkDepth) return null;
      const key = `${fields.join(".")}|${sourceFrameKey(sourceGraph, node, env)}`,
        active = serviceQueries.get(node) ?? [];
      if (active.includes(key)) return null;
      serviceQueries.set(node, active);
      active.push(key);
      try {
        return serviceValueIn(node, env, fields, depth);
      } finally {
        active.pop();
      }
    }

    const ownFunction = (node) => {
      for (let parent = node?.parent; parent; parent = parent.parent) if (isFunctionNode(parent)) return parent;
    };

    const isDecisionProducerCall = (node, env) =>
      ts.isCallExpression(node) &&
      (isPortCall(node) ||
        sourceEvaluator.evaluate(node.expression, env).some((value) => value.fn && producesDecision(value.node)));

    function unwrapDecisionCall(call, env, depth = 0) {
      if (!call || depth > 6 || isPortCall(call)) return { call, env };
      const input = call.arguments[0];
      if (input && serviceValue(input, env, ["binding"]) !== missingServiceField) return { call, env };
      for (const value of sourceEvaluator.evaluate(unwrap(call.expression), env)) {
        if (!value.fn || !value.node.body) continue;
        for (const inner of ownNodes(value.node.body))
          if (ts.isCallExpression(inner) && inner !== call && decisionCall(inner, new Set()))
            return unwrapDecisionCall(
              inner,
              bindFrame(value, sourceEvaluator.expandArguments(call.arguments, env), env),
              depth + 1,
            );
      }
      return { call, env };
    }

    function resolveLocalBinding(declaration, initializerExpr, env, trail, fields, depth) {
      const projected = serviceValue(initializerExpr, env, [...trail, ...fields], depth + 1);
      if (projected) return projected;
      const initializer = unwrap(initializerExpr);
      if (ts.isCallExpression(initializer)) {
        const functions = sourceEvaluator.evaluate(initializer.expression, env).filter((value) => value.fn);
        const opaque =
          functions.length !== 1 ||
          functions.some((value) => {
            let returns = 0;
            if (value.node.body)
              eachOwnNode(value.node.body, (inner) => {
                if (ts.isReturnStatement(inner)) returns++;
              });
            return returns > 1;
          });
        if (opaque) return { node: declaration, fields: [...trail, ...fields], env };
      }
      return null;
    }

    function resolveCallFunctions(functions, argumentExpressions, env, fields, depth) {
      const answers = [];
      for (const value of functions) {
        const inner = bindFrame(value, sourceEvaluator.expandArguments(argumentExpressions, env), env);
        for (const result of serviceReturns(value.node, inner)) {
          const answer = serviceValue(result.expression, inner, fields, depth + 1);
          if (!answer) return null;
          if (answer === missingServiceField) {
            answers.push(answer);
            continue;
          }
          const guarded = result.guards.some((condition) => serviceDenial(condition, inner, answer));
          answers.push({ ...answer, guarded: answer.guarded || guarded });
        }
      }
      if (answers.length && answers.every((answer) => answer === missingServiceField)) return missingServiceField;
      return answers.length && answers.every((answer) => sameServiceValue(answer, answers[0]))
        ? { ...answers[0], guarded: answers.every((answer) => answer.guarded) }
        : null;
    }

    function singleAssignmentIn(fn, declaration) {
      if (!fn?.body || !ts.isIdentifier(declaration.name)) return null;
      const matches = [];
      for (const child of ownNodes(fn.body)) {
        if (
          ts.isBinaryExpression(child) &&
          child.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(child.left) &&
          sourceGraph.lookup(child.left.text, child.left)?.declaration === declaration
        )
          matches.push({ assign: child, expression: child.right });
        else if (
          ((ts.isBinaryExpression(child) &&
            child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            child.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
            ((ts.isPrefixUnaryExpression(child) || ts.isPostfixUnaryExpression(child)) &&
              [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(child.operator))) &&
          ts.isIdentifier(child.left ?? child.operand) &&
          sourceGraph.lookup((child.left ?? child.operand).text, child.left ?? child.operand)?.declaration ===
            declaration
        )
          return null;
      }
      return matches.length === 1 ? matches[0] : null;
    }

    function serviceValueIn(expression, env, fields, depth) {
      const node = unwrap(expression);
      if (!node || depth > maxWalkDepth) return null;
      const next = (expression, env, fields) => serviceValue(expression, env, fields, depth + 1);
      if (ts.isIdentifier(node)) {
        const binding = sourceGraph.lookup(node.text, node);
        if (binding?.kind === "param") {
          const bound = env.get(binding.parameter);
          if (bound?.expression) return next(bound.expression, bound.env, [...binding.trail, ...fields]);
          return { node: binding.parameter, fields: [...binding.trail, ...fields], env };
        }
        if (binding?.kind === "var") {
          if (binding.declaration.initializer && binding.declaration.parent.flags & ts.NodeFlags.Const)
            return resolveLocalBinding(
              binding.declaration,
              binding.declaration.initializer,
              env,
              binding.trail,
              fields,
              depth,
            );
          const assigned =
            !binding.declaration.initializer &&
            (sourceGraph.singleAssignment?.(binding.declaration) ??
              singleAssignmentIn(ownFunction(node), binding.declaration));
          if (assigned && ownFunction(node) === ownFunction(assigned.assign) && assigned.assign.end <= node.pos)
            return resolveLocalBinding(binding.declaration, assigned.expression, env, binding.trail, fields, depth);
          return { node: binding.declaration, fields: [...binding.trail, ...fields], env };
        }
      }
      if (ts.isPropertyAccessExpression(node)) return next(node.expression, env, [node.name.text, ...fields]);
      if (ts.isConditionalExpression(node)) {
        const folded = serviceCondition(node.condition, env);
        if (folded) return next(folded.value ? node.whenTrue : node.whenFalse, env, fields);
        const cond = next(node.condition, env, []);
        if (cond?.node && !cond.fields.length && isDecisionProducerCall(cond.node, cond.env))
          return next(node.whenTrue, env, fields);
        const left = next(node.whenTrue, env, fields),
          right = left && next(node.whenFalse, env, fields);
        if (left && right && sameServiceValue(left, right))
          return left === missingServiceField ? left : { ...left, guarded: left.guarded && right.guarded };
        return null;
      }
      if (ts.isObjectLiteralExpression(node) && fields.length) {
        const [key, ...rest] = fields;
        for (const property of [...node.properties].reverse()) {
          if (ts.isSpreadAssignment(property)) {
            if (lacksKey(property.expression, key)) continue;
            const found = next(property.expression, env, fields);
            if (found !== missingServiceField) return found;
          } else if (property.name && sourceGraph.memberKey(property.name) === key)
            return next(ts.isPropertyAssignment(property) ? property.initializer : property.name, env, rest);
        }
        return missingServiceField;
      }
      if (ts.isCallExpression(node)) {
        if (!fields.length && isDecisionProducerCall(node, env)) return { node, fields, env };
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "Object" &&
          node.expression.name.text === "freeze" &&
          !sourceGraph.lookup("Object", node)
        )
          return next(node.arguments[0], env, fields);
        const callee = unwrap(node.expression);
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === "then") {
          const [resolved] = node.arguments;
          if (!resolved) return next(callee.expression, env, fields);
          return resolveCallFunctions(
            sourceEvaluator.evaluate(resolved, env).filter((value) => value.fn),
            [callee.expression],
            env,
            fields,
            depth,
          );
        }
        if (ts.isPropertyAccessExpression(callee) && ["catch", "finally"].includes(callee.name.text))
          return next(callee.expression, env, fields);
        return resolveCallFunctions(
          sourceEvaluator.evaluate(node.expression, env).filter((value) => value.fn),
          node.arguments,
          env,
          fields,
          depth,
        );
      }
      return { node, fields, env };
    }

    const sameServiceValue = (left, right) =>
      Boolean(
        left?.node &&
          right?.node &&
          left.node === right.node &&
          left.fields.join(".") === right.fields.join(".") &&
          sourceFrameKey(sourceGraph, left.node, left.env) === sourceFrameKey(sourceGraph, right.node, right.env),
      );

    // Only a throwing denial exit dominates an enforcer's returned decision. A name,
    // annotation or unused guard is not proof. Fold command discriminants at the actual call.
    function serviceReturns(fn, env) {
      const returns = [];
      const walk = (node, guards) => {
        if (!node) return true;
        if (ts.isReturnStatement(node)) {
          if (node.expression) returns.push({ expression: node.expression, guards });
          return false;
        }
        if (ts.isThrowStatement(node)) return false;
        if (ts.isIfStatement(node)) {
          const folded = serviceCondition(node.expression, env);
          if (folded) return walk(folded.value ? node.thenStatement : node.elseStatement, guards);
          const left = walk(node.thenStatement, guards),
            right = walk(node.elseStatement, guards);
          return left || right;
        }
        if (ts.isBlock(node)) {
          const preceding = [...guards];
          for (const statement of node.statements) {
            if (!walk(statement, [...preceding])) return false;
            if (ts.isIfStatement(statement)) {
              const branch = statement.thenStatement;
              if (
                ts.isThrowStatement(branch) ||
                (ts.isBlock(branch) && branch.statements.length === 1 && ts.isThrowStatement(branch.statements[0]))
              )
                preceding.push(statement.expression);
            }
          }
        }
        return true;
      };
      if (fn.body && ts.isBlock(fn.body)) walk(fn.body, []);
      else if (fn.body) returns.push({ expression: fn.body, guards: [] });
      return returns;
    }

    function serviceCondition(expression, env) {
      const folded = sourceEvaluator.fold(expression, env);
      if (folded) return folded;
      const node = unwrap(expression);
      if (!ts.isBinaryExpression(node)) return null;
      const operator = node.operatorToken.kind;
      if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(operator)) {
        const left = serviceCondition(node.left, env),
          right = serviceCondition(node.right, env);
        if (operator === ts.SyntaxKind.BarBarToken) {
          if (left?.value || right?.value) return { value: true };
          return left && right ? { value: false } : null;
        }
        if ((left && !left.value) || (right && !right.value)) return { value: false };
        return left && right ? { value: true } : null;
      }
      const left = serviceValue(node.left, env),
        right = serviceValue(node.right, env);
      if (
        !left?.node ||
        !right?.node ||
        left.fields.length ||
        right.fields.length ||
        !ts.isStringLiteralLike(left.node) ||
        !ts.isStringLiteralLike(right.node)
      )
        return null;
      const equal = left.node.text === right.node.text;
      return operator === ts.SyntaxKind.EqualsEqualsEqualsToken
        ? { value: equal }
        : operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
          ? { value: !equal }
          : null;
    }

    function serviceDenial(expression, env, decision) {
      const node = unwrap(expression);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
        return serviceDenial(node.left, env, decision) || serviceDenial(node.right, env, decision);
      return (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
        comparesField(node, "outcome", ts.SyntaxKind.ExclamationEqualsEqualsToken, "allowed") &&
        sameServiceValue(serviceValue(unwrap(node.left).expression, env), decision)
      );
    }

    function verifyServiceProofCall(node, env, fn, options) {
      const { allowCarried, state, describe, reject, requireSite } = options;
      if (node.arguments.length < 2) return reject(node, 0, "service proof has no resolved decision");
      const [command, proof] = node.arguments,
        decision = serviceValue(proof, env, ["authorizationDecision"]),
        actor = serviceValue(command, env, ["actor"]),
        proofActor = serviceValue(proof, env, ["actorBinding"]),
        boundActor = serviceValue(proof, env, ["actor", "principal"]);
      if (!decision?.node) return reject(node, 0, "service proof has no resolved decision");
      let inlineGuard = false;
      for (let child = node; fn?.body && child.parent && child !== fn.body; child = child.parent) {
        if (!ts.isBlock(child.parent)) continue;
        for (const statement of child.parent.statements) {
          if (statement === child) break;
          if (!ts.isIfStatement(statement)) continue;
          const branch = statement.thenStatement;
          if (
            (ts.isThrowStatement(branch) ||
              (ts.isBlock(branch) && branch.statements.length === 1 && ts.isThrowStatement(branch.statements[0]))) &&
            serviceDenial(statement.expression, env, decision)
          )
            inlineGuard = true;
        }
      }
      if (!decision.guarded && !inlineGuard)
        return reject(node, 1, "service proof decision has no throwing allowed-decision enforcer");
      if (
        !ts.isCallExpression(decision.node) ||
        (allowCarried
          ? !(state?.authorized || state?.effect) || state.decisionKind?.kind !== descriptor.kind
          : ownFunction(decision.node) !== fn || decision.node.pos >= node.pos)
      )
        return reject(
          node,
          2,
          allowCarried
            ? "service proof decision is not an authorized decision for this command"
            : "decision is not independently produced before this service call in the callback",
        );
      const { call: portCall, env: portEnv } = allowCarried
        ? unwrapDecisionCall(decision.node, decision.env)
        : { call: decision.node, env: decision.env };
      const subject = decisionSubject(portCall, portEnv),
        input = portCall.arguments[0],
        authorizedActor = serviceValue(input, portEnv, ["binding", "actor", "principal"]),
        revision = serviceValue(input, portEnv, ["revision"]);
      const canonical = Boolean(decision.guarded || anchors.serviceCall?.(node, subject.kind, true));
      if (canonical && (!allowCarried || proofActor?.node) && !sameServiceValue(actor, proofActor))
        return reject(
          node,
          3,
          `command and service proof actors do not resolve to the same principal (${describe(actor)} / ${describe(proofActor)})`,
        );
      const declared = (facts.constants.actionDeclarations ?? []).some((action) => action.kind === subject.kind);
      const commandType = serviceValue(command, env, ["type"]),
        expectedKinds =
          commandType?.node && !commandType.fields.length && ts.isStringLiteralLike(commandType.node)
            ? lifecycleKinds.get(commandType.node.text)
            : null;
      if (canonical ? !expectedKinds || expectedKinds.size !== 1 || !expectedKinds.has(subject.kind) : !declared)
        return reject(node, 4, "own Port decision does not name this canonical action");
      const principal = canonical ? serviceValue(command, env, ["actor", "principal"]) : boundActor;
      if (!sameServiceValue(principal, authorizedActor))
        return reject(
          node,
          5,
          `own Port and command actors do not resolve to the same principal (${describe(principal)} / ${describe(authorizedActor)})`,
        );
      if (!revision?.node || revision.fields.length) return reject(node, 6, "own Port has no resolved revision input");
      let cut = unwrap(revision.node);
      if (
        ts.isBinaryExpression(cut) &&
        cut.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
        unwrap(cut.right).kind === ts.SyntaxKind.NumericLiteral &&
        unwrap(cut.right).text === "0"
      )
        cut = unwrap(cut.left);
      if (!ts.isPropertyAccessExpression(cut) || cut.name.text !== "revision")
        return reject(node, 7, "own Port revision is not a fresh head revision");
      const read = unwrap(cut.expression),
        expectedRevisionFn = allowCarried ? ownFunction(portCall) : fn;
      if (
        !ts.isCallExpression(read) ||
        !expectedRevisionFn ||
        ownFunction(read) !== expectedRevisionFn ||
        !callsMember(read, cutMembers, cutCalls)
      )
        return reject(
          node,
          8,
          allowCarried
            ? "head revision is not read from the canonical store beside the authorization decision"
            : "head revision is not read from the canonical store in this callback",
        );
      if (requireSite && !anchors.serviceCall?.(node, subject.kind, canonical))
        return reject(node, 9, "invocation is not its declared canonical effect or a verified technical port");
      return { ok: true, kind: subject.kind };
    }

    function verifyCarriedServiceCall(node, env, state) {
      let failure = "service invocation failed authorization proof verification";
      const describe = (value) => (value?.node ? `${where(value.node)}:${value.fields.join(".")}` : "unresolved");
      const reject = (_node, _stage, reason) => {
        failure = reason;
        return { ok: false, failure };
      };
      return verifyServiceProofCall(node, env, ownFunction(node), {
        allowCarried: true,
        state,
        describe,
        reject,
        requireSite: false,
      });
    }

    function serviceContinuation(value, env) {
      const sites = new Map(),
        fn = value.node;
      let progress = -1,
        failure = "no command/proof service invocation";
      const describe = (value) => (value?.node ? `${where(value.node)}:${value.fields.join(".")}` : "unresolved");
      const reject = (node, stage, reason) => {
        if (stage > progress) {
          progress = stage;
          failure = `${where(node)}: ${reason}`;
        }
        return { ok: false };
      };
      if (!fn.body) return { sites, failure };
      let changed = false;
      eachOwnNode(fn.body, (node) => {
        if (
          (ts.isBinaryExpression(node) &&
            node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
          ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
            [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))
        )
          changed = true;
      });
      if (changed) return { sites, failure: "callback mutates its bindings" };
      eachOwnNode(fn.body, (node) => {
        if (!ts.isCallExpression(node) || node.arguments.length < 2) return;
        const verified = verifyServiceProofCall(node, env, fn, {
          allowCarried: false,
          describe,
          reject,
          requireSite: true,
        });
        if (verified.ok) sites.set(node, verified.kind);
      });
      if (!sites.size) return { sites, failure };
      const reachable = processSourceSites(sourceGraph, fn, {
        evaluator: sourceEvaluator,
        env,
        targets: [...sites.keys()].map((node) => sourceSite(sourceGraph, node)),
      });
      return {
        sites: new Map([...sites].filter(([node]) => reachable.has(sourceSite(sourceGraph, node)))),
        failure: "declared service invocation is unreachable in this callback frame",
      };
    }

    function invokeCallback(parameter, value, call, env, state, sourceAuthority) {
      // Grouped per guard frame: a non-durable branch of another command is not this route's bypass.
      const group = sourceFrameKey(graph, parameter.parent, env),
        frames = guardCalls.get(parameter) ?? new Map(),
        calls = frames.get(group) ?? { routed: routedFrame(env), calls: [] };
      calls.calls.push({ authorized: state.authorized, at: where(call), carried: false, parameter });
      frames.set(group, calls);
      guardCalls.set(parameter, frames);
      const next = bindFrame(value, evaluator.expandArguments(call.arguments, env), env),
        inner = clone(state);
      inner.writerTurn ||= Boolean(writerQueue && parameter.parent === writerQueue);
      inner.sourceCovered ||= Boolean(sourceAuthority);
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
      // CH1 / CEO Option 2: retain the carrier rule. An independently authorized service
      // instead certifies only the exact command/proof call reached in this writer turn.
      if (
        state.authorized &&
        inner.writerTurn &&
        inner.writerFenced &&
        !calls.calls.at(-1).carried &&
        decisionCallback(parameter)
      ) {
        const { sites, failure } = serviceContinuation(value, next);
        calls.calls.at(-1).selfAuthorized = sites.size > 0;
        calls.calls.at(-1).selfFailure = failure;
        // This certificate answers only for its service invocation. The outer principal's
        // authority cannot cover earlier calls or any other effect in the callback.
        if (sites.size) {
          inner.authorized = false;
          inner.effect = false;
          inner.sourceCovered = false;
          inner.decisionKind = null;
          inner.tainted.clear();
          inner.serviceSites = sites;
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
          if (descriptor.ownSession && sessionDerived(declaration.initializer, env, state))
            state.sessioned.add(declaration);
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
      } else if (ts.isThrowStatement(statement)) {
        visit(statement.expression, env, state);
        state.alive = false;
      } else if (ts.isIfStatement(statement)) walkIf(statement, env, state, frame);
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

    const authorityShape = (state) =>
      `${state.authorized ? 1 : 0}${state.effect ? 1 : 0}${state.sourceCovered ? 1 : 0}${state.local ? 1 : 0}${state.sessioned.size > 0 ? 1 : 0}:${state.writerTurn ? 1 : 0}${state.writerFenced ? 1 : 0}:${state.decisionKind?.kind ?? ""}:${state.decisionKind?.routed ? 1 : 0}:${[...(state.serviceSites ?? [])].map(([node, kind]) => `${sourceSite(graph, node)}=${kind}`).join(",")}`;

    function frameReachesSource(fn, env) {
      let reachable = deferredReachability.get(fn);
      if (!reachable) deferredReachability.set(fn, (reachable = new WeakMap()));
      if (!reachable.has(env)) {
        const sites = processSourceSites(sourceGraph, fn, {
          evaluator: sourceEvaluator,
          env,
          targets: sourceTargets,
          matchAny: true,
        });
        reachable.set(
          env,
          sourceTargets.some((site) => sites.has(site)),
        );
      }
      return reachable.get(env);
    }

    function deferSourceFrame(value, env, state, key) {
      const fn = value.node,
        contexts = deferredKeys.get(fn) ?? new WeakMap(),
        keys = contexts.get(env) ?? new Set();
      if (keys.has(key)) return;
      contexts.set(env, keys);
      deferredKeys.set(fn, contexts);
      keys.add(key);
      // Deferred frames cannot supply a return summary. Only a real source reachable in
      // this exact argument frame can affect the remaining source proof; no authority is cached.
      if (frameReachesSource(fn, env)) deferredFrames.push({ value, env, state: clone(state) });
    }

    function carriesSourceCallback(env) {
      if (env.size === 0 || sourceRanges.length === 0) return false;
      const canCache = graph.internEnv?.isCanonical?.(env);
      if (canCache && callbackCarriers.has(env)) return callbackCarriers.get(env);
      let found = false;
      for (const bound of env.values()) {
        const entries = bound.rest ?? [bound];
        for (const argument of entries) {
          if (
            argument.expression &&
            evaluator
              .evaluate(argument.expression, argument.env)
              .some((value) => value.fn && enclosesSource(value.node))
          ) {
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (canCache) callbackCarriers.set(env, found);
      return found;
    }

    function enclosesSource(fn) {
      if (sourceRanges.length === 0) return false;
      if (enclosedSources.has(fn)) return enclosedSources.get(fn);
      const file = sourceGraph.fileOf(fn),
        start = nodeStart(fn),
        end = fn.end;
      const result = sourceRanges.some((range) => range.file === file && start <= range.start && end >= range.end);
      enclosedSources.set(fn, result);
      return result;
    }

    function walkFunction(value, env, state, resume = false) {
      env = graph.internEnv(env);
      const fn = value.node,
        none = {
          authorizedReturn: false,
          consumedReturn: false,
          decisionKind: null,
          localReturn: false,
          refusal: false,
        };
      if (!fn.body) return none;
      // Resolve forwarded aliases and retain the source walk's bounded lexical context.
      // One identity handles both reuse and in-progress cycles: a fresh Map is not a new
      // callback, and the same expression can carry another caller's callback.
      const key = `${authorityShape(state)}|${sourceFrameKey(graph, fn, env)}`;
      const seen = memo.get(fn) ?? new Map();
      // The in-progress entry terminates the same frame. Another callback binding may
      // re-enter this function and acquire its own authority, as queued continuations do.
      if (seen.has(key) && !(resume && seen.get(key).deferred)) return seen.get(key);
      // The owner walk above remains unchanged. Inside its covered source trace, a
      // closed negative reachability proof can discard only an irrelevant frame. This
      // grants no return authority; uncovered invocations and callback carriers still walk.
      if (
        sourceTargets.length > 0 &&
        state.sourceCovered &&
        !enclosesSource(fn) &&
        !carriesSourceCallback(env) &&
        !frameReachesSource(fn, env)
      ) {
        seen.set(key, none);
        memo.set(fn, seen);
        return none;
      }
      if (stack.length > maxWalkDepth) {
        // The policy summary remains conservative, but a full source audit cannot drop
        // this invocation: another shallow authorized path may have seen the same source.
        if (descriptor.sources?.length) {
          seen.set(key, { ...none, deferred: true });
          memo.set(fn, seen);
          deferSourceFrame(value, env, state, key);
        }
        return none;
      }
      seen.set(key, none);
      memo.set(fn, seen);
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

    for (const entry of descriptor.entries ?? anchors.entries) {
      const env = graph.internEnv([[entry.parameters[0], { root: true }]]);
      walkFunction({ fn: true, node: entry, env: EMPTY_ENV }, env, newState());
    }
    // Bound the JavaScript stack, not the source proof. Shared frame identities still
    // terminate cycles; an unfinished frame never supplies an authorized return summary.
    for (let index = 0; index < deferredFrames.length; index++) {
      const { value, env, state } = deferredFrames[index];
      deferredFrames[index] = null;
      walkFunction(value, env, state, true);
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
          else if (!call.carried && !call.selfAuthorized)
            report.violations.push(
              `${call.at}: the effect callback runs without the authorization decision${call.selfFailure ? ` (${call.selfFailure})` : ""}`,
            );
      }
    return report;
  }

  return { traceDescriptor, producesDecision, allowPredicate };
}
