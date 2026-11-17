// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { loadAuthorizationInputs } from "../ontology-durable-action-authorization.mjs";
import { buildFlowGraph } from "../authorization-flow-graph.mjs";
import { declaredPortKey } from "../authorization-gui-source-proof.mjs";
import { sourceFileOf, sourceWitnesses, technicalPortEvidence } from "../authorization-source-proof.mjs";

// dec_04A9211B073F29F0FC1E1CA573 CH2: a transport certificate must name its actual typed call, never another authority.
test("isolated commit and orchestration ports retain exact typed technical ownership", async () => {
  const root = process.cwd(),
    inputs = await loadAuthorizationInputs(root),
    owner = inputs.constants.actionDeclarations.find((action) => action.kind === "daemon-local-state"),
    sources = owner.ontology.sources.filter(
      (source) =>
        source.role === "technical-port" &&
        /(?:canonical-commit-(?:client|worker)|repo-orchestration-(?:host|worker)|repo-writer-host|commit-worker-client|sqlite-git-outbox-publisher)\.ts#/u.test(
          source.candidateId,
        ),
    ),
    graph = buildFlowGraph(root, { sourceFiles: [...new Set(sources.map(sourceFileOf))] }),
    witnesses = sourceWitnesses(graph, sources);
  assert.ok(sources.length > 0);
  for (const source of sources) {
    const node = witnesses.get(source.candidateId);
    assert.ok(node, source.candidateId);
    assert.equal(source.port, declaredPortKey(graph, node), source.candidateId);
    assert.ok(technicalPortEvidence(graph, node, source, owner, inputs.descriptors), source.candidateId);
    assert.equal(
      technicalPortEvidence(graph, node, { ...source, route: "runtime-run" }, owner, inputs.descriptors),
      null,
    );
    assert.equal(
      technicalPortEvidence(graph, node, { ...source, port: "unrelated.ts#write" }, owner, inputs.descriptors),
      null,
    );
  }
});
