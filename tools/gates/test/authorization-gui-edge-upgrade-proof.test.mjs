// harness-test-tier: fast
import assert from "node:assert/strict";
import { realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildFlowGraph } from "../authorization-flow-graph.mjs";
import {
  clientEntryEvidence,
  resolvedGuiClientBindings,
  sourceWitnesses,
  technicalPortEvidence,
} from "../authorization-source-proof.mjs";
import { scanOntologyText } from "../ontology-closure-scan.mjs";
import { makeRepo } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("edge-upgrade preload IPC channels prove host-local technical ports and fail closed on daemon or unmapped channels", () => {
  const contractFile = "packages/gui/src/api/edge-upgrade-contract.ts";
  const preloadFile = "packages/gui/src/preload/edge-upgrade-preload.ts";
  const files = {
    "packages/gui/package.json": JSON.stringify({ name: "@harness-anything/gui", type: "module" }),
    [contractFile]: [
      'export const EDGE_UPGRADE_STATUS_CHANNEL = "harness:edge-upgrade-status";',
      'export const EDGE_UPGRADE_RUN_CHANNEL = "harness:edge-upgrade-run";',
      'export const EDGE_UPGRADE_RELAUNCH_CHANNEL = "harness:edge-upgrade-relaunch";',
      'export const RPC_CHANNEL = "harness:rpc";',
      'export const UNKNOWN_CHANNEL = "harness:unknown";',
    ].join("\n"),
    [preloadFile]: [
      "import {",
      "  EDGE_UPGRADE_RELAUNCH_CHANNEL,",
      "  EDGE_UPGRADE_RUN_CHANNEL,",
      "  EDGE_UPGRADE_STATUS_CHANNEL,",
      "  RPC_CHANNEL,",
      "  UNKNOWN_CHANNEL,",
      '} from "../api/edge-upgrade-contract.ts";',
      "export function edgeUpgradePreloadApi(invoke: (channel: string, request: unknown) => Promise<unknown>) {",
      "  return {",
      "    status: () => invoke(EDGE_UPGRADE_STATUS_CHANNEL, null),",
      "    run: () => invoke(EDGE_UPGRADE_RUN_CHANNEL, {}),",
      "    relaunch: () => invoke(EDGE_UPGRADE_RELAUNCH_CHANNEL, null),",
      "    evadeRpc: () => invoke(RPC_CHANNEL, {}),",
      "    evadeUnknown: () => invoke(UNKNOWN_CHANNEL, {}),",
      "  };",
      "}",
    ].join("\n"),
  };
  const { rootDir } = makeRepo(files);
  symlinkSync(realpathSync(path.join(repoRoot, "node_modules")), path.join(rootDir, "node_modules"), "dir");
  const graph = buildFlowGraph(rootDir, { sourceFiles: [contractFile, preloadFile] });
  const candidates = scanOntologyText(preloadFile, files[preloadFile])
    .filter((row) => row.category === "action")
    .map((row) => ({ candidateId: row.id }));
  const witnesses = sourceWitnesses(graph, candidates);
  const nodeFor = (fragment) => [...witnesses.entries()].find(([id]) => id.includes(fragment))?.[1];

  const localStateAction = {
    kind: "daemon-local-state",
    residency: { scope: "host-local" },
    ontology: { owner: "daemon", technical: true, authority: "local-process" },
    receiptSettlement: "none",
  };
  const readAction = { kind: "repository-read", executionClass: "repo-read", ontology: {} };
  const port = `${preloadFile}#edgeUpgradePreloadApi.invoke`;

  for (const method of ["status", "run", "relaunch"]) {
    const node = nodeFor(`edgeUpgradePreloadApi.${method}:`);
    assert.ok(node, `missing witness for ${method}`);
    const resolved = resolvedGuiClientBindings(graph, node, []);
    assert.equal(resolved.hasUnprovenCallback, false, method);
    assert.equal(resolved.reachesDaemonTransport, false, method);
    assert.ok(
      technicalPortEvidence(
        graph,
        node,
        { role: "technical-port", route: "daemon-local-state", port },
        localStateAction,
        [],
      ),
      `expected technicalPortEvidence for ${method}`,
    );
    assert.equal(
      clientEntryEvidence(graph, node, { role: "client", route: "repository-read", port }, readAction, []),
      null,
      `expected clientEntryEvidence to reject local-only ${method}`,
    );
  }

  for (const method of ["evadeRpc", "evadeUnknown"]) {
    const node = nodeFor(`edgeUpgradePreloadApi.${method}:`);
    assert.ok(node, `missing witness for ${method}`);
    assert.equal(
      technicalPortEvidence(
        graph,
        node,
        { role: "technical-port", route: "daemon-local-state", port },
        localStateAction,
        [],
      ),
      null,
      `expected technicalPortEvidence to fail closed on ${method}`,
    );
  }
});
