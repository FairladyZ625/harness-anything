import { realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { buildFlowGraph } from "../authorization-flow-graph.mjs";
import { sourceWitnesses } from "../authorization-source-proof.mjs";
import { scanOntologyText } from "../ontology-closure-scan.mjs";
import { makeRepo } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
export const file = "packages/demo/scripts/copy-assets.mjs";
export function fixture(text, scripts = { build: "node scripts/copy-assets.mjs" }, extraFiles = {}) {
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
export function callNamed(graph, file, name) {
  const source = graph.modules.get(file)?.sourceFile;
  let found = null;
  (function visit(node) {
    if (found) return;
    if (ts.isCallExpression(node) && node.expression.getText(source) === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  })(source);
  return found;
}
