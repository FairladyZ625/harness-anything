import type { DecisionDocumentState } from "@harness-anything/kernel";
import type { DatabaseSync } from "node:sqlite";
import type { SessionProvenanceV1 } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import type {
  DecisionAmendmentV1,
  DecisionContentPinV1,
  DecisionFulfillmentMode,
  DecisionJudgmentConsentV1,
  DecisionReviewOverrideV1,
  DecisionReviewResponseV1,
  DecisionReviewV1,
  DecisionState,
} from "@harness-anything/kernel/internal/domain/decision-event.ts";
import type { ActorIdentity } from "@harness-anything/kernel/internal/domain/write-chain.contract.ts";
import {
  decisionCapabilities,
  decisionClaimsOpen,
} from "@harness-anything/kernel/internal/domain/decision-board-projection.ts";
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
} from "@harness-anything/kernel";
import { ftsQuery } from "./fts-query.ts";
import { queryRows, type ProjectionSqlRow } from "./rebuildable-task-projection-sql.ts";
import { checkedPageLimit, decodePageCursor, encodePageCursor, type ProjectionPage } from "./task-query-projection.ts";
import { readRelationProjectionRows, readRelationProjectionRowsTargetingEntity } from "./relation-entity-projection.ts";

const decisionIdSortAlphabet = [
    ...new Set([..."-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz"].map((c) => c.toLowerCase())),
  ].sort((left, right) => left.localeCompare(right)),
  decisionIdSortRanks = new Map(decisionIdSortAlphabet.map((character, rank) => [character, rank])),
  lowercaseSortWeight = "a".localeCompare("A") < 0 ? "!" : '"',
  uppercaseSortWeight = lowercaseSortWeight === "!" ? '"' : "!";

/** Encodes the ASCII identifier collation used by localeCompare into a SQLite BINARY-sortable key. */
export function decisionIdSortKey(decisionId: string): string {
  const primary: string[] = [],
    caseWeight: string[] = [];
  for (const character of decisionId) {
    const rank = decisionIdSortRanks.get(character.toLowerCase());
    if (rank === undefined) throw new Error(`decision id contains unsupported character ${JSON.stringify(character)}`);
    primary.push(String.fromCharCode(33 + rank));
    caseWeight.push(character >= "A" && character <= "Z" ? uppercaseSortWeight : lowercaseSortWeight);
  }
  return `${primary.join("")} ${caseWeight.join("")}`;
}

export function readDecisionRow(db: DatabaseSync, decisionId: string, withBody = true): DecisionProjectionRow | null {
  return readDecisionRows(db, [decisionId], withBody)[0] ?? null;
}

export function readDecisionRows(
  db: DatabaseSync,
  decisionIds: readonly string[],
  withBody = true,
): readonly DecisionProjectionRow[] {
  if (
    !Array.isArray(decisionIds) ||
    decisionIds.some((decisionId) => typeof decisionId !== "string" || decisionId.length === 0)
  )
    throw new Error("decision collection read requires non-empty string ids");
  if (decisionIds.length === 0) return [];
  const bodyColumn = withBody ? "document.value_json" : "NULL",
    bodyJoin = withBody
      ? "LEFT JOIN document ON document.path = 'decisions/decision-' || decision.decision_id || '/decision.md'"
      : "";
  const sql = `WITH requested_decisions(request_order, decision_id) AS MATERIALIZED (
      SELECT CAST(key AS INTEGER), value FROM json_each(?)
    )
    SELECT
      requested_decisions.request_order,
      decision.decision_id,
      decision.state,
      decision.title,
      decision.question,
      decision.risk_tier,
      decision.urgency,
      decision.vertical,
      decision.preset,
      decision.decision_class,
      decision.applies_json,
      decision.proposer_json,
      decision.arbiter_json,
      decision.proposed_at,
      decision.decided_at,
      decision.provenance_json,
      decision.workspace_revision,
      ${bodyColumn} AS body_document_json,
      COALESCE((
        SELECT json_group_array(
          json_object('kind', kind, 'option_id', option_id, 'text', text, 'rationale', rationale)
        )
        FROM (
          SELECT kind, option_id, text, rationale FROM decision_option
          WHERE decision_id = decision.decision_id ORDER BY kind, position
        )
      ), '[]') AS options_json,
      COALESCE((
        SELECT json_group_array(
          json_object(
            'claim_id', claim_id,
            'text', text,
            'load_bearing', load_bearing,
            'fulfillment', fulfillment
          )
        )
        FROM (
          SELECT claim_id, text, load_bearing, fulfillment FROM decision_claim
          WHERE decision_id = decision.decision_id ORDER BY position
        )
      ), '[]') AS claims_json,
      COALESCE((
        SELECT json_group_array(value_json) FROM (
          SELECT value_json FROM decision_judgment_consent
          WHERE decision_id = decision.decision_id ORDER BY workspace_revision
        )
      ), '[]') AS consents_json,
      COALESCE((
        SELECT json_group_array(value_json) FROM (
          SELECT value_json FROM decision_amendment
          WHERE decision_id = decision.decision_id ORDER BY workspace_revision
        )
      ), '[]') AS amendments_json,
      COALESCE((
        SELECT json_group_array(value_json) FROM (
          SELECT value_json FROM decision_content_pin
          WHERE decision_id = decision.decision_id ORDER BY workspace_revision
        )
      ), '[]') AS pins_json
      , COALESCE((
        SELECT json_group_array(value_json) FROM (
          SELECT value_json FROM decision_review_event
          WHERE decision_id = decision.decision_id AND kind = 'review' ORDER BY workspace_revision
        )
      ), '[]') AS reviews_json
      , COALESCE((
        SELECT json_group_array(value_json) FROM (
          SELECT value_json FROM decision_review_event
          WHERE decision_id = decision.decision_id AND kind = 'response' ORDER BY workspace_revision
        )
      ), '[]') AS review_responses_json
      , COALESCE((
        SELECT json_group_array(value_json) FROM (
          SELECT value_json FROM decision_review_event
          WHERE decision_id = decision.decision_id AND kind = 'override' ORDER BY workspace_revision
        )
      ), '[]') AS review_overrides_json
      , COALESCE((
        SELECT json_group_array(row_json) FROM (
          SELECT row_json FROM relation_edge
          WHERE owner_ref = 'decision/' || decision.decision_id ORDER BY relation_id
        )
      ), '[]') AS relations_json
    FROM requested_decisions JOIN decision ON decision.decision_id = requested_decisions.decision_id ${bodyJoin}
    ORDER BY requested_decisions.request_order`;
  return queryRows<DecisionCollectionRecord>(db, sql, JSON.stringify(decisionIds)).map(decisionCollectionRow);
}

interface DecisionCollectionRecord extends ProjectionSqlRow {
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
  readonly reviews_json: string;
  readonly review_responses_json: string;
  readonly review_overrides_json: string;
  readonly relations_json: string;
}

function decisionCollectionRow(row: DecisionCollectionRecord): DecisionProjectionRow {
  const decisionId = row.decision_id,
    state = row.state as DecisionState,
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
    amendments = (JSON.parse(row.amendments_json) as string[]).map((value) => JSON.parse(value) as DecisionAmendmentV1),
    pins = (JSON.parse(row.pins_json) as string[]).map((value) => JSON.parse(value) as DecisionContentPinV1),
    body = row.body_document_json === null ? null : decisionBodyFromDocument(decisionId, row.body_document_json),
    reviews = (JSON.parse(row.reviews_json) as string[]).map((value) => JSON.parse(value) as DecisionReviewV1),
    reviewResponses = (JSON.parse(row.review_responses_json) as string[]).flatMap(
      (value) => JSON.parse(value) as DecisionReviewResponseV1[],
    ),
    reviewOverrides = (JSON.parse(row.review_overrides_json) as string[]).map(
      (value) => JSON.parse(value) as DecisionReviewOverrideV1,
    ),
    reviewState = { reviews, reviewResponses, reviewOverrides },
    relations = (JSON.parse(row.relations_json) as string[]).map((value) => {
      const edge = JSON.parse(value) as DecisionRelationEdgeRow;
      return {
        relation_id: edge.relationId,
        source: edge.sourceRef,
        target: edge.targetRef,
        type: edge.relationType,
        direction: edge.direction,
        strength: edge.strength,
        origin: edge.origin,
        rationale: edge.rationale,
        state: edge.state,
      };
    });
  return {
    schema: "decision-row/v1",
    decisionId,
    ...(legacyId ? { legacyId } : {}),
    path: `decisions/decision-${decisionId}/decision.md`,
    state,
    title: row.title,
    question: row.question,
    riskTier: row.risk_tier as DecisionProjectionRow["riskTier"],
    urgency: row.urgency as DecisionProjectionRow["urgency"],
    vertical: row.vertical,
    preset: row.preset,
    decisionClass: row.decision_class as DecisionProjectionRow["decisionClass"],
    appliesTo: JSON.parse(row.applies_json) as DecisionProjectionRow["appliesTo"],
    proposer: JSON.parse(row.proposer_json) as ActorIdentity,
    arbiter: row.arbiter_json === null ? null : (JSON.parse(row.arbiter_json) as ActorIdentity),
    proposedAt: row.proposed_at,
    decidedAt: row.decided_at,
    provenance: JSON.parse(row.provenance_json) as readonly SessionProvenanceV1[],
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
    ...reviewState,
    relations,
    ...(amendments.length ? { amendments } : {}),
    ...(pins.length ? { contentPins: pins } : {}),
    body,
    capabilities: decisionCapabilities(state),
    claimsOpen: decisionClaimsOpen(state),
  };
}

/**
 * Decision list with one batched row read: the unparameterized filters keep returning every match
 * (the GUI board and decision readiness read the whole corpus); an explicit limit/cursor pages over
 * the same compareDecisionIds order. The cursor carries the last returned decisionId, so a row
 * deleted between pages cannot drop or duplicate its neighbours.
 */
export function listDecisionRowsPage(
  db: DatabaseSync,
  filters: DecisionListFilters,
): { readonly rows: readonly DecisionProjectionRow[]; readonly page?: ProjectionPage } {
  const where: string[] = [],
    values: (string | number)[] = [];
  if (filters.search?.trim()) {
    where.push("decision_id IN (SELECT decision_id FROM decision_fts WHERE decision_fts MATCH ?)");
    values.push(ftsQuery(filters.search));
  }
  if (filters.state) {
    where.push("state=?");
    values.push(filters.state);
  }
  if (filters.module) {
    where.push("EXISTS (SELECT 1 FROM json_each(decision.applies_json, '$.modules') WHERE value=?)");
    values.push(filters.module);
  }
  if (filters.productLine) {
    where.push("EXISTS (SELECT 1 FROM json_each(decision.applies_json, '$.productLines') WHERE value=?)");
    values.push(filters.productLine);
  }
  if (filters.limit !== undefined || filters.cursor !== undefined)
    return listDecisionRowsPageFromIndex(db, filters, where, values);

  const ids = queryRows<{ readonly decision_id: string }>(
    db,
    `SELECT decision_id FROM decision${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`,
    ...values,
  )
    .map((row) => row.decision_id)
    .filter((decisionId) => {
      const legacy = decisionLegacyId(decisionId);
      return (
        (!filters.legacyId || legacy === filters.legacyId) &&
        (!filters.legacyRange ||
          (legacy !== undefined &&
            decisionLegacyNumber(decisionId)! >= filters.legacyRange.start &&
            decisionLegacyNumber(decisionId)! <= filters.legacyRange.end))
      );
    })
    .sort(compareDecisionIds);

  return { rows: readDecisionRows(db, ids, filters.withBody === true) };
}

function listDecisionRowsPageFromIndex(
  db: DatabaseSync,
  filters: DecisionListFilters,
  where: readonly string[],
  values: readonly (string | number)[],
): { readonly rows: readonly DecisionProjectionRow[]; readonly page: ProjectionPage } {
  const pageLimit = filters.limit === undefined ? 100 : checkedPageLimit(filters.limit),
    cursorId = filters.cursor === undefined ? undefined : decodePageCursor(filters.cursor, 1)[0]!,
    cursorLegacyNumber = cursorId === undefined ? null : decisionLegacyNumber(cursorId),
    cursorSortKey = cursorId === undefined ? "" : decisionIdSortKey(cursorId),
    legacyWhere = ["legacy_number IS NOT NULL", ...where],
    legacyValues: (string | number)[] = [...values];

  if (filters.legacyId) {
    const match = /^E([1-9][0-9]*)$/u.exec(filters.legacyId);
    if (match) {
      legacyWhere.push("legacy_number = ?");
      legacyValues.push(Number(match[1]));
    } else legacyWhere.push("0");
  }
  if (filters.legacyRange !== undefined) {
    legacyWhere.push("legacy_number BETWEEN ? AND ?");
    legacyValues.push(filters.legacyRange.start, filters.legacyRange.end);
  }

  if (cursorId !== undefined && cursorLegacyNumber === null) legacyWhere.push("0");
  const cursorBoundary: readonly [number, string, string] =
      cursorId === undefined
        ? [0, "", ""]
        : cursorLegacyNumber === null
          ? [0, "", ""]
          : [cursorLegacyNumber, cursorSortKey, cursorId],
    legacyBranch = [
      "SELECT * FROM (SELECT decision_id, legacy_number, decision_sort_key, decision_id AS tie FROM decision",
      `WHERE ${[...legacyWhere, "(legacy_number, decision_sort_key, decision_id) > (?, ?, ?)"].join(" AND ")}`,
      "ORDER BY legacy_number, decision_sort_key, decision_id LIMIT ?)",
    ].join(" ");
  legacyValues.push(...cursorBoundary, pageLimit + 1);

  const branches = [legacyBranch],
    queryValues: (string | number)[] = [...legacyValues];
  if (!filters.legacyId && filters.legacyRange === undefined) {
    const plainWhere = ["legacy_number IS NULL", ...where, "(decision_sort_key, decision_id) > (?, ?)"],
      plainCursor = cursorLegacyNumber === null && cursorId !== undefined ? cursorId : "",
      plainBoundary = cursorLegacyNumber === null && cursorId !== undefined ? cursorSortKey : "";
    branches.push(
      [
        "SELECT * FROM (SELECT decision_id, NULL AS legacy_number, decision_sort_key, decision_id AS tie FROM decision",
        `WHERE ${plainWhere.join(" AND ")}`,
        "ORDER BY decision_sort_key, decision_id LIMIT ?)",
      ].join(" "),
    );
    queryValues.push(...values, plainBoundary, plainCursor, pageLimit + 1);
  }

  const raw = queryRows<{ readonly decision_id: string }>(
      db,
      [
        "SELECT decision_id FROM (",
        branches.join(" UNION ALL "),
        ") ORDER BY legacy_number IS NULL, legacy_number, decision_sort_key, tie LIMIT ?",
      ].join(" "),
      ...queryValues,
      pageLimit + 1,
    ),
    pageIds = raw.slice(0, pageLimit).map(({ decision_id }) => decision_id),
    last = pageIds.at(-1);
  return {
    rows: readDecisionRows(db, pageIds, filters.withBody === true),
    page: {
      limit: pageLimit,
      cursor: filters.cursor ?? null,
      nextCursor: raw.length > pageLimit && last ? encodePageCursor([last]) : null,
    },
  };
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
  const raw = queryRows<{
      readonly decision_id: string;
      readonly title: string;
      readonly risk_tier: DecisionAgendaProjectionRow["riskTier"];
      readonly urgency: DecisionAgendaProjectionRow["urgency"];
      readonly proposed_at: string;
    }>(
      db,
      [
        "SELECT decision_id, title, risk_tier, urgency, proposed_at FROM decision",
        `WHERE ${where.join(" AND ")}`,
        "ORDER BY decision_id LIMIT ?",
      ].join(" "),
      ...values,
    ),
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
      nextCursor: raw.length > limit && last ? encodePageCursor([last.decision_id]) : null,
    },
  };
}

export function decisionLegacyId(decisionId: string): string | undefined {
  const match = /(?:^|_)E([1-9][0-9]*)(?:_|$)/u.exec(decisionId);
  return match ? `E${Number(match[1])}` : undefined;
}

export function decisionLegacyNumber(decisionId: string): number | null {
  const legacyId = decisionLegacyId(decisionId);
  return legacyId === undefined ? null : Number(legacyId.slice(1));
}

function compareDecisionIds(left: string, right: string): number {
  const a = decisionLegacyNumber(left),
    b = decisionLegacyNumber(right);
  return a !== null && b !== null && a !== b
    ? a - b
    : a !== null && b === null
      ? -1
      : a === null && b !== null
        ? 1
        : left.localeCompare(right);
}

/** Non-fact-owned relation edges targeting one Decision or its option/claim anchors. */
export function readDecisionIncomingRelationRows(
  db: DatabaseSync,
  decisionId: string,
): ReturnType<typeof readDecisionGraphRows>["edges"] {
  return readRelationProjectionRowsTargetingEntity(db, `decision/${decisionId}`).filter(
    (edge) => !edge.ownerRef.startsWith("fact/"),
  );
}

export function readDecisionGraphRows(
  db: DatabaseSync,
  basisRevision: number,
): {
  readonly edges: readonly DecisionRelationEdgeRow[];
  readonly decisionAnchors: readonly DecisionAnchorRow[];
  readonly coverageRows: readonly DecisionCoverageRow[];
} {
  const edges = readRelationProjectionRows(db).filter((edge) => !edge.ownerRef.startsWith("fact/")),
    anchors = decisionAnchorIndex(db),
    decisionAnchors = queryRows<{ readonly decision_id: string }>(
      db,
      "SELECT decision_id FROM decision ORDER BY decision_id",
    ).map((r) => ({
      decisionId: r.decision_id,
      decisionRef: `decision/${r.decision_id}`,
      anchorRefs: anchors.get(r.decision_id) ?? [`decision/${r.decision_id}`],
      sourcePath: `event:decision/${r.decision_id}`,
    }));
  return {
    edges,
    decisionAnchors,
    coverageRows: decisionCoverage(
      db,
      decisionAnchors.map(({ decisionId }) => decisionId),
      basisRevision,
    ),
  };
}

export function decisionAnchorIndex(db: DatabaseSync): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const row of queryRows<{ readonly decision_id: string }>(db, "SELECT decision_id FROM decision"))
    map.set(row.decision_id, [`decision/${row.decision_id}`]);
  for (const sql of [
    "SELECT decision_id, option_id AS anchor FROM decision_option",
    "SELECT decision_id, claim_id AS anchor FROM decision_claim",
  ])
    for (const row of queryRows<{ readonly decision_id: string; readonly anchor: string }>(db, sql))
      map.get(row.decision_id)?.push(`decision/${row.decision_id}/${row.anchor}`);
  for (const refs of map.values()) refs.sort();
  return map;
}

export function readDecisionDocumentState(db: DatabaseSync, decisionId: string): DecisionDocumentState | null {
  const row = readDecisionRow(db, decisionId);
  if (!row) return null;
  const { body: _body, ...decision } = row;
  return decision;
}
