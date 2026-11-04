import assert from "node:assert/strict";
import type { Pool } from "pg";
import { compileDecisionWrite } from "@harness-anything/kernel";
import { reduceDecisionDocument } from "@harness-anything/kernel/internal/domain/decision-event-document.ts";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { refreshPgDecisionSearch, backfillPgDecisionSearchPage } from "../../src/pg/pg-decision-search.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { decisionProjectionDatabase, proposal } from "../store/relation-graph-projection.fixtures.ts";
import { listDecisionRowsPage, reduceDecisionEvent } from "../../src/projection/decision-event-projection.ts";
import { refreshDecisionDocumentSearch } from "../../src/projection/decision-projection-reducer.ts";
import { PG_PROJECTION_SCHEMA_VERSION } from "../../src/pg/pg-projection-schema.ts";
import type { DocumentState } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";

export async function assertDecisionSearchEdges(pool: Pool, backend: string) {
  const scope = { tenantId: "search-edges", projectId: "search-edges", policyEpoch: 1 },
    repoId = "search-edges",
    sqlite = decisionProjectionDatabase(),
    pg = createPgTaskProjectionSource({ pool, scope, repoId, ownsPool: false });
  const samples = [
    { body: "CAFÉ naïve Straße 中文", query: "cafe naive" },
    { body: `${"filler ".repeat(17000)}alpha needle`, query: "alpha needle" },
    { body: `${"alpha filler ".repeat(300)}alpha needle`, query: "alpha needle" },
    { body: "a".repeat(2050), query: "a".repeat(2050) },
    {
      body: Array.from({ length: 400 }, (_, i) => `word${i}`).join(" "),
      query: Array.from({ length: 400 }, (_, i) => `word${i}`).join(" "),
    },
    { body: "not adjacent alpha gap needle", query: "alpha needle" },
    { body: "legacy precision boundary", query: "legacy precision boundary" },
    { body: "legacy precision boundary", query: "legacy precision boundary" },
  ];
  try {
    await withPostgresTransaction(
      pool,
      async (client) => {
        await client.query(
          `INSERT INTO ha_repo_heads(tenant_id,project_id,policy_epoch,repo_id,revision,head_op_id,head_event_digest,head_digest,readers)
        VALUES($1,$2,$3,$4,$5,'fixture','fixture','fixture',ARRAY['visible','hidden'])`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, repoId, samples.length],
        );
      },
      scope,
    );
    for (const [index, sample] of samples.entries()) {
      const id =
          index >= 6 ? `dec_E${index === 6 ? "9007199254740992" : "9007199254740993"}_${index}` : `dec_SEARCH_${index}`,
        draft = proposal(index + 1, id),
        compiled = compileDecisionWrite({
          decisionReviewRequirement: "off",
          event: { ...draft, payload: { ...draft.payload, body: sample.body } },
          currentDecision: null,
          currentRelations: [],
          currentDocument: null,
        }),
        state = reduceDecisionDocument(null, compiled.event),
        claim = compiled.event.payload.decisionDocumentClaim,
        document = {
          path: claim.path,
          blobSha256: claim.sha256,
          size: claim.size,
          mediaType: claim.mediaType,
          workspaceRevision: index + 1,
          body: compiled.body,
        } as DocumentState;
      reduceDecisionEvent(sqlite, compiled.event);
      sqlite
        .prepare("INSERT INTO document(path,workspace_revision,value_json) VALUES(?,?,?)")
        .run(claim.path, index + 1, JSON.stringify(document));
      refreshDecisionDocumentSearch(sqlite, document);
      await withPostgresTransaction(
        pool,
        async (client) => {
          await client.query(
            `INSERT INTO ha_decisions(tenant_id,project_id,policy_epoch,readers,decision_id,workspace_revision,value)
          VALUES($1,$2,$3,ARRAY['visible'],$4,$5,$6::jsonb)`,
            [scope.tenantId, scope.projectId, scope.policyEpoch, id, index + 1, JSON.stringify(state)],
          );
          await client.query(
            `INSERT INTO ha_content_blobs(tenant_id,project_id,policy_epoch,readers,sha256,size,body)
          VALUES($1,$2,$3,ARRAY['visible'],$4,$5,$6)`,
            [scope.tenantId, scope.projectId, scope.policyEpoch, claim.sha256, claim.size, Buffer.from(compiled.body)],
          );
          await client.query(
            `INSERT INTO ha_document_heads(tenant_id,project_id,policy_epoch,readers,repo_id,path,sha256,size,node_kind,revision)
          VALUES($1,$2,$3,ARRAY['visible'],$4,$5,$6,$7,'file',$8)`,
            [
              scope.tenantId,
              scope.projectId,
              scope.policyEpoch,
              repoId,
              claim.path,
              claim.sha256,
              claim.size,
              index + 1,
            ],
          );
          await refreshPgDecisionSearch(client, scope, id);
        },
        scope,
      );
    }
    await withPostgresTransaction(
      pool,
      async (client) => {
        await client.query(
          `INSERT INTO ha_projection_meta(tenant_id,project_id,policy_epoch,schema_version,watermark,source_revision)
        VALUES($1,$2,$3,$4,$5,$5)`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, PG_PROJECTION_SCHEMA_VERSION, samples.length],
        );
      },
      scope,
    );
    for (const sample of samples) {
      const expected = listDecisionRowsPage(sqlite, { search: sample.query, withBody: true }).rows;
      const actual = await pg.listDecisions({ search: sample.query, withBody: true });
      assert.deepEqual(actual.decisions, expected, backend + " exact phrase " + sample.query.slice(0, 40));
      process.stdout.write(
        `POSITION_PARITY ${JSON.stringify({ backend, queryBytes: Buffer.byteLength(sample.query), ids: actual.decisions.map((r) => r.decisionId) })}\n`,
      );
    }
    for (const legacyId of ["E9007199254740992", "E9007199254740993"]) {
      for (const limit of [undefined, 10]) {
        const filters = { legacyId, ...(limit === undefined ? {} : { limit }) };
        assert.deepEqual((await pg.listDecisions(filters)).decisions, listDecisionRowsPage(sqlite, filters).rows);
      }
    }
    const visible = createPgTaskProjectionSource({
        pool,
        scope: { ...scope, readers: ["visible"] },
        repoId,
        ownsPool: false,
      }),
      hidden = createPgTaskProjectionSource({
        pool,
        scope: { ...scope, readers: ["hidden"] },
        repoId,
        ownsPool: false,
      });
    assert.deepEqual(
      (await visible.listDecisions({ search: "cafe naive" })).decisions.map((r) => r.decisionId),
      ["dec_SEARCH_0"],
    );
    assert.deepEqual((await hidden.listDecisions({ search: "cafe naive" })).decisions, []);
    await withPostgresTransaction(
      pool,
      async (client) => {
        await client.query(
          "UPDATE ha_decisions SET value=jsonb_set(value,'{title}','\"replacement\"') WHERE decision_id='dec_SEARCH_0'",
        );
      },
      scope,
    );
    await withPostgresTransaction(
      pool,
      async (client) => {
        await client.query(
          "UPDATE ha_decisions SET decision_sort_key=NULL,decision_state=NULL WHERE decision_id='dec_SEARCH_0'",
        );
      },
      scope,
    );
    await assert.rejects(() => pg.listDecisionAgendaPage({ state: "proposed" }), { code: "projection_pending" });
    await assert.rejects(() => pg.listDecisions({ limit: 1 }), { code: "projection_pending" });
    await withPostgresTransaction(
      pool,
      async (client) => {
        assert.equal(
          (
            await client.query<{ processed: number }>("SELECT ha_backfill_decision_indexes($1,$2,$3) AS processed", [
              scope.tenantId,
              scope.projectId,
              scope.policyEpoch,
            ])
          ).rows[0]!.processed,
          1,
        );
      },
      scope,
    );
    await assert.rejects(() => pg.listDecisions({ search: "replacement" }), { code: "projection_pending" });
    await withPostgresTransaction(
      pool,
      async (client) => assert.equal(await backfillPgDecisionSearchPage(client, scope), 1),
      scope,
    );
    assert.deepEqual(
      (await pg.listDecisions({ search: "replacement" })).decisions.map((r) => r.decisionId),
      ["dec_SEARCH_0"],
    );
  } finally {
    sqlite.close();
  }
}
