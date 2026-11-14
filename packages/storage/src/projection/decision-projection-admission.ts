import type { DatabaseSync } from "node:sqlite";
import type { DecisionState, DecisionEventV1 } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import { FactProjectionError } from "@harness-anything/kernel/internal/domain/fact-admission.ts";
import {
  assertDecisionAdmissionAtCut,
  type DecisionAdmissionState,
} from "@harness-anything/kernel/internal/domain/decision-admission.ts";
import {
  activeMaterializationHolds,
  materializationEntityRef,
  type MaterializationEntityState,
  type MaterializationRelation,
} from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import { readDecisionDocumentState } from "./decision-projection-reads.ts";
import { prepareQuery, queryRows, runSql } from "./rebuildable-task-projection-sql.ts";

export function assertDecisionAdmission(db: DatabaseSync, event: DecisionEventV1): void {
  const document = readDecisionDocumentState(db, event.decisionId);
  const relations = document
    ? (prepareQuery(
        db,
        "SELECT relation_id, source_ref, target_ref FROM relation_edge WHERE state='active' AND (source_ref GLOB ? OR target_ref GLOB ?) ORDER BY relation_id",
      ).all(
        `decision/${event.decisionId}/*`,
        `decision/${event.decisionId}/*`,
      ) as unknown as DecisionAdmissionState["relations"])
    : [];
  assertDecisionAdmissionAtCut(
    { document, relations, hasSupersedes: hasActiveSupersedesRelation(db, event.decisionId) },
    event,
  );
}

export function decisionMaterializationHeld(db: DatabaseSync, decisionId: string, state: string): boolean {
  const ref = `decision/${decisionId}`,
    pattern = `${ref}/*`,
    source = queryRows<{
      readonly source_ref: string;
      readonly target_ref: string;
      readonly relation_type: string;
      readonly state: string;
    }>(
      db,
      "SELECT source_ref, target_ref, relation_type, state FROM relation_edge INDEXED BY relation_edge_source " +
        "WHERE state='active' AND (source_ref=? OR source_ref GLOB ?)",
      ref,
      pattern,
    ),
    target = queryRows<{
      readonly source_ref: string;
      readonly target_ref: string;
      readonly relation_type: string;
      readonly state: string;
    }>(
      db,
      "SELECT source_ref, target_ref, relation_type, state FROM relation_edge INDEXED BY relation_edge_target " +
        "WHERE state='active' AND (target_ref=? OR target_ref GLOB ?)",
      ref,
      pattern,
    ),
    byId = new Map(
      [...source, ...target].map((edge) => [`${edge.source_ref}\0${edge.target_ref}\0${edge.relation_type}`, edge]),
    );
  const relations: MaterializationRelation[] = [...byId.values()].map((edge) => ({
      source: edge.source_ref,
      target: edge.target_ref,
      type: edge.relation_type as MaterializationRelation["type"],
      state: edge.state,
    })),
    endpointRefs = [
      ...new Set(relations.flatMap(({ source: from, target: to }) => [from, to]).map(materializationEntityRef)),
    ],
    decisionIds = endpointRefs.flatMap((endpoint) => endpoint.match(/^decision\/([^/]+)$/u)?.[1] ?? []),
    taskIds = endpointRefs.flatMap((endpoint) => endpoint.match(/^task\/(.+)$/u)?.[1] ?? []),
    states = new Map<string, MaterializationEntityState>([[ref, { ref, state, kind: "decision" }]]);
  if (decisionIds.length)
    for (const row of queryRows<{ readonly decision_id: string; readonly state: string }>(
      db,
      "SELECT decision_id, state FROM decision WHERE decision_id IN (SELECT value FROM json_each(?))",
      JSON.stringify(decisionIds),
    )) {
      const endpoint = `decision/${row.decision_id}`;
      states.set(endpoint, { ref: endpoint, state: row.state, kind: "decision" });
    }
  if (taskIds.length)
    for (const row of queryRows<{ readonly task_id: string; readonly status: string }>(
      db,
      "SELECT task_id, CASE WHEN json_extract(snapshot_json,'$.task.packageDisposition')='archived' THEN 'archived' ELSE status END AS status FROM task_snapshot WHERE task_id IN (SELECT value FROM json_each(?))",
      JSON.stringify(taskIds),
    )) {
      const endpoint = `task/${row.task_id}`;
      states.set(endpoint, { ref: endpoint, state: row.status, kind: "task" });
    }
  return activeMaterializationHolds({ ref, state, kind: "decision" }, relations, states).length > 0;
}

function hasActiveSupersedesRelation(db: DatabaseSync, decisionId: string): boolean {
  return Boolean(
    prepareQuery(
      db,
      "SELECT 1 FROM relation_edge WHERE target_ref=? AND relation_type='supersedes' AND state='active' " +
        "AND source_ref GLOB 'decision/*' AND source_ref<>? AND source_ref NOT GLOB ? LIMIT 1",
    ).get(`decision/${decisionId}`, `decision/${decisionId}`, `decision/${decisionId}/*`),
  );
}

export function decisionState(
  db: DatabaseSync,
  id: string,
): { readonly state: DecisionState; readonly proposer_json: string } | undefined {
  return prepareQuery(db, "SELECT state,proposer_json FROM decision WHERE decision_id=?").get(id) as
    | { readonly state: DecisionState; readonly proposer_json: string }
    | undefined;
}

export function fail(code: FactProjectionError["code"], message: string): never {
  throw new FactProjectionError(code, message);
}

/** Refresh each affected edge once. The owner index makes subsequent hold tests independent of neighbor degree. */
export function refreshMaterializationHolds(db: DatabaseSync, refs: readonly string[]): readonly string[] {
  const edges = new Map<
      string,
      {
        relation_id: string;
        source_ref: string;
        target_ref: string;
        relation_type: MaterializationRelation["type"];
        state: string;
      }
    >(),
    candidates = new Set(refs.map(materializationEntityRef)),
    states = new Map<string, MaterializationEntityState>();
  for (const ref of candidates)
    for (const edge of queryRows<{
      relation_id: string;
      source_ref: string;
      target_ref: string;
      relation_type: MaterializationRelation["type"];
      state: string;
    }>(
      db,
      "SELECT relation_id,source_ref,target_ref,relation_type,state FROM relation_edge WHERE source_ref=? OR target_ref=? OR " +
        "(source_ref>=? AND source_ref<?) OR (target_ref>=? AND target_ref<?)",
      ref,
      ref,
      `${ref}/`,
      `${ref}0`,
      `${ref}/`,
      `${ref}0`,
    ))
      edges.set(edge.relation_id, edge);
  const stateFor = (ref: string): MaterializationEntityState | null => {
    const cached = states.get(ref);
    if (cached) return cached;
    const [kind, id] = ref.split("/");
    if (kind !== "fact" && kind !== "decision" && kind !== "task") return null;
    const row =
      kind === "decision"
        ? queryRows<{ state: string }>(db, "SELECT state FROM decision WHERE decision_id=?", id!)[0]
        : kind === "task"
          ? queryRows<{ state: string }>(
              db,
              "SELECT CASE WHEN json_extract(snapshot_json,'$.task.packageDisposition')='archived' THEN 'archived' ELSE status END AS state FROM task_snapshot WHERE task_id=?",
              id!,
            )[0]
          : { state: "standing" };
    if (!row) return null;
    const entity: MaterializationEntityState = { ref, kind, state: row.state };
    states.set(ref, entity);
    return entity;
  };
  for (const edge of edges.values()) {
    const source = materializationEntityRef(edge.source_ref),
      target = materializationEntityRef(edge.target_ref),
      entities = [stateFor(source), stateFor(target)].filter((value) => value !== null),
      relation = { source: edge.source_ref, target: edge.target_ref, type: edge.relation_type, state: edge.state };
    runSql(db, "DELETE FROM materialization_hold WHERE relation_id=?", edge.relation_id);
    for (const entity of entities) {
      candidates.add(entity.ref);
      if (activeMaterializationHolds(entity, [relation], states).length)
        runSql(
          db,
          "INSERT OR IGNORE INTO materialization_hold(owner_ref,relation_id) VALUES (?,?)",
          entity.ref,
          edge.relation_id,
        );
    }
  }
  return [...candidates];
}
