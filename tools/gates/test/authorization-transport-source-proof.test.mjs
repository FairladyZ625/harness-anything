// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildFlowGraph } from "../authorization-flow-graph.mjs";
import { declaredPortKey } from "../authorization-gui-source-proof.mjs";
import { clientEntryEvidence, sourceWitnesses, technicalPortEvidence } from "../authorization-source-proof.mjs";
import { loadAuthorizationInputs } from "../ontology-durable-action-authorization.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const transportPort =
  /#(?:relayStream\.onValue|readDaemonStreamAt\.send|openRemoteProxyManager\.stream\.(?:detach|onValue)|exposedHarnessApi\.subscribe(?:\.stop)?):/u;

test("dec_89D06D7360CBEC09795F7B12EC: recovery framing and cancellation bind to exact transport ports", async () => {
  const { constants, descriptors } = await loadAuthorizationInputs(root);
  const sources = constants.actionDeclarations.flatMap((action) =>
    (action.ontology?.sources ?? [])
      .filter((source) => transportPort.test(source.candidateId))
      .map((source) => ({ action, source })),
  );
  assert.equal(sources.length, 7);
  const sourceFiles = sources.map(({ source }) => source.candidateId.split(":")[2].split("#")[0]);
  const graph = buildFlowGraph(root, { sourceFiles });
  const witnesses = sourceWitnesses(
    graph,
    sources.map(({ source }) => source),
  );
  const declaredPorts = {};
  const registeredPorts = {};
  for (const { source } of sources) {
    const node = witnesses.get(source.candidateId);
    declaredPorts[source.candidateId] = node ? declaredPortKey(graph, node) : null;
    registeredPorts[source.candidateId] = source.port;
  }
  assert.deepEqual(declaredPorts, registeredPorts);
  for (const { action, source } of sources) {
    const node = witnesses.get(source.candidateId);
    const proof = source.role === "client" ? clientEntryEvidence : technicalPortEvidence;
    assert.ok(proof(graph, node, source, action, descriptors), source.candidateId);
    assert.equal(proof(graph, node, { ...source, port: `${source.port}.wrong` }, action, descriptors), null);
  }
});
