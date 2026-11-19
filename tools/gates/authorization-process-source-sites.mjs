import ts from "typescript";
import { bindArguments, EMPTY_ENV, isFunctionNode, makeEvaluator, unwrap } from "./authorization-flow-graph.mjs";
import { nodeStart, sourceSite } from "./authorization-gui-source-proof.mjs";
import { sourceOriginFilter } from "./authorization-source-origins.mjs";

import { expandSourceFrames } from "./authorization-source-traversal.mjs";

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

export function processNativeSourceSites(graph, entry, evaluator, targets) {
  const ranges = targets.map((site) => {
    const [, file, start, end] = /^(.*):(\d+):(\d+)$/u.exec(site);
    return { file, start: Number(start), end: Number(end) };
  });
  const mayReachTarget = sourceOriginFilter(graph, ranges);
  const reached = new Set();
  // Each witness gets its own search order. The shared evaluator and origin
  // scope keep the expanded frames and their proofs across the searches.
  for (const site of new Set(targets))
    if (processSourceSites(graph, entry, { evaluator, targets: [site], targetOnly: true, mayReachTarget }).has(site))
      reached.add(site);
  return reached;
}

function* sourceWalk(
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
  function expansion(frame) {
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
    return {
      body: fn.body,
      fold: (condition) => evaluator.fold(condition, env),
      promise(node) {
        if (graph.lookup("Promise", node) || (mayReachTarget && !mayReachTarget(node, env))) return;
        for (const argument of node.arguments ?? [])
          for (const value of evaluator.evaluate(argument, env).filter((value) => value.fn)) linkFrame(value);
      },
      call(node) {
        frame.sites.push(location(node));
        if (mayReachTarget && !mayReachTarget(node, env)) return;
        const values = evaluator.evaluate(node.expression, env);
        const functions = values.filter((value) => value.fn);
        for (const value of functions) linkFrame(value, node.arguments);
        const declared = functions.length === 0 && graph.callDeclaration(node);
        if (isFunctionNode(declared)) linkFrame({ node: declared, env: EMPTY_ENV }, node.arguments);
        if (values.some((value) => value.external !== undefined))
          for (const arg of node.arguments)
            for (const value of evaluator.evaluate(arg, env).filter((value) => value.fn)) linkFrame(value);
      },
    };
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
      if (isFunctionNode(child)) found.push(rangeOf(child));
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
  // Each lane advances its own depth-first cursor. Suspending at expansion
  // never changes which actual binding first occupies a bounded frame key.
  const pending = [{ frame: frameFor(entry, env) }];
  while (pending.length) {
    const { frame, previousHits } = pending.pop();
    if (previousHits !== undefined) {
      if (hits.length > previousHits) {
        frame.hits ??= new Set();
        for (let i = previousHits; i < hits.length; i++) frame.hits.add(hits[i]);
      }
      continue;
    }
    if (!frame.fn.body || seen.has(frame) || satisfied() || allRemainingMissing(frame)) continue;
    if (frame.edges === null && mayReachTarget && !mayReachTarget(frame.fn, frame.env)) continue;
    const start = hits.length;
    if (targetOnly && frame.hits) {
      for (const site of frame.hits) {
        record(site);
        if (satisfied()) break;
      }
      if (satisfied()) continue;
    }
    seen.add(frame);
    if (targetOnly) pending.push({ frame, previousHits: start });
    const endpoint = location(frame.fn);
    if (requested.has(endpoint)) record(endpoint);
    if (targetOnly && satisfied()) continue;
    if (frame.edges === null) {
      yield expansion(frame);
      frame.env = null;
    }
    for (const site of frame.sites) record(site);
    if (satisfied()) continue;
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
      next.push(edge);
    }
    for (const group of [remaining, neighboring, preferred])
      for (let i = group.length - 1; i >= 0; i--) pending.push(group[i]);
  }
  // A missing requested target forces a complete traversal (including cycles). Every
  // visited frame then has the same negative reachability fact. An early hit proves
  // no absence; an untargeted query still walks the whole graph. Never cache authority.
  if (missing !== 0n && (!matchAny || hits.length === 0)) for (const frame of seen) frame.missing |= missing;
  return sites;
}

export function processSourceSites(graph, entry, options) {
  return processSourceQueries([{ graph, entry, options }])[0];
}

// Run independent descriptor searches in lockstep at frame expansion. Queries
// sharing an evaluator must finish in caller order: their frame tables persist.
export function processSourceQueries(queries, profile) {
  const results = [];
  for (let start = 0; start < queries.length; ) {
    const walks = [],
      evaluators = new Set();
    while (start + walks.length < queries.length && walks.length < 4) {
      const { graph, entry, options } = queries[start + walks.length];
      if (options?.evaluator && evaluators.has(options.evaluator)) break;
      evaluators.add(options?.evaluator);
      walks.push(sourceWalk(graph, entry, options));
    }
    results.push(
      ...advanceWalks(walks, (frames) => {
        const bodies = expandSourceFrames(frames);
        if (profile) {
          profile.sourceFrames += frames.length;
          profile.sourceBodyVisits += bodies;
        }
      }),
    );
    start += walks.length;
  }
  return results;
}

// A lane suspends only for a source query. Reports, recursion cutoffs, target
// order, and the first bound environment of each frame stay inside that lane.
export function runDescriptorTraversals(walks, profile) {
  return advanceWalks(walks, (queries) => processSourceQueries(queries, profile));
}

function advanceWalks(walks, resolve) {
  const answers = [];
  let active = walks.map((walk, index) => ({ walk, index }));
  while (active.length) {
    const pending = [],
      requests = [];
    for (const lane of active) {
      const step = lane.walk.next(answers[lane.index]);
      if (step.done) answers[lane.index] = step.value;
      else {
        pending.push(lane);
        requests.push(step.value);
      }
    }
    if (!pending.length) break;
    const replies = resolve(requests);
    if (replies) for (let i = 0; i < pending.length; i++) answers[pending[i].index] = replies[i];
    active = pending;
  }
  return answers;
}
