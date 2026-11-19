// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  bindArguments,
  buildFlowGraph,
  EMPTY_ENV,
  freshEvaluationGraph,
  makeEvaluator,
} from "../authorization-flow-graph.mjs";
import { sourceOriginFilter } from "../authorization-source-origins.mjs";
import { processSourceSites, sourceSite, sourceWitnesses } from "../authorization-source-proof.mjs";
import { scanOntologyText } from "../ontology-closure-scan.mjs";
import { makeRepo } from "./helpers.mjs";

test("shared source witnesses survive caller mutation and reject replaced syntax", () => {
  const file = "packages/daemon/src/witness.ts",
    text = 'function effect() { store.append("original"); }',
    { rootDir } = makeRepo({ [file]: text }),
    graph = buildFlowGraph(rootDir),
    sources = scanOntologyText(file, text)
      .filter((candidate) => candidate.category === "action")
      .map((candidate) => ({ candidateId: candidate.id })),
    original = [...sourceWitnesses(graph, sources)];
  assert.equal(original.length, 1);
  sourceWitnesses(graph, sources).clear();
  const query = freshEvaluationGraph(graph);
  assert.deepEqual([...sourceWitnesses(query, sources)], original);
  query.releaseQueries();
  const changed = graph.withSourceOverrides(new Map([[file, "function effect() {}"]]));
  assert.equal(sourceWitnesses(changed, sources).size, 0);
  assert.deepEqual([...sourceWitnesses(graph, sources)], original);
  changed.releaseQueries();
  graph.releaseQueries();
});

test("a retained source file releases its completed audit's environment owner", () => {
  const file = "packages/daemon/src/owner.ts",
    { rootDir } = makeRepo({ [file]: "function owner(callback) { callback(); }" }),
    graph = buildFlowGraph(rootDir),
    owner = graph.modules.get(file).sourceFile.statements[0],
    bind = () => bindArguments({ node: owner, env: EMPTY_ENV }, [owner.name], EMPTY_ENV),
    live = bind();
  assert.equal(live, graph.internEnv(live));
  graph.releaseQueries();
  assert.throws(bind, TypeError, "the retained AST no longer selects the completed interner");
  const next = freshEvaluationGraph(graph),
    current = bind();
  graph.releaseQueries();
  assert.equal(current, next.internEnv(current), "a stale owner cannot release the next audit's interner");
  next.releaseQueries();
});

test("shared AST audits discard fact memo and frame identity in positive and negative order", (t) => {
  const file = "packages/daemon/src/audit.ts",
    { rootDir } = makeRepo({
      [file]:
        'import { allowed } from "@harness-anything/kernel"; function owner(callback) { if (allowed) callback(); }',
    }),
    graph = buildFlowGraph(rootDir),
    owner = graph.modules.get(file).sourceFile.statements[1],
    condition = owner.body.statements[0].expression,
    facts = { authorityModule: "@harness-anything/kernel", constants: {}, functions: {} },
    argument = { expression: owner.name, env: EMPTY_ENV },
    bind = () => graph.internEnv(new Map([[owner.parameters[0], argument]]));
  let previous = bind();
  for (const allowed of [true, true, false, true, false, false, true]) {
    facts.constants.allowed = allowed;
    const auditGraph = freshEvaluationGraph(graph),
      evaluator = makeEvaluator(auditGraph, facts),
      frame = bind();
    assert.equal(auditGraph.modules, graph.modules, "the source graph is reused");
    assert.notEqual(auditGraph.internEnv, graph.internEnv, "each audit owns a new environment interner");
    assert.notEqual(frame, previous, "the preceding audit's frame pool is empty");
    assert.deepEqual(evaluator.fold(condition, EMPTY_ENV), { value: allowed });
    previous = frame;
  }
  // Positive control: deliberately retain one audit identity after warming its allowed
  // fold. Clearing frames alone cannot invalidate fact memo for the same constants object.
  const pollutedGraph = freshEvaluationGraph(graph);
  assert.deepEqual(makeEvaluator(pollutedGraph, facts).fold(condition, EMPTY_ENV), { value: true });
  facts.constants.allowed = false;
  pollutedGraph.resetFramePool();
  const leaked = makeEvaluator(pollutedGraph, facts).fold(condition, EMPTY_ENV);
  assert.throws(() => assert.deepEqual(leaked, { value: false }), { code: "ERR_ASSERTION" });
  t.diagnostic("positive control retained proof memo: expected false, observed true; ERR_ASSERTION detected");
});

test("recursive helpers and self-updated locals capture only actual free parameters", () => {
  const file = "packages/daemon/src/frame.ts",
    { rootDir } = makeRepo({
      [file]: `function effect() { store.append(); } function empty() {}
function owner(callback, unused) {
  let value = callback; value = value || callback;
  function first() { second(); }
  function second() { if (value) value(); first(); }
  first();
}
function closed(unused) { function first() { second(); } function second() { first(); } return first; }`,
    }),
    graph = buildFlowGraph(rootDir),
    [effect, empty, owner, closed] = graph.modules.get(file).sourceFile.statements,
    [first, second] = owner.body.statements.filter((node) => node.name),
    site = sourceSite(graph, effect.body.statements[0].expression),
    evaluator = makeEvaluator(graph, { constants: {}, functions: {}, strictMembers: true });
  for (const fn of [first, second])
    assert.deepEqual(
      [...graph.freeParameters(fn)].map((node) => node.name.text),
      ["callback"],
    );
  assert.equal(graph.freeParameters(closed.body.statements[0]).size, 0);
  for (const [callback, expected] of [
    [empty.name, false],
    [effect.name, true],
    [empty.name, false],
  ]) {
    const env = bindArguments({ node: owner, env: EMPTY_ENV }, [callback], EMPTY_ENV);
    assert.equal(processSourceSites(graph, owner, { evaluator, env, targets: [site] }).has(site), expected);
  }
});

test("stored argument captures share the canonical environment DAG", () => {
  const file = "packages/daemon/src/frame.ts",
    { rootDir } = makeRepo({
      [file]: `function take(value, noise) { if (noise) return value.value; return value.value; }
function caller(value, noise) { const payload = { value }; return take(payload, noise); }
const same = "same", first = 1, second = 2;`,
    }),
    graph = buildFlowGraph(rootDir),
    [take, caller, values] = graph.modules.get(file).sourceFile.statements,
    args = values.declarationList.declarations.map((node) => node.initializer),
    call = caller.body.statements.at(-1).expression,
    frame = (noise) =>
      bindArguments(
        { node: take, env: EMPTY_ENV },
        call.arguments,
        bindArguments({ node: caller, env: EMPTY_ENV }, [args[0], noise], EMPTY_ENV),
      ),
    first = frame(args[1]),
    second = frame(args[2]),
    capture = first.get(take.parameters[0]).env,
    evaluator = makeEvaluator(graph, { constants: {}, functions: {} });
  assert.ok(first !== second, "different referenced noise still distinguishes the outer frame");
  assert.ok(capture === graph.internEnv(capture), "stored captures must be canonical, not only their key");
  assert.ok(capture === second.get(take.parameters[0]).env, "equivalent captured subgraphs share storage");
  const seen = new Set(),
    pending = [first, second];
  while (pending.length) {
    const env = pending.pop();
    if (seen.has(env)) continue;
    seen.add(env);
    assert.ok(env === graph.internEnv(env), "every retained capture is a canonical DAG node");
    for (const bound of env.values()) if (bound.env) pending.push(bound.env);
  }
  assert.deepEqual(evaluator.fold(take.body.statements[0].thenStatement.expression, first), { value: "same" });
  assert.deepEqual(evaluator.fold(take.body.statements[0].expression, first), { value: 1 });
  assert.deepEqual(evaluator.fold(take.body.statements[0].expression, second), { value: 2 });
});

test("a function value cannot capture its own invocation parameters", () => {
  const file = "packages/daemon/src/frame.ts",
    { rootDir } = makeRepo({
      [file]: `function take(value) { return value; }
function recursive(callback) { callback(); return take(recursive); }
function first() {} function second() {}`,
    }),
    graph = buildFlowGraph(rootDir),
    [take, recursive, first, second] = graph.modules.get(file).sourceFile.statements,
    args = recursive.body.statements.at(-1).expression.arguments,
    invocation = (callback) => bindArguments({ node: recursive, env: EMPTY_ENV }, [callback], EMPTY_ENV),
    value = (callback) => bindArguments({ node: take, env: EMPTY_ENV }, args, invocation(callback));
  assert.ok(value(first.name) === value(second.name), "a function closes over its declaration, not its call");
});

test("unused own parameters cannot multiply a function invocation frame", () => {
  const file = "packages/daemon/src/frame.ts",
    { rootDir } = makeRepo({
      [file]: `function effect() { store.append(); } function empty() {}
function invoke(callback, unused) { callback(); }
const first = 1, second = 2;`,
    }),
    graph = buildFlowGraph(rootDir),
    [effect, empty, invoke, values] = graph.modules.get(file).sourceFile.statements,
    args = values.declarationList.declarations.map((node) => node.initializer),
    fn = { node: invoke, env: EMPTY_ENV },
    frame = (callback, noise) => bindArguments(fn, [callback, noise], EMPTY_ENV),
    first = frame(effect.name, args[0]),
    second = frame(effect.name, args[1]);
  assert.ok(first === second, "an unreferenced formal parameter must not enter the frame pool");
  assert.ok(first !== frame(empty.name, args[0]), "the real callback still distinguishes invocations");
});

test("recursive function expressions capture only parameters outside their declaration", () => {
  for (const local of [false, true]) {
    const file = "packages/daemon/src/frame.ts",
      definition = "const recursive = (callback) => { callback(); return recursive; };",
      { rootDir } = makeRepo({
        [file]: `function take(value) { return value; }
${local ? `function owner() { ${definition} }` : definition}
function first() {} function second() {}`,
      }),
      graph = buildFlowGraph(rootDir),
      [take, declaration, first, second] = graph.modules.get(file).sourceFile.statements,
      recursive = (local ? declaration.body.statements[0] : declaration).declarationList.declarations[0].initializer,
      reference = recursive.body.statements.at(-1).expression,
      invocation = (callback) => bindArguments({ node: recursive, env: EMPTY_ENV }, [callback], EMPTY_ENV),
      value = (callback) => bindArguments({ node: take, env: EMPTY_ENV }, [reference], invocation(callback));
    assert.ok(value(first.name) === value(second.name), "a const function alias has the same capture boundary");
    const literalValue = (callback) => bindArguments({ node: take, env: EMPTY_ENV }, [recursive], invocation(callback));
    assert.ok(literalValue(first.name) === literalValue(second.name), "a function literal has the same boundary");
    assert.equal(graph.freeParameters(reference).size, 0, "the value captures no outer parameter");
    assert.ok(graph.freeParameters(recursive).has(recursive.parameters[0]), "the body still depends on its argument");
  }
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1: a cached frame never certifies another caller.
test("complete source misses reuse their closed call graph without poisoning hits or full walks", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: `function target() {}
function first() { second(); }
function second() { first(); }
function entry() { first(); }`,
  });
  const original = buildFlowGraph(rootDir),
    [target, first, second, entry] = original.modules.get(file).sourceFile.statements;
  let reads = 0;
  const graph = {
      ...original,
      fileOf(node) {
        reads++;
        return original.fileOf(node);
      },
    },
    evaluator = makeEvaluator(graph, { constants: {}, functions: {}, strictMembers: true }),
    missing = sourceSite(original, target),
    query = () => processSourceSites(graph, entry, { evaluator, targets: [missing] });
  const early = sourceSite(original, first);
  assert.ok(processSourceSites(graph, entry, { evaluator, targets: [early] }).has(early));
  assert.equal(query().has(missing), false);
  const firstReads = reads;
  assert.ok(firstReads > 0);
  assert.equal(query().has(missing), false);
  assert.equal(reads, firstReads, "a complete negative closure must not be walked again");
  const live = sourceSite(original, first);
  assert.ok(processSourceSites(graph, entry, { evaluator, targets: [live] }).has(live));
  assert.ok(
    processSourceSites(graph, entry, { evaluator }).has(sourceSite(original, second.body.statements[0].expression)),
  );
});

test("target-only source queries reuse a proven suffix reached by another caller", () => {
  const file = "packages/daemon/src/shared-suffix.ts";
  const { rootDir } = makeRepo({
    [file]: `function target() { store.append("target"); }
function middle() { target(); }
function shared() { middle(); }
function first() { shared(); }
function second() { shared(); }`,
  });
  const original = buildFlowGraph(rootDir);
  const [target, , , first, second] = original.modules.get(file).sourceFile.statements;
  let targetReads = 0;
  const graph = {
    ...original,
    fileOf(node) {
      if (node === target) targetReads++;
      return original.fileOf(node);
    },
  };
  const site = sourceSite(original, target.body.statements[0].expression);
  const evaluator = makeEvaluator(graph, { strictMembers: true });
  const query = (entry) => processSourceSites(graph, entry, { evaluator, targets: [site], targetOnly: true });
  assert.deepEqual([...query(first)], [site]);
  assert.ok(targetReads > 0);
  const firstReads = targetReads;
  assert.deepEqual([...query(second)], [site]);
  assert.equal(targetReads, firstReads, "a proven suffix does not traverse its target edge again");
});

test("matchAny source queries stop at the first hit without marking unvisited targets missing", () => {
  const file = "packages/daemon/src/match-any.ts";
  const { rootDir } = makeRepo({
    [file]: `function hit() { store.append("first"); }
function later() { store.append("second"); }
function absent() { store.append("never"); }
function entry() { hit(); later(); }`,
  });
  const graph = buildFlowGraph(rootDir),
    [hit, later, absent, entry] = graph.modules.get(file).sourceFile.statements,
    evaluator = makeEvaluator(graph, { constants: {}, functions: {}, strictMembers: true }),
    firstSite = sourceSite(graph, hit.body.statements[0].expression),
    secondSite = sourceSite(graph, later.body.statements[0].expression),
    absentSite = sourceSite(graph, absent.body.statements[0].expression);
  const early = processSourceSites(graph, entry, {
    evaluator,
    targets: [firstSite, secondSite],
    matchAny: true,
  });
  assert.equal(early.has(firstSite), true);
  assert.equal(early.has(secondSite), false, "matchAny returns on the first reachable target");
  assert.equal(
    processSourceSites(graph, entry, { evaluator, targets: [secondSite] }).has(secondSite),
    true,
    "an early matchAny exit must not cache unvisited targets as missing",
  );
  assert.deepEqual(
    [...processSourceSites(graph, entry, { evaluator, targets: [secondSite, absentSite], targetOnly: true })],
    [secondSite],
  );
  assert.equal(
    processSourceSites(graph, entry, { evaluator, targets: [absentSite], matchAny: true }).has(absentSite),
    false,
  );
});

test("source origins keep typed member implementations and caller-bound functions", () => {
  const file = "packages/daemon/src/origin-entry.ts",
    implementation = "packages/daemon/src/origin-implementation.ts",
    { rootDir } = makeRepo({
      [file]: `import { alternate, write } from "./origin-implementation.ts";
import type { Port } from "./origin-implementation.ts";
declare const port: Port;
function relay(callback) { callback(); }
function throughPort() { port.commit(); }
function bindings() { relay(alternate); relay(write); }`,
      [implementation]: `export interface Port { commit(): void }
export function write() { store.append("wanted"); }
export function alternate() { store.append("unrelated"); }
export const port: Port = { commit() { write(); } };`,
    }),
    graph = buildFlowGraph(rootDir),
    [, write] = graph.modules.get(implementation).sourceFile.statements,
    [, , , relay, throughPort, bindings] = graph.modules.get(file).sourceFile.statements,
    call = write.body.statements[0].expression,
    site = sourceSite(graph, call),
    mayReach = sourceOriginFilter(graph, [{ file: implementation, start: call.getStart(), end: call.end }]),
    frame = (index) =>
      bindArguments({ node: relay, env: EMPTY_ENV }, bindings.body.statements[index].expression.arguments, EMPTY_ENV);
  assert.equal(mayReach(relay, frame(0)), false);
  assert.equal(mayReach(relay, frame(1)), true);
  const query = { targets: [site], targetOnly: true, mayReachTarget: mayReach };
  assert.equal(processSourceSites(graph, relay, { ...query, env: frame(0) }).has(site), false);
  assert.equal(processSourceSites(graph, relay, { ...query, env: frame(1) }).has(site), true);
  assert.equal(mayReach(throughPort, EMPTY_ENV), true);
  assert.equal(processSourceSites(graph, throughPort, query).has(site), true);
});

test("a lexical class receiver retains the source of a sibling method", () => {
  const file = "packages/daemon/src/receiver.mjs",
    { rootDir } = makeRepo({
      [file]: `class Receiver {
  run() { this.write(); }
  write() { store.append(); }
}`,
    }),
    graph = buildFlowGraph(rootDir, { lexicalFiles: [file] }),
    [receiver] = graph.modules.get(file).sourceFile.statements,
    [run, write] = receiver.members,
    call = write.body.statements[0].expression,
    site = sourceSite(graph, call),
    options = { targets: [site], targetOnly: true };
  assert.equal(graph.callDeclaration(run.body.statements[0].expression), undefined);
  assert.equal(processSourceSites(graph, run, options).has(site), true);
  const mayReachTarget = sourceOriginFilter(graph, [{ file, start: call.getStart(), end: call.end }]);
  assert.equal(processSourceSites(graph, run, { ...options, mayReachTarget }).has(site), true);
});

test("source summaries reuse unchanged frames and retain separate callback bindings", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: `
function invoke(callback) { callback(); }
function empty() {}
function effect() { store.append(); }
function first() { invoke(empty); }
function second() { invoke(effect); }`,
  });
  const graph = buildFlowGraph(rootDir);
  const functions = graph.modules.get(file).sourceFile.statements;
  const site = sourceSite(graph, functions[2].body.statements[0].expression);
  const evaluator = makeEvaluator(graph, { constants: {}, functions: {} });
  const evaluate = evaluator.evaluate;
  let evaluations = 0;
  evaluator.evaluate = (...args) => {
    evaluations++;
    return evaluate(...args);
  };
  const env = new Map();
  assert.equal(processSourceSites(graph, functions[3], { evaluator, env, targets: [site] }).has(site), false);
  const beforeRepeat = evaluations;
  assert.equal(processSourceSites(graph, functions[3], { evaluator, env, targets: [site] }).has(site), false);
  assert.equal(evaluations, beforeRepeat);
  assert.equal(processSourceSites(graph, functions[4], { evaluator, env, targets: [site] }).has(site), true);
});

test("source frames ignore parameters outside their lexical scope", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: `
function caller(input) {}
function effect() { store.append(); }
function entry() { effect(); }
const first = 1, second = 2;`,
  });
  const graph = buildFlowGraph(rootDir);
  const nodes = graph.modules.get(file).sourceFile.statements;
  const evaluator = makeEvaluator(graph, { constants: {}, functions: {} });
  const evaluate = evaluator.evaluate;
  let evaluations = 0;
  evaluator.evaluate = (...args) => {
    evaluations++;
    return evaluate(...args);
  };
  const frame = (index) =>
    new Map([
      [
        nodes[0].parameters[0],
        {
          expression: nodes[3].declarationList.declarations[index].initializer,
          env: new Map(),
        },
      ],
    ]);
  const site = sourceSite(graph, nodes[1].body.statements[0].expression);
  assert.equal(processSourceSites(graph, nodes[2], { evaluator, env: frame(0), targets: [site] }).has(site), true);
  const beforeRepeat = evaluations;
  assert.equal(processSourceSites(graph, nodes[2], { evaluator, env: frame(1), targets: [site] }).has(site), true);
  assert.equal(evaluations, beforeRepeat);
});

// A mutation Program reuses pristine syntax, while its checker and proof state remain separate.
test("source overrides reuse unchanged ASTs and recheck changed imports in either order", () => {
  const file = "packages/daemon/src/value.ts",
    caller = "packages/daemon/src/caller.ts",
    { rootDir } = makeRepo({
      [file]: 'export function value() { return "green"; }',
      [caller]: 'import { value } from "./value.ts"; export function entry() { return value(); }',
    }),
    baseline = buildFlowGraph(rootDir),
    originalCaller = baseline.modules.get(caller).sourceFile,
    expression = originalCaller.statements[1].body.statements[0].expression,
    check = (graph, expected) => {
      const query = freshEvaluationGraph(graph);
      try {
        assert.deepEqual(makeEvaluator(query, {}).fold(expression, EMPTY_ENV), { value: expected });
      } finally {
        query.releaseQueries();
      }
    };
  check(baseline, "green");
  assert.equal(baseline.callDeclaration(expression), baseline.modules.get(file).sourceFile.statements[0]);
  const mutation = baseline.withSourceOverrides(
    new Map([
      [file, 'export function value() { return "red"; }'],
      ["packages/daemon/src/new.ts", "export function added() { return false; }"],
    ]),
  );
  assert.equal(mutation.modules.get(caller).sourceFile, originalCaller);
  assert.notEqual(mutation.modules.get(file).sourceFile, baseline.modules.get(file).sourceFile);
  assert.ok(mutation.modules.has("packages/daemon/src/new.ts"));
  assert.equal(mutation.callDeclaration(expression), mutation.modules.get(file).sourceFile.statements[0]);
  check(mutation, "red");
  mutation.releaseQueries();
  check(baseline, "green");
  check(mutation, "red");
});

test("interleaved Programs bind through their own query owner on shared source files", () => {
  const file = "packages/daemon/src/caller.ts",
    { rootDir } = makeRepo({
      [file]: 'function value(input) { return input; } export function entry() { return value("ok"); }',
    }),
    baseline = buildFlowGraph(rootDir),
    left = freshEvaluationGraph(baseline),
    right = freshEvaluationGraph(baseline.withSourceOverrides(new Map())),
    expression = baseline.modules.get(file).sourceFile.statements[1].body.statements[0].expression,
    first = makeEvaluator(left, {}),
    second = makeEvaluator(right, {});
  assert.deepEqual(second.fold(expression, EMPTY_ENV), { value: "ok" });
  right.releaseQueries();
  assert.deepEqual(first.fold(expression, EMPTY_ENV), { value: "ok" });
  left.releaseQueries();
});
