// Shared source inputs within one test process / partition. No authorization result is cached.
import path from "node:path";
import { buildFlowGraph, freshEvaluationGraph } from "../authorization-flow-graph.mjs";
import { guiCallbackCallerFiles, sourceFileOf } from "../authorization-source-proof.mjs";
import { auditDurableActionAuthorization, loadAuthorizationInputs } from "../ontology-durable-action-authorization.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
let inputsPromise, baselineInputs, graph;

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
          sourceFiles.filter((file) => /^packages\/gui\/src\/(?:renderer|preload|browser)\//u.test(file)),
        ),
      }),
    );
  }
  return graph;
}

export function baselineFlowGraph() {
  return freshEvaluationGraph(baselineSourceGraph());
}

export function auditWithBaseline(rootDir, inputs, options = {}) {
  return auditDurableActionAuthorization(rootDir, inputs, {
    ...(rootDir === repoRoot && (options.sourceRoot ?? rootDir) === repoRoot ? { graph: baselineSourceGraph() } : {}),
    ...options,
  });
}
