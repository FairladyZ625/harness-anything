// harness-test-tier: contract
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readWorkspacePackages } from "../../public-workspaces.mjs";
import { formatOntologyFacetShard, ontologyFacetShardFiles } from "../../refresh-ontology-facets.mjs";
import { auditOntologyClosure } from "../ontology-closure-audit.mjs";
import { scanOntologyText } from "../ontology-closure-scan.mjs";
import { loadOntologyClosureSnapshot } from "../ontology-gate-lib.mjs";

const repo = path.resolve(import.meta.dirname, "../../..");
const domainPath = "packages/kernel/src/domain";
const domain = path.join(repo, domainPath);

test("each facet family matches the workspace package list and refreshes deterministically", () => {
  const packages = [...readWorkspacePackages(repo).map(({ directory }) => path.basename(directory)), "tools"].sort();
  const files = ontologyFacetShardFiles(domain);
  for (const family of ["action-source-facets", "source-contract-facets"]) {
    assert.deepEqual(
      files.filter((file) => file.startsWith(`${family}/`)),
      packages.map((name) => `${family}/${name}.json`),
    );
  }
  for (const file of files) {
    const text = readFileSync(path.join(domain, file), "utf8").replaceAll("\r\n", "\n");
    assert.equal(formatOntologyFacetShard(file, text), text, file);
  }
});

test("refresh sorts its shard and rejects a source from a different package", () => {
  const file = "action-source-facets/cli.json";
  const source = (name, owner = "cli") => ({
    candidateId: `action:packages/${owner}:packages/${owner}/src/${name}.ts#run`,
    route: "run",
  });
  const a = { ...source("a"), order: 1 },
    b = { ...source("b"), order: 0 };
  assert.deepEqual(JSON.parse(formatOntologyFacetShard(file, JSON.stringify({ sources: { run: [b, a] } }))), {
    sources: { run: [a, b] },
  });
  assert.throws(
    () => formatOntologyFacetShard(file, JSON.stringify({ sources: { run: [source("run", "storage")] } })),
    /belongs in storage, found in cli/u,
  );
});

test("closure rejects tampering with a source or contract loaded from disk shards", (t) => {
  const repoCopy = mkdtempSync(path.join(tmpdir(), "ontology-facet-shards-"));
  t.after(() => rmSync(repoCopy, { recursive: true, force: true }));
  const target = path.join(repoCopy, domainPath);
  mkdirSync(target, { recursive: true });
  for (const name of [
    "action-declaration.ts",
    "action-source-facets.ts",
    "action-source-facets",
    "ontology-facet-order.ts",
    "source-contract-facets.ts",
    "source-contract-facets",
  ])
    cpSync(path.join(domain, name), path.join(target, name), { recursive: true });
  writeFileSync(
    path.join(target, "entity-kind-registry.ts"),
    'import { sourceContractFacets } from "./source-contract-facets.ts";\n' +
      "export const entityKindContracts = Object.entries(sourceContractFacets).map(([kind, {contracts, judgments}]) => ({kind, judgments, sourceContracts: contracts}));\n",
  );
  const analyze = (id) => {
    const file = id.split(":")[2].split("#")[0];
    const candidates = scanOntologyText(file, readFileSync(path.join(repo, file), "utf8")).filter(
      (row) => row.id === id,
    );
    assert.equal(candidates.length, 1, id);
    return auditOntologyClosure({ candidates, baseline: [], snapshot: loadOntologyClosureSnapshot(repoCopy) }).findings;
  };

  const actionFile = path.join(target, "action-source-facets/gui.json"),
    actionShard = JSON.parse(readFileSync(actionFile, "utf8")),
    [action] = actionShard.sources["entity-delete"];
  assert.deepEqual(analyze(action.candidateId), []);
  actionShard.sources["entity-delete"].shift();
  writeFileSync(actionFile, JSON.stringify(actionShard));
  const actionFindings = analyze(action.candidateId);
  assert.deepEqual(
    actionFindings.map(({ code, id }) => [code, id]),
    [["ONTOLOGY_ACTION_UNDECLARED", action.candidateId]],
  );
  t.diagnostic(`${actionFindings[0].code} ${actionFindings[0].id}`);

  const contractFile = path.join(target, "source-contract-facets/application.json"),
    contractShard = JSON.parse(readFileSync(contractFile, "utf8")),
    [contract] = Object.values(contractShard).flatMap(({ contracts }) => contracts),
    [source] = contract.sources;
  assert.deepEqual(analyze(source.candidateId), []);
  source.route = `${contract.symbol}.wrong`;
  writeFileSync(contractFile, JSON.stringify(contractShard));
  const contractFindings = analyze(source.candidateId);
  assert.deepEqual(
    contractFindings.map(({ code, id }) => [code, id]),
    [["ONTOLOGY_JUDGMENT_DUPLICATE", source.candidateId]],
  );
  t.diagnostic(`${contractFindings[0].code} ${contractFindings[0].id}`);
});
