// Shared source inputs within one test process / partition. No authorization result is cached.
import path from "node:path";
import fs from "node:fs";
import { afterEach } from "node:test";
import { walkTypeScriptFiles } from "../ontology-gate-lib.mjs";
import { buildFlowGraph, freshEvaluationGraph } from "../authorization-flow-graph.mjs";
import { guiCallbackCallerFiles, sourceFileOf } from "../authorization-source-proof.mjs";
import { auditDurableActionAuthorization, loadAuthorizationInputs } from "../ontology-durable-action-authorization.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
let inputsPromise, baselineInputs, graph, activeQueries, activeMutation;

afterEach(() => {
  activeQueries?.releaseQueries();
  activeMutation?.releaseQueries();
  activeQueries = activeMutation = null;
});

export function baselineAuthorizationInputs() {
  return (inputsPromise ??= loadAuthorizationInputs(repoRoot).then((inputs) => {
    // Declaration mutations use copies; never replace a shared audit input in place.
    Object.freeze(inputs.constants);
    Object.freeze(inputs.functions);
    baselineInputs = Object.freeze(inputs);
    return baselineInputs;
  }));
}

function baselineSourceGraph() {
  if (!graph) {
    const actions = baselineInputs.constants.actionDeclarations,
      sourceFiles = [
        ...new Set(
          actions.flatMap((action) => [
            ...(action.ontology?.sources ?? []).map(sourceFileOf),
            ...Object.values(action.ontology?.entries ?? {}).flatMap((entry) => [
              entry.file,
              ...(entry.builder ? [entry.builder] : []),
            ]),
          ]),
        ),
      ];
    // TypeScript lazily fills its own source/type indexes. Freeze the public graph
    // shell, not AST nodes or the checker's internal source-only caches.
    graph = Object.freeze(
      buildFlowGraph(repoRoot, {
        sourceFiles,
        lexicalFiles: guiCallbackCallerFiles(
          repoRoot,
          sourceFiles.filter((file) => /^packages\/gui\/src\/(?:renderer|preload|browser|main)\//u.test(file)),
        ),
      }),
    );
  }
  return graph;
}

export function baselineFlowGraph(sourceRoot = repoRoot) {
  activeQueries?.releaseQueries();
  return (activeQueries = freshEvaluationGraph(
    sourceRoot === repoRoot ? baselineSourceGraph() : mutationGraph(sourceRoot),
  ));
}

export function mutatedFlowGraph(overrides) {
  activeMutation?.releaseQueries();
  return (activeMutation = baselineSourceGraph().withSourceOverrides(overrides));
}

function mutationGraph(sourceRoot) {
  const baseline = baselineSourceGraph(),
    overrides = new Map(),
    packagesDir = path.join(sourceRoot, "packages"),
    copiedRoots = fs.existsSync(packagesDir)
      ? fs
          .readdirSync(packagesDir)
          .filter((entry) => !fs.lstatSync(path.join(packagesDir, entry)).isSymbolicLink())
          .map((entry) => `packages/${entry}`)
      : ["packages"];
  // Compare only copied modules. Symlinked packages remain the same read-only source.
  const files = new Set([
    ...[...baseline.modules.keys()].filter((file) =>
      copiedRoots.some((root) => file === root || file.startsWith(`${root}/`)),
    ),
    ...copiedRoots.flatMap((root) => walkTypeScriptFiles(sourceRoot, root)),
  ]);
  for (const file of files) {
    const sourceFile = baseline.modules.get(file)?.sourceFile;
    const candidate = path.join(sourceRoot, file);
    if (!fs.existsSync(candidate)) continue;
    const text = fs.readFileSync(candidate, "utf8");
    if (text !== sourceFile?.text) overrides.set(file, text);
  }
  return overrides.size === 0 ? baseline : baseline.withSourceOverrides(overrides);
}

export function auditWithBaseline(rootDir, inputs, options = {}) {
  const sourceRoot = options.sourceRoot ?? rootDir;
  const graph =
    options.graph ??
    (rootDir === repoRoot ? (sourceRoot === repoRoot ? baselineSourceGraph() : mutationGraph(sourceRoot)) : undefined);
  return auditDurableActionAuthorization(rootDir, inputs, { ...options, ...(graph ? { graph } : {}) });
}
