// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeCapabilityBridge, analyzeModuleClosure } from "./analyze-module-closure.mjs";

function fixture(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), "module-closure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(files)) {
    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
  }
  return root;
}

test("diamond imports share a dominator and report retained modules per dominator edge", (t) => {
  const root = fixture(t, {
    "entry.ts": 'import "./left.ts";\nimport "./right.ts";\n',
    "left.ts": 'import "./shared.ts";\n',
    "right.ts": 'import "./shared.ts";\n',
    "shared.ts": 'import "./leaf.ts";\n',
    "leaf.ts": "export const leaf = true;\n",
  });

  const result = analyzeModuleClosure({ root, entry: "entry.ts" });
  const modules = new Map(result.modules.map((module) => [module.path, module]));
  const dominatorEdges = new Map(result.dominatorEdges.map((edge) => [edge.to, edge]));

  assert.equal(result.moduleCount, 5);
  assert.equal(modules.get("shared.ts").immediateDominator, "entry.ts");
  assert.equal(modules.get("leaf.ts").immediateDominator, "shared.ts");
  assert.equal(dominatorEdges.get("shared.ts").retainedModules, 2);
  assert.equal(dominatorEdges.get("left.ts").retainedModules, 1);
  assert.equal(dominatorEdges.get("right.ts").retainedModules, 1);
  assert.equal(dominatorEdges.get("shared.ts").retainedModules, 2);
  assert.equal(dominatorEdges.get("leaf.ts").retainedModules, 1);
  assert.notEqual(modules.get("shared.ts").immediateDominator, "left.ts");
});

test("type-only imports and exports do not contribute runtime closure edges", (t) => {
  const root = fixture(t, {
    "entry.ts": [
      'import type { A } from "./import-type.ts";',
      'import type { ChildProcess } from "node:child_process";',
      'import { type B } from "./specifier-type.ts";',
      'export type { C } from "./export-type.ts";',
      'export { type D } from "./specifier-export-type.ts";',
      'import type DefaultType from "./default-import-type.ts";',
      'import "./runtime.ts";',
      'import type from "./type-named-default.ts";',
      'import { type } from "./type-named-import.ts";',
      'import * as namespace from "./namespace.ts";',
      'type E = import("./import-type-node.ts").E;',
      'void import("./dynamic-runtime.ts");',
      "",
    ].join("\n"),
    "import-type.ts": "export type A = string;\n",
    "specifier-type.ts": "export type B = string;\n",
    "export-type.ts": "export type C = string;\n",
    "specifier-export-type.ts": "export type D = string;\n",
    "default-import-type.ts": "export default 1;\n",
    "import-type-node.ts": "export type E = string;\n",
    "runtime.ts": "export const runtime = true;\n",
    "type-named-default.ts": "export const value = true;\n",
    "type-named-import.ts": "export const type = true;\n",
    "namespace.ts": "export const value = true;\n",
    "dynamic-runtime.ts": "export const value = true;\n",
  });

  const result = analyzeModuleClosure({ root, entry: "entry.ts" });
  assert.deepEqual(result.modules.map((module) => module.path).sort(), [
    "dynamic-runtime.ts",
    "entry.ts",
    "namespace.ts",
    "runtime.ts",
    "specifier-export-type.ts",
    "specifier-type.ts",
    "type-named-default.ts",
    "type-named-import.ts",
  ]);
  assert.deepEqual(result.forbiddenTargets, []);
  assert.deepEqual(
    result.edges.map(({ specifier }) => specifier),
    [
      "./specifier-type.ts",
      "./specifier-export-type.ts",
      "./runtime.ts",
      "./type-named-default.ts",
      "./type-named-import.ts",
      "./namespace.ts",
      "./dynamic-runtime.ts",
    ],
  );
});

test("cycles and duplicate imports do not inflate retention or choose a diamond arm", (t) => {
  const root = fixture(t, {
    "entry.ts": 'import "./a.ts"; import "./b.ts"; import "./a.ts";',
    "a.ts": 'import "./c.ts";',
    "b.ts": 'import "./c.ts";',
    "c.ts": 'import "./a.ts"; import "./leaf.ts";',
    "leaf.ts": 'import "./leaf.ts";',
  });
  const result = analyzeModuleClosure({ root, entry: "entry.ts" });
  assert.equal(result.moduleCount, 5);
  assert.deepEqual(
    result.modules.map(({ path, immediateDominator, retainedModules }) => [path, immediateDominator, retainedModules]),
    [
      ["a.ts", "entry.ts", 1],
      ["b.ts", "entry.ts", 1],
      ["c.ts", "entry.ts", 2],
      ["entry.ts", null, 5],
      ["leaf.ts", "c.ts", 1],
    ],
  );
  assert.equal(result.dominatorEdges.find((edge) => edge.to === "c.ts").directImport, false);
});

test("JavaScript ESM, dynamic import, and require edges ignore comments and strings", (t) => {
  const root = fixture(t, {
    "entry.mjs": [
      '// import "./comment.mjs";',
      "const text = " + JSON.stringify('require("./string.cjs")') + ";",
      'import { value } from "./static.mjs";',
      'export { value as other } from "./reexport.mjs";',
      'void import("./dynamic.mjs");',
      'require("./common.cjs");',
      'require("./folder");',
      'require("./trailing.cjs",);',
      "require(`./literal-template.cjs`);",
      "void import(`./literal-template.mjs`);",
      'const nested = `${require("./nested.cjs")}`;',
      'object.require("./property.cjs");',
      'require("./computed-" + variable);',
      'export default function getMessage() { return "from ./not-imported.mjs"; }',
      "",
    ].join("\n"),
    "static.mjs": "export const value = 1;\n",
    "reexport.mjs": "export const value = 2;\n",
    "dynamic.mjs": "export const value = 3;\n",
    "common.cjs": "module.exports = true;\n",
    "folder/package.json": JSON.stringify({ main: "./entry.cjs" }),
    "folder/entry.cjs": "module.exports = true;\n",
    "trailing.cjs": "module.exports = true;\n",
    "literal-template.cjs": "module.exports = true;\n",
    "literal-template.mjs": "export const value = true;\n",
    "nested.cjs": "module.exports = true;\n",
  });

  const result = analyzeModuleClosure({ root, entry: "entry.mjs" });
  assert.deepEqual(result.edges.map(({ specifier }) => specifier).sort(), [
    "./common.cjs",
    "./dynamic.mjs",
    "./folder",
    "./literal-template.cjs",
    "./literal-template.mjs",
    "./nested.cjs",
    "./reexport.mjs",
    "./static.mjs",
    "./trailing.cjs",
  ]);
});

test("Lengauer-Tarjan agrees with fixed-point dominators on nested cyclic joins", (t) => {
  const graph = [[1, 2], [3], [4], [5, 2], [5], [6], [3, 7], [7]];
  const root = fixture(
    t,
    Object.fromEntries(
      graph.map((targets, index) => [`${index}.mjs`, targets.map((target) => `import "./${target}.mjs";`).join("\n")]),
    ),
  );
  const all = graph.map((_, index) => index);
  const dominates = all.map((index) => new Set(index === 0 ? [0] : all));
  // Independent definition: Dom(v) = {v} union intersection(Dom(predecessors)).
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of all.slice(1)) {
      const predecessors = all.filter((index) => graph[index].includes(node));
      const next = new Set([
        node,
        ...all.filter((candidate) => predecessors.every((index) => dominates[index].has(candidate))),
      ]);
      if (next.size !== dominates[node].size) {
        dominates[node] = next;
        changed = true;
      }
    }
  }
  const result = analyzeModuleClosure({ root, entry: "0.mjs" });
  for (const module of result.modules) {
    const node = Number.parseInt(module.path);
    const strict = [...dominates[node]].filter((candidate) => candidate !== node);
    strict.sort((left, right) => dominates[right].size - dominates[left].size);
    assert.equal(module.immediateDominator, strict.length ? `${strict[0]}.mjs` : null);
    assert.equal(module.retainedModules, dominates.filter((set) => set.has(node)).length);
  }
});

test("workspace package exports resolve from the analyzed repository root", (t) => {
  const root = fixture(t, {
    "packages/kernel/package.json": JSON.stringify({
      name: "@fixture/kernel",
      exports: { ".": { types: "./dist/index.d.ts", default: "./src/index.ts" } },
    }),
    "packages/kernel/src/index.ts": 'export { value } from "./value.ts";\n',
    "packages/kernel/src/value.ts": "export const value = 1;\n",
    "packages/daemon/src/entry.ts": 'import { value } from "@fixture/kernel";\nvoid value;\n',
  });

  const result = analyzeModuleClosure({ root, entry: "packages/daemon/src/entry.ts" });
  assert.deepEqual(result.modules.map((module) => module.path).sort(), [
    "packages/daemon/src/entry.ts",
    "packages/kernel/src/index.ts",
    "packages/kernel/src/value.ts",
  ]);
  assert.deepEqual(result.unresolvedImports, []);
});

test("templates, regexes, export namespaces and JSX preserve only real module edges", (t) => {
  const root = fixture(t, {
    "entry.tsx": [
      'import type { Props } from "./types.ts";',
      'import "./view.jsx";',
      'export * as namespace from "./module.mjs";',
      'const node = <div>import "./jsx-text.mjs"</div>;',
    ].join("\n"),
    "view.jsx": 'export const view = <div>require("./text.cjs")</div>;',
    "module.mjs": [
      'const text = `import "./template-text.mjs" ${"from"} export * from "./tail.mjs"`;',
      'const regex = /require\\("fake"\\)/;',
      'const expression = `${import("./real.mjs")}`;',
      'export * as namespace from "./real.mjs";',
    ].join("\n"),
    "real.mjs": "export const value = 1;",
  });
  const result = analyzeModuleClosure({ root, entry: "entry.tsx" });
  assert.deepEqual(result.unresolvedImports, []);
  assert.equal(result.moduleCount, 4);
  assert.equal(result.edges.filter((edge) => edge.to === "real.mjs").length, 2);
});

test("package imports, wildcard exports and import/require conditions use runtime targets", (t) => {
  const root = fixture(t, {
    "package.json": JSON.stringify({
      imports: { "#local/*": "./local/*.mjs", "#network": "node:net", "#package": "conditional" },
    }),
    "entry.mjs": [
      'import "#local/value";',
      'import "#network";',
      'import "#package";',
      'import "conditional";',
      'require("conditional");',
      'import "conditional/feature/value";',
      'import "conditional/blocked";',
      'import "conditional/missing";',
    ].join("\n"),
    "local/value.mjs": "export const value = 1;",
    "node_modules/conditional/package.json": JSON.stringify({
      name: "conditional",
      exports: {
        ".": { types: "./wrong.d.ts", import: "./esm.mjs", require: "./cjs.cjs" },
        "./feature/*": "./features/*.mjs",
        "./blocked": { import: null, default: "./blocked.mjs" },
      },
    }),
    "node_modules/conditional/esm.mjs": "export const value = 1;",
    "node_modules/conditional/cjs.cjs": "module.exports = 1;",
    "node_modules/conditional/features/value.mjs": "export const value = 1;",
    "node_modules/conditional/blocked.mjs": "export const value = 1;",
    "node_modules/conditional/missing.ts": "export const value = 1;",
  });
  const result = analyzeModuleClosure({ root, entry: "entry.mjs" });
  assert.deepEqual(
    result.modules.map((module) => module.path),
    [
      "entry.mjs",
      "local/value.mjs",
      "node_modules/conditional/cjs.cjs",
      "node_modules/conditional/esm.mjs",
      "node_modules/conditional/features/value.mjs",
    ],
  );
  assert.deepEqual(
    result.unresolvedImports.map((item) => item.specifier),
    ["conditional/blocked", "conditional/missing"],
  );
  assert.deepEqual(
    result.forbiddenTargets[0].witness.map((step) => step.path),
    ["entry.mjs", "node:net"],
  );
});

test("forbidden targets include a shortest import witness chain", (t) => {
  const root = fixture(t, {
    "entry.ts":
      'import "./long-path.ts";\nimport "node:http";\nimport "child_process";\nimport "node:https";\nimport "net";\nimport "node:tls";\n',
    "long-path.ts": 'import "./middle.ts";\n',
    "middle.ts": 'import "node:http";\n',
  });

  const result = analyzeModuleClosure({ root, entry: "entry.ts" });
  const forbidden = result.forbiddenTargets.find((target) => target.target === "node:http");
  assert.deepEqual(
    forbidden.witness.map((step) => step.path),
    ["entry.ts", "node:http"],
  );
  assert.equal(forbidden.witness.length, 2);
  assert.deepEqual(
    result.forbiddenTargets.filter((target) => target.rule === "forbidden-node-module").map((target) => target.target),
    ["node:child_process", "node:http", "node:https", "node:net", "node:tls"],
  );
});

test("forbidden target rules cover runtime-spawn, fleet, and authorization packages", (t) => {
  const root = fixture(t, {
    "entry.ts": [
      'import "./runtime-spawn-child.ts";',
      'import "./fleet/peer.ts";',
      'import "@harness-anything/authorization-keycloak";',
      "",
    ].join("\n"),
    "runtime-spawn-child.ts": "export const process = true;\n",
    "fleet/peer.ts": "export const peer = true;\n",
    "node_modules/@harness-anything/authorization-keycloak/package.json": JSON.stringify({
      name: "@harness-anything/authorization-keycloak",
      exports: { ".": { import: "./src/index.ts" } },
    }),
    "node_modules/@harness-anything/authorization-keycloak/src/index.ts": "export const provider = true;\n",
  });

  const result = analyzeModuleClosure({ root, entry: "entry.ts" });
  const rules = new Set(result.forbiddenTargets.map((target) => target.rule));
  assert.deepEqual(rules, new Set(["authorization-provider", "fleet", "runtime-spawn"]));
  assert.equal(
    result.forbiddenTargets.every((target) => target.witness.length === 2),
    true,
  );
});

test("capability bridge audit maps worker calls to supervisor handlers", (t) => {
  const root = fixture(t, {
    "packages/daemon/src/repo-writer-worker.ts": [
      'syncCapability("now", null);',
      'asyncCapability("prepareRuntimeLaunch", payload);',
      'notify("runtimeSignal", payload);',
      'notify("orphanCapability", payload);',
      "asyncCapability(variableCapability, payload);",
      '// syncCapability("commentOnly", null);',
      "const asyncCapabilities = new Map();",
      "asyncCapabilities.get(callId);",
      "asyncCapabilities.delete(callId);",
    ].join("\n"),
    "packages/daemon/src/writer-supervisor.ts": [
      'if (message.capability === "runtimeSignal") return;',
      "async function capabilityValue(call) {",
      "  switch (call.capability) {",
      '    case "now": return Date.now();',
      '    case "prepareRuntimeLaunch": return prepare();',
      '    case "runtimeSignal": return notify();',
      '    case "unusedHostCapability": return undefined;',
      "  }",
      '  switch (otherKind) { case "unrelatedSwitch": return; }',
      "}",
    ].join("\n"),
  });

  const audit = analyzeCapabilityBridge({ root });
  const methods = new Map(audit.methods.map((method) => [method.capability, method]));
  assert.deepEqual(methods.get("now").workerModes, ["sync"]);
  assert.deepEqual(methods.get("prepareRuntimeLaunch").workerModes, ["async"]);
  assert.deepEqual(methods.get("runtimeSignal").workerModes, ["notify"]);
  assert.equal(methods.get("now").supervisorHandler.line, 4);
  assert.equal(audit.asyncReplyMap.declared, true);
  assert.equal(audit.asyncReplyMap.hasLookup, true);
  assert.equal(audit.asyncReplyMap.hasDelete, true);
  assert.deepEqual(audit.unhandledWorkerMethods, ["orphanCapability"]);
  assert.deepEqual(audit.supervisorOnlyMethods, ["unusedHostCapability"]);
  assert.deepEqual(audit.dynamicWorkerCalls, [{ capability: null, mode: "async", line: 5 }]);
});

test("repo-writer-worker closure and bridge audit finish within 1.5 seconds", () => {
  const root = path.resolve(".");
  const result = analyzeModuleClosure({ root, entry: "packages/daemon/src/repo-writer-worker.ts" });
  const bridge = analyzeCapabilityBridge({ root });

  assert.ok(result.moduleCount > 0);
  assert.ok(result.forbiddenTargets.length > 0);
  assert.ok(bridge.methods.some((method) => method.capability === "runtimeLaunch"));
  assert.ok(result.durationMs < 1500, `analysis took ${result.durationMs.toFixed(1)}ms`);
});
