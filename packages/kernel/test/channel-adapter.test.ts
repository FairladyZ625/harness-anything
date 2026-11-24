// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  channelDedupeKey,
  channelInboxSource,
  channelPageLimit,
  validateChannelInboxEnvelope,
  validateChannelOutboxMessage,
} from "../src/domain/channel-adapter.ts";

test("channel adapter: envelope validation", () => {
  assert.deepEqual(validateChannelInboxEnvelope(null), ["channel inbox envelope must be an object"]);
  assert.deepEqual(validateChannelInboxEnvelope({}), ["channel inbox envelope required fields are invalid"]);

  const valid = {
    envelopeId: "env-1",
    channelKind: "webhook",
    idempotencyKey: "key-1",
    principalPersonId: "person_alice",
    summary: "External webhook message",
  };
  assert.deepEqual(validateChannelInboxEnvelope(valid), []);

  const peerValid = {
    ...valid,
    channelKind: "a2a-peer",
    peerPayload: {
      toPersonId: "person_bob",
      claim: "Need help",
      requestedAction: "Review logs",
    },
  };
  assert.deepEqual(validateChannelInboxEnvelope(peerValid), []);

  const peerMissing = { ...valid, channelKind: "a2a-peer" };
  assert.deepEqual(validateChannelInboxEnvelope(peerMissing), ["a2a-peer channel requires peerPayload"]);
});

test("channel adapter: outbox message validation", () => {
  assert.deepEqual(validateChannelOutboxMessage(null), ["channel outbox message must be an object"]);

  const valid = {
    messageId: "msg-1",
    channelKind: "gui",
    idempotencyKey: "key-1",
    principalPersonId: "person_alice",
    summary: "Reply to user",
    recipientRef: "person_bob",
  };
  assert.deepEqual(validateChannelOutboxMessage(valid), []);
});

test("channel adapter: dedupe key is deterministic", () => {
  const key = channelDedupeKey({ channelKind: "webhook", idempotencyKey: "hook-42" });
  assert.equal(key, "channel:webhook:hook-42");
});

test("channel adapter: channelKind maps to inbox source", () => {
  assert.equal(channelInboxSource("a2a-peer"), "peer_request");
  assert.equal(channelInboxSource("webhook"), "external_ingress");
  assert.equal(channelInboxSource("lark"), "external_ingress");
  assert.equal(channelInboxSource("cli"), "external_ingress");
  assert.equal(channelInboxSource("gui"), "external_ingress");
  assert.equal(channelInboxSource("custom"), "external_ingress");
});

test("channel adapter: page limit bounds", () => {
  assert.equal(channelPageLimit(undefined), 200);
  assert.equal(channelPageLimit(50), 50);
  assert.equal(channelPageLimit(500), 200);
  assert.equal(channelPageLimit(0), 1);
});