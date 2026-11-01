import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";
import type { LeaseV1, TaskProjection } from "@harness-anything/kernel";
import { compileFactWrite } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import { compileDecisionWrite } from "@harness-anything/kernel/internal/domain/decision-event-document.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import type { PgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import type { PgProjectionScope } from "../../src/pg/pg-task-event-materialize.ts";
import type { CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { fact, proposal } from "../store/relation-graph-projection.fixtures.ts";

export async function appendQueryParityFixtures(
  append: (bundle: CanonicalWriteBundle) => Promise<void>,
  revision: () => number,
): Promise<void> {
  for (const [factId, statement, evidenceSource] of [
    ["F-11111111", "Alpha café 中文 東京", "source only beta"],
    ["F-22222222", "alpha beta gamma foo_bar ộ naïve", "other"],
    ["F-33333333", '% _ "quoted" phrase', "third"],
  ]) {
    const draft = fact(revision());
    await append(
      compileFactWrite({
        event: {
          ...draft,
          factId: factId!,
          payload: { ...draft.payload, statement: statement!, evidenceSource: evidenceSource! },
        },
      }),
    );
  }
  for (const [decisionId, title] of [
    ["dec_E2", "Alpha café 中文 東京"],
    ["dec_E10", "alpha beta gamma foo_bar ộ naïve"],
    ["dec_TEXT_ONLY", 'literal "quoted" phrase'],
  ]) {
    const draft = proposal(revision(), decisionId!);
    await append(
      compileDecisionWrite({
        event: {
          ...draft,
          payload: {
            ...draft.payload,
            title: title!,
            question: "questionzircon",
            chosen: [{ id: "CH1", text: "optionopal" }],
            rejected: [{ id: "RJ1", text: "rejectedruby", whyNot: "reasonzinc" }],
            claims: [{ id: "C1", text: "claimgarnet", loadBearing: true }],
            body: draft.payload.body + "\n\nbodyquartz",
            provenance: fact(revision()).payload.provenance,
          },
        },
        currentDecision: null,
        currentRelations: [],
        currentDocument: null,
        decisionReviewRequirement: "off",
      }),
    );
  }
}

export async function assertTextQueryParity(pg: PgTaskProjectionSource, sqlite: TaskProjection): Promise<void> {
  const factCases: readonly [string, readonly string[]][] = [
    ["alp", []],
    ["alpha", ["F-11111111", "F-22222222"]],
    ["alpha beta", ["F-22222222"]],
    ["beta alpha", []],
    ["%", []],
    ["_", []],
    ["foo_bar", ["F-22222222"]],
    ["cafe", ["F-11111111"]],
    ["CAFÉ", ["F-11111111"]],
    ["中文", ["F-11111111"]],
    ["中", []],
    ["東京", ["F-11111111"]],
    ['"quoted" phrase', ["F-33333333"]],
    ["source only", ["F-11111111"]],
    ["東京 source", []],
    ["alpha OR beta", []],
    ["o", ["F-22222222"]],
  ];
  for (const [query, expected] of factCases) {
    const oracle = sqlite.searchFacts({ query });
    assert.deepEqual(
      oracle.facts.map((row) => row.factId),
      expected,
      "SQLite fact oracle: " + query,
    );
    assert.deepEqual(await pg.searchFacts({ query }), oracle, "Fact literal query: " + query);
  }
  const decisionCases: readonly [string, readonly string[]][] = [
    ["alp", []],
    ["alpha", ["dec_E2", "dec_E10"]],
    ["alpha beta", ["dec_E10"]],
    ["%", []],
    ["_", []],
    ["foo_bar", ["dec_E10"]],
    ["CAFÉ", ["dec_E2"]],
    ["中文", ["dec_E2"]],
    ["中", []],
    ['"quoted" phrase', ["dec_TEXT_ONLY"]],
    ["dec_TEXT_ONLY", []],
    ["東京 questionzircon", []],
    ["alpha OR beta", []],
    ["o", ["dec_E10"]],
  ];
  for (const [search, expected] of decisionCases) {
    const oracle = sqlite.listDecisions({ search });
    assert.deepEqual(
      oracle.decisions.map((row) => row.decisionId),
      expected,
      "SQLite decision oracle: " + search,
    );
    assert.deepEqual(await pg.listDecisions({ search }), oracle, "Decision literal query: " + search);
  }
  for (const search of ["questionzircon", "optionopal", "rejectedruby", "claimgarnet", "bodyquartz"]) {
    const oracle = sqlite.listDecisions({ search, withBody: true });
    assert.equal(oracle.decisions.length, 3, "indexed Decision field: " + search);
    assert.deepEqual(await pg.listDecisions({ search, withBody: true }), oracle, search);
  }
  let factCursor: string | undefined;
  const facts: string[] = [];
  do {
    const query = { query: "alpha", limit: 1, ...(factCursor === undefined ? {} : { cursor: factCursor }) };
    const page = await pg.searchFacts(query);
    assert.deepEqual(page, sqlite.searchFacts(query));
    facts.push(...page.facts.map((row) => row.factId));
    factCursor = page.page!.nextCursor ?? undefined;
  } while (factCursor !== undefined);
  assert.deepEqual(facts, ["F-11111111", "F-22222222"]);
  let decisionCursor: string | undefined;
  const decisions: string[] = [];
  do {
    const query = { search: "alpha", limit: 1, ...(decisionCursor === undefined ? {} : { cursor: decisionCursor }) };
    const page = await pg.listDecisions(query);
    assert.deepEqual(page, sqlite.listDecisions(query));
    decisions.push(...page.decisions.map((row) => row.decisionId));
    decisionCursor = page.page!.nextCursor ?? undefined;
  } while (decisionCursor !== undefined);
  assert.deepEqual(decisions, ["dec_E2", "dec_E10"]);
}

export async function assertAgendaQueryParity(pg: PgTaskProjectionSource, sqlite: TaskProjection): Promise<void> {
  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const query = { state: "proposed" as const, limit: 1, ...(cursor === undefined ? {} : { cursor }) };
    const page = await pg.listDecisionAgendaPage(query);
    assert.deepEqual(page, sqlite.listDecisionAgendaPage(query), "agenda page " + ids.length);
    ids.push(...page.decisions.map((row) => row.decisionId));
    cursor = page.page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  assert.deepEqual(ids, ["dec_E10", "dec_E2", "dec_TEXT_ONLY"]);
  for (const limit of [101, 500]) {
    const query = { state: "proposed" as const, limit };
    assert.deepEqual(await pg.listDecisionAgendaPage(query), sqlite.listDecisionAgendaPage(query));
  }
  const end = { state: "proposed" as const, cursor: Buffer.from(JSON.stringify([ids.at(-1)!])).toString("base64url") };
  assert.deepEqual(await pg.listDecisionAgendaPage(end), sqlite.listDecisionAgendaPage(end));
  assert.equal((await pg.listDecisionAgendaPage(end)).decisions.length, 0);
  for (const limit of [0, 501, 1.5, Number.NaN]) {
    const query = { state: "proposed" as const, limit };
    const expected = { message: "query page limit must be an integer between 1 and 500" };
    assert.throws(() => sqlite.listDecisionAgendaPage(query), expected);
    await assert.rejects(pg.listDecisionAgendaPage(query), expected);
  }
  for (const invalid of ["!", Buffer.from("[]").toString("base64url")]) {
    const query = { state: "proposed" as const, cursor: invalid };
    const expected = { message: "query cursor is invalid" };
    assert.throws(() => sqlite.listDecisionAgendaPage(query), expected);
    await assert.rejects(pg.listDecisionAgendaPage(query), expected);
    assert.throws(() => sqlite.listDecisionAgendaPage({ ...query, limit: 0 }), expected);
    await assert.rejects(pg.listDecisionAgendaPage({ ...query, limit: 0 }), expected);
  }
}

export async function assertLeaseQueryParity(
  pg: PgTaskProjectionSource,
  sqlite: TaskProjection,
  pool: Pool,
  scope: PgProjectionScope,
): Promise<void> {
  const taskId = "task-work-root";
  const start = lifecycleFixture({ taskId, executionId: "execution-query-lease" }).events.find(
    (e) => e.type === "execution_started",
  )!;
  assert.equal(start.type, "execution_started");
  if (start.type !== "execution_started") return;
  const db = new DatabaseSync(sqlite.path);
  // Runtime lease phases are projection state, not fabricated lifecycle snapshots. The task
  // already came from canonical replay; install the same admitted lease value in both stores.
  try {
    for (const phase of ["held", "reserving", "released", "orphaned"] as const) {
      const lease: LeaseV1 = { ...start.payload.lease, phase };
      db.prepare(
        "INSERT INTO lease_cas(task_id, lease_json) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET lease_json=excluded.lease_json",
      ).run(taskId, JSON.stringify(lease));
      await withPostgresTransaction(
        pool,
        async (client) => {
          await client.query(
            "UPDATE ha_task_snapshots SET raw_lease=$1::jsonb WHERE tenant_id=$2 AND project_id=$3 AND policy_epoch=$4 AND task_id=$5",
            [JSON.stringify(lease), scope.tenantId, scope.projectId, scope.policyEpoch, taskId],
          );
        },
        scope,
      );
      for (const now of ["2026-08-11T00:30:00.000Z", lease.expiresAt, "2026-08-11T02:00:00.000Z"]) {
        assert.deepEqual(await pg.currentLease(taskId, now), sqlite.currentLease(taskId, now), phase + " task " + now);
        assert.deepEqual(
          await pg.currentLeaseForExecution(lease.executionId, now),
          sqlite.currentLeaseForExecution(lease.executionId, now),
          phase + " execution " + now,
        );
      }
    }
    assert.equal(await pg.currentLease("missing"), null);
    assert.equal(await pg.currentLeaseForExecution("missing"), null);
  } finally {
    db.prepare("DELETE FROM lease_cas WHERE task_id=?").run(taskId);
    db.close();
    await withPostgresTransaction(
      pool,
      async (client) => {
        await client.query(
          "UPDATE ha_task_snapshots SET raw_lease=NULL WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND task_id=$4",
          [scope.tenantId, scope.projectId, scope.policyEpoch, taskId],
        );
      },
      scope,
    );
  }
}
