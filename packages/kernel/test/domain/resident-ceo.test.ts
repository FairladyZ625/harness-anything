// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertResidentCeoPrincipal,
  createResidentCeoProfile,
  ResidentCeoProfileError,
  residentCeoWakeDue,
  residentCeoWakeReceipt,
} from "../../src/domain/resident-ceo.ts";

const profile = createResidentCeoProfile(
  {
    principalPersonId: "person_owner",
    runtimeInstanceId: "runtime_local",
    model: "model-a",
    heartbeatIntervalSec: 60,
  },
  "2026-11-24T00:00:00.000Z",
);

test("resident CEO profile validates its principal, provider selection, and controlled interval", () => {
  assert.equal(profile.principalPersonId, "person_owner");
  assert.equal(profile.runtimeInstanceId, "runtime_local");
  assert.equal(profile.model, "model-a");
  assert.throws(
    () => assertResidentCeoPrincipal(profile, "person_other"),
    (error: unknown) => error instanceof ResidentCeoProfileError && error.code === "resident_ceo_principal_mismatch",
  );
  assert.throws(
    () => createResidentCeoProfile({ ...profile, heartbeatIntervalSec: 1 }, "2026-11-24T00:00:00.000Z"),
    (error: unknown) => error instanceof ResidentCeoProfileError && error.code === "resident_ceo_invalid_profile",
  );
});

test("heartbeat is due only for a running profile and advances from the previous receipt", () => {
  const running = { ...profile, status: "running" as const };
  assert.equal(residentCeoWakeDue(profile, Date.parse("2026-11-24T00:01:00.000Z")), false);
  assert.equal(residentCeoWakeDue(running, Date.parse("2026-11-24T00:00:00.000Z")), true);
  const completed = residentCeoWakeReceipt({
    profile: running,
    wakeId: "wake-1",
    cause: "heartbeat",
    requestedAt: "2026-11-24T00:00:00.000Z",
    completedAt: "2026-11-24T00:00:10.000Z",
    status: "succeeded",
    runtimeSessionId: "session-1",
    persistentSessionId: "provider-session-1",
  });
  assert.equal(residentCeoWakeDue(completed, Date.parse("2026-11-24T00:01:09.999Z")), false);
  assert.equal(residentCeoWakeDue(completed, Date.parse("2026-11-24T00:01:10.000Z")), true);
  assert.equal(completed.persistentSessionId, "provider-session-1");
});

test("a running wake receipt prevents overlapping heartbeat dispatch", () => {
  const waking = residentCeoWakeReceipt({
    profile: { ...profile, status: "running" },
    wakeId: "wake-2",
    cause: "peer-request",
    requestedAt: "2026-11-24T00:00:00.000Z",
    completedAt: null,
    status: "running",
    runtimeSessionId: null,
  });
  assert.equal(residentCeoWakeDue(waking, Date.parse("2026-11-24T00:05:00.000Z")), false);
});
