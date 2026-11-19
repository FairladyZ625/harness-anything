import assert from "node:assert/strict";
import type { TaskProjectionQueries } from "@harness-anything/kernel";
import {
  readAgendaAwaitsPage,
  readCollaboratorDecisions,
  readCollaboratorLiveFloor,
  readCollaboratorTokenUsage,
} from "@harness-anything/application/queries";
import {
  alice,
  bob,
  edgeA,
  edgeB,
  first,
  second,
  awaitRef,
} from "../../storage/test/store/collaborator-ledger.events.fixture.ts";

export function assertCollaboratorLedger(projection: TaskProjectionQueries): void {
  const decisionIds = (viewerPersonId: string, involvement: "all" | "mine", filterNodeId?: string) =>
    readCollaboratorDecisions(projection, {
      viewerPersonId,
      involvement,
      ...(filterNodeId === undefined ? {} : { filterNodeId }),
    })
      .decisions.map(({ decisionId }) => decisionId)
      .sort();

  assert.deepEqual(decisionIds(alice, "mine"), ["dec_ALICE_ONLY", "dec_AWAITS_BOB"]);
  assert.deepEqual(decisionIds(bob, "mine"), ["dec_AWAITS_BOB", "dec_BOB_ONLY"]);
  assert.deepEqual(decisionIds("person_unrelated", "mine"), []);
  assert.deepEqual(decisionIds(bob, "all"), ["dec_ALICE_ONLY", "dec_AWAITS_BOB", "dec_BOB_ONLY"]);
  assert.deepEqual(decisionIds(bob, "mine", edgeA), ["dec_AWAITS_BOB"]);
  const asks = readAgendaAwaitsPage(projection, { viewerPersonId: alice, scopePersonId: bob, limit: 1 });
  assert.equal(asks.awaitingYou.length, 1);
  assert.ok(asks.page.nextCursor);
  const next = readAgendaAwaitsPage(projection, { viewerPersonId: bob, cursor: asks.page.nextCursor, limit: 1 });
  assert.equal(next.page.nextCursor, null);
  assert.deepEqual([...asks.awaitingYou, ...next.awaitingYou].map(({ sourceRef }) => sourceRef).sort(), [
    awaitRef,
    "decision/dec_BOB_ONLY",
  ]);
  const [asked] = readAgendaAwaitsPage(projection, { viewerPersonId: bob, filterNodeId: edgeA }).awaitingYou;
  assert.equal(asked?.sourceRef, awaitRef);
  assert.equal(asked?.question, "Review the deployment?");
  assert.equal(asked?.personId, bob);
  assert.equal(asked?.askedBy, alice);
  assert.equal(asked?.title, "Store Decision");
  assert.deepEqual(
    readAgendaAwaitsPage(projection, { viewerPersonId: bob, filterNodeId: edgeB }).awaitingYou.map(
      ({ sourceRef }) => sourceRef,
    ),
    ["decision/dec_BOB_ONLY"],
  );

  let pages = 0;
  const billing = {
    readCut: projection.readCut,
    readRuntimeSessionEventsByType: projection.readRuntimeSessionEventsByType,
    // Exercise multiple real storage cursors with a compact ledger.
    readRuntimeDispatchPage: (query: Parameters<typeof projection.readRuntimeDispatchPage>[0]) => {
      pages += 1;
      return projection.readRuntimeDispatchPage({ ...query, limit: 1 });
    },
  };
  const full = readCollaboratorTokenUsage(billing, { startedAtGte: first });
  assert.equal(pages, 4);
  assert.equal(full.totals.dispatches, 4);
  assert.equal(full.totals.usageReportedDispatches, 4);
  assert.equal(full.totals.totalTokens, 55);
  assert.deepEqual(
    full.byPerson.map(({ personId, totalTokens }) => [personId, totalTokens]),
    [
      [alice, 28],
      [bob, 27],
    ],
  );
  assert.deepEqual(
    full.byNode.map(({ nodeId, totalTokens }) => [nodeId, totalTokens]),
    [
      [edgeA, 28],
      [edgeB, 27],
    ],
  );
  const bill = (scope: { scopePersonId?: string; filterNodeId?: string; startedAtLt?: string }) =>
    readCollaboratorTokenUsage(billing, { startedAtGte: first, ...scope }).totals.totalTokens;
  assert.equal(bill({ filterNodeId: edgeA, startedAtLt: second }), 28);
  assert.equal(bill({ filterNodeId: edgeA, startedAtLt: "2026-11-19T03:00:00.025Z" }), 20);
  assert.equal(bill({ filterNodeId: edgeB }), 27);
  assert.equal(bill({ scopePersonId: alice, filterNodeId: edgeB }), 0);
  assert.equal(bill({ scopePersonId: "person_unrelated" }), 0);

  assert.deepEqual(
    readCollaboratorLiveFloor(projection, {
      filterNodeId: edgeA,
      scopePersonId: alice,
      startedAtGte: "2026-11-19T02:00:00.000Z",
    }).map(({ dispatch, nodeId, startedAt }) => [dispatch?.payload.dispatchId, nodeId, startedAt]),
    [["billing-live-dispatch", edgeA, "2026-11-19T02:00:00.000Z"]],
  );
  assert.deepEqual(readCollaboratorLiveFloor(projection, { filterNodeId: edgeB, scopePersonId: alice }), []);
}
