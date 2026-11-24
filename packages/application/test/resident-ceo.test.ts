// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { makeResidentCeoService } from "../src/resident-ceo.ts";
import type { ResidentCeoProfile } from "@harness-anything/kernel/internal/domain/resident-ceo.ts";

function fixture() {
  let profile: ResidentCeoProfile | null = null;
  let now = "2026-11-24T00:00:00.000Z";
  const runs: { readonly persistentSessionId: string | null; readonly peerRequestId?: string }[] = [];
  const service = makeResidentCeoService({
    profiles: {
      read: async () => profile,
      write: async (next, expectedUpdatedAt) => {
        assert.equal(expectedUpdatedAt, profile?.updatedAt ?? null);
        profile = next;
      },
    },
    runtime: {
      run: async (request) => {
        runs.push({
          persistentSessionId: request.persistentSessionId,
          ...(request.peerRequestId === undefined ? {} : { peerRequestId: request.peerRequestId }),
        });
        return {
          runtimeSessionId: `session-${runs.length}`,
          response: Promise.resolve({
            response: `reply-${runs.length}`,
            persistentSessionId: `provider-session-${runs.length}`,
          }),
        };
      },
    },
    now: () => now,
    createId: () => `wake-${runs.length + 1}`,
  });
  return { service, runs, setNow: (value: string) => (now = value) };
}

test("resident CEO config, start, and stop preserve principal ownership", async () => {
  const { service } = fixture();
  const configured = await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
  });
  assert.equal(configured.status, "stopped");
  assert.equal((await service.start("person_owner")).status, "running");
  assert.equal((await service.stop("person_owner")).status, "stopped");
  await assert.rejects(service.status("person_other"), /belongs to person_owner/u);
});

test("chat and peer wakes resume the same persistent session and record a receipt", async () => {
  const { service, runs, setNow } = fixture();
  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
  });
  await service.start("person_owner");
  const first = await service.wake("person_owner", "human-chat", "Please review the current plan.");
  setNow("2026-11-24T00:00:30.000Z");
  const second = await service.wake(
    "person_owner",
    "peer-request",
    "Peer request: prepare a handoff.",
    "peer_request_1",
  );
  assert.equal(first.response, "reply-1");
  assert.equal(second.response, "reply-2");
  assert.equal(runs[0]?.persistentSessionId, null);
  assert.equal(runs[1]?.persistentSessionId, "provider-session-1");
  assert.equal(runs[1]?.peerRequestId, "peer_request_1");
  assert.equal(second.profile.persistentSessionId, "provider-session-2");
  assert.equal(second.profile.lastWake?.cause, "peer-request");
  assert.equal(second.profile.lastWake?.status, "succeeded");
});

test("heartbeat wakes only when due and persists the current session pointer", async () => {
  const { service, runs, setNow } = fixture();
  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
  });
  await service.start("person_owner");
  const first = await service.wake("person_owner", "heartbeat", "Check inbox.");
  setNow("2026-11-24T00:00:59.999Z");
  const early = await service.wake("person_owner", "heartbeat", "Check inbox.");
  assert.equal(early.response, null);
  assert.equal(runs.length, 1);
  setNow("2026-11-24T00:01:00.000Z");
  const next = await service.wake("person_owner", "heartbeat", "Check inbox.");
  assert.equal(next.response, "reply-2");
  assert.equal(runs[1]?.persistentSessionId, "provider-session-1");
});

test("changing provider instance or model clears an incompatible provider session pointer", async () => {
  const { service } = fixture();
  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
  });
  await service.start("person_owner");
  await service.wake("person_owner", "human-chat", "Continue this session.");
  const changed = await service.configure("person_owner", {
    runtimeInstanceId: "instance-two",
    model: "model-two",
    heartbeatIntervalSec: 60,
  });
  assert.equal(changed.persistentSessionId, null);
  assert.equal(changed.status, "running");
});
