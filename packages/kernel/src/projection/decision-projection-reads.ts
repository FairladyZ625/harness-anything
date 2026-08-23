import type { DatabaseSync } from "node:sqlite";
import type { SessionProvenanceV1 } from "../domain/agent-runtime.ts";
import type {
  DecisionAmendmentV1,
  DecisionContentPinV1,
  DecisionFulfillmentMode,
  DecisionJudgmentConsentV1,
  DecisionState,
} from "../domain/decision-event.ts";
import type { ActorIdentity } from "../domain/write-chain.contract.ts";
import { decisionCoverage } from "./decision-projection-coverage.ts";
import { decisionBodyFromDocument } from "./decision-projection-documents.ts";
import type {
  DecisionAgendaProjectionRow,
  DecisionAnchorRow,
  DecisionCoverageRow,
  DecisionListFilters,
  DecisionPageQuery,
  DecisionProjectionRow,
  DecisionRelationEdgeRow,
} from "./decision-projection-model.ts";
import { ftsQuery } from "./fts-query.ts";
import {
  checkedPageLimit,
  decodePageCursor,
  encodePageCursor,
  type ProjectionPage,
} from "./task-query-projection.ts";

export function readDecisionRow(
  db: DatabaseSync,
  decisionId: string,
  withBody = true,
): DecisionProjectionRow | null {
  return readDecisionRows(db, [decisionId], withBody)[0] ?? null;
}

export function readDecisionRows(
  db: DatabaseSync,
  decisionIds: readonly string[],
  withBody = true,
): readonly DecisionProjectionRow[] {
  if (
    !Array.isArray(decisionIds) ||
    decisionIds.some(
      (decisionId) => typeof decisionId !== "string" || decisionId.length === 0,
    )
  )
    throw new Error("decision collection read requires non-empty string ids");
  if (decisionIds.length === 0) return [];
  const bodyColumn = withBody ? "document.value_json" : "NULL",
    bodyJoin = withBody
      ? "LEFT JOIN document ON document.path = 'decisions/decision-' || decision.decision_id || '/decision.md'"
      : "";
  const sql = `WITH requested_decisions(request_order, decision_id) AS MATERIALIZED (SELECT CAST(key AS INTEGER), value FROM json_each(?))
    SELECT requested_decisions.request_order, decision.decision_id, decision.state, decision.title, decision.question, decision.risk_tier, decision.urgency, decision.vertical, decision.preset, decision.decision_class, decision.applies_json, decision.proposer_json, decision.arbiter_json, decision.proposed_at, decision.decided_at, decision.provenance_json, decision.workspace_revision,
      ${bodyColumn} AS body_document_json,
      COALESCE((SELECT json_group_array(json_object('kind', kind, 'option_id', option_id, 'text', text, 'rationale', rationale)) FROM (SELECT kind, option_id, text, rationale FROM decision_option WHERE decision_id = decision.decision_id ORDER BY kind, position)), '[]') AS options_json,
      COALESCE((SELECT json_group_array(json_object('claim_id', claim_id, 'text', text, 'load_bearing', load_bearing, 'fulfillment', fulfillment)) FROM (SELECT claim_id, text, load_bearing, fulfillment FROM decision_claim WHERE decision_id = decision.decision_id ORDER BY position)), '[]') AS claims_json,
      COALESCE((SELECT json_group_array(value_json) FROM (SELECT value_json FROM decision_judgment_consent WHERE decision_id = decision.decision_id ORDER BY workspace_revision)), '[]') AS consents_json,
      COALESCE((SELECT json_group_array(value_json) FROM (SELECT value_json FROM decision_amendment WHERE decision_id = decision.decision_id ORDER BY workspace_revision)), '[]') AS amendments_json,
      COALESCE((SELECT json_group_array(value_json) FROM (SELECT value_json FROM decision_content_pin WHERE decision_id = decision.decision_id ORDER BY workspace_revision)), '[]') AS pins_json
    FROM requested_decisions JOIN decision ON decision.decision_id = requested_decisions.decision_id ${bodyJoin}
    ORDER BY requested_decisions.request_order`;
  return (
    db
      .prepare(sql)
      .all(
        JSON.stringify(decisionIds),
      ) as unknown as readonly DecisionCollectionRecord[]
  ).map(decisionCollectionRow);
}

interface DecisionCollectionRecord extends Record<string, unknown> {
  readonly decision_id: string;
  readonly state: string;
  readonly title: string;
  readonly question: string;
  readonly risk_tier: string;
  readonly urgency: string;
  readonly vertical: string;
  readonly preset: string;
  readonly decision_class: string;
  readonly applies_json: string;
  readonly proposer_json: string;
  readonly arbiter_json: string | null;
  readonly proposed_at: string;
  readonly decided_at: string | null;
  readonly provenance_json: string;
  readonly workspace_revision: number;
  readonly body_document_json: string | null;
  readonly options_json: string;
  readonly claims_json: string;
  readonly consents_json: string;
  readonly amendments_json: string;
  readonly pins_json: string;
}

function decisionCollectionRow(
  row: DecisionCollectionRecord,
): DecisionProjectionRow {
  const decisionId = row.decision_id,
    legacyId = decisionLegacyId(decisionId),
    options = JSON.parse(row.options_json) as {
      readonly kind: string;
      readonly option_id: string;
      readonly text: string;
      readonly rationale: string | null;
    }[],
    claims = JSON.parse(row.claims_json) as {
      readonly claim_id: string;
      readonly text: string;
      readonly load_bearing: number;
      readonly fulfillment: DecisionFulfillmentMode | null;
    }[],
    consents = (JSON.parse(row.consents_json) as string[]).map(
      (value) => JSON.parse(value) as DecisionJudgmentConsentV1,
    ),
    amendments = (JSON.parse(row.amendments_json) as string[]).map(
      (value) => JSON.parse(value) as DecisionAmendmentV1,
    ),
    pins = (JSON.parse(row.pins_json) as string[]).map(
      (value) => JSON.parse(value) as DecisionContentPinV1,
    ),
    body =
      row.body_document_json === null
        ? null
        : decisionBodyFromDocument(decisionId, row.body_document_json);
  return {
    schema: "decision-row/v1",
    decisionId,
    ...(legacyId ? { legacyId } : {}),
    path: `decisions/decision-${decisionId}/decision.md`,
    state: row.state as DecisionState,
    title: row.title,
    question: row.question,
    riskTier: row.risk_tier as DecisionProjectionRow["riskTier"],
    urgency: row.urgency as DecisionProjectionRow["urgency"],
    vertical: row.vertical,
    preset: row.preset,
    decisionClass: row.decision_class as DecisionProjectionRow["decisionClass"],
    appliesTo: JSON.parse(
      row.applies_json,
    ) as DecisionProjectionRow["appliesTo"],
    proposer: JSON.parse(row.proposer_json) as ActorIdentity,
    arbiter:
      row.arbiter_json === null
        ? null
        : (JSON.parse(row.arbiter_json) as ActorIdentity),
    proposedAt: row.proposed_at,
    decidedAt: row.decided_at,
    provenance: JSON.parse(
      row.provenance_json,
    ) as readonly SessionProvenanceV1[],
    workspaceRevision: Number(row.workspace_revision),
    chosen: options
      .filter((option) => option.kind === "chosen")
      .map((option) => ({
        id: option.option_id,
        text: option.text,
        ...(option.rationale ? { rationale: option.rationale } : {}),
      })),
    rejected: options
      .filter((option) => option.kind === "rejected")
      .map((option) => ({
        id: option.option_id,
        text: option.text,
        whyNot: option.rationale!,
      })),
    claims: claims.map((claim) => ({
      id: claim.claim_id,
      text: claim.text,
      loadBearing: Boolean(claim.load_bearing),
      fulfillment: claim.fulfillment,
    })),
    judgmentConsents: consents,
    ...(amendments.length ? { amendments } : {}),
    ...(pins.length ? { contentPins: pins } : {}),
    body,
  };
}

export function listDecisionRows(
  db: DatabaseSync,
  filters: DecisionListFilters,
): readonly DecisionProjectionRow[] {
  const where: string[] = [],
    values: string[] = [];
  if (filters.search?.trim()) {
    where.push(
      "decision_id IN (SELECT decision_id FROM decision_fts WHERE decision_fts MATCH ?)",
    );
    values.push(ftsQuery(filters.search));
  }
  if (filters.state) {
    where.push("state=?");
    values.push(filters.state);
  }
  if (filters.module) {
    where.push(
      "EXISTS (SELECT 1 FROM json_each(decision.applies_json, '$.modules') WHERE value=?)",
    );
    values.push(filters.module);
  }
  if (filters.productLine) {
    where.push(
      "EXISTS (SELECT 1 FROM json_each(decision.applies_json, '$.productLines') WHERE value=?)",
    );
    values.push(filters.productLine);
  }
  return (
    db
      .prepare(
        `SELECT decision_id FROM decision${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`,
      )
      .all(...values) as unknown as readonly { readonly decision_id: string }[]
  )
    .map((row) => row.decision_id)
    .filter((decisionId) => {
      const legacy = decisionLegacyId(decisionId);
      return (
        (!filters.legacyId || legacy === filters.legacyId) &&
        (!filters.legacyRange ||
          (legacy !== undefined &&
            projectedLegacyNumber(legacy) >= filters.legacyRange.start &&
            projectedLegacyNumber(legacy) <= filters.legacyRange.end))
      );
    })
    .sort(compareDecisionIds)
    .map((decisionId) => ({
      ...readDecisionRow(db, decisionId, false)!,
      body: null,
    }));
}

export function listDecisionAgendaRowsPage(
  db: DatabaseSync,
  query: DecisionPageQuery,
): {
  readonly rows: readonly DecisionAgendaProjectionRow[];
  readonly page: ProjectionPage;
} {
  const values: (string | number)[] = [query.state],
    where = ["state = ?"];
  if (query.cursor !== undefined) {
    const [decisionId] = decodePageCursor(query.cursor, 1);
    where.push("decision_id > ?");
    values.push(decisionId!);
  }
  const limit = query.limit === undefined ? 100 : checkedPageLimit(query.limit);
  values.push(limit + 1);
  const raw = db
      .prepare(
        `SELECT decision_id, title, risk_tier, urgency, proposed_at FROM decision WHERE ${where.join(" AND ")} ORDER BY decision_id LIMIT ?`,
      )
      .all(...values) as unknown as readonly {
      readonly decision_id: string;
      readonly title: string;
      readonly risk_tier: DecisionAgendaProjectionRow["riskTier"];
      readonly urgency: DecisionAgendaProjectionRow["urgency"];
      readonly proposed_at: string;
    }[],
    visible = raw.slice(0, limit),
    rows = visible.map((row) => ({
      decisionId: row.decision_id,
      title: row.title,
      riskTier: row.risk_tier,
      urgency: row.urgency,
      proposedAt: row.proposed_at,
    })),
    last = visible.at(-1);
  return {
    rows,
    page: {
      limit,
      cursor: query.cursor ?? null,
      nextCursor:
        raw.length > limit && last
          ? encodePageCursor([last.decision_id])
          : null,
    },
  };
}

export function decisionLegacyId(decisionId: string): string | undefined {
  const match = /(?:^|_)E([1-9][0-9]*)(?:_|$)/u.exec(decisionId);
  return match ? `E${Number(match[1])}` : undefined;
}

function projectedLegacyNumber(value: string): number {
  return Number(value.slice(1));
}

function compareDecisionIds(left: string, right: string): number {
  const legacyLeft = decisionLegacyId(left),
    legacyRight = decisionLegacyId(right),
    a = legacyLeft ? projectedLegacyNumber(legacyLeft) : undefined,
    b = legacyRight ? projectedLegacyNumber(legacyRight) : undefined;
  return a !== undefined && b !== undefined && a !== b
    ? a - b
    : a !== undefined && b === undefined
      ? -1
      : a === undefined && b !== undefined
        ? 1
        : left.localeCompare(right);
}

export function readDecisionGraphRows(db: DatabaseSync): {
  readonly edges: readonly DecisionRelationEdgeRow[];
  readonly decisionAnchors: readonly DecisionAnchorRow[];
  readonly coverageRows: readonly DecisionCoverageRow[];
} {
  const edges = (
      db
        .prepare(
          "SELECT row_json FROM relation_edge WHERE owner_ref NOT LIKE 'fact/%' ORDER BY relation_id",
        )
        .all() as unknown as readonly { readonly row_json: string }[]
    ).map((r) => JSON.parse(r.row_json) as DecisionRelationEdgeRow),
    anchors = decisionAnchorIndex(db),
    decisionAnchors = (
      db
        .prepare("SELECT decision_id FROM decision ORDER BY decision_id")
        .all() as unknown as readonly { readonly decision_id: string }[]
    ).map((r) => ({
      decisionId: r.decision_id,
      decisionRef: `decision/${r.decision_id}`,
      anchorRefs: anchors.get(r.decision_id) ?? [`decision/${r.decision_id}`],
      sourcePath: `event:decision/${r.decision_id}`,
    }));
  return { edges, decisionAnchors, coverageRows: decisionCoverage(db, edges) };
}

export function decisionAnchorIndex(
  db: DatabaseSync,
): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const row of db
    .prepare("SELECT decision_id FROM decision")
    .all() as unknown as readonly { readonly decision_id: string }[])
    map.set(row.decision_id, [`decision/${row.decision_id}`]);
  for (const sql of [
    "SELECT decision_id, option_id AS anchor FROM decision_option",
    "SELECT decision_id, claim_id AS anchor FROM decision_claim",
  ])
    for (const row of db.prepare(sql).all() as unknown as readonly {
      readonly decision_id: string;
      readonly anchor: string;
    }[])
      map
        .get(row.decision_id)
        ?.push(`decision/${row.decision_id}/${row.anchor}`);
  for (const refs of map.values()) refs.sort();
  return map;
}
