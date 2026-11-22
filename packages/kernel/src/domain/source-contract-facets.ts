import application from "./source-contract-facets/application.json" with { type: "json" };
import authorization from "./source-contract-facets/authorization.json" with { type: "json" };
import cli from "./source-contract-facets/cli.json" with { type: "json" };
import daemon from "./source-contract-facets/daemon.json" with { type: "json" };
import dshPlugin from "./source-contract-facets/dsh-plugin.json" with { type: "json" };
// dec_42EB7B8F636C12381A447E52A3/CH2: source contract facet shard for independent packages/gui-fde.
import guiFde from "./source-contract-facets/gui-fde.json" with { type: "json" };
import gui from "./source-contract-facets/gui.json" with { type: "json" };
import kernel from "./source-contract-facets/kernel.json" with { type: "json" };
import preset from "./source-contract-facets/preset.json" with { type: "json" };
import storage from "./source-contract-facets/storage.json" with { type: "json" };
import tools from "./source-contract-facets/tools.json" with { type: "json" };
import { facetRowsInOrder, type OrderedFacetRow } from "./ontology-facet-order.ts";
import type { OntologyJudgmentDeclaration, OntologySourceContract } from "./ontology-source.ts";

type ContractRows = {
  contracts: OrderedFacetRow<OntologySourceContract>[];
  judgments: OrderedFacetRow<OntologyJudgmentDeclaration>[];
};
const shards = [
  application,
  authorization,
  cli,
  daemon,
  dshPlugin,
  guiFde,
  gui,
  kernel,
  preset,
  storage,
  tools,
] as readonly Readonly<Record<string, ContractRows>>[];

const rowsByKind = new Map<string, ContractRows>();
for (const shard of shards) {
  for (const [kind, rows] of Object.entries(shard)) {
    let group = rowsByKind.get(kind);
    if (!group) {
      group = { contracts: [], judgments: [] };
      rowsByKind.set(kind, group);
    }
    group.contracts.push(...rows.contracts);
    group.judgments.push(...rows.judgments);
  }
}

export const sourceContractFacets = Object.freeze(
  Object.fromEntries(
    [...rowsByKind].map(([kind, group]) => [
      kind,
      Object.freeze({
        judgments: facetRowsInOrder(group.judgments, (row) => row.id),
        contracts: facetRowsInOrder(group.contracts, (row) => row.id),
      }),
    ]),
  ),
);
