import application from "./action-source-facets/application.json" with { type: "json" };
import authorization from "./action-source-facets/authorization.json" with { type: "json" };
import cli from "./action-source-facets/cli.json" with { type: "json" };
import daemon from "./action-source-facets/daemon.json" with { type: "json" };
import dshPlugin from "./action-source-facets/dsh-plugin.json" with { type: "json" };
import gui from "./action-source-facets/gui.json" with { type: "json" };
import kernel from "./action-source-facets/kernel.json" with { type: "json" };
import preset from "./action-source-facets/preset.json" with { type: "json" };
import storage from "./action-source-facets/storage.json" with { type: "json" };
import tools from "./action-source-facets/tools.json" with { type: "json" };
import { facetRowsInOrder, type OrderedFacetRow } from "./ontology-facet-order.ts";
import type { OntologyActionSources, OntologySourceBinding } from "./ontology-source.ts";

type SourceRow = OrderedFacetRow<OntologySourceBinding>;
const actionMetadata = kernel.actions as Readonly<Record<string, Omit<OntologyActionSources, "sources">>>;
const shards = [application, authorization, cli, daemon, dshPlugin, gui, kernel, preset, storage, tools] as readonly {
  readonly sources: Readonly<Record<string, readonly SourceRow[]>>;
}[];

// Action metadata belongs to the kernel declarations; each call site belongs to its source package.
const sourcesByAction = new Map<string, SourceRow[]>(Object.keys(actionMetadata).map((kind) => [kind, []]));
for (const { sources } of shards) {
  for (const [kind, rows] of Object.entries(sources)) {
    const actionSources = sourcesByAction.get(kind);
    if (!actionSources) throw new Error(`Ontology source shard references undeclared action ${kind}`);
    actionSources.push(...rows);
  }
}

export const actionSourceFacets: Readonly<Record<string, OntologyActionSources>> = Object.freeze(
  Object.fromEntries(
    Object.entries(actionMetadata).map(([kind, metadata]) => [
      kind,
      Object.freeze({ ...metadata, sources: facetRowsInOrder(sourcesByAction.get(kind)!, (row) => row.candidateId) }),
    ]),
  ),
);
