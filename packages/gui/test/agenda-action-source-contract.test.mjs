// harness-test-tier: contract
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { actionDeclarations } from "@harness-anything/kernel";
import { buildFlowGraph } from "../../../tools/gates/authorization-flow-graph.mjs";
import { declaredPortKey } from "../../../tools/gates/authorization-gui-source-proof.mjs";
import {
  clientEntryEvidence,
  guiCallbackCallerFiles,
  resolvedGuiClientBindings,
  sourceFileOf,
  sourceWitnesses,
} from "../../../tools/gates/authorization-source-proof.mjs";
import { loadAuthorizationInputs } from "../../../tools/gates/ontology-durable-action-authorization.mjs";

// dec_86761D79CF16E14C4583890F59: the selected-card callbacks must name their actual
// compiler-resolved client ports and retain the existing server authorization route.
test("Agenda action sources bind actual typed ports and reject an unrelated RPC route", async () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const bindings = actionDeclarations.flatMap((action) =>
    (action.ontology?.sources ?? [])
      .filter(
        (source) =>
          /views\/agenda\//u.test(source.candidateId) ||
          /AwaitsAnswerPanel\.tsx#AnswerForm:/u.test(source.candidateId) ||
          /api-client\.ts#harnessClient\.(?:archiveTasks|dismissRuntimeIncident|resolveTaskEscalation):/u.test(
            source.candidateId,
          ),
      )
      .map((source) => ({ action, source })),
  );
  assert.ok(bindings.length > 0);
  const sources = bindings.map(({ source }) => source);
  const files = [...new Set(sources.map(sourceFileOf))];
  const graph = buildFlowGraph(root, { sourceFiles: files, lexicalFiles: guiCallbackCallerFiles(root, files) });
  const witnesses = sourceWitnesses(graph, sources);
  const { descriptors } = await loadAuthorizationInputs(root);
  const failures = [];
  for (const { action, source } of bindings) {
    const node = witnesses.get(source.candidateId);
    assert.ok(node, source.candidateId);
    const actualPort = declaredPortKey(graph, node);
    if (source.port !== actualPort || !clientEntryEvidence(graph, node, source, action, descriptors)) {
      failures.push({
        id: source.candidateId,
        declared: source.port,
        actualPort,
        resolved: resolvedGuiClientBindings(graph, node, descriptors),
      });
    }
    assert.equal(
      clientEntryEvidence(graph, node, { ...source, route: "task.delete" }, action, descriptors),
      null,
      `wrong route must remain rejected: ${source.candidateId}`,
    );
  }
  assert.deepEqual(failures, []);
});
