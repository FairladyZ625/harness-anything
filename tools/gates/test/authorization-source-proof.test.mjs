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

test("GUI renderer/preload client calls bind their business action and fail closed under daemon-local-state or server files", async () => {
  const { clientEntryEvidence, guiClientSource, technicalPortEvidence } = await import(
    "../authorization-source-proof.mjs"
  );
  const invokeFile = "packages/gui/src/renderer/api-client-invoke.ts";
  const todosFile = "packages/gui/src/renderer/todos-client.ts";
  const preloadFile = "packages/gui/src/preload/access-admin-preload.ts";
  const domFile = "packages/gui/src/renderer/theme-dom.ts";
  const serverFile = "packages/daemon/src/fake-server.ts";
  const files = {
    [invokeFile]:
      "export async function invoke(method: string, payload: unknown): Promise<unknown> { return [method, payload]; }\n",
    [todosFile]: [
      'import { invoke } from "./api-client-invoke.js";',
      "export const todosClient = {",
      '  add: (rootDir: string, title: string) => invoke("repo.todo.add", { rootDir, title }),',
      "};",
    ].join("\n"),
    [preloadFile]: [
      'const ACCESS_ADMIN_CHANNEL = "harness:access-admin";',
      "export const accessAdminPreloadApi = {",
      "  invoke: (channel: string, payload: unknown) => [channel, payload],",
      "  ask: (rootDir: string) => accessAdminPreloadApi.invoke(ACCESS_ADMIN_CHANNEL, { rootDir }),",
      "};",
    ].join("\n"),
    [domFile]: [
      '/// <reference lib="dom" />',
      'export function clearTheme() { document.documentElement.classList.remove("dark"); }',
    ].join("\n"),
    [serverFile]: [
      "export function serverWrite(method: string) { return invoke(method); }",
      "function invoke(method: string) { return method; }",
    ].join("\n"),
  };
  const { rootDir } = makeRepo(files);
  symlinkSync(realpathSync(path.join(repoRoot, "node_modules")), path.join(rootDir, "node_modules"), "dir");
  const graph = buildFlowGraph(rootDir, { sourceFiles: Object.keys(files) });
  const candidates = Object.entries(files).flatMap(([target, body]) =>
    scanOntologyText(target, body)
      .filter((row) => row.category === "action")
      .map((row) => ({ candidateId: row.id })),
  );
  const witnesses = [...sourceWitnesses(graph, candidates).values()];
  const todoNode = witnesses.find((node) => node.getText().includes('invoke("repo.todo.add"'));
  const preloadNode = witnesses.find((node) =>
    node.getText().includes("accessAdminPreloadApi.invoke(ACCESS_ADMIN_CHANNEL"),
  );
  const domNode = witnesses.find((node) => node.getText().includes('classList.remove("dark")'));
  const serverNode = witnesses.find((node) => node.getText() === "invoke(method)");
  assert.ok(todoNode && preloadNode && domNode && serverNode);

  assert.equal(guiClientSource(graph, todoNode), true);
  assert.equal(guiClientSource(graph, preloadNode), true);
  assert.equal(guiClientSource(graph, domNode), true);
  assert.equal(guiClientSource(graph, serverNode), false);

  const descriptors = [
    {
      id: "todo.add",
      actionKind: "todo-add",
      method: "repo.todo.add",
      guiBridgeMethod: "todoAdd",
      commandClass: "repo-write",
    },
    {
      id: "task.submit",
      actionKind: "task-submit",
      method: "repo.task.submit",
      guiBridgeMethod: "submitTask",
      commandClass: "repo-write",
    },
    {
      id: "node-unregister",
      actionKind: "access-manage",
      method: "daemon.rbac.manage",
      commandClass: "admin",
    },
  ];
  const todoAction = { kind: "todo-add", executionClass: "repo-write", ontology: {} };
  const taskSubmitAction = { kind: "task-submit", executionClass: "repo-write", ontology: {} };
  const accessAction = { kind: "access-manage", executionClass: "admin", ontology: {} };
  const localStateAction = {
    kind: "daemon-local-state",
    ontology: { owner: "daemon", technical: true, authority: "local-process" },
    receiptSettlement: "none",
  };

  const todoPort = `${invokeFile}#invoke`;
  const preloadPort = `${preloadFile}#accessAdminPreloadApi.invoke`;
  const domPort = "node_modules/typescript/lib/lib.dom.d.ts#DOMTokenList.remove";
  const serverPort = `${serverFile}#invoke`;

  assert.ok(
    clientEntryEvidence(
      graph,
      todoNode,
      { role: "client", route: "todo.add", port: todoPort },
      todoAction,
      descriptors,
    ),
  );
  assert.ok(
    clientEntryEvidence(
      graph,
      preloadNode,
      { role: "client", route: "node-unregister", port: preloadPort },
      accessAction,
      descriptors,
    ),
  );
  // Mismatched route, mismatched owning action, or server file claiming role: "client" must fail closed.
  assert.equal(
    clientEntryEvidence(
      graph,
      todoNode,
      { role: "client", route: "task.submit", port: todoPort },
      todoAction,
      descriptors,
    ),
    null,
  );
  assert.equal(
    clientEntryEvidence(
      graph,
      todoNode,
      { role: "client", route: "task.submit", port: todoPort },
      taskSubmitAction,
      descriptors,
    ),
    null,
  );
  assert.equal(
    clientEntryEvidence(
      graph,
      serverNode,
      { role: "client", route: "todo.add", port: serverPort },
      todoAction,
      descriptors,
    ),
    null,
  );
  // Business GUI RPCs and daemon-forwarding IPC channels cannot hide under daemon-local-state.
  assert.equal(
    technicalPortEvidence(
      graph,
      todoNode,
      { role: "technical-port", route: "daemon-local-state", port: todoPort },
      localStateAction,
      descriptors,
    ),
    null,
  );
  assert.equal(
    technicalPortEvidence(
      graph,
      preloadNode,
      { role: "technical-port", route: "daemon-local-state", port: preloadPort },
      localStateAction,
      descriptors,
    ),
    null,
  );
  // Genuine process-local DOM mutations remain valid under daemon-local-state.
  assert.ok(
    technicalPortEvidence(
      graph,
      domNode,
      { role: "technical-port", route: "daemon-local-state", port: domPort },
      localStateAction,
      descriptors,
    ),
  );
});

test("GUI higher-order callback parameters resolve multiplexed business routes and reject unproven callbacks from daemon-local-state", async () => {
  const { clientEntryEvidence, clientEntryRequiredRoutes, resolvedGuiClientBindings, technicalPortEvidence } =
    await import("../authorization-source-proof.mjs");
  const invokeFile = "packages/gui/src/renderer/api-client-invoke.ts";
  const clientFile = "packages/gui/src/renderer/api-client.ts";
  const reviewFile = "packages/gui/src/renderer/decision-review-actions.ts";
  const taskFile = "packages/gui/src/renderer/task-actions.ts";
  const todosFile = "packages/gui/src/renderer/views/TodosView.tsx";
  const unprovenFile = "packages/gui/src/renderer/unproven-runner.ts";
  const files = {
    "packages/gui/package.json": JSON.stringify({ name: "@harness-anything/gui", type: "module" }),
    [invokeFile]: [
      "export async function invoke(method: string, payload?: unknown) {",
      "  return { method, payload };",
      "}",
    ].join("\n"),
    [clientFile]: [
      'import { invoke } from "./api-client-invoke.ts";',
      "export const harnessClient = {",
      '  respondReview: (repoId: string) => invoke("repo.decision.respondReview", { repoId }),',
      '  dispatchReview: (repoId: string) => invoke("repo.decision.dispatchReview", { repoId }),',
      '  async pinTask(repoId: string) { return invoke("repo.task.pin", { repoId }); },',
      '  async unpinTask(repoId: string) { return invoke("repo.task.unpin", { repoId }); },',
      "};",
      "export const todosClient = {",
      '  add: (repoId: string, text: string) => invoke("repo.todo.add", { repoId, text }),',
      '  done: (repoId: string, id: string) => invoke("repo.todo.done", { repoId, id }),',
      "};",
    ].join("\n"),
    [reviewFile]: [
      'import { harnessClient } from "./api-client.ts";',
      "export function useDecisionReviewActions(repoId: string) {",
      "  const exec = async (write: () => Promise<unknown>) => {",
      "    const receipt = await write();",
      "    return receipt;",
      "  };",
      "  return {",
      "    respond: () => exec(() => harnessClient.respondReview(repoId)),",
      "    dispatch: () => exec(() => harnessClient.dispatchReview(repoId)),",
      "  };",
      "}",
    ].join("\n"),
    [taskFile]: [
      'import { useCallback } from "react";',
      'import { harnessClient } from "./api-client.ts";',
      "export function useTaskActions(repoId: string) {",
      "  const once = useCallback((run: () => Promise<unknown>) => run(), []);",
      "  const setTaskPin = (pinned: boolean) =>",
      "    once(() => (pinned ? harnessClient.pinTask : harnessClient.unpinTask)(repoId));",
      "  return { setTaskPin };",
      "}",
    ].join("\n"),
    [todosFile]: [
      'import { useMutation } from "@tanstack/react-query";',
      'import { todosClient } from "../api-client.ts";',
      "export function TodosView({ repoId }: { readonly repoId: string }) {",
      "  const mutation = useMutation({",
      "    mutationFn: (run: () => Promise<unknown>) => run(),",
      "  });",
      '  const addNow = () => mutation.mutate(() => todosClient.add(repoId, "x"));',
      "  return <TodoActions repoId={repoId} run={(run) => mutation.mutate(run)} onAdd={addNow} />;",
      "}",
      "function TodoActions({ repoId, run }: { readonly repoId: string; readonly run: (cb: () => Promise<unknown>) => void; readonly onAdd: () => void }) {",
      '  const completeOne = () => run(() => todosClient.done(repoId, "1"));',
      "  return <div>{String(Boolean(completeOne))}</div>;",
      "}",
    ].join("\n"),
    [unprovenFile]: [
      "export function uncalledRunner(write: () => Promise<void>) {",
      "  return write();",
      "}",
      "export function opaqueRunner(run: () => Promise<void>) {",
      "  return run();",
      "}",
      "export function callOpaque(ext: { readonly next: () => Promise<void> }) {",
      "  return opaqueRunner(ext.next);",
      "}",
      "const applyLocal = (update: (n: number) => number) => update(1);",
      "export const localResult = applyLocal((x) => x + 1);",
    ].join("\n"),
  };
  const { rootDir } = makeRepo(files);
  symlinkSync(realpathSync(path.join(repoRoot, "node_modules")), path.join(rootDir, "node_modules"), "dir");
  const graph = buildFlowGraph(rootDir, { sourceFiles: Object.keys(files).filter((f) => /\.tsx?$/u.test(f)) });
  const candidates = Object.entries(files).flatMap(([target, body]) =>
    scanOntologyText(target, body)
      .filter((row) => row.category === "action")
      .map((row) => ({ candidateId: row.id })),
  );
  const witnesses = sourceWitnesses(graph, candidates);
  const nodeFor = (fileFragment, textFragment) =>
    [...witnesses.entries()].find(([id, node]) => id.includes(fileFragment) && node.getText() === textFragment)?.[1];

  const writeNode = nodeFor("decision-review-actions.ts", "write()");
  const onceRunNode = nodeFor("task-actions.ts", "run()");
  const mutationRunNode = nodeFor("TodosView.tsx#TodosView.mutation.mutationFn", "run()");
  const childDoneNode = [...witnesses.entries()].find(
    ([id, node]) => id.includes("TodosView.tsx#TodoActions") && node.getText().startsWith("run("),
  )?.[1];
  const uncalledNode = nodeFor("unproven-runner.ts#uncalledRunner", "write()");
  const opaqueNode = nodeFor("unproven-runner.ts#opaqueRunner", "run()");
  const localNode = nodeFor("unproven-runner.ts#applyLocal", "update(1)");
  assert.ok(writeNode && onceRunNode && mutationRunNode && childDoneNode && uncalledNode && opaqueNode && localNode);

  const descriptors = [
    {
      id: "decision.respondReview",
      actionKind: "decision-respond-review",
      method: "repo.decision.respondReview",
      commandClass: "repo-write",
    },
    {
      id: "decision.dispatchReview",
      actionKind: "decision-dispatch-review",
      method: "repo.decision.dispatchReview",
      commandClass: "repo-write",
    },
    { id: "task.pin", actionKind: "entity-pin", method: "repo.task.pin", commandClass: "repo-write" },
    { id: "task.unpin", actionKind: "entity-unpin", method: "repo.task.unpin", commandClass: "repo-write" },
    { id: "todo.add", actionKind: "todo-add", method: "repo.todo.add", commandClass: "repo-write" },
    { id: "todo.done", actionKind: "todo-done", method: "repo.todo.done", commandClass: "repo-write" },
  ];
  const localStateAction = {
    kind: "daemon-local-state",
    ontology: { owner: "daemon", technical: true, authority: "local-process" },
    receiptSettlement: "none",
  };
  const respondAction = { kind: "decision-respond-review", executionClass: "repo-write", ontology: {} };
  const pinAction = { kind: "entity-pin", executionClass: "repo-write", ontology: {} };
  const todoAddAction = { kind: "todo-add", executionClass: "repo-write", ontology: {} };
  const todoDoneAction = { kind: "todo-done", executionClass: "repo-write", ontology: {} };

  // 1. Direct callable parameter `write()` resolves both review routes, passes clientEntryEvidence, and rejects daemon-local-state.
  const reviewResolved = resolvedGuiClientBindings(graph, writeNode, descriptors);
  assert.equal(reviewResolved.viaCallbackParam, true);
  assert.equal(reviewResolved.hasUnprovenCallback, false);
  assert.deepEqual(
    reviewResolved.bindings.map((b) => b.route),
    ["decision.dispatchReview", "decision.respondReview"],
  );
  const writePort = `${reviewFile}#useDecisionReviewActions.exec.write`;
  assert.ok(
    clientEntryEvidence(
      graph,
      writeNode,
      { role: "client", route: "decision.respondReview", port: writePort },
      respondAction,
      descriptors,
    ),
  );
  assert.deepEqual(
    clientEntryRequiredRoutes(
      graph,
      writeNode,
      { role: "client", route: "decision.respondReview", port: writePort },
      respondAction,
      descriptors,
    ),
    ["decision.dispatchReview", "decision.respondReview"],
  );
  assert.equal(
    clientEntryEvidence(
      graph,
      writeNode,
      { role: "client", route: "todo.add", port: writePort },
      todoAddAction,
      descriptors,
    ),
    null,
  );
  assert.equal(
    technicalPortEvidence(
      graph,
      writeNode,
      { role: "technical-port", route: "daemon-local-state", port: writePort },
      localStateAction,
      descriptors,
    ),
    null,
  );

  // 2. useCallback-wrapped `once` + conditional callee `(pinned ? pinTask : unpinTask)` resolves both routes and rejects daemon-local-state.
  const taskResolved = resolvedGuiClientBindings(graph, onceRunNode, descriptors);
  assert.deepEqual(
    taskResolved.bindings.map((b) => b.route),
    ["task.pin", "task.unpin"],
  );
  const oncePort = `${taskFile}#useTaskActions.once.run`;
  assert.ok(
    clientEntryEvidence(
      graph,
      onceRunNode,
      { role: "client", route: "task.pin", port: oncePort },
      pinAction,
      descriptors,
    ),
  );
  assert.equal(
    technicalPortEvidence(
      graph,
      onceRunNode,
      { role: "technical-port", route: "daemon-local-state", port: oncePort },
      localStateAction,
      descriptors,
    ),
    null,
  );

  // 3. useMutation({ mutationFn: (run) => run() }) resolves direct mutate() + JSX prop handoffs while keeping child callsite 1:1.
  const mutResolved = resolvedGuiClientBindings(graph, mutationRunNode, descriptors);
  assert.deepEqual(
    mutResolved.bindings.map((b) => b.route),
    ["todo.add", "todo.done"],
  );
  const mutPort = `${todosFile}#TodosView.mutation.mutationFn.run`;
  assert.ok(
    clientEntryEvidence(
      graph,
      mutationRunNode,
      { role: "client", route: "todo.add", port: mutPort },
      todoAddAction,
      descriptors,
    ),
  );
  assert.equal(
    technicalPortEvidence(
      graph,
      mutationRunNode,
      { role: "technical-port", route: "daemon-local-state", port: mutPort },
      localStateAction,
      descriptors,
    ),
    null,
  );
  const childResolved = resolvedGuiClientBindings(graph, childDoneNode, descriptors);
  assert.equal(childResolved.viaCallbackParam, false);
  assert.deepEqual(
    childResolved.bindings.map((b) => b.route),
    ["todo.done"],
  );
  assert.ok(
    clientEntryEvidence(
      graph,
      childDoneNode,
      { role: "client", route: "todo.done", port: `${todosFile}#TodoActions.run` },
      todoDoneAction,
      descriptors,
    ),
  );

  // 4. Unknown callback reachability (0 callers or opaque argument) MUST fail closed on daemon-local-state AND clientEntryEvidence.
  for (const [node, port] of [
    [uncalledNode, `${unprovenFile}#uncalledRunner.write`],
    [opaqueNode, `${unprovenFile}#opaqueRunner.run`],
  ]) {
    const res = resolvedGuiClientBindings(graph, node, descriptors);
    assert.equal(res.hasUnprovenCallback, true);
    assert.equal(
      technicalPortEvidence(
        graph,
        node,
        { role: "technical-port", route: "daemon-local-state", port },
        localStateAction,
        descriptors,
      ),
      null,
    );
    assert.equal(
      clientEntryEvidence(graph, node, { role: "client", route: "todo.add", port }, todoAddAction, descriptors),
      null,
    );
  }

  // 5. Statically proven local-only callback updater still passes daemon-local-state.
  const localPort = `${unprovenFile}#applyLocal.update`;
  const localResolved = resolvedGuiClientBindings(graph, localNode, descriptors);
  assert.equal(localResolved.hasUnprovenCallback, false);
  assert.equal(localResolved.reachesDaemonTransport, false);
  assert.ok(
    technicalPortEvidence(
      graph,
      localNode,
      { role: "technical-port", route: "daemon-local-state", port: localPort },
      localStateAction,
      descriptors,
    ),
  );
});

test("GUI source-proof resolves omitted optional callbacks, concrete class methods on parameters, forwarded hooks, and stream disposer ref maps", async () => {
  const { clientEntryEvidence, resolvedGuiClientBindings, technicalPortEvidence } = await import(
    "../authorization-source-proof.mjs"
  );
  const invokeFile = "packages/gui/src/renderer/api-client-invoke.ts";
  const featureFile = "packages/gui/src/renderer/runtime-feature.tsx";
  const files = {
    "packages/gui/package.json": JSON.stringify({ name: "@harness-anything/gui", type: "module" }),
    [invokeFile]: [
      "export async function invoke(method: string, payload?: unknown) {",
      "  return { method, payload };",
      "}",
    ].join("\n"),
    [featureFile]: [
      'import { useMemo, useRef } from "react";',
      'import { invoke } from "./api-client-invoke.ts";',
      "class RowLog {",
      "  dropOldest() { return 0; }",
      "}",
      "function appendRow(rows: RowLog) {",
      "  return rows.dropOldest();",
      "}",
      "function useInnerHistory() {",
      '  return { run: () => invoke("repo.todo.add", {}) };',
      "}",
      "function useForwardedHistory() {",
      "  const inner = useInnerHistory();",
      "  return inner;",
      "}",
      "function useOptionalRefresh(refresh?: () => Promise<unknown>) {",
      "  const run = async () => {",
      "    const r = new RowLog();",
      "    appendRow(r);",
      '    await invoke("repo.task.pin", {});',
      "    await refresh?.();",
      "  };",
      "  return useMemo(() => ({ run }), []);",
      "}",
      "function bridge() {",
      "  return { attachTerminal: (_id: string) => () => undefined };",
      "}",
      "export function FeatureView() {",
      "  const omitted = useOptionalRefresh();",
      "  const forwarded = useForwardedHistory();",
      "  const stops = useRef(new Map<string, () => void>());",
      '  const stop = bridge().attachTerminal("s1");',
      '  stops.current.set("s1", stop);',
      "  const run = (fn: () => void) => fn();",
      '  const closeOne = () => run(stops.current.get("s1") ?? (() => undefined));',
      "  return <div>{String(Boolean(omitted.run()) && Boolean(forwarded.run()) && Boolean(closeOne))}</div>;",
      "}",
    ].join("\n"),
  };
  const { rootDir } = makeRepo(files);
  symlinkSync(realpathSync(path.join(repoRoot, "node_modules")), path.join(rootDir, "node_modules"), "dir");
  const graph = buildFlowGraph(rootDir, { sourceFiles: [invokeFile, featureFile] });
  const candidates = scanOntologyText(featureFile, files[featureFile])
    .filter((row) => row.category === "action")
    .map((row) => ({ candidateId: row.id }));
  const witnesses = sourceWitnesses(graph, candidates);
  const execNode = [...witnesses.values()].find((n) => n.getText() === "omitted.run()");
  const forwardedNode = [...witnesses.values()].find((n) => n.getText() === "forwarded.run()");
  const closeNode = [...witnesses.values()].find(
    (n) => n.getText() === 'run(stops.current.get("s1") ?? (() => undefined))',
  );
  assert.ok(execNode && forwardedNode && closeNode);

  const descriptors = [
    { id: "task.pin", actionKind: "entity-pin", method: "repo.task.pin", commandClass: "repo-write" },
    { id: "todo.add", actionKind: "todo-add", method: "repo.todo.add", commandClass: "repo-write" },
  ];
  const pinAction = { kind: "entity-pin", executionClass: "repo-write", ontology: {} };
  const todoAddAction = { kind: "todo-add", executionClass: "repo-write", ontology: {} };
  const localStateAction = {
    kind: "daemon-local-state",
    ontology: { owner: "daemon", technical: true, authority: "local-process" },
    receiptSettlement: "none",
  };

  const execRes = resolvedGuiClientBindings(graph, execNode, descriptors);
  assert.equal(execRes.hasUnprovenCallback, false);
  assert.deepEqual(
    execRes.bindings.map((b) => b.route),
    ["task.pin"],
  );
  assert.ok(
    clientEntryEvidence(
      graph,
      execNode,
      { role: "client", route: "task.pin", port: `${featureFile}#useOptionalRefresh.run` },
      pinAction,
      descriptors,
    ),
  );

  const fwdRes = resolvedGuiClientBindings(graph, forwardedNode, descriptors);
  assert.equal(fwdRes.hasUnprovenCallback, false);
  assert.deepEqual(
    fwdRes.bindings.map((b) => b.route),
    ["todo.add"],
  );
  assert.ok(
    clientEntryEvidence(
      graph,
      forwardedNode,
      { role: "client", route: "todo.add", port: `${featureFile}#useInnerHistory.run` },
      todoAddAction,
      descriptors,
    ),
  );

  const closeRes = resolvedGuiClientBindings(graph, closeNode, descriptors);
  assert.equal(closeRes.hasUnprovenCallback, false);
  assert.equal(closeRes.reachesDaemonTransport, false);
  assert.ok(
    technicalPortEvidence(
      graph,
      closeNode,
      { role: "technical-port", route: "daemon-local-state", port: `${featureFile}#FeatureView.run` },
      localStateAction,
      descriptors,
    ),
  );
});

test("all 197 live non-main GUI client sources and 110 daemon-local-state sources pass source proof and reject local evasion", async () => {
  const { loadAuthorizationInputs } = await import("../ontology-durable-action-authorization.mjs");
  const {
    clientEntryEvidence,
    clientEntryRequiredRoutes,
    guiCallbackCallerFiles,
    resolvedGuiClientBindings,
    technicalPortEvidence,
  } = await import("../authorization-source-proof.mjs");
  const inputs = await loadAuthorizationInputs(repoRoot);
  const isNonMainGui = (candidateId) =>
    candidateId.startsWith("action:packages/gui:") &&
    !candidateId.startsWith("action:packages/gui:packages/gui/src/main/");

  const guiClientPairs = inputs.constants.actionDeclarations.flatMap((action) =>
    (action.ontology?.sources ?? [])
      .filter((source) => source.role === "client" && isNonMainGui(source.candidateId))
      .map((source) => ({ action, source })),
  );
  const localState = inputs.constants.actionDeclarations.find((action) => action.kind === "daemon-local-state");
  const guiLocalSources = (localState?.ontology?.sources ?? []).filter((source) => isNonMainGui(source.candidateId));
  assert.equal(guiClientPairs.length, 197);
  assert.equal(new Set(guiClientPairs.map(({ action }) => action.kind)).size, 78);
  assert.equal(guiLocalSources.length, 110);

  const allSources = [...guiClientPairs.map(({ source }) => source), ...guiLocalSources];
  const sourceFiles = [...new Set(allSources.map((s) => s.candidateId.split(":")[2].split("#")[0]))];
  const lexicalFiles = guiCallbackCallerFiles(
    repoRoot,
    sourceFiles.filter((f) => /^packages\/gui\/src\/(?:renderer|preload|browser)\//u.test(f)),
  );
  const graph = buildFlowGraph(repoRoot, { sourceFiles, lexicalFiles });
  const witnesses = sourceWitnesses(graph, allSources);
  const durableIds = new Set(inputs.descriptors.filter((d) => d.commandClass !== "repo-read").map((d) => d.id));

  for (const { action, source } of guiClientPairs) {
    const node = witnesses.get(source.candidateId);
    assert.ok(node, `missing witness for ${source.candidateId}`);
    assert.ok(
      clientEntryEvidence(graph, node, source, action, inputs.descriptors),
      `expected clientEntryEvidence for ${source.candidateId} (${action.kind})`,
    );
    const routes = clientEntryRequiredRoutes(graph, node, source, action, inputs.descriptors);
    if (action.executionClass !== "repo-read") {
      assert.ok(routes.length >= 1, `expected required routes for ${source.candidateId}`);
      for (const route of routes) {
        assert.ok(durableIds.has(route), `missing durable server descriptor ${route} for ${source.candidateId}`);
      }
    }
    assert.equal(
      technicalPortEvidence(
        graph,
        node,
        { ...source, role: "technical-port", route: "daemon-local-state" },
        localState,
        inputs.descriptors,
      ),
      null,
      `expected technicalPortEvidence to reject GUI client ${source.candidateId}`,
    );
  }

  for (const source of guiLocalSources) {
    const node = witnesses.get(source.candidateId);
    assert.ok(node, `missing witness for local GUI source ${source.candidateId}`);
    if (source.role === "support") {
      assert.ok(intrinsicSupport(graph, node), `expected intrinsicSupport for ${source.candidateId}`);
    } else {
      assert.ok(
        technicalPortEvidence(graph, node, source, localState, inputs.descriptors),
        `expected technicalPortEvidence for ${source.candidateId}`,
      );
    }
  }

  // Unmapped non-read RPC in a callback runner branch must fail closed (hasUnprovenCallback = true) rather than silently dropping the route.
  const reviewPair = guiClientPairs.find(({ source }) =>
    source.candidateId.includes("decision-review-actions.ts#useDecisionReviewActions.run.receipt"),
  );
  assert.ok(reviewPair);
  const reviewNode = witnesses.get(reviewPair.source.candidateId);
  const droppedDispatchDescriptors = inputs.descriptors.filter((d) => d.id !== "decision.dispatchReview");
  const droppedResolved = resolvedGuiClientBindings(graph, reviewNode, droppedDispatchDescriptors);
  assert.equal(droppedResolved.hasUnprovenCallback, true);
  assert.equal(
    clientEntryEvidence(graph, reviewNode, reviewPair.source, reviewPair.action, droppedDispatchDescriptors),
    null,
  );
});
