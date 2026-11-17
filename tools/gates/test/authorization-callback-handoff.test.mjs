// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import path from "node:path";
import { loadAuthorizationInputs } from "../ontology-durable-action-authorization.mjs";
import {
  authorizationPolicyGraph,
  bindArguments,
  buildFlowGraph,
  EMPTY_ENV,
  makeEvaluator,
} from "../authorization-flow-graph.mjs";
import { makeAuthorizationTracer } from "../authorization-flow-trace.mjs";
import { processSourceSites, sourceFrameKey, sourceSite, sourceWitnesses } from "../authorization-source-proof.mjs";
import { makeRepo } from "./helpers.mjs";

// dec_7E44897ECDCAEF2B92EC66A260/CH1: remove unrelated calling context, never callback evidence.
test("rest forwarding captures each argument without retaining an outer caller frame", () => {
  const file = "packages/daemon/src/rest.ts",
    { rootDir } = makeRepo({
      [file]: `function effect() { store.append(); } function empty() {}
function invoke(callback) { callback(); }
function forward(...callbacks) { invoke(...callbacks); }
function caller(noise, callback) { forward(callback); }
const first = 1, second = 2;`,
    }),
    graph = buildFlowGraph(rootDir),
    [effect, empty, , forward, caller, values] = graph.modules.get(file).sourceFile.statements,
    args = values.declarationList.declarations.map((node) => node.initializer),
    frame = (index) => bindArguments({ node: caller, env: EMPTY_ENV }, [args[index], effect.name], EMPTY_ENV),
    call = caller.body.statements[0].expression,
    fn = { node: forward, env: EMPTY_ENV },
    first = bindArguments(fn, call.arguments, frame(0)),
    second = bindArguments(fn, call.arguments, frame(1)),
    evaluator = makeEvaluator(graph, { constants: {}, functions: {}, strictMembers: true }),
    site = sourceSite(graph, effect.body.statements[0].expression);
  assert.ok(first === second, "rest entries already own their argument environments");
  assert.ok(first.get(forward.parameters[0]).env === EMPTY_ENV);
  assert.ok(processSourceSites(graph, forward, { evaluator, env: first, targets: [site] }).has(site));
  const detached = bindArguments(fn, [empty.name], EMPTY_ENV);
  assert.ok(first !== detached);
  assert.equal(processSourceSites(graph, forward, { evaluator, env: detached, targets: [site] }).has(site), false);
});

test("normalized rest forwarding preserves a root argument's request provenance", () => {
  const file = "packages/daemon/src/rest-root.ts",
    { rootDir } = makeRepo({
      [file]: `function invoke(request) { return request.method; }
function forward(...args) { return invoke(...args); }
function entry(request) { return forward(request); }`,
    }),
    graph = buildFlowGraph(rootDir),
    entry = graph.modules.get(file).sourceFile.statements.at(-1),
    env = graph.internEnv([[entry.parameters[0], { root: true }]]),
    evaluator = makeEvaluator(graph, { method: "demo", constants: {}, functions: {} });
  assert.deepEqual(evaluator.fold(entry.body.statements[0].expression, env), { value: "demo" });
  assert.equal(evaluator.fold(entry.body.statements[0].expression, EMPTY_ENV), null);
});

test("assigned let and non-null arguments capture their data parameters without callback frame pollution", () => {
  const file = "packages/daemon/src/database.ts",
    { rootDir } = makeRepo({
      [file]: `function effect() { store.append(); } function empty() {}
function take(value) { return value; }
function owner(operation, projectionPath, unused) {
  let db = null; db = projectionPath; operation(db!); return take(db!);
}
const first = "first", second = "second";`,
    }),
    graph = buildFlowGraph(rootDir),
    [effect, empty, take, owner, values] = graph.modules.get(file).sourceFile.statements,
    paths = values.declarationList.declarations.map((node) => node.initializer),
    call = owner.body.statements.at(-1).expression,
    fn = { node: take, env: EMPTY_ENV },
    ownerFrame = (callback, index) =>
      bindArguments({ node: owner, env: EMPTY_ENV }, [callback, paths[index]], EMPTY_ENV),
    first = bindArguments(fn, call.arguments, ownerFrame(effect.name, 0)),
    second = bindArguments(fn, call.arguments, ownerFrame(empty.name, 0));
  assert.ok(first === second, "db! depends on projectionPath, not the operation callback");
  assert.ok(first !== bindArguments(fn, call.arguments, ownerFrame(effect.name, 1)));
  assert.deepEqual(
    [...graph.freeParameters(call.arguments[0])].map((node) => node.name.text),
    ["projectionPath"],
  );
  const site = sourceSite(graph, effect.body.statements[0].expression),
    evaluator = makeEvaluator(graph, { constants: {}, functions: {}, strictMembers: true });
  assert.ok(
    processSourceSites(graph, owner, { evaluator, env: ownerFrame(effect.name, 0), targets: [site] }).has(site),
  );
  assert.equal(
    processSourceSites(graph, owner, { evaluator, env: ownerFrame(empty.name, 0), targets: [site] }).has(site),
    false,
  );
});

test("catch values and object projections narrow cache and source frames to free parameters", () => {
  const file = "packages/daemon/src/capture.ts",
    { rootDir } = makeRepo({
      [file]: `function take(value) { return value; }
function owner(binding, authorizationDecision, unused) {
  const { unused: renamed } = binding;
  try {} catch(error) { take(error); }
  return { ...binding, authorizationDecision };
}
const first = 1, second = 2;`,
    }),
    graph = buildFlowGraph(rootDir),
    [take, owner, values] = graph.modules.get(file).sourceFile.statements,
    args = values.declarationList.declarations.map((node) => node.initializer),
    frames = args.map((arg) => bindArguments({ node: owner, env: EMPTY_ENV }, [args[0], args[0], arg], EMPTY_ENV)),
    caught = owner.body.statements.find(ts.isTryStatement).catchClause.block.statements[0].expression.arguments[0],
    object = owner.body.statements.at(-1).expression,
    fn = { node: take, env: EMPTY_ENV },
    evaluator = makeEvaluator(graph, { constants: {}, functions: {} });
  assert.ok(bindArguments(fn, [caught], frames[0]) === bindArguments(fn, [caught], frames[1]));
  assert.ok(evaluator.evaluate(caught, frames[0]) === evaluator.evaluate(caught, frames[1]));
  assert.ok(evaluator.evaluate(object, frames[0]) === evaluator.evaluate(object, frames[1]));
  assert.deepEqual(
    [...graph.freeParameters(owner.body.statements[0])].map((node) => node.name.text),
    ["binding"],
  );
  assert.deepEqual(
    [...graph.freeParameters(object)].map((node) => node.name.text),
    ["binding", "authorizationDecision"],
  );
  assert.equal(sourceFrameKey(graph, owner, frames[0]), sourceFrameKey(graph, owner, frames[1]));
});

test("mutually recursive local helpers and this retain real captured callbacks across pool resets", () => {
  const file = "packages/daemon/src/recursive.ts",
    { rootDir } = makeRepo({
      [file]: `function effect() { store.append(); } function empty() {}
function owner(callback, ready) {
  function first() { if (ready) callback(); else second(); }
  function second() { first(); }
  class Runner { run() { callback(); } call() { this.run(); } }
  first(); new Runner().call();
}`,
    }),
    graph = buildFlowGraph(rootDir),
    [effect, empty, owner] = graph.modules.get(file).sourceFile.statements,
    [first, second, cls] = owner.body.statements,
    site = sourceSite(graph, effect.body.statements[0].expression),
    frame = (callback) => bindArguments({ node: owner, env: EMPTY_ENV }, [callback], EMPTY_ENV);
  assert.ok(graph.freeParameters(first).has(owner.parameters[0]));
  assert.ok(graph.freeParameters(second).has(owner.parameters[0]));
  const receiver = cls.members[1].body.statements[0].expression.expression.expression;
  assert.ok(graph.freeParameters(receiver).has(owner.parameters[0]));
  for (const [callback, expected] of [
    [empty.name, false],
    [effect.name, true],
    [empty.name, false],
  ]) {
    graph.resetFramePool();
    const env = frame(callback),
      evaluator = makeEvaluator(graph, { constants: {}, functions: {}, strictMembers: true });
    assert.equal(processSourceSites(graph, owner, { evaluator, env, targets: [site] }).has(site), expected);
  }
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1: reuse calculations, never an authorization result.
test("equivalent immutable argument frames share identity and cache nonempty evaluation", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: `
function first() {} function second(unrelated) {}
function factory(selection, ...callbacks) { return { selection, callbacks }; }
factory(first, first); factory(second, first);`,
  });
  const graph = buildFlowGraph(rootDir),
    evaluator = makeEvaluator(graph, { constants: {}, functions: {} }),
    source = graph.modules.get(file).sourceFile,
    calls = source.statements.filter(ts.isExpressionStatement).map((statement) => statement.expression),
    [fn] = evaluator.evaluate(calls[0].expression, new Map()),
    first = bindArguments(fn, calls[0].arguments, new Map()),
    again = bindArguments(fn, calls[0].arguments, new Map()),
    other = bindArguments(fn, calls[1].arguments, new Map()),
    body = fn.node.body.statements[0].expression;
  assert.ok(first === again, "same parameter/expression/rest bindings must intern to one Map");
  assert.ok(first !== other, "a different argument remains a different frame");
  assert.ok(graph.internEnv([...first].reverse()) === first, "binding order cannot create another frame");
  const values = evaluator.evaluate(body, first);
  assert.ok(values === evaluator.evaluate(body, again), "nonempty frames must hit the evaluation cache");
  const unrelated = source.statements[1].parameters[0],
    extra = new Map([...first, [unrelated, first.get(fn.node.parameters[0])]]);
  assert.ok(values === evaluator.evaluate(body, extra), "unrelated caller parameters cannot multiply a lexical query");
  assert.ok(values !== evaluator.evaluate(body, other));
  assert.equal(evaluator.evaluate(body, first, 13)[0].unknown, true, "a shallow result cannot extend the depth budget");
  assert.ok(
    bindArguments({ node: fn.node, env: new Map() }, [], new Map()) ===
      bindArguments({ node: fn.node, env: new Map() }, [], new Map()),
    "empty frames share one identity",
  );
});

test("forwarded parameter aliases retain one immutable argument frame", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: `function take(value) { return value; }
function forward(value) { return take(value); }
const first = "first", second = "second";`,
  });
  const graph = buildFlowGraph(rootDir),
    [take, forward, declaration] = graph.modules.get(file).sourceFile.statements,
    [first, second] = declaration.declarationList.declarations,
    empty = new Map(),
    fn = { node: take, env: empty },
    direct = bindArguments(fn, [first.initializer], empty),
    caller = bindArguments({ node: forward, env: empty }, [first.initializer], empty),
    forwarded = bindArguments(fn, forward.body.statements[0].expression.arguments, caller);
  assert.ok(direct === forwarded, "forwarding an immutable parameter must not grow the environment chain");
  assert.ok(direct === bindArguments(fn, [first.initializer], caller), "a literal has no caller environment");
  assert.ok(
    direct !== bindArguments(fn, [second.initializer], empty),
    "different callbacks/data keep different frames",
  );
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1: repeated receiver projections on the
// same argument DAG must not expand both unknown choices again at each use.
test("shared object choices keep lexical lookup work linear in the argument chain", () => {
  function lookupWork(length) {
    const file = "packages/daemon/src/callback.ts";
    const { rootDir } = makeRepo({
      [file]: `function choose(value) { return unknown ? value : value; }
function entry() {
  const a0 = { method: "demo" };
${Array.from({ length }, (_, index) => `  const a${index + 1} = choose(a${index});`).join("\n")}
  return a${length}.method;
}`,
    });
    const graph = buildFlowGraph(rootDir);
    const entry = graph.modules.get(file).sourceFile.statements[1];
    let lookups = 0;
    const evaluator = makeEvaluator(
      {
        ...graph,
        lookup(...args) {
          lookups++;
          return graph.lookup(...args);
        },
      },
      { constants: {}, functions: {} },
    );
    assert.deepEqual(evaluator.fold(entry.body.statements.at(-1).expression, new Map()), { value: "demo" });
    return lookups;
  }
  const single = lookupWork(1),
    triple = lookupWork(3);
  assert.ok(triple <= single * 3, `three shared calls took ${triple} lookups versus one call's ${single}`);
});

test("folded object projections retain their argument frame and remaining depth", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: `function entry(value) { return value.kind; }
const first = { kind: "selected" }, second = { kind: "other" };`,
  });
  const graph = buildFlowGraph(rootDir);
  const [entry, values] = graph.modules.get(file).sourceFile.statements;
  const expression = entry.body.statements[0].expression;
  const frames = values.declarationList.declarations.map((declaration) =>
    bindArguments({ node: entry, env: new Map() }, [declaration.initializer], new Map()),
  );
  const evaluator = makeEvaluator(graph, { constants: {}, functions: {} });
  assert.equal(evaluator.fold(expression, frames[0], 12), null);
  assert.deepEqual(evaluator.fold(expression, frames[0]), { value: "selected" });
  assert.deepEqual(evaluator.fold(expression, frames[1]), { value: "other" });
});

test("the policy walk proves its exact callback without a second source walk and still challenges bypasses", () => {
  function run(bypass, target) {
    const file = "packages/daemon/src/callback.ts";
    const { rootDir } = makeRepo({
      [file]: `const store = { append(value) {} };
function invoke(execute) { execute(); }
function unrelated() {}
function entry(request) {
  const callback = () => {
    if (false) store.append("unreachable");
    store.append("target");
    unrelated();
  };
  ${bypass ? "invoke(callback);" : ""}
  if (request.transportKind !== "unix-socket") return;
  invoke(callback);
}`,
    });
    const graph = buildFlowGraph(rootDir);
    const entry = graph.modules.get(file).sourceFile.statements.at(-1);
    let call,
      expansions = 0;
    (function visit(node) {
      if (ts.isCallExpression(node) && node.arguments[0]?.text === target) call = node;
      ts.forEachChild(node, visit);
    })(entry);
    assert.ok(call);
    const sourceGraph = {
      ...graph,
      lookup(name, node) {
        if (name === "unrelated") expansions++;
        return graph.lookup(name, node);
      },
    };
    const site = sourceSite(graph, call);
    const result = makeAuthorizationTracer(authorizationPolicyGraph(graph), {
      sourceGraph,
      ports: [],
      entries: [entry],
      constants: {},
      functions: {},
    })
      .traceDescriptor({
        method: "demo",
        kind: "demo",
        commandClass: "repo-write",
        localTransport: true,
        sources: [{ id: "effect", site }],
      })
      .sources.get(site);
    return { result, expansions };
  }
  const guarded = run(false, "target");
  assert.equal(guarded.result.seen && guarded.result.ok, true);
  assert.equal(guarded.expansions, 0, "the actual policy callback supplies this source certificate");
  const bypassed = run(true, "target").result;
  assert.equal(bypassed.seen && !bypassed.ok, true);
  assert.equal(run(false, "unreachable").result.seen, false);
});

function trace(handoff, invocation) {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: `const store = { append() {} };
${handoff}
function entry(request: { transportKind: string }) {
  if (request.transportKind !== "unix-socket") return;
  ${invocation}
}`,
  });
  const graph = buildFlowGraph(rootDir);
  const source = graph.modules.get(file).sourceFile;
  const entry = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === "entry");
  let effect;
  (function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText() === "store.append") effect = node;
    ts.forEachChild(node, visit);
  })(source);
  assert.ok(effect);
  return makeAuthorizationTracer(graph, { ports: [], entries: [entry], constants: {}, functions: {} })
    .traceDescriptor({
      method: "demo",
      kind: "demo",
      commandClass: "repo-write",
      localTransport: true,
      sources: [{ id: "effect", site: sourceSite(graph, effect) }],
    })
    .sources.get(sourceSite(graph, effect));
}

function traceQueuedReentry(invocation, recursive = false) {
  const file = "packages/daemon/src/reentry.ts";
  const { rootDir } = makeRepo({
    [file]: `const store = { append() {} };
function effect() { store.append(); }
function entry(request: { transportKind: string }) {
function queue(request, phase, callback) {
  if (phase === "write") {
    if (request.transportKind !== "unix-socket") return;
    callback();
  } else ${recursive ? "queue(request, phase, callback)" : "callback()"};
}
${invocation}
}`,
  });
  const graph = buildFlowGraph(rootDir),
    statements = graph.modules.get(file).sourceFile.statements,
    site = sourceSite(graph, statements[1].body.statements[0].expression);
  let phaseLookups = 0;
  const traced = {
    ...graph,
    lookup(name, node) {
      if (name === "phase" && ts.isBinaryExpression(node.parent)) phaseLookups++;
      return graph.lookup(name, node);
    },
  };
  const result = makeAuthorizationTracer(traced, {
    ports: [],
    entries: [statements.at(-1)],
    constants: {},
    functions: {},
  })
    .traceDescriptor({
      method: "demo",
      kind: "demo",
      commandClass: "repo-write",
      localTransport: true,
      sources: [{ id: "effect", site }],
    })
    .sources.get(site);
  return { ...result, phaseLookups };
}

// CH1: preparation may re-enter the queue with another callback. Only the actual
// write frame's denial exit certifies that callback; an active function alone is no cycle.
test("a new queued callback frame can acquire its own authority", () => {
  const result = traceQueuedReentry('queue(request, "prepare", () => queue(request, "write", effect));');
  assert.equal(result.seen && result.ok, true);
});

test("a replaced queued callback does not certify the unused source", () => {
  const result = traceQueuedReentry('queue(request, "prepare", () => queue(request, "write", () => {}));');
  assert.equal(result.seen, false);
});

test("an unguarded queue frame still rejects a source certified by a reentrant queue", () => {
  const result = traceQueuedReentry(
    'queue(request, "prepare", () => queue(request, "write", effect)); queue(request, "prepare", effect);',
  );
  assert.equal(result.seen, true);
  assert.equal(result.ok, false);
});

test("the same recursive queue frame terminates without certifying an uncalled source", () => {
  const result = traceQueuedReentry('queue(request, "prepare", effect);', true);
  assert.equal(result.seen, false);
  assert.ok(result.phaseLookups <= 8, `same queue frame expanded ${result.phaseLookups} phase lookups`);
});

function tracePackageBridge({ detached = false, bypass = false } = {}) {
  const file = "packages/daemon/src/bridge-callback.ts";
  const { rootDir } = makeRepo({
    "packages/storage/src/bridge.ts": `import { effect } from "../../daemon/src/bridge-callback.ts";
export function invoke(request, callback) { callback(); ${bypass ? "effect(request);" : ""} }`,
    [file]: `import { invoke } from "../../storage/src/bridge.ts";
const store = { append() {} };
export function effect(request) { store.append(); }
function entry(request: { transportKind: string }) {
  invoke(request, () => {
    if (request.transportKind !== "unix-socket") return;
    ${detached ? "" : "effect(request);"}
  });
}`,
  });
  const graph = buildFlowGraph(rootDir),
    statements = graph.modules.get(file).sourceFile.statements,
    site = sourceSite(graph, statements[2].body.statements[0].expression);
  return makeAuthorizationTracer(graph, { ports: [], entries: [statements.at(-1)], constants: {}, functions: {} })
    .traceDescriptor({
      method: "demo",
      kind: "demo",
      commandClass: "repo-write",
      localTransport: true,
      sources: [{ id: "effect", site }],
    })
    .sources.get(site);
}

// dec_7E44897ECDCAEF2B92EC66A260/CH1: a package boundary can invoke daemon
// callbacks that establish their own authority. Reachability alone cannot judge that path.
test("a package callback's own denial exit certifies its actual effect", () => {
  const result = tracePackageBridge();
  assert.equal(result.seen && result.ok, true);
});

test("a package bridge cannot borrow its guarded callback's authority for another call", () => {
  const result = tracePackageBridge({ bypass: true });
  assert.equal(result.seen, true);
  assert.equal(result.ok, false);
});

test("a package bridge with a detached callback does not reach the effect", () => {
  assert.equal(tracePackageBridge({ detached: true }).seen, false);
});

function traceReusedForwarder(invocation) {
  const file = "packages/daemon/src/forwarder.ts";
  const { rootDir } = makeRepo({
    [file]: `const store = { append() {} };
function effect(request) { store.append(); }
function invoke(execute) { execute(); }
function queue(work) { invoke(() => work()); }
function forward(work) { queue(work); }
function entry(request: { transportKind: string }) {
  const guarded = () => {
    if (request.transportKind !== "unix-socket") return;
    effect(request);
  };
  ${invocation}
}`,
  });
  const graph = buildFlowGraph(rootDir),
    statements = graph.modules.get(file).sourceFile.statements,
    site = sourceSite(graph, statements[1].body.statements[0].expression);
  return makeAuthorizationTracer(graph, { ports: [], entries: [statements.at(-1)], constants: {}, functions: {} })
    .traceDescriptor({
      method: "demo",
      kind: "demo",
      commandClass: "repo-write",
      localTransport: true,
      sources: [{ id: "effect", site }],
    })
    .sources.get(site);
}

// The queue expression is reused, but its forwarded callback is a different value.
// Both cache reuse and cycle detection must retain the original caller's binding.
test("a reused forwarder still invokes its later guarded callback", () => {
  const result = traceReusedForwarder("forward(() => {}); forward(guarded);");
  assert.equal(result.seen && result.ok, true);
});

test("a reused forwarder cannot reuse another caller's authorization", () => {
  const result = traceReusedForwarder("forward(guarded); forward(() => effect(request));");
  assert.equal(result.seen, true);
  assert.equal(result.ok, false);
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1: a passed callback supplies source evidence only
// when invocation preserves its actual argument frame, including rest/spread forwarding.
test("an invoked ordinary object callback retains local authority", () => {
  const result = trace(
    "function dispatch(callbacks) { callbacks.todo(); }",
    "dispatch({ todo: () => store.append() });",
  );
  assert.equal(result.seen && result.ok, true);
});

test("an invoked callback selected by a known computed key retains local authority", () => {
  const result = trace(
    "function dispatch(key, callbacks) { callbacks[key](); }",
    'dispatch("todo", { todo: () => store.append() });',
  );
  assert.equal(result.seen && result.ok, true);
});

test("a callback selected through a dynamic nested key remains reachable", () => {
  const result = trace(
    `function dispatch(key, runtimes) {
  const implementation = runtimes.entity?.[key];
  implementation();
}`,
    'dispatch("todo", { entity: { todo: () => store.append() } });',
  );
  assert.equal(result.seen && result.ok, true);
});

test("policy dispatch needs a known key and source reachability retains authored alternatives", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: `const callbacks = { selected() {}, alternate() {} };
function entry(key: string) { callbacks[key](); }`,
  });
  const graph = buildFlowGraph(rootDir);
  const source = graph.modules.get(file).sourceFile;
  const entry = source.statements.at(-1);
  const callee = entry.body.statements[0].expression.expression;
  const env = bindArguments({ node: entry, env: new Map() }, [], new Map());
  const facts = { constants: {}, functions: {} };
  assert.equal(
    makeEvaluator(graph, facts)
      .evaluate(callee, env)
      .some((value) => value.fn),
    false,
  );
  assert.equal(
    makeEvaluator(graph, { ...facts, strictMembers: true })
      .evaluate(callee, env)
      .filter((value) => value.fn).length,
    2,
  );
});

test("rest/spread forwarding preserves the callback argument frame", () => {
  const result = trace(
    `function dispatch(callbacks) { callbacks.todo(); }
const bind = (implementation) => (...args) => implementation(...args);
const run = bind(dispatch);`,
    "run({ todo: () => store.append() });",
  );
  assert.equal(result.seen && result.ok, true);
});

test("passing an uninvoked callback supplies no source evidence", () => {
  const result = trace("function dispatch(callbacks) {}", "dispatch({ todo: () => store.append() });");
  assert.equal(result.seen, false);
});

test("a known callback key does not invoke another authored member", () => {
  const result = trace(
    "function dispatch(callbacks) { callbacks.selected(); }",
    "dispatch({ selected: () => {}, unused: () => store.append() });",
  );
  assert.equal(result.seen, false);
});

// The target sits in the helper called by the callback, outside the callback's own AST range.
test("targeted source reachability follows a callback through an uncertain branch and a helper", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: `function effect() { store.append(); }
function select(input) { return input.enabled; }
function dispatch(callbacks, input) { if (select(input)) callbacks.todo(); }
function entry() { dispatch({ todo: () => effect() }, unknownInput); }`,
  });
  const graph = buildFlowGraph(rootDir);
  const source = graph.modules.get(file).sourceFile;
  const entry = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === "entry");
  const effect = source.statements[0].body.statements[0].expression;
  const site = sourceSite(graph, effect);
  assert.equal(processSourceSites(graph, entry, { targets: [site] }).has(site), true);
});

test("separate captured callback frames retain their separate source sites", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: `function invoke(callback) { callback(); }
function forward(callback) { invoke(callback); }
function bind(callback) { return () => forward(callback); }
function first() { store.append("first"); }
function second() { store.append("second"); }
function entry() { bind(first)(); bind(second)(); }`,
  });
  const graph = buildFlowGraph(rootDir);
  const source = graph.modules.get(file).sourceFile;
  const entry = source.statements.at(-1);
  const sites = source.statements
    .filter((node) => ts.isFunctionDeclaration(node) && ["first", "second"].includes(node.name?.text))
    .map((node) => sourceSite(graph, node.body.statements[0].expression));
  const reached = processSourceSites(graph, entry, { targets: sites });
  assert.deepEqual(
    sites.map((site) => reached.has(site)),
    [true, true],
  );
});

test("source proof does not reuse another caller's callback across a policy boundary", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: `import { invoke } from "../../kernel/src/domain/callback.ts";
const store = { append() {} };
function run(request, runtimes) {
  if (request.transportKind !== "unix-socket") return;
  invoke(runtimes);
}
function entry(request: { transportKind: string }) {
  run(request, { todo: () => {} });
  run(request, { todo: () => store.append() });
}`,
    "packages/kernel/src/domain/callback.ts": "export function invoke(runtimes) { runtimes.todo(); }",
  });
  const graph = buildFlowGraph(rootDir);
  const source = graph.modules.get(file).sourceFile;
  const entry = source.statements.at(-1);
  let effect;
  (function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText() === "store.append") effect = node;
    ts.forEachChild(node, visit);
  })(source);
  const site = sourceSite(graph, effect);
  const result = makeAuthorizationTracer(authorizationPolicyGraph(graph), {
    sourceGraph: graph,
    ports: [],
    entries: [entry],
    constants: {},
    functions: {},
  })
    .traceDescriptor({
      method: "demo",
      kind: "demo",
      commandClass: "repo-write",
      localTransport: true,
      sources: [{ id: "effect", site }],
    })
    .sources.get(site);
  assert.equal(result.seen && result.ok, true);
});

test("parameter forwarding does not spend the expression nesting budget", () => {
  const forwards = Array.from(
    { length: 20 },
    (_, index) =>
      `function forward${index}(callbacks) { ${index === 19 ? "callbacks.todo()" : `forward${index + 1}(callbacks)`}; }`,
  ).join("\n");
  const result = trace(forwards, "forward0({ todo: () => store.append() });");
  assert.equal(result.seen && result.ok, true);
});

test("a module-level callable keeps its lexical frame across unrelated callers", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: "const callback = () => 1; function entry(input) { return callback; }",
  });
  const graph = buildFlowGraph(rootDir);
  const entry = graph.modules.get(file).sourceFile.statements[1];
  const reference = entry.body.statements[0].expression;
  const evaluator = makeEvaluator(graph, { constants: {}, functions: {} });
  const first = evaluator.evaluate(reference, new Map([[entry.parameters[0], { root: true }]]))[0];
  const second = evaluator.evaluate(reference, new Map([[entry.parameters[0], { root: true }]]))[0];
  assert.strictEqual(first.env, second.env);
});

test("the real catalog executor reaches its bound todo runtime directly", async () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const inputs = await loadAuthorizationInputs(root);
  const action = inputs.constants.actionDeclarations.find((action) => action.kind === "todo-add");
  const source = action.ontology.sources.find((source) => source.role === "effect");
  const graph = buildFlowGraph(root);
  const factory = graph.modules
    .get("packages/application/src/commands/entity-action-catalog-executor.ts")
    .sourceFile.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === "makeEntityActionCatalogExecutor",
    );
  const run = factory.body.statements
    .filter(ts.isVariableStatement)
    .flatMap((node) => [...node.declarationList.declarations])
    .find((node) => node.name.getText() === "run").initializer;
  let runtimes;
  (function visit(node) {
    if (ts.isCallExpression(node) && node.arguments[3]?.getText().includes("runTodoAction(cell"))
      runtimes = node.arguments[3];
    ts.forEachChild(node, visit);
  })(graph.modules.get("packages/daemon/src/repo-cell-action-dispatch.ts").sourceFile);
  assert.ok(runtimes);
  const literals = ts.createSourceFile(
    "catalog-input.ts",
    'const action = { kind: "todo-add" }; const binding = {}; const opId = "test";',
    ts.ScriptTarget.Latest,
    true,
  );
  const args = literals.statements.map((node) => node.declarationList.declarations[0].initializer);
  const env = bindArguments({ node: run, env: new Map() }, [...args, runtimes], new Map());
  const evaluator = makeEvaluator(graph, {
    kind: "todo-add",
    constants: inputs.constants,
    functions: inputs.functions,
    authorityModule: "@harness-anything/kernel",
    strictMembers: true,
  });
  let targetKind;
  (function visit(node) {
    if (!targetKind && ts.isPropertyAccessExpression(node) && node.getText() === "contract.target.kind")
      targetKind = node;
    ts.forEachChild(node, visit);
  })(run.body);
  assert.deepEqual(
    evaluator.fold(targetKind, env),
    { value: "todo" },
    "catalog dispatch must retain the registry target coordinate",
  );
  const witness = sourceWitnesses(graph, [source]).get(source.candidateId);
  const site = sourceSite(graph, witness);
  const sites = processSourceSites(graph, run, { evaluator, env, targets: [site] });
  assert.equal(sites.has(site), true);
  const caller = graph.modules
    .get("packages/daemon/src/repo-cell-action-dispatch.ts")
    .sourceFile.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "executeRepoAction");
  const callerEnv = bindArguments({ node: caller, env: new Map() }, [args[1], args[0], args[1]], new Map());
  assert.equal(
    processSourceSites(graph, caller, { evaluator, env: callerEnv, targets: [site] }).has(site),
    true,
    "the typed catalog caller must preserve its authored todo callback",
  );
});

test("a depth-limited expression does not poison a later shallow query", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: "const callbacks = { todo: () => 1 }; function entry() { return callbacks.todo; }",
  });
  const graph = buildFlowGraph(rootDir);
  const entry = graph.modules.get(file).sourceFile.statements[1];
  const reference = entry.body.statements[0].expression;
  const evaluator = makeEvaluator(graph, { constants: {}, functions: {} });
  assert.equal(
    evaluator.evaluate(reference, new Map(), 12).some((value) => value.fn),
    false,
  );
  assert.equal(
    evaluator.evaluate(reference, new Map()).some((value) => value.fn),
    true,
  );
});

test("a depth-limited typed member does not poison another caller", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: `interface Handler { run(): void }
const wrap = (fn) => () => fn();
const implementation: Handler = { run: wrap(() => {}) };
function entry(api: Handler) { api.run(); }`,
  });
  const graph = buildFlowGraph(rootDir);
  const entry = graph.modules.get(file).sourceFile.statements.at(-1);
  const callee = entry.body.statements[0].expression.expression;
  const facts = { constants: {}, functions: {} };
  const frame = () => new Map([[entry.parameters[0], { root: true }]]);
  assert.equal(
    makeEvaluator(graph, facts)
      .evaluate(callee, frame())
      .some((value) => value.fn),
    true,
  );
  const evaluator = makeEvaluator(graph, facts);
  assert.equal(
    evaluator.evaluate(callee, frame(), 12).some((value) => value.fn),
    false,
  );
  assert.equal(
    evaluator.evaluate(callee, frame()).some((value) => value.fn),
    true,
  );
});

test("a depth-limited provenance query does not poison later request provenance", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: "function entry(request) { const forwarded = request; return forwarded; }",
  });
  const graph = buildFlowGraph(rootDir);
  const entry = graph.modules.get(file).sourceFile.statements[0];
  const reference = entry.body.statements[1].expression;
  const env = new Map([[entry.parameters[0], { root: true }]]);
  const evaluator = makeEvaluator(graph, { constants: {}, functions: {} });
  assert.equal(evaluator.provenance(reference, env, 64), null);
  assert.equal(evaluator.provenance(reference, env), "request");
});

test("a contract target kind cannot borrow the request action kind", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: `
function entry(request) {
  const action = decode(request.params);
  const contract = declaration(action.kind);
  const resolution = resolve(request.params);
  return [action.kind, contract.target.kind, resolution.action.kind];
}`,
  });
  const graph = buildFlowGraph(rootDir);
  const entry = graph.modules.get(file).sourceFile.statements[0];
  const expressions = entry.body.statements.at(-1).expression.elements;
  const evaluator = makeEvaluator(graph, { kind: "todo-add", constants: {}, functions: {} });
  const env = new Map([[entry.parameters[0], { root: true }]]);
  assert.deepEqual(evaluator.fold(expressions[0], env), { value: "todo-add" });
  assert.equal(evaluator.fold(expressions[1], env), null);
  assert.deepEqual(evaluator.fold(expressions[2], env), { value: "todo-add" });
});

test("a request-derived contract key reaches only its authored runtime callbacks", () => {
  const result = trace(
    `
function declaration(kind) { return lookup(kind); }
function dispatch(action, runtimes) {
  const contract = declaration(action.kind);
  runtimes[contract.target.kind]();
}`,
    "dispatch(decode(request.params), { todo: () => store.append() });",
  );
  assert.equal(result.seen && result.ok, true);
});

test("a rejected source stays rejected while later independent sources are still proved", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: `import { invoke } from "../../kernel/src/domain/callback.ts";
function first() { store.append("first"); }
function second() { store.append("second"); }
function entry(request) {
  invoke({ execute: first });
  if (request.transportKind !== "unix-socket") return;
  invoke({ execute: first });
  invoke({ execute: second });
}`,
    "packages/kernel/src/domain/callback.ts": "export function invoke(callbacks) { callbacks.execute(); }",
  });
  const graph = buildFlowGraph(rootDir);
  const nodes = graph.modules.get(file).sourceFile.statements;
  const sources = [nodes[1], nodes[2]].map((fn) => ({
    id: fn.name.text,
    site: sourceSite(graph, fn.body.statements[0].expression),
  }));
  const result = makeAuthorizationTracer(authorizationPolicyGraph(graph), {
    sourceGraph: graph,
    ports: [],
    entries: [nodes[3]],
    constants: {},
    functions: {},
  }).traceDescriptor({ method: "demo", kind: "demo", commandClass: "repo-write", localTransport: true, sources });
  const first = result.sources.get(sources[0].site),
    second = result.sources.get(sources[1].site);
  assert.equal(first.seen && !first.ok, true);
  assert.equal(second.seen && second.ok, true);
  assert.equal(first.evidence.length, 1, "an irreversible rejection needs no later authorized reproof");
});

test("an unguarded caller still challenges a source already proved under authority", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: `import { invoke } from "../../kernel/src/domain/callback.ts";
function effect() { store.append(); }
function guarded(request) {
  if (request.transportKind !== "unix-socket") return;
  invoke({ execute: effect });
}
function unguarded(request) { invoke({ execute: effect }); }`,
    "packages/kernel/src/domain/callback.ts": "export function invoke(callbacks) { callbacks.execute(); }",
  });
  const graph = buildFlowGraph(rootDir),
    nodes = graph.modules.get(file).sourceFile.statements;
  const site = sourceSite(graph, nodes[1].body.statements[0].expression);
  const result = makeAuthorizationTracer(authorizationPolicyGraph(graph), {
    sourceGraph: graph,
    ports: [],
    entries: [nodes[2], nodes[3]],
    constants: {},
    functions: {},
  })
    .traceDescriptor({
      method: "demo",
      kind: "demo",
      commandClass: "repo-write",
      localTransport: true,
      sources: [{ id: "effect", site }],
    })
    .sources.get(site);
  assert.equal(result.seen && !result.ok, true);
  assert.ok(result.evidence.some((entry) => entry.includes("unguarded call")));
});

test("an ownerless callback has no source authority", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: `import { invoke } from "../../kernel/src/domain/callback.ts";
function effect() { store.append(); }
function entry(request) { invoke({ execute: effect }); }`,
    "packages/kernel/src/domain/callback.ts": "export function invoke(callbacks) { callbacks.execute(); }",
  });
  const graph = buildFlowGraph(rootDir),
    nodes = graph.modules.get(file).sourceFile.statements;
  const site = sourceSite(graph, nodes[1].body.statements[0].expression);
  const result = makeAuthorizationTracer(authorizationPolicyGraph(graph), {
    sourceGraph: graph,
    ports: [],
    entries: [nodes[2]],
    constants: {},
    functions: {},
  })
    .traceDescriptor({
      method: "demo",
      kind: "demo",
      commandClass: "repo-write",
      localTransport: true,
      sources: [{ id: "effect", site }],
    })
    .sources.get(site);
  assert.equal(result.seen && result.ok, false);
});

test("constructing another tracer does not replace the first graph's locations", () => {
  const file = "packages/daemon/src/callback.ts";
  function create(label) {
    const { rootDir } = makeRepo({
      [file]: `function dispatch() {}
function entry(request) {
  if (request.transportKind !== "unix-socket") return;
  dispatch();
}`,
    });
    const original = buildFlowGraph(rootDir),
      graph = { ...original, fileOf: () => label };
    const entry = original.modules.get(file).sourceFile.statements[1];
    return makeAuthorizationTracer(graph, { ports: [], entries: [entry], constants: {}, functions: {} });
  }
  const first = create("first-graph.ts");
  create("second-graph.ts");
  const result = first.traceDescriptor({
    method: "demo",
    kind: "demo",
    commandClass: "repo-write",
    localTransport: true,
  });
  assert.ok(result.local.length > 0);
  assert.ok(
    result.local.every((entry) => entry.startsWith("first-graph.ts:")),
    result.local.join("; "),
  );
});

// CH1: a dispatch may re-enter the same function with a different action/callback frame.
// Only repeated frames are cycles; the function declaration alone is not the cycle identity.
test("source reachability re-enters a function with a new argument binding", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: `function effect() { store.append(); }
function dispatch(callback, ready) { if (ready) callback(); else dispatch(callback, true); }
function entry() { dispatch(effect, false); }`,
  });
  const graph = buildFlowGraph(rootDir),
    nodes = graph.modules.get(file).sourceFile.statements;
  const site = sourceSite(graph, nodes[0].body.statements[0].expression);
  assert.equal(processSourceSites(graph, nodes[2], { targets: [site] }).has(site), true);
});

test("a recursive frame that never invokes its callback leaves the source detached", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: `function effect() { store.append(); }
function dispatch(callback) { dispatch(callback); }
function entry() { dispatch(effect); }`,
  });
  const graph = buildFlowGraph(rootDir),
    nodes = graph.modules.get(file).sourceFile.statements;
  const site = sourceSite(graph, nodes[0].body.statements[0].expression);
  assert.equal(processSourceSites(graph, nodes[2], { targets: [site] }).has(site), false);
});

test("recursive callback replacement does not invoke the original callback", () => {
  const file = "packages/daemon/src/callback.ts";
  const { rootDir } = makeRepo({
    [file]: `function effect() { store.append(); }
function dispatch(callback, ready) { if (ready) callback(); else dispatch(() => {}, true); }
function entry() { dispatch(effect, false); }`,
  });
  const graph = buildFlowGraph(rootDir),
    nodes = graph.modules.get(file).sourceFile.statements;
  const site = sourceSite(graph, nodes[0].body.statements[0].expression);
  assert.equal(processSourceSites(graph, nodes[2], { targets: [site] }).has(site), false);
});

function sourceChoice(operator, argument, mutation = "") {
  const file = "packages/daemon/src/coalescing.ts";
  const { rootDir } = makeRepo({
    [file]: `const store={append(value){}};
function chosen(){store.append("chosen");}
function fallback(){store.append("fallback");}
function invoke(provided){${mutation} const port=provided ${operator} {run:fallback};port.run();}
function forward(value){invoke(value);}
function entry(){forward(${argument});}`,
  });
  const graph = buildFlowGraph(rootDir),
    sf = graph.modules.get(file).sourceFile;
  const sites = new Map();
  (function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText() === "store.append")
      sites.set(node.arguments[0].text, sourceSite(graph, node));
    ts.forEachChild(node, visit);
  })(sf);
  const found = processSourceSites(graph, sf.statements.at(-1), { targets: [...sites.values()] });
  return Object.fromEntries([...sites].map(([name, site]) => [name, found.has(site)]));
}
// dec_7E44897ECDCAEF2B92EC66A260/CH1: a known injected port excludes its unused ambient fallback.
test("known supplied object ports do not invoke a coalescing fallback", () => {
  for (const operator of ["??", "||"])
    assert.deepEqual(sourceChoice(operator, "{run:chosen}"), { chosen: true, fallback: false }, operator);
});
test("null and unknown supplied ports retain their possible fallback", () => {
  for (const operator of ["??", "||"]) {
    assert.deepEqual(sourceChoice(operator, "null"), { chosen: false, fallback: true }, operator);
    assert.equal(sourceChoice(operator, "unknown").fallback, true, operator);
  }
});

test("reassignment forms retain a possible fallback without confusing shadowed bindings", () => {
  for (const operator of ["??", "||"]) {
    for (const mutation of [
      "provided=null;",
      "provided &&= null;",
      "[provided]=[null];",
      "({value:provided}={value:null});",
      "for(provided of [null]){}",
    ])
      assert.equal(sourceChoice(operator, "{run:chosen}", mutation).fallback, true, operator + mutation);
    assert.equal(sourceChoice(operator, "true", "provided=null;").fallback, true, operator);
    assert.equal(sourceChoice(operator, "{run:chosen}", "{let provided;provided=null;}").fallback, false, operator);
  }
  assert.equal(sourceChoice("||", "{run:chosen}", "provided++;").fallback, true);
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1: known symbol identities cannot borrow writer callbacks.
function traceSymbolCallback(invocation, { alias = false, separate = false } = {}) {
  const file = "packages/daemon/src/symbol-callback.ts";
  const { rootDir } = makeRepo({
    "packages/daemon/src/symbols.ts": 'export const read = Symbol("read"); export const write = Symbol("write");',
    "packages/daemon/src/other-symbols.ts": 'export const read = Symbol("read");',
    [file]: `import { read${alias ? " as query" : ""}, write } from "./symbols.ts";
import { read as otherRead } from "./other-symbols.ts";
const store = { append() {} };
const callbacks = { [${alias ? "query" : "read"}]: () => {}, [${separate ? "otherRead" : "write"}]: () => store.append() };
function entry(request: { transportKind: string }, unknownKey: symbol) {
  if (request.transportKind !== "unix-socket") return;
  ${invocation}
}`,
  });
  const graph = buildFlowGraph(rootDir),
    source = graph.modules.get(file).sourceFile;
  let effect;
  (function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText() === "store.append") effect = node;
    ts.forEachChild(node, visit);
  })(source);
  const site = sourceSite(graph, effect);
  return makeAuthorizationTracer(graph, {
    ports: [],
    entries: [source.statements.at(-1)],
    constants: {},
    functions: {},
  })
    .traceDescriptor({
      method: "demo",
      kind: "demo",
      commandClass: "repo-write",
      localTransport: true,
      sources: [{ id: "effect", site }],
    })
    .sources.get(site);
}

// CH1: query-only APIs use an imported unique symbol. Treating that known key as
// arbitrary also invokes every writer member and invents an owner/authority chain.
test("a unique read symbol does not invoke an unrelated writer member", () => {
  assert.equal(traceSymbolCallback("callbacks[read]();").seen, false);
});

test("the selected unique writer symbol reaches its actual source", () => {
  const result = traceSymbolCallback("callbacks[write]();");
  assert.equal(result.seen && result.ok, true);
});

test("an imported symbol alias retains its original member identity", () => {
  assert.equal(traceSymbolCallback("callbacks[query]();", { alias: true }).seen, false);
});

test("same-named symbols from separate modules cannot borrow each other's callbacks", () => {
  assert.equal(traceSymbolCallback("callbacks[read]();", { separate: true }).seen, false);
});

test("an unknown symbol keeps every possible callback live", () => {
  const result = traceSymbolCallback("callbacks[unknownKey]();");
  assert.equal(result.seen && result.ok, true);
});

// CH1: a full source graph must not turn a bounded policy walk into a bypass exemption.
test("a deep package callback still challenges a source certified by a shallow guarded call", () => {
  const file = "packages/daemon/src/entry.ts",
    bridge = "packages/storage/src/bridge.ts",
    { rootDir } = makeRepo({
      [bridge]: Array.from(
        { length: 72 },
        (_, index) => `export function hop${index}(work) { ${index === 71 ? "work()" : `hop${index + 1}(work)`}; }`,
      ).join("\n"),
      [file]: `import { hop0 } from "../../storage/src/bridge.ts";
const store = { append() {} };
function effect() { store.append(); }
function entry(request) {
  hop0(effect);
  if (request.transportKind !== "unix-socket") return;
  effect();
}`,
    }),
    graph = buildFlowGraph(rootDir),
    statements = graph.modules.get(file).sourceFile.statements,
    entry = statements.at(-1),
    effect = statements.at(-2),
    call = effect.body.statements[0].expression,
    site = sourceSite(graph, call),
    result = makeAuthorizationTracer(graph, {
      sourceGraph: graph,
      ports: [],
      entries: [entry],
      constants: {},
      functions: {},
    }).traceDescriptor({
      method: "demo",
      kind: "demo",
      commandClass: "repo-write",
      localTransport: true,
      sources: [{ id: "append", site }],
    });
  assert.equal(result.sources.get(site).seen, true);
  assert.equal(result.sources.get(site).ok, false);
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1: decided conditionals, 0-arg IIFEs, and pure multi-statement
// bodies fold through action guards without retaining stale closure frames.
test("provenance folds decided conditionals and 0-arg IIFE return spreads while keeping unspread objects non-action", () => {
  const file = "packages/daemon/src/provenance-iife.ts",
    { rootDir } = makeRepo({
      [file]: `declare function makeAction(req: { kind: string }): { kind: string; executionId?: string };
function readExternal(action: { kind: string; executionId?: string }, flag: boolean) {
  const selected = action.kind === "settings-update" ? action : { other: true };
  const rebuilt = action.kind === "task-start" ? (() => { const extra = "e1"; return { ...action, executionId: extra }; })() : action;
  const unguarded = flag ? (() => ({ ...action, executionId: "e2" }))() : action;
  const plain = (() => ({ kind: action.kind }))();
  return { selected, rebuilt, unguarded, plain };
}
function entry(request: { kind: string }, flag: boolean) {
  const action = makeAction(request);
  return readExternal(action, flag);
}`,
    }),
    graph = buildFlowGraph(rootDir),
    [, helperFn, entryFn] = graph.modules.get(file).sourceFile.statements,
    entryCall = entryFn.body.statements[1].expression,
    entryEnv = bindArguments({ node: entryFn, env: EMPTY_ENV }, [{ flowArgument: true, root: true }], EMPTY_ENV),
    helperEnv = bindArguments({ node: helperFn, env: EMPTY_ENV }, entryCall.arguments, entryEnv),
    inits = helperFn.body.statements.slice(0, 4).map((stmt) => stmt.declarationList.declarations[0].initializer),
    settingsEval = makeEvaluator(graph, {
      kind: "settings-update",
      commandClass: "repo-write",
      constants: {},
      functions: {},
      strictMembers: true,
    }),
    startEval = makeEvaluator(graph, {
      kind: "task-start",
      commandClass: "repo-write",
      constants: {},
      functions: {},
      strictMembers: true,
    });
  assert.equal(settingsEval.provenance(inits[0], helperEnv), "action");
  assert.equal(startEval.provenance(inits[0], helperEnv), null);
  assert.equal(startEval.provenance(inits[1], helperEnv), "action");
  assert.equal(startEval.provenance(inits[2], helperEnv), "action");
  assert.notEqual(settingsEval.provenance(inits[3], helperEnv), "action");
});

test("foldCall folds pure multi-statement const/if/return guards and leaves undecided or impure bodies open", () => {
  const file = "packages/daemon/src/fold-statements.ts",
    { rootDir } = makeRepo({
      [file]: `declare function makeAction(req: { kind: string }): { kind: string; executionId?: string };
function makeWork() { return Promise.resolve(); }
function prepareStart(action: { kind: string }, source: unknown) {
  if (source !== "local" || action.kind !== "task-start") return null;
  const tag = "work";
  return makeWork();
}
function readExternal(action: { kind: string }, source: unknown) {
  if (action.kind === "task-submit" || action.kind === "task-settle") return makeWork();
  const startAction = action.kind === "task-start" ? (() => ({ ...action, started: true }))() : action;
  const started = prepareStart(startAction, source);
  if (started) return started;
  if (action.kind === "task-push") return makeWork();
  return null;
}
function impureOrMutable(action: { kind: string }) {
  let result: unknown = null;
  if (action.kind === "settings-update") return result;
  return null;
}
function entry(request: { kind: string }, source: unknown) {
  const action = makeAction(request);
  return readExternal(action, source);
}
function entryMutable(request: { kind: string }) {
  const action = makeAction(request);
  return impureOrMutable(action);
}`,
    }),
    graph = buildFlowGraph(rootDir),
    statements = graph.modules.get(file).sourceFile.statements,
    entryFn = statements[5],
    entryMutableFn = statements[6],
    entryEnv = bindArguments({ node: entryFn, env: EMPTY_ENV }, [{ flowArgument: true, root: true }], EMPTY_ENV),
    externalCall = entryFn.body.statements[1].expression,
    mutableCall = entryMutableFn.body.statements[1].expression,
    mutableEnv = bindArguments(
      { node: entryMutableFn, env: EMPTY_ENV },
      [{ flowArgument: true, root: true }],
      EMPTY_ENV,
    ),
    evalFor = (kind) =>
      makeEvaluator(graph, {
        kind,
        commandClass: "repo-write",
        constants: {},
        functions: {},
        strictMembers: true,
      });
  assert.deepEqual(evalFor("settings-update").fold(externalCall, entryEnv), { value: null });
  assert.equal(evalFor("task-start").fold(externalCall, entryEnv), null);
  assert.equal(evalFor("task-submit").fold(externalCall, entryEnv), null);
  assert.equal(evalFor("settings-update").fold(mutableCall, mutableEnv), null);
});

test("shared empty-env evaluator caches isolate descriptor kind, method, fields, commandClass, and unset depths", () => {
  const file = "packages/daemon/src/fact-isolation.ts",
    { rootDir } = makeRepo({
      [file]: `
declare function decode(params: unknown): { kind: string; scope?: string; extra?: string };
declare const unknownTarget: { dryRun?: boolean; commandClass?: string };
function makeActionReader(req: { method: string; scope?: string; extra?: string }) {
  return () => decode(req).kind;
}
function entry(request: { method: string; scope?: string; extra?: string }) {
  const action = decode(request);
  const readKind = makeActionReader(request);
  return [
    action.kind + ":" + request.method + ":" + request.scope,
    request.extra,
    readKind(),
    unknownTarget.dryRun,
    unknownTarget.commandClass,
  ];
}`,
    }),
    graph = buildFlowGraph(rootDir),
    sourceFile = graph.modules.get(file).sourceFile,
    entryFn = sourceFile.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === "entry"),
    elements = entryFn.body.statements.at(-1).expression.elements,
    [summarizeExpr, readExtraExpr, readKindCallExpr, dryRunExpr, commandClassExpr] = elements,
    reqEnv = new Map([[entryFn.parameters[0], { root: true }]]),
    shared = { constants: {}, functions: {}, commandClass: "repo-write", strictMembers: true },
    evalA = makeEvaluator(graph, {
      ...shared,
      kind: "action-a",
      method: "route.a",
      fields: { scope: "alpha" },
    }),
    evalWithRepoRead = makeEvaluator(graph, {
      ...shared,
      kind: "action-a",
      method: "route.a",
      fields: { scope: "alpha" },
      commandClass: "repo-read",
    }),
    evalB = makeEvaluator(graph, {
      ...shared,
      kind: "action-b",
      method: "route.b",
      fields: { scope: "beta" },
    }),
    evalNoKind = makeEvaluator(graph, { ...shared, method: "route.c", fields: { scope: "gamma" } }),
    evalNoMethod = makeEvaluator(graph, { ...shared, kind: "action-c" }),
    evalWithMethod = makeEvaluator(graph, { ...shared, kind: "action-c", method: "route.c" }),
    evalWithExtra = makeEvaluator(graph, {
      ...shared,
      kind: "action-b",
      method: "route.b",
      fields: { extra: "only-extra" },
    });

  // Prime with evalA first; evalB must still compute its own kind, method, and field values.
  assert.deepEqual(evalA.fold(summarizeExpr, reqEnv), { value: "action-a:route.a:alpha" });
  assert.deepEqual(evalB.fold(summarizeExpr, reqEnv), { value: "action-b:route.b:beta" });
  assert.deepEqual(evalA.fold(readKindCallExpr, reqEnv), { value: "action-a" });
  assert.deepEqual(evalB.fold(readKindCallExpr, reqEnv), { value: "action-b" });

  // Depth-sparse empty-env writes (depth 1 before depth 0) must not leak UNSET_QUERY or commandClass across evaluators.
  const atDepth1 = evalA.evaluate(dryRunExpr, EMPTY_ENV, 1);
  const atDepth0 = evalB.evaluate(dryRunExpr, EMPTY_ENV, 0);
  assert.ok(Array.isArray(atDepth1));
  assert.ok(Array.isArray(atDepth0));
  assert.deepEqual(evalA.fold(dryRunExpr, EMPTY_ENV), { value: false });
  assert.equal(evalNoKind.fold(dryRunExpr, EMPTY_ENV), null);
  assert.deepEqual(evalA.fold(commandClassExpr, EMPTY_ENV, 1), { value: "repo-write" });
  assert.deepEqual(evalWithRepoRead.fold(commandClassExpr, EMPTY_ENV, 0), { value: "repo-read" });
  assert.deepEqual(evalA.fold(commandClassExpr, EMPTY_ENV), { value: "repo-write" });
  assert.deepEqual(evalWithRepoRead.fold(commandClassExpr, EMPTY_ENV), { value: "repo-read" });

  // Presence of kind, method, commandClass, or different field keys must isolate factScope directly.
  assert.equal(evalNoMethod.fold(summarizeExpr, reqEnv), null);
  assert.equal(evalB.fold(readExtraExpr, reqEnv), null);
  assert.deepEqual(evalWithExtra.fold(readExtraExpr, reqEnv), { value: "only-extra" });
  assert.notEqual(evalNoKind.staticScope, evalA.staticScope);
  assert.notEqual(evalNoMethod.staticScope, evalWithMethod.staticScope);
  assert.notEqual(evalB.staticScope, evalWithExtra.staticScope);
  assert.notEqual(evalA.staticScope, evalWithRepoRead.staticScope);
  assert.equal(evalA.staticScope, evalB.staticScope);
});

test("fold preserves JS optional-chaining short-circuit boundaries across chained accesses", () => {
  const file = "packages/daemon/src/optional-chain.ts",
    { rootDir } = makeRepo({
      [file]: `
function testChains(input) {
  const missing = undefined;
  const literalUndef = { b: undefined };
  const literalNull = { b: null };
  return [
    missing?.a.b.c,
    (missing?.a.b).c,
    ({}).b.c,
    literalUndef?.b.c,
    literalNull?.b.c,
    input?.nested?.prop,
  ];
}`,
    }),
    graph = buildFlowGraph(rootDir),
    sourceFile = graph.modules.get(file).sourceFile,
    fn = sourceFile.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === "testChains"),
    elements = fn.body.statements.at(-1).expression.elements,
    evaluator = makeEvaluator(graph, { constants: {}, functions: {}, strictMembers: true });
  // Optional chain short-circuits the entire chain when its optional link evaluates to undefined.
  assert.deepEqual(evaluator.fold(elements[0], EMPTY_ENV), { value: undefined, optionalShortCircuit: true });
  // Parenthesizing terminates the optional chain, so `.c` must not inherit short-circuiting.
  assert.equal(evaluator.fold(elements[1], EMPTY_ENV), null);
  // Plain property access on `{}` without `?.` or undefined initializer must not short-circuit.
  assert.equal(evaluator.fold(elements[2], EMPTY_ENV), null);
  // Existing property values `undefined` / `null` do not trigger `?.` short-circuiting on `.c`.
  assert.equal(evaluator.fold(elements[3], EMPTY_ENV), null);
  assert.equal(evaluator.fold(elements[4], EMPTY_ENV), null);
  // Symbolic input without a null/undefined binding stays unknown (`null`).
  assert.equal(evaluator.fold(elements[5], EMPTY_ENV), null);
});

test("processSourceSites keeps exact callback evidence after evicting transient env frames", () => {
  const file = "packages/daemon/src/bounded-frames.ts",
    { rootDir } = makeRepo({
      [file]: `const store = { append() {}, noop() {} };
function effect() { store.append(); }
function idle() { store.noop(); }
function pass(index: number, cb: () => void) { return cb(); }
function root(request: { transportKind: string }) { pass(0, effect); }`,
    }),
    graph = buildFlowGraph(rootDir),
    statements = graph.modules.get(file).sourceFile.statements,
    [, effectFn, idleFn, passFn, rootFn] = statements,
    effectSite = sourceSite(graph, effectFn.body.statements[0].expression),
    idleSite = sourceSite(graph, idleFn.body.statements[0].expression),
    evaluator = makeEvaluator(graph, { constants: {}, functions: {}, strictMembers: true });
  for (let i = 0; i < 20050; i += 1) {
    const numLiteral = ts.factory.createNumericLiteral(String(i)),
      bound = bindArguments({ node: passFn, env: EMPTY_ENV }, [numLiteral, idleFn.name], EMPTY_ENV);
    assert.ok(bound instanceof Map);
  }
  const hit = processSourceSites(graph, passFn, {
    evaluator,
    env: bindArguments(
      { node: passFn, env: EMPTY_ENV },
      [ts.factory.createNumericLiteral("1"), effectFn.name],
      EMPTY_ENV,
    ),
    targets: [effectSite],
  });
  assert.equal(hit.has(effectSite), true);
  assert.equal(
    processSourceSites(graph, passFn, {
      evaluator,
      env: bindArguments(
        { node: passFn, env: EMPTY_ENV },
        [ts.factory.createNumericLiteral("2"), idleFn.name],
        EMPTY_ENV,
      ),
      targets: [effectSite, idleSite],
    }).has(effectSite),
    false,
  );
  assert.ok(rootFn);
});
