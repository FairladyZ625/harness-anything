// harness-test-tier: contract
import assert from "node:assert/strict";
import { realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildFlowGraph } from "../authorization-flow-graph.mjs";
import {
  buildOutputWithinPackage,
  intrinsicSupport,
  processEntry,
  processSourceSites,
  processOwnedOutput,
  sourceSite,
  sourceWitnesses,
} from "../authorization-source-proof.mjs";
import { scanOntologyText } from "../ontology-closure-scan.mjs";
import { makeRepo } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const file = "packages/demo/scripts/copy-assets.mjs";
function fixture(text, scripts = { build: "node scripts/copy-assets.mjs" }, extraFiles = {}) {
  text = '/// <reference types="node" />\n' + text;
  const { rootDir } = makeRepo({
    "packages/demo/package.json": JSON.stringify({ name: "demo", type: "module", scripts }),
    [file]: text,
    ...extraFiles,
  });
  symlinkSync(realpathSync(path.join(repoRoot, "node_modules")), path.join(rootDir, "node_modules"), "dir");
  const graph = buildFlowGraph(rootDir, {
    sourceFiles: [file, ...Object.keys(extraFiles).filter((file) => /\.[cm]?ts$/u.test(file))],
  });
  const sources = scanOntologyText(file, text)
    .filter((row) => row.category === "action")
    .map((row) => ({ candidateId: row.id }));
  return { graph, sources, nodes: sourceWitnesses(graph, sources) };
}
const build = (destination) => `import { rmSync } from "node:fs";
const target = new URL(${JSON.stringify(destination)}, import.meta.url);
rmSync(target, { recursive: true, force: true });`;

test("a real package script reaches its dist effect; a detached effect has no entry evidence", () => {
  const { graph, nodes } = fixture(build("../dist/assets/") + '\nfunction detached() { rmSync("/tmp/detached"); }');
  const root = processEntry(graph, { file, script: "build" }, "package-script");
  assert.ok(root);
  const sites = processSourceSites(graph, root);
  const [effect, detached] = [...nodes.values()];
  assert.ok(sites.has(sourceSite(graph, effect)));
  assert.equal(sites.has(sourceSite(graph, detached)), false);
  assert.equal(buildOutputWithinPackage(graph, effect), true);
});

test("build authority cannot claim a script absent from the package manifest or output outside dist", () => {
  const { graph, nodes } = fixture(build("../canonical/"));
  assert.equal(processEntry(graph, { file, script: "missing" }, "package-script"), null);
  assert.equal(buildOutputWithinPackage(graph, [...nodes.values()][0]), false);
  const fake = fixture(build("../dist/assets/"), { build: "echo scripts/copy-assets.mjs" });
  assert.equal(processEntry(fake.graph, { file, script: "build" }, "package-script"), null);
});

test("chained calls with the same start keep distinct AST witnesses; local collections are support", () => {
  const { graph, nodes } = fixture(
    'import { createHash } from "node:crypto"; createHash("sha256").update("x").update("y"); const state = new Map(); state.delete("key");',
  );
  const values = [...nodes.values()];
  assert.equal(values.length, 3);
  assert.equal(new Set(values).size, values.length);
  assert.ok(values.every(Boolean));
  assert.ok(values.some((node) => intrinsicSupport(graph, node)));
});

test("an unused callback is detached while an invoked callback has entry evidence", () => {
  const { graph, nodes } = fixture(`import { rmSync } from "node:fs";
function invoke(callback) { callback(); }
function ignore(callback) { return undefined; }
invoke(() => rmSync("/tmp/invoked"));
ignore(() => rmSync("/tmp/unused"));`);
  const sites = processSourceSites(graph, processEntry(graph, { file, script: "build" }, "package-script"));
  const [invoked, unused] = [...nodes.values()].filter((node) => node.expression.getText() === "rmSync");
  assert.equal(sites.has(sourceSite(graph, invoked)), true);
  assert.equal(sites.has(sourceSite(graph, unused)), false);
});

test("stdio authority names only the real Node process streams, never a shadowed receiver", () => {
  for (const [prefix, expected] of [
    ['import "node:process";', true],
    ["const process = { stderr: { write() {} } };", false],
  ]) {
    const { graph, nodes } = fixture(prefix + 'process.stderr.write("test");');
    assert.equal(processOwnedOutput(graph, [...nodes.values()][0]), expected);
  }
});

test("the real Promise constructor invokes its executor, a shadowed constructor cannot borrow that edge", () => {
  for (const [prefix, expected] of [
    ["", true],
    ["class Promise { constructor(callback) {} }", false],
  ]) {
    const { graph, nodes } = fixture(
      'import { rmSync } from "node:fs";' + prefix + 'new Promise(() => rmSync("/tmp/executor"));',
    );
    const sites = processSourceSites(graph, processEntry(graph, { file, script: "build" }, "package-script"));
    assert.equal(sites.has(sourceSite(graph, [...nodes.values()][0])), expected);
  }
});

test("a native bin requires a real emitted wrapper; merely logging matching import text is rejected", () => {
  const entry = { file: "packages/demo/src/bin.ts", builder: file, bin: "demo" };
  const scripts = { build: "node scripts/copy-assets.mjs" };
  const extra = {
    "packages/demo/package.json": JSON.stringify({ type: "module", scripts, bin: { demo: "dist/index.js" } }),
    "packages/demo/tsconfig.build.json": JSON.stringify({
      compilerOptions: { rootDir: "..", outDir: "dist" },
      include: ["src/**/*.ts"],
    }),
    [entry.file]: 'console.log("native entry");',
  };
  for (const [emit, expected] of [
    ["writeFileSync", true],
    ["console.log", false],
  ]) {
    const { graph } = fixture(
      `import { writeFileSync } from "node:fs"; ${emit}(new URL("../dist/index.js", import.meta.url), 'import "./demo/src/bin.js";');`,
      scripts,
      extra,
    );
    assert.equal(Boolean(processEntry(graph, entry, "local-process")), expected);
  }
});

test("a shadowed URL constructor cannot claim the built-in URL's dist boundary", () => {
  const { graph, nodes } = fixture("class URL { constructor(...args) {} }" + build("../dist/assets/"));
  assert.equal(buildOutputWithinPackage(graph, [...nodes.values()][0]), false);
});

test("storage technical ports require the actual typed declaration, not a matching method name", async () => {
  const { technicalPortEvidence } = await import("../authorization-source-proof.mjs");
  const action = {
    kind: "storage-io",
    ontology: { technical: true, authority: "local-process" },
    receiptSettlement: "none",
  };
  const port = "node_modules/@types/node/sqlite.d.ts#node:sqlite.StatementSync.run";
  for (const [receiver, expected] of [
    [
      'import { DatabaseSync } from "node:sqlite"; const statement = new DatabaseSync(":memory:").prepare("SELECT 1");',
      true,
    ],
    ["const statement = { run() { return 1; } };", false],
  ]) {
    const { graph, nodes } = fixture(receiver + "statement.run();");
    const node = [...nodes.values()].at(-1);
    const source = { port, route: action.kind, role: "technical-port" };
    assert.equal(Boolean(technicalPortEvidence(graph, node, source, action)), expected);
    assert.equal(Boolean(technicalPortEvidence(graph, node, { ...source, route: "task-delete" }, action)), false);
    assert.equal(
      Boolean(technicalPortEvidence(graph, node, source, { ...action, receiptSettlement: "canonical-acceptance" })),
      false,
    );
    assert.equal(Boolean(technicalPortEvidence(graph, node, {}, action)), false);
    assert.equal(
      Boolean(technicalPortEvidence(graph, node, source, { ...action, ontology: { authority: "local-process" } })),
      false,
    );
  }
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1 S4: root tools/ scripts have no package dist, so the
// package-script build action owns them only through an exact typed port; packages/ keep the
// dist boundary and gain no port route.
test("a package-script technical port proves a root tools/ effect but never a package script effect", async () => {
  const { technicalPortEvidence, rootToolingSource } = await import("../authorization-source-proof.mjs");
  const tool = "tools/demo-tool.mjs";
  const text =
    '/// <reference types="node" />\nimport { writeFileSync } from "node:fs";\nwriteFileSync("/tmp/demo", "x");\n';
  const { rootDir } = makeRepo({
    "packages/demo/package.json": JSON.stringify({ name: "demo", type: "module" }),
    [file]: text,
    [tool]: text,
  });
  symlinkSync(realpathSync(path.join(repoRoot, "node_modules")), path.join(rootDir, "node_modules"), "dir");
  const graph = buildFlowGraph(rootDir, { sourceFiles: [file, tool] });
  const witness = (target) => {
    const sources = scanOntologyText(target, text)
      .filter((row) => row.category === "action")
      .map((row) => ({ candidateId: row.id }));
    assert.equal(sources.length, 1);
    return sourceWitnesses(graph, sources).get(sources[0].candidateId);
  };
  const port = "node_modules/@types/node/fs.d.ts#fs.writeFileSync";
  const action = {
    kind: "package-assets-build",
    ontology: { technical: true, authority: "package-script" },
    receiptSettlement: "none",
  };
  const source = { port, route: action.kind, role: "technical-port" };
  const [toolNode, packageNode] = [witness(tool), witness(file)];
  assert.equal(rootToolingSource(graph, toolNode), true);
  assert.equal(rootToolingSource(graph, packageNode), false);
  assert.ok(technicalPortEvidence(graph, toolNode, source, action));
  assert.equal(technicalPortEvidence(graph, packageNode, source, action), null);
  assert.equal(technicalPortEvidence(graph, toolNode, { ...source, port: `${port}x` }, action), null);
  assert.equal(technicalPortEvidence(graph, toolNode, { ...source, route: "task-delete" }, action), null);
  assert.equal(
    technicalPortEvidence(graph, toolNode, source, { ...action, ontology: { ...action.ontology, technical: false } }),
    null,
  );
  assert.equal(
    technicalPortEvidence(graph, toolNode, source, { ...action, ontology: { technical: true, authority: "remote" } }),
    null,
  );
  const local = { ...action, ontology: { technical: true, authority: "local-process" } };
  assert.ok(technicalPortEvidence(graph, packageNode, source, local));
});

test("tools client entries bind business actions with transport + command proof and cannot hide under package-assets-build", async () => {
  const { clientEntryEvidence, technicalPortEvidence } = await import("../authorization-source-proof.mjs");
  const tool = "tools/client-demo.mjs";
  const pkgCaller = "packages/demo/scripts/client-demo.mjs";
  const body = [
    '/// <reference types="node" />',
    'import { execFileSync, spawn } from "node:child_process";',
    "function run(args) { return execFileSync('ha', args, { encoding: 'utf8' }); }",
    "class RpcClient { run(payload) { return execFileSync('ha', ['rpc', JSON.stringify(payload)]); } }",
    "function invoke(args) { return args.join(' '); }",
    "export function main(taskId, runnerArgs) {",
    "  const client = new RpcClient();",
    '  const created = run(["--json", "task", "create", "title"]);',
    '  const runtimeArgs = ["runtime", "run", taskId];',
    "  const dispatched = run(runtimeArgs);",
    '  const installed = client.run({ kind: "agent-install", id: "coder" });',
    '  spawn("node", runnerArgs);',
    '  const decoupled = invoke(["task", "create"]);',
    "  return { created, dispatched, installed, decoupled };",
    "}",
  ].join("\n");
  const { rootDir } = makeRepo({
    "packages/demo/package.json": JSON.stringify({ name: "demo", type: "module" }),
    [tool]: body,
    [pkgCaller]: body,
  });
  symlinkSync(realpathSync(path.join(repoRoot, "node_modules")), path.join(rootDir, "node_modules"), "dir");
  const graph = buildFlowGraph(rootDir, { sourceFiles: [tool, pkgCaller] });
  const witnessMap = (target) => {
    const sources = scanOntologyText(target, body)
      .filter((row) => row.category === "action")
      .map((row) => ({ candidateId: row.id }));
    return [...sourceWitnesses(graph, sources).values()];
  };
  const nodes = witnessMap(tool);
  const pkgNodes = witnessMap(pkgCaller);
  const byCall = (list, fragment) => list.find((node) => node.getText().includes(fragment));
  const createNode = byCall(nodes, '"task", "create"');
  const runtimeNode = byCall(nodes, "run(runtimeArgs)");
  const installNode = byCall(nodes, 'kind: "agent-install"');
  const dynamicNode = byCall(nodes, 'spawn("node", runnerArgs)');
  const noTransportNode = byCall(nodes, 'invoke(["task", "create"])');
  const pkgCreateNode = byCall(pkgNodes, '"task", "create"');
  assert.ok(createNode && runtimeNode && installNode && dynamicNode && noTransportNode && pkgCreateNode);

  const descriptors = [
    { id: "task-create", path: ["task", "create"] },
    { id: "runtime-run", path: ["runtime", "run"] },
    { id: "agent-install", actionKind: "agent-install" },
  ];
  const runCliPort = `${tool}#run`;
  const sendRpcPort = `${tool}#RpcClient.run`;
  const noTransportPort = `${tool}#invoke`;
  const spawnPort = "node_modules/@types/node/child_process.d.ts#child_process.spawn";

  const createAction = { kind: "task-create", executionClass: "repo-write", ontology: {} };
  const runtimeAction = { kind: "runtime-run", executionClass: "repo-write", ontology: {} };
  const installAction = { kind: "agent-install", executionClass: "repo-write", ontology: {} };
  const buildAction = {
    kind: "package-assets-build",
    ontology: { owner: "distribution", technical: true, authority: "package-script" },
    receiptSettlement: "none",
  };

  assert.ok(
    clientEntryEvidence(
      graph,
      createNode,
      { role: "client", route: "task-create", port: runCliPort },
      createAction,
      descriptors,
    ),
  );
  assert.ok(
    clientEntryEvidence(
      graph,
      runtimeNode,
      { role: "client", route: "runtime-run", port: runCliPort },
      runtimeAction,
      descriptors,
    ),
  );
  assert.ok(
    clientEntryEvidence(
      graph,
      installNode,
      { role: "client", route: "agent-install", port: sendRpcPort },
      installAction,
      descriptors,
    ),
  );
  assert.equal(
    clientEntryEvidence(
      graph,
      createNode,
      { role: "client", route: "task-start", port: runCliPort },
      createAction,
      descriptors,
    ),
    null,
  );
  assert.equal(
    clientEntryEvidence(
      graph,
      createNode,
      { role: "client", route: "task-create", port: `${runCliPort}x` },
      createAction,
      descriptors,
    ),
    null,
  );
  assert.equal(
    clientEntryEvidence(
      graph,
      pkgCreateNode,
      { role: "client", route: "task-create", port: `${pkgCaller}#runCli` },
      createAction,
      descriptors,
    ),
    null,
  );
  assert.equal(
    clientEntryEvidence(
      graph,
      noTransportNode,
      { role: "client", route: "task-create", port: noTransportPort },
      createAction,
      descriptors,
    ),
    null,
  );
  assert.equal(
    clientEntryEvidence(
      graph,
      createNode,
      { role: "client", route: "task-create", port: runCliPort },
      { ...createAction, ontology: { technical: true } },
      descriptors,
    ),
    null,
  );
  assert.equal(
    technicalPortEvidence(
      graph,
      createNode,
      { role: "technical-port", route: "package-assets-build", port: runCliPort },
      buildAction,
      descriptors,
    ),
    null,
  );
  assert.ok(
    technicalPortEvidence(
      graph,
      dynamicNode,
      { role: "technical-port", route: "package-assets-build", port: spawnPort },
      buildAction,
      descriptors,
    ),
  );
});

test("fleet schema RPC writes and indirect/computed CLI wrappers bind business actions and fail package-assets-build", async () => {
  const { clientEntryEvidence, technicalPortEvidence } = await import("../authorization-source-proof.mjs");
  const tool = "tools/fleet-upload-demo.mjs";
  const peer = "packages/daemon/src/fleet/peer.ts";
  const centerListener = "packages/daemon/src/fleet/center-listener.ts";
  const toolBody = [
    '/// <reference types="node" />',
    'import { execFileSync } from "node:child_process";',
    'import { runFleetWriteClient } from "../packages/daemon/src/fleet/peer.ts";',
    "function write(docPath, content) {",
    '  return runFleetWriteClient({ schema: "fleet.doc.submit/v1", path: docPath, body: content });',
    "}",
    "function invoke(argv) {",
    '  return execFileSync("ha", argv, { encoding: "utf8" });',
    "}",
    'const factRecordArgv = (sampleId) => ["--json", "fact", "record", "--task", "t1", "--statement", sampleId];',
    "export function main(sampleId, command = {}) {",
    '  const written = write("docs/a.md", "hello");',
    "  const recorded = invoke(command.argv ?? factRecordArgv(sampleId));",
    "  return { written, recorded };",
    "}",
  ].join("\n");
  const peerBody = "export function runFleetWriteClient(payload: Record<string, unknown>) { return payload; }\n";
  const listenerBody = [
    "declare function precheck(): boolean;",
    "declare function dispatch(action: { kind: string }): unknown;",
    "export function handleFrame(frame: { schema: string }) {",
    '  if (frame.schema === "fleet.doc.submit/v1") {',
    '    if (precheck()) return dispatch({ kind: "task-show" });',
    '    return dispatch({ kind: "doc-submit" });',
    "  }",
    "  return null;",
    "}",
  ].join("\n");
  const { rootDir } = makeRepo({
    [peer]: peerBody,
    [centerListener]: listenerBody,
    [tool]: toolBody,
  });
  symlinkSync(realpathSync(path.join(repoRoot, "node_modules")), path.join(rootDir, "node_modules"), "dir");
  const graph = buildFlowGraph(rootDir, { sourceFiles: [peer, centerListener, tool] });
  const sources = scanOntologyText(tool, toolBody)
    .filter((row) => row.category === "action")
    .map((row) => ({ candidateId: row.id }));
  const nodes = [...sourceWitnesses(graph, sources).values()];
  const writeNode = nodes.find((node) => node.getText().includes('write("docs/a.md"'));
  const recordedNode = nodes.find((node) => node.getText().includes("factRecordArgv(sampleId)"));
  assert.ok(writeNode && recordedNode);

  const descriptors = [
    { id: "doc-sync-submit", actionKind: "doc-submit", path: ["doc", "sync"] },
    { id: "fact-record", path: ["fact", "record"] },
    { id: "task-show", path: ["task", "show"] },
  ];
  const docSubmitAction = { kind: "doc-submit", executionClass: "repo-write", ontology: {} };
  const factRecordAction = { kind: "fact-record", executionClass: "repo-write", ontology: {} };
  const buildAction = {
    kind: "package-assets-build",
    ontology: { owner: "distribution", technical: true, authority: "package-script" },
    receiptSettlement: "none",
  };
  const writePort = `${tool}#write`;
  const invokePort = `${tool}#invoke`;

  assert.ok(
    clientEntryEvidence(
      graph,
      writeNode,
      { role: "client", route: "doc-sync-submit", port: writePort },
      docSubmitAction,
      descriptors,
    ),
  );
  assert.ok(
    clientEntryEvidence(
      graph,
      writeNode,
      { role: "client", route: "doc-submit", port: writePort },
      docSubmitAction,
      descriptors,
    ),
  );
  assert.equal(
    technicalPortEvidence(
      graph,
      writeNode,
      { role: "technical-port", route: "package-assets-build", port: writePort },
      buildAction,
      descriptors,
    ),
    null,
  );
  assert.ok(
    clientEntryEvidence(
      graph,
      recordedNode,
      { role: "client", route: "fact-record", port: invokePort },
      factRecordAction,
      descriptors,
    ),
  );
  assert.equal(
    technicalPortEvidence(
      graph,
      recordedNode,
      { role: "technical-port", route: "package-assets-build", port: invokePort },
      buildAction,
      descriptors,
    ),
    null,
  );
});

test("command-table wrapper loops cannot stay in package-assets-build while split operations resolve cleanly", async () => {
  const { clientEntryEvidence, resolvedCommandBindings, technicalPortEvidence } = await import(
    "../authorization-source-proof.mjs"
  );
  const tool = "tools/bench-table-demo.mjs";
  const toolBody = [
    '/// <reference types="node" />',
    'import { execFileSync } from "node:child_process";',
    "function invoke(metric, argv) {",
    '  return execFileSync("node", ["packages/cli/src/index.ts", ...argv], { encoding: "utf8" });',
    "}",
    "const commandTable = [",
    '  ["task-create", (c) => ["task", "create", "--title", c.title]],',
    '  ["entity-import~adr", (c) => ["entity", "import", "--kind", "adr", "--locator", c.loc]],',
    "];",
    "export function runLoop(c, argv) {",
    "  for (const [metric, build] of commandTable) {",
    "    invoke(metric, build(c));",
    "  }",
    '  invoke("capabilities", ["capabilities"]);',
    '  invoke("events-tail", ["events", "tail"]);',
    '  invoke("entity-import", ["entity", "import", ...argv.slice(2)]);',
    "}",
  ].join("\n");
  const { rootDir } = makeRepo({ [tool]: toolBody });
  symlinkSync(realpathSync(path.join(repoRoot, "node_modules")), path.join(rootDir, "node_modules"), "dir");
  const graph = buildFlowGraph(rootDir, { sourceFiles: [tool] });
  const sources = scanOntologyText(tool, toolBody)
    .filter((row) => row.category === "action")
    .map((row) => ({ candidateId: row.id }));
  const nodes = [...sourceWitnesses(graph, sources).values()];
  const loopNode = nodes.find((node) => node.getText().includes("invoke(metric, build(c))"));
  const capNode = nodes.find((node) => node.getText().includes('invoke("capabilities"'));
  const tailNode = nodes.find((node) => node.getText().includes('invoke("events-tail"'));
  const importNode = nodes.find((node) => node.getText().includes('invoke("entity-import"'));
  assert.ok(loopNode && capNode && tailNode && importNode);

  const descriptors = [
    { id: "task-create", path: ["task", "create"] },
    { id: "entity-import", path: ["entity", "import"], commandClass: "repo-write" },
  ];
  const buildAction = {
    kind: "package-assets-build",
    ontology: { owner: "distribution", technical: true, authority: "package-script" },
    receiptSettlement: "none",
  };
  const importAction = { kind: "entity-import", executionClass: "repo-write", ontology: {} };
  const readAction = { kind: "repository-read", executionClass: "repo-read", ontology: {} };
  const invokePort = `${tool}#invoke`;

  const loopBinding = resolvedCommandBindings(graph, loopNode, descriptors);
  assert.equal(Object.hasOwn(loopBinding, "matrixTable"), false);
  assert.deepEqual(loopBinding, { descriptors: [], targetsCliEntry: true, helpOnly: false });
  assert.equal(
    technicalPortEvidence(
      graph,
      loopNode,
      { role: "technical-port", route: "package-assets-build", port: invokePort },
      buildAction,
      descriptors,
    ),
    null,
  );
  assert.ok(
    technicalPortEvidence(
      graph,
      capNode,
      { role: "technical-port", route: "package-assets-build", port: invokePort },
      buildAction,
      descriptors,
    ),
  );
  assert.ok(
    clientEntryEvidence(
      graph,
      tailNode,
      { role: "client", route: "events-tail", port: invokePort },
      readAction,
      descriptors,
    ),
  );
  assert.ok(
    clientEntryEvidence(
      graph,
      importNode,
      { role: "client", route: "entity-import", port: invokePort },
      importAction,
      descriptors,
    ),
  );
});
