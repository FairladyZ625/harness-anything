import { EMPTY_ENV, lexicalEnvironment } from "./authorization-flow-env.mjs";

// Member/type candidates and return syntax depend only on this immutable source index.
const evaluatorGraphScopes = new WeakMap();
// Fact folds remain keyed by the individual audit, never by the shared member index.
const evaluatorFactScopes = new WeakMap();
const EMPTY_SCOPE_MAP = Object.freeze({});
const PENDING_QUERY = Symbol("pending");
const DESCRIPTOR_FACT = 1;
const IN_FLIGHT = 2;

function getEvaluatorScope(graph, facts) {
  let graphScope = evaluatorGraphScopes.get(graph.members);
  if (!graphScope) {
    const promiseThenEntries = graph.members.get("then") ?? [];
    graphScope = {
      typedMemberCandidates: new WeakMap(),
      canonicalSignatures: new Map(),
      expressionIds: new WeakMap(),
      returnExpressionCache: new WeakMap(),
      spreadArguments: new WeakMap(),
      nextExpressionId: 0,
      onlyExternalPromiseThen: promiseThenEntries.every((entry) => !/\.[cm]?[jt]sx?$/u.test(entry.file)),
    };
    evaluatorGraphScopes.set(graph.members, graphScope);
  }
  let factScopes = evaluatorFactScopes.get(graph);
  if (!factScopes) evaluatorFactScopes.set(graph, (factScopes = []));
  const strictMembers = Boolean(facts.strictMembers);
  const authorityModule = facts.authorityModule ?? "";
  const constants = facts.constants ?? EMPTY_SCOPE_MAP;
  const functions = facts.functions ?? EMPTY_SCOPE_MAP;
  const commandClass = facts.commandClass ?? "";
  const kindShape = facts.kind === undefined ? undefined : Boolean(facts.kind);
  const hasMethod = facts.method !== undefined;
  const fieldKeys = facts.fields ? Object.keys(facts.fields).sort().join(",") : "";
  let factScope = factScopes.find(
    (entry) =>
      entry.strictMembers === strictMembers &&
      entry.authorityModule === authorityModule &&
      entry.constants === constants &&
      entry.functions === functions &&
      entry.commandClass === commandClass &&
      entry.kindShape === kindShape &&
      entry.hasMethod === hasMethod &&
      entry.fieldKeys === fieldKeys,
  );
  if (!factScope) {
    factScope = {
      strictMembers,
      authorityModule,
      constants,
      functions,
      commandClass,
      kindShape,
      hasMethod,
      fieldKeys,
      memberCache: new Map(),
      emptyValueQueries: new WeakMap(),
      emptyFoldQueries: new WeakMap(),
    };
    factScopes.push(factScope);
  }
  return { graphScope, factScope };
}

export function makeEvaluationCache(graph, facts) {
  const { graphScope, factScope } = getEvaluatorScope(graph, facts);
  const lexicalEnv = graph.internEnv?.lexicalEnvironment ?? lexicalEnvironment;
  const factFlagsByArray = new WeakMap();
  let queryFlags = 0;

  function markDescriptorFact() {
    queryFlags |= DESCRIPTOR_FACT;
  }

  // Like provenance, these pure queries use immutable argument frames. A shared field
  // expression is one subproblem per frame and remaining depth, not a fresh receiver walk.
  function cachedQuery(cache, expression, env, depth, calculate, pending = null, emptyCache = null) {
    const sharedAtInput = env.size === 0 ? emptyCache?.get(expression) : undefined;
    if (sharedAtInput?.[depth] !== undefined) return sharedAtInput[depth];
    let slot = cache.get(expression);
    if (!slot) {
      slot = {
        closed: undefined,
        empty: undefined,
        contexts: undefined,
      };
      cache.set(expression, slot);
    }
    if (env.size !== 0 && slot.closed === undefined)
      slot.closed = graph.freeParameters ? graph.freeParameters(expression).size === 0 : false;
    const resolvedEnv = slot.closed || env.size === 0 ? EMPTY_ENV : lexicalEnv(expression, env);
    let depths;
    if (resolvedEnv.size === 0) {
      depths = slot.empty ??= [];
    } else {
      // The interner bounds live frames. An expression cache must not keep an
      // evicted callback's captured environments alive through a shortcut.
      const contexts = (slot.contexts ??= new WeakMap());
      depths = contexts.get(resolvedEnv);
      if (!depths) {
        depths = [];
        contexts.set(resolvedEnv, depths);
      }
    }
    if (env.size !== 0 && resolvedEnv === EMPTY_ENV && emptyCache) {
      const sharedDepths = emptyCache.get(expression);
      if (sharedDepths?.[depth] !== undefined) return sharedDepths[depth];
    }
    const cached = depths[depth];
    if (cached === PENDING_QUERY) {
      queryFlags |= IN_FLIGHT;
      return pending;
    }
    if (cached !== undefined) {
      queryFlags |= factFlagsByArray.get(depths)?.[depth] ?? 0;
      return cached;
    }
    depths[depth] = PENDING_QUERY;
    const parentFlags = queryFlags;
    queryFlags = 0;
    let result, flags;
    try {
      result = calculate(expression, resolvedEnv, depth);
    } finally {
      flags = queryFlags;
      queryFlags = parentFlags | flags;
    }
    depths[depth] = result;
    if (flags) {
      let entries = factFlagsByArray.get(depths);
      if (!entries) factFlagsByArray.set(depths, (entries = []));
      entries[depth] = flags;
    } else if (resolvedEnv === EMPTY_ENV && emptyCache) {
      let sharedDepths = emptyCache.get(expression);
      if (!sharedDepths) emptyCache.set(expression, (sharedDepths = []));
      sharedDepths[depth] = result;
    }
    return result;
  }

  return { graphScope, factScope, cachedQuery, markDescriptorFact, lexicalEnv };
}
