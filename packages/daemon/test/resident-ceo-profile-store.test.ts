// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createResidentCeoProfile } from "@harness-anything/kernel/internal/domain/resident-ceo.ts";
import { openResidentCeoProfileStore } from "../src/daemon-host/resident-ceo-profile-store.ts";

test("resident CEO profiles persist through the supplied repository-writer settings boundary", async () => {
  let serialized: string | undefined;
  const writes: string[] = [];
  const store = openResidentCeoProfileStore({
    key: "repo-a",
    readSerialized: async () => serialized,
    writeSerialized: async (value) => {
      writes.push(value);
      serialized = value;
    },
  });
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
  assert.equal(writes.length, 1);
  await assert.rejects(store.write({ ...profile, model: "model-b" }, null), /changed before write/u);
});

test("resident CEO profile writes preserve concurrent principals in one repository settings record", async () => {
  let serialized: string | undefined;
  const callbacks = {
    key: "repo-concurrent",
    readSerialized: async () => serialized,
    writeSerialized: async (value: string) => {
      serialized = value;
    },
  };
  const firstStore = openResidentCeoProfileStore(callbacks),
    secondStore = openResidentCeoProfileStore(callbacks),
    owner = createResidentCeoProfile(
      {
        principalPersonId: "person_owner",
        runtimeInstanceId: "instance-one",
        model: "model-a",
        heartbeatIntervalSec: 60,
      },
      "2026-11-24T00:00:00.000Z",
    ),
    peer = createResidentCeoProfile(
      {
        principalPersonId: "person_peer",
        runtimeInstanceId: "instance-two",
        model: "model-b",
        heartbeatIntervalSec: 90,
      },
      "2026-11-24T00:00:01.000Z",
    );
  await Promise.all([firstStore.write(owner, null), secondStore.write(peer, null)]);
  assert.deepEqual(await firstStore.read("person_owner"), owner);
  assert.deepEqual(await firstStore.read("person_peer"), peer);
});
