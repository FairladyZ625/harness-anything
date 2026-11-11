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
