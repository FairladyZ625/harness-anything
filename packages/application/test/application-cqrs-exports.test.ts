// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  decisionAmendmentConsent,
  decisionApproval,
  drainChannelOutbox,
  makeEntityActionCatalogExecutor,
  noChanges,
  prepareDecisionAmend,
  reject,
  runChannelWriteAction,
} from "@harness-anything/application/commands";
import {
  decodeEvidencePayload,
  projectionCut,
  readChannelList,
  readChannelListAction,
  readTodos,
  renderEvidencePayload,
  requireSameProjectionCut,
  workIndexFromProjection,
} from "@harness-anything/application/queries";

const binding = {
  actor: { principal: { personId: "person_owner" }, executor: null },
  source: "cli" as const,
} as const;

test("application ./commands barrel exposes pure CQRS command orchestrations and consent validation", () => {
  assert.equal(typeof makeEntityActionCatalogExecutor, "function");

  const noopReceipt = noChanges({ opId: "op_1", revision: 4, evidence: "already aligned" });
  assert.equal(noopReceipt.outcome, "no_changes");
  assert.equal(noopReceipt.proof.committedRevision, 4);

  assert.throws(
    () => reject("invalid_command", "missing field"),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "invalid_command",
  );

  const consent = decisionApproval(
    {
      kind: "decision-accept",
      consentBy: "person_owner",
      consentAt: "2026-11-17T00:00:00Z",
      consentChannel: "cli",
    },
    binding,
  );
  assert.deepEqual(consent, { approvedBy: "person_owner", at: "2026-11-17T00:00:00Z", channel: "cli" });

  assert.throws(
    () =>
      decisionApproval(
        {
          kind: "decision-accept",
          consentBy: "person_other",
          consentAt: "2026-11-17T00:00:00Z",
          consentChannel: "cli",
        },
        binding,
      ),
    /authenticated principal person/u,
  );

  const inEffectDecision = {
    state: "in_effect",
    proposer: { principal: { personId: "person_owner" }, executor: null },
  } as Parameters<typeof decisionAmendmentConsent>[1];
  assert.throws(
    () => decisionAmendmentConsent({ kind: "decision-amend" }, inEffectDecision, binding),
    /Decision amendment consent requires/u,
  );

  const currentDecision = {
    decisionId: "dec_sample",
    title: "Keep pure CQRS handlers",
    decisionClass: "ordinary",
    appliesTo: { modules: ["application"], productLines: ["harness"] },
    chosen: [{ id: "CH1", text: "Extract commands and queries" }],
    rejected: [],
    claims: [],
  } as Parameters<typeof prepareDecisionAmend>[1];
  const amended = prepareDecisionAmend(
    { reason: "Clarify scope", title: "Keep pure CQRS handlers cleanly", sets: [], appends: [], fulfillments: [] },
    currentDecision,
  );
  assert.equal(amended.title, "Keep pure CQRS handlers cleanly");
});

test("application ./queries barrel exposes pure CQRS read assemblers and projection cut guards", () => {
  assert.equal(typeof workIndexFromProjection, "function");

  const cut = projectionCut({ status: "current", watermark: 12, sourceRevision: 12 });
  assert.deepEqual(cut, { status: "current", watermark: 12, sourceRevision: 12 });
  assert.deepEqual(
    requireSameProjectionCut("unit-test", [
      { status: "current", watermark: 12, sourceRevision: 12 },
      { status: "current", watermark: 12, sourceRevision: 12 },
    ]),
    cut,
  );
  assert.throws(
    () =>
      requireSameProjectionCut("unit-test", [
        { status: "current", watermark: 12, sourceRevision: 12 },
        { status: "current", watermark: 13, sourceRevision: 13 },
      ]),
    /spans multiple event projection cuts/u,
  );

  assert.deepEqual(decodeEvidencePayload('payload:{"ok":true}'), { ok: true });
  assert.match(renderEvidencePayload({ ok: true, count: 2 }), /ok=true\s+count=2/u);

  const todos = readTodos({
    listEntities: () => [
      {
        id: "todo_0123456789abcdef01234567",
        workspaceRevision: 7,
        value: { id: "todo_0123456789abcdef01234567", text: "Ship W1A", completed: false, archived: false },
      },
    ],
    getEntity: () => undefined,
    read: () => ({ snapshot: { task: null } }),
    readDecision: () => ({ decision: null }),
    readRelationQuery: () => ({ rows: [], page: { nextCursor: null } }),
  } as unknown as Parameters<typeof readTodos>[0]);
  assert.equal(todos.length, 1);
  assert.equal(todos[0]?.ref, "todo/todo_0123456789abcdef01234567");
  assert.equal(todos[0]?.open, true);

  assert.equal(typeof runChannelWriteAction, "function");
  assert.equal(typeof drainChannelOutbox, "function");
  assert.equal(typeof readChannelListAction, "function");

  const channelRead = readChannelList(
    {
      readCut: () => ({ status: "current", watermark: 9, sourceRevision: 9 }),
      readInbox: () => ({ status: "ready", items: [], nextCursor: null }),
      readPeerRequests: () => ({ status: "ready", requests: [], nextCursor: null }),
    } as unknown as Parameters<typeof readChannelList>[0],
    { principalPersonId: "person_owner", channelKind: "gui", direction: "inbound", limit: 10 },
    (message) => {
      throw Object.assign(new Error(message), { code: "invalid_field" });
    },
  );
  assert.deepEqual(channelRead, { items: [], nextCursor: null, watermark: 9, sourceRevision: 9 });
});
