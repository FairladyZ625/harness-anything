import {
  isFactEvent,
  isMigrationImportEvent,
  stableStringify,
  type PersistedCanonicalEventV1,
} from "../../kernel/src/index.ts";
import type { EmbeddedRelationRestatementDifference } from "./embedded-relation-restatement.ts";

export interface FactRekeyEvidencePlan {
  readonly facts: readonly { readonly row: { readonly taskId?: string } }[];
  readonly map: ReadonlyMap<string, string>;
  readonly relationMap: ReadonlyMap<string, string>;
  readonly eventRewrites: readonly { readonly event: PersistedCanonicalEventV1 }[];
  readonly docsOnly: readonly unknown[];
  readonly embeddedRelationRestatements: readonly EmbeddedRelationRestatementDifference[];
  readonly migrationTaskProvenanceRestatements: readonly {
    readonly opId: string;
    readonly sourcePath: string;
  }[];
  readonly rewrittenAgentEvents: number;
  readonly rewrittenSettingsEvents: number;
}

export function factRekeyIdMapBody(plan: FactRekeyEvidencePlan): string {
  return `${stableStringify(factRekeyEvidence(plan))}\n`;
}

export function factRekeyEvidence(plan: FactRekeyEvidencePlan) {
  return {
    schema: "fact-rekey-id-map/v1",
    maps: {
      fact: Object.fromEntries(plan.map),
      relation: Object.fromEntries(plan.relationMap),
    },
    counts: factRekeyCounts(plan),
    embeddedRelationRestatements: plan.embeddedRelationRestatements,
    migrationTaskProvenanceRestatements: plan.migrationTaskProvenanceRestatements,
  };
}

function factRekeyCounts(plan: FactRekeyEvidencePlan): Record<string, number> {
  return {
    rekeyedFacts: plan.facts.length,
    factEvents: plan.eventRewrites.filter(({ event }) => isFactEvent(event)).length + plan.docsOnly.length,
    producesEdges: plan.facts.filter((fact) => fact.row.taskId).length,
    retargetedRelations: [...plan.relationMap].filter(([from, to]) => from !== to).length,
    rewrittenRelationEvents: plan.eventRewrites.filter(
      ({ event }) => isMigrationImportEvent(event) && event.payload.entity.kind === "relation",
    ).length,
    rewrittenEmbeddedRelationEvents: plan.embeddedRelationRestatements.length,
    rewrittenMigrationTaskEvents: plan.migrationTaskProvenanceRestatements.length,
    rewrittenDecisionEvents: plan.eventRewrites.filter(({ event }) => event.schema === "decision-event/v1").length,
    rewrittenTaskEvents: plan.eventRewrites.filter(({ event }) => event.schema === "task-event/v1").length,
    rewrittenAgentEvents: plan.rewrittenAgentEvents,
    rewrittenSettingsEvents: plan.rewrittenSettingsEvents,
  };
}
