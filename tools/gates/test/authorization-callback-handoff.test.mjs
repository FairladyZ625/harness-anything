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
  makeEvaluator,
} from "../authorization-flow-graph.mjs";
import { makeAuthorizationTracer } from "../authorization-flow-trace.mjs";
import { processSourceSites, sourceSite, sourceWitnesses } from "../authorization-source-proof.mjs";
import { makeRepo } from "./helpers.mjs";

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
function queue(request, phase, callback) {
  if (phase === "write") {
    if (request.transportKind !== "unix-socket") return;
    callback();
  } else ${recursive ? "queue(request, phase, callback)" : "callback()"};
}
function entry(request: { transportKind: string }) { ${invocation} }`,
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
});

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
    .get("packages/daemon/src/entity-action-catalog-executor.ts")
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

// A cached frame contains direct graph edges, not another entry's transitive proof.
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
