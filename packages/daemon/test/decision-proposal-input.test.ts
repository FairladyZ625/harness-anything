// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_SETTINGS_V1 } from "@harness-anything/kernel";
import { decisionProposalAction } from "../src/repo-cell-action-parse.ts";

const settings = () => ({ ...INITIAL_SETTINGS_V1, defaultVertical: "software/coding" });

const requiredPacket = {
  title: "Edge decision",
  question: "Can the edge submit the same Decision packet as the center?",
  riskTier: "low",
  urgency: "medium",
  decisionClass: "ordinary",
  chosen: [{ id: "CH1", text: "Forward the decoded packet." }],
  rejected: [{ id: "RJ1", text: "Require the center's file path.", whyNot: "The edge owns that file." }],
  claims: [],
};

const defaults = {
  vertical: "software/coding",
  preset: "decision-conformance",
  appliesTo: { modules: [], productLines: [] },
  fulfillments: [],
  defaultedDecisionPacketFields: ["vertical", "preset", "appliesTo", "fulfillments", "relations"],
};

test("a fleet-forwarded decision proposal with only its required packet fields is accepted", () => {
  const body = "# Edge decision\n\nRecorded from the edge node.\n",
    resolved = decisionProposalAction("/unused", { kind: "decision-propose", ...requiredPacket, body }, settings);
  assert.deepEqual(resolved, { kind: "decision-propose", ...requiredPacket, ...defaults, body });
});

test("a fleet-forwarded decision proposal without a body source keeps the packet body unset", () => {
  const resolved = decisionProposalAction("/unused", { kind: "decision-propose", ...requiredPacket }, settings);
  assert.deepEqual(resolved, { kind: "decision-propose", ...requiredPacket, ...defaults });
  assert.equal(Object.hasOwn(resolved, "body"), false);
});

test("a complete direct GUI proposal keeps its packet fields and body unchanged", () => {
  const body = "# Direct decision\n\nWritten by the GUI.\n",
    action = {
      kind: "decision-propose",
      ...requiredPacket,
      vertical: "software/coding",
      preset: "decision-conformance",
      appliesTo: { modules: ["daemon"], productLines: [] },
      fulfillments: [],
      body,
    };
  assert.deepEqual(decisionProposalAction("/unused", action, settings), action);
});

test("a direct packet still rejects fields that no proposal packet declares", () => {
  assert.throws(
    () => decisionProposalAction("/unused", { kind: "decision-propose", ...requiredPacket, unknown: true }, settings),
    /Decision propose requires one structured packet and at most one body source/u,
  );
});
