// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { oracleO1, oracleO2, oracleO7 } from "./oracles.mjs";

const event = { workspaceRevision: 1, opId: "op-1", type: "fixture" };
const outcome = {
  opId: "op-1",
  status: "accepted_durable",
  firstRevision: 1,
  lastRevision: 1,
  intentDigest: "sha256:intent",
};
const receiptLog = {
  complete: true,
  errors: [],
  records: [
    { type: "campaign_started" },
    {
      type: "request",
      request: {
        requestId: "request-1",
        opId: "op-1",
        intentDigest: "sha256:intent",
        expectedEvents: [event],
      },
    },
    {
      type: "receipt",
      requestId: "request-1",
      receipt: { status: "accepted_durable", intentDigest: "sha256:intent" },
    },
    { type: "campaign_completed" },
  ],
};
const canonicalCut = { revision: 1, events: [event], outcomes: [] };
const sqliteCut = { revision: 0, events: [], outcomes: [] };
const reconciliation = { matches: false, firstDivergentRevision: 1 };

test("canonical authority accepts complete WAL closure and detected physical shadow lag", () => {
  const input = authorityInput("canonical", "physical-io");
  assert.equal(oracleO1(input).verdict, "PASS");
  assert.equal(oracleO2(input).verdict, "PASS");
  assert.equal(oracleO7(input).verdict, "PASS");
});

test("sqlite authority keeps the same shadow loss as a red model", () => {
  const input = authorityInput("sqlite", "physical-io");
  assert.equal(oracleO1(input).verdict, "FAIL");
  assert.equal(oracleO2(input).verdict, "FAIL");
  assert.equal(oracleO7(input).verdict, "FAIL");
});

test("O2 permits one command identity to own a contiguous multi-event range", () => {
  const secondEvent = { ...event, workspaceRevision: 2, type: "fixture-second" };
  const request = receiptLog.records[1].request;
  const input = {
    ...authorityInput("sqlite", "physical-io"),
    receiptLog: structuredClone(receiptLog),
    sqliteCut: {
      revision: 2,
      events: [event, secondEvent],
      outcomes: [{ ...outcome, lastRevision: 2 }],
    },
    recovery: undefined,
  };
  input.receiptLog.records[1].request = { ...request, expectedEvents: [event, secondEvent] };
  assert.equal(oracleO2(input).verdict, "PASS");
});

for (const cause of ["fence-unavailable", "unknown"])
  test(`canonical authority rejects ${cause} shadow lag`, () => {
    const observed = oracleO7(authorityInput("canonical", cause));
    assert.equal(observed.verdict, "FAIL");
  });

function authorityInput(authority, shadowFailureCause) {
  return {
    authority,
    receiptLog,
    canonicalCut,
    sqliteCut,
    shadowLag: { firstDivergentRevision: 1 },
    shadowFailureCause,
    recovery: {
      reconciliation,
      sql: { integrity: "ok", head: 0 },
      objectsComplete: true,
      firstRebuild: {},
      secondRebuild: {},
    },
  };
}
