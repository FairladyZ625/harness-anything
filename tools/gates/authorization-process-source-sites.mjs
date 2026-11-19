import ts from "typescript";
import { bindArguments, EMPTY_ENV, isFunctionNode, makeEvaluator, unwrap } from "./authorization-flow-graph.mjs";
import { nodeStart, sourceSite } from "./authorization-gui-source-proof.mjs";

const frameKeys = new WeakMap();
const graphReferences = new WeakMap();
const graphSites = new WeakMap();

/** Bounded lexical/caller identity shared by source and policy cycle detection. */
export function sourceFrameKey(graph, fn, env) {
  if (env.size === 0) return "";
  if (!graph.internEnv?.isCanonical?.(env)) return frameKey(graph, fn, env);
  let environments = frameKeys.get(graph);
  if (!environments) frameKeys.set(graph, (environments = new WeakMap()));
  let functions = environments.get(env);
  if (!functions) environments.set(env, (functions = new WeakMap()));
  let key = functions.get(fn);
  if (key === undefined) {
    key = frameKey(graph, fn, env);
    functions.set(fn, key);
  }
  return key;
}

function frameKey(graph, fn, env) {
  const argumentSite = (argument) => {
    let bound = argument;
    // Parameter bindings point into older caller frames, so forwarding aliases terminate at
    // their original argument without serializing unrelated captured environments.
    while (bound.expression) {
      const expression = unwrap(bound.expression);
      if (!ts.isIdentifier(expression)) break;
      const binding = graph.lookup(expression.text, expression);
      if (binding?.kind !== "param" || binding.trail.length > 0) break;
      const caller = bound.env.get(binding.parameter);
      if (!caller) break;
      bound = caller;
    }
    return bound.root
      ? "request"
      : bound.rest
        ? bound.rest.map(argumentSite).join(",")
        : bound.expression
          ? sourceSite(graph, bound.expression)
          : "-";
  };
  // Only lexical ancestors can supply a function's captured parameters. An evaluator may carry
  // extra caller bindings while resolving a nested callable; those cannot change this frame.
  const lexicalBindings = (node, env) => {
    const parameters = graph.freeParameters(node);
    return [...env].filter(([parameter]) => parameters.has(parameter)).map(([, bound]) => bound);
  };
  const callerShape = (bound) => {
    if (bound.rest) return bound.rest.map(callerShape).join(",");
    if (!bound.expression || !bound.env) return "";
    const node = unwrap(bound.expression),
      binding = ts.isIdentifier(node) ? graph.lookup(node.text, node) : null,
      // A const alias captures at its declaration, not at a later reference inside
      // an unrelated binder. Preserve the declaration's actual captured arguments.
      captured =
        binding?.kind === "var" && binding.trail.length === 0 && binding.declaration.parent.flags & ts.NodeFlags.Const
          ? (binding.declaration.initializer ?? node)
          : binding?.kind === "fn"
            ? binding.node
            : node;
    return lexicalBindings(captured, bound.env).map(argumentSite).join("|");
  };
  // One lexical caller frame distinguishes a reused expression bound to different callbacks.
  // This is bounded calling context, not recursive serialization of the environment chain.
  return lexicalBindings(fn, env)
    .map((bound) => `${argumentSite(bound)}@[${callerShape(bound)}]`)
    .join("|");
}

const sourceWalks = new WeakMap();

export function processSourceSites(
  graph,
  entry,
  {
    evaluator = makeEvaluator(graph, { constants: {}, functions: {}, strictMembers: true }),
    env = EMPTY_ENV,
    targets = [],
    matchAny = false,
    targetOnly = false,
    mayReachTarget,
  } = {},
) {
  const requested = new Set(targets);
  const sites = new Set();
  const hits = [];
  // Cache reachability within the same evaluator and binding frame. A hit can only certify
  // existence. A miss still needs the closed walk below, including every edge of a cycle.
  const graphs = sourceWalks.get(evaluator) ?? new WeakMap();
  sourceWalks.set(evaluator, graphs);
  const projections = graphs.get(graph) ?? new Map();
  graphs.set(graph, projections);
  const walkContext = projections.get(mayReachTarget) ?? { frames: new Map(), siteBits: new Map() };
  projections.set(mayReachTarget, walkContext);
  const { frames, siteBits } = walkContext;
  let missing = 0n;
  const bits = new Map();
  for (const site of requested) {
    const bit = siteBits.get(site) ?? 1n << BigInt(siteBits.size);
    siteBits.set(site, bit);
    bits.set(site, bit);
    missing |= bit;
  }
  function record(site) {
    const bit = bits.get(site);
    if (bit && !sites.has(site)) {
      hits.push(site);
      missing ^= bit;
    }
    if (bit || !targetOnly) sites.add(site);
  }
  const seen = new Set();
  let locations = graphSites.get(graph);
  if (!locations) graphSites.set(graph, (locations = new WeakMap()));
  function location(node) {
    let site = locations.get(node);
    if (site === undefined) {
      site = sourceSite(graph, node);
      locations.set(node, site);
    }
    return site;
  }
  function frameFor(fn, env) {
    const key = sourceFrameKey(graph, fn, env),
      contexts = frames.get(fn) ?? new Map();
    frames.set(fn, contexts);
    if (!contexts.has(key)) contexts.set(key, { fn, env, sites: [], edges: null, missing: 0n, hits: null });
    return contexts.get(key);
  }
  function expand(frame) {
    const { fn, env } = frame;
    frame.edges = [];
    const linkFrame = (value, args = null) => {
      if (!value.node.body) return;
      const bound = args
        ? bindArguments(value, evaluator.expandArguments(args, env), env, value.env, graph.internEnv)
        : value.env;
      if (mayReachTarget && !mayReachTarget(value.node, bound)) return;
      frame.edges.push({
        frame: frameFor(value.node, bound),
        // Ordering needs only declaration ranges, not argument AST arrays. These cached
        // edges are reused for different target queries, so retain no query-specific flag.
        references: args ? referencedRanges(args) : [],
      });
    };
    function visit(node) {
      if (isFunctionNode(node)) return true;
      if (ts.isBlock(node) || ts.isSourceFile(node)) {
        for (const statement of node.statements) if (!visit(statement)) return false;
        return true;
      }
      if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
        if (node.expression) visit(node.expression);
        return false;
      }
      if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
        const condition = ts.isIfStatement(node) ? node.expression : node.condition;
        visit(condition);
        const folded = evaluator.fold(condition, env);
        const left = ts.isIfStatement(node) ? node.thenStatement : node.whenTrue;
        const right = ts.isIfStatement(node) ? node.elseStatement : node.whenFalse;
        if (folded) {
          const selected = folded.value ? left : right;
          return selected ? visit(selected) : true;
        }
        // Unknown branches both remain reachable; only two exits terminate the next statement.
        const leftContinues = visit(left),
          rightContinues = right ? visit(right) : true;
        return leftContinues || rightContinues;
      }
      if (
        ts.isNewExpression(node) &&
        node.expression.getText() === "Promise" &&
        !graph.lookup("Promise", node) &&
        (!mayReachTarget || mayReachTarget(node, env))
      )
        for (const argument of node.arguments ?? [])
          for (const value of evaluator.evaluate(argument, env).filter((value) => value.fn)) linkFrame(value);
      if (ts.isCallExpression(node)) {
        frame.sites.push(location(node));
        if (!mayReachTarget || mayReachTarget(node, env)) {
          const values = evaluator.evaluate(node.expression, env);
          const functions = values.filter((value) => value.fn);
          for (const value of functions) linkFrame(value, node.arguments);
          // A typeof callback signature can refer to a different implementation.
          // The actual callback wins whenever it resolves.
          const declared = functions.length === 0 && graph.callDeclaration(node);
          if (isFunctionNode(declared)) linkFrame({ node: declared, env: EMPTY_ENV }, node.arguments);
          if (values.some((value) => value.external !== undefined))
            for (const arg of node.arguments)
              for (const value of evaluator.evaluate(arg, env).filter((value) => value.fn)) linkFrame(value);
        }
      }
      // A child's exit cannot skip siblings in an enclosing loop/try/switch. Keep those
      // constructs conservative; sequential blocks and branches handle their own exits above.
      ts.forEachChild(node, (child) => {
        visit(child);
      });
      return true;
    }
    if (fn.body) visit(fn.body);
    frame.env = null;
  }
  const targetRanges = new Map();
  for (const site of requested) {
    const [, file, start, end] = /^(.*):(\d+):(\d+)$/u.exec(site);
    if (!targetRanges.has(file)) targetRanges.set(file, []);
    targetRanges.get(file).push({ start: Number(start), end: Number(end) });
  }
  const rangeOf = (node) => ({ file: graph.fileOf(node), start: nodeStart(node), end: node.end });
  const containsTarget = ({ file, start, end }) =>
    targetRanges.get(file)?.some((target) => start <= target.start && end >= target.end) ?? false;
  let references = graphReferences.get(graph);
  if (!references) graphReferences.set(graph, (references = new WeakMap()));
  function referencedRanges(args) {
    if (references.has(args)) return references.get(args);
    const found = [];
    function visit(child) {
      if (ts.isCallExpression(child)) {
        const declaration = graph.callDeclaration(child);
        if (isFunctionNode(declaration) && declaration.body) found.push(rangeOf(declaration));
      }
      ts.forEachChild(child, visit);
    }
    for (const arg of args) visit(arg);
    references.set(args, found);
    return found;
  }
  const satisfied = () => requested.size > 0 && (matchAny ? hits.length > 0 : missing === 0n);
  function allRemainingMissing(frame) {
    return missing !== 0n && (frame.missing & missing) === missing;
  }
  function walk(frame) {
    // A dispatcher may re-enter with another argument binding. frameFor already gives
    // each binding context its identity; seen frames terminate cycles without pruning it.
    if (!frame.fn.body || seen.has(frame)) return;
    if (satisfied()) return;
    if (allRemainingMissing(frame)) return;
    // An authored-origin summary can rule out the entire unexpanded frame.
    // Possible origins still go through the same control-flow and binding walk.
    if (frame.edges === null && mayReachTarget && !mayReachTarget(frame.fn, frame.env)) return;
    const previousHits = hits.length;
    if (targetOnly && frame.hits) {
      for (const site of frame.hits) {
        record(site);
        if (satisfied()) return;
      }
    }
    seen.add(frame);
    // Upstream host/migration proofs target an invoked callback endpoint as well as calls.
    const endpoint = location(frame.fn);
    if (requested.has(endpoint)) record(endpoint);
    if (!targetOnly || !satisfied()) {
      if (frame.edges === null) expand(frame);
      for (const site of frame.sites) record(site);
    }
    if (!satisfied()) {
      // A callback naming the target is cheap to inspect first. Other edges remain available.
      const preferred = [],
        neighboring = [],
        remaining = [];
      for (const edge of frame.edges) {
        const inTargetFile = targetRanges.has(graph.fileOf(edge.frame.fn));
        const next =
          (inTargetFile && containsTarget(rangeOf(edge.frame.fn))) || edge.references.some(containsTarget)
            ? preferred
            : inTargetFile
              ? neighboring
              : remaining;
        next.push(edge.frame);
      }
      for (const edges of [preferred, neighboring, remaining])
        for (const edge of edges) {
          if (satisfied()) break;
          walk(edge);
        }
    }
    // Each hit added below this frame has an actual edge path from here. Do not cache
    // hits from an earlier sibling or make any claim about unexplored edges.
    if (targetOnly && hits.length > previousHits) {
      frame.hits ??= new Set();
      for (let index = previousHits; index < hits.length; index++) frame.hits.add(hits[index]);
    }
  }
  walk(frameFor(entry, env));
  // A missing requested target forces a complete traversal (including cycles). Every
  // visited frame then has the same negative reachability fact. An early hit proves
  // no absence; an untargeted query still walks the whole graph. Never cache authority.
  if (missing !== 0n && (!matchAny || hits.length === 0)) for (const frame of seen) frame.missing |= missing;
  return sites;
}
