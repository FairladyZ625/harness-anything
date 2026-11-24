// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createResidentCeoProfile } from "@harness-anything/kernel/internal/domain/resident-ceo.ts";
import { openResidentCeoProfileStore } from "../src/daemon-host/resident-ceo-profile-store.ts";

test("resident CEO profile store persists a principal-scoped profile and rejects stale writes", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "resident-ceo-store-"));
  try {
    const store = openResidentCeoProfileStore(userRoot);
    const profile = createResidentCeoProfile(
      {
        principalPersonId: "person_owner",
        runtimeInstanceId: "instance-one",
        model: "model-a",
        heartbeatIntervalSec: 60,
      },
      "2026-11-24T00:00:00.000Z",
    );
    await store.write(profile, null);
    assert.deepEqual(await store.read("person_owner"), profile);
    assert.deepEqual(await store.list(), [profile]);
    await assert.rejects(store.write({ ...profile, model: "model-b" }, null), /changed before write/u);
    await assert.rejects(store.read("../other"), /principal id is invalid/u);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
