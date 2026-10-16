// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createEdgeJoinStore, decodeEdgeJoinLink, EdgeJoinError, encodeEdgeJoinLink } from "../src/fleet/edge-join.ts";

test("edge join invitation is typed, pin checked, person bound, and single use", () => {
  const current = "2026-10-16T00:00:00.000Z";
  const store = createEdgeJoinStore({ now: () => current, randomToken: () => "opaque-token" });
  const link = store.create({
    centerUrl: "https://center.example",
    personId: "person-a",
    nodeId: "node-a",
    spkiSha256: "sha256:pin",
    ttlMs: 60_000,
  });
  const encoded = encodeEdgeJoinLink(link);
  assert.deepEqual(decodeEdgeJoinLink(encoded), link);
  assert.equal(store.status(link.inviteId).status, "pending");
  assert.throws(
    () => store.consume({ link: encoded, loginPersonId: "person-a", observedSpkiSha256: "sha256:wrong" }),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "pin_mismatch",
  );
  assert.throws(
    () => store.consume({ link: encoded, loginPersonId: "person-b", observedSpkiSha256: "sha256:pin" }),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "person_mismatch",
  );
  const consumed = store.consume({ link: encoded, loginPersonId: "person-a", observedSpkiSha256: "sha256:pin" });
  assert.equal(consumed.consumedAt, current);
  assert.equal(store.status(link.inviteId).status, "consumed");
  assert.throws(
    () => store.consume({ link: encoded, loginPersonId: "person-a", observedSpkiSha256: "sha256:pin" }),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "already_consumed",
  );
});

test("edge join invitation expires before consumption", () => {
  let current = "2026-10-16T00:00:00.000Z";
  const store = createEdgeJoinStore({ now: () => current, randomToken: () => "opaque-token" });
  const link = store.create({
    centerUrl: "https://center.example",
    personId: "person-a",
    nodeId: "node-a",
    spkiSha256: "pin",
    ttlMs: 1,
  });
  current = "2026-10-16T00:00:00.002Z";
  assert.equal(store.status(link.inviteId).status, "expired");
  assert.throws(
    () => store.consume({ link, loginPersonId: "person-a", observedSpkiSha256: "pin" }),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "expired",
  );
});
