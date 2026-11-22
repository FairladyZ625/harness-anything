// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { FLEET_FRAME_BYTES } from "../src/daemon-host/fleet/command-protocol.ts";
import { FleetRemoteError, readFleetOperationalClient } from "../src/daemon-host/fleet/peer.ts";
import { parseDaemonReadResult } from "../src/daemon-host/protocol/daemon-result-validation.ts";
import { fleetFixture } from "./fleet-tls-session.fixture.ts";

test(
  "Fleet event subscription resumes across connections and carries complete multi-frame pages",
  { timeout: 45_000 },
  async (t) => {
    const fixture = await fleetFixture(t, undefined, "standard", false);
    const { repoId, nodeId, taskId } = fixture.subject;
    fixture.owners.keycloak.account("person-event-reader");
    fixture.owners.keycloak.permit("person-event-reader", repoId, ["repository-read"]);
    fixture.owners.keycloak.interactiveSession(
      "person-event-reader",
      nodeId,
      fixture.owners.url,
      "reader-token",
      "web-bff",
    );

    const center = await fixture.center(),
      peer = {
        port: center.port,
        ca: fixture.cert,
        servername: "localhost",
        nodeId,
        credential: "machine-secret",
        repoId,
      },
      request = (payload: Readonly<Record<string, unknown>>, token?: string) =>
        readFleetOperationalClient({
          ...peer,
          method: "repo.events.read",
          payload,
          readAccessToken: async () => token,
        }),
      read = async (payload: Readonly<Record<string, unknown>>) =>
        parseDaemonReadResult("repo.events.read", await request(payload, "reader-token"));

    const initial = await read({ afterRevision: 0, limit: 500 });
    assert.equal(initial.headRevision, fixture.eventCount());
    assert.equal(initial.hasMore, false);
    const append = async (number: number) => {
      const receipt = await fixture.host.run(
        repoId,
        {
          kind: "fact-record",
          taskId,
          statement: `Fleet replay batch ${number} ${"a".repeat(24_000)}`,
          evidenceSource: "synthetic event subscription fixture",
          confidence: "high",
          memoryClass: "episodic",
          memoryTags: [],
        },
        fixture.auth,
      );
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      return receipt.opId;
    };

    for (let i = 0; i < 5; i++) await append(i);
    const first = await read({ afterRevision: initial.nextAfterRevision, limit: 1 });
    assert.equal(first.events.length, 1);
    assert.equal(first.hasMore, true);
    await append(5);
    const resumed = await read({ afterRevision: first.nextAfterRevision, limit: 500 });
    assert.ok(Buffer.byteLength(JSON.stringify(resumed)) > FLEET_FRAME_BYTES);
    assert.equal(resumed.hasMore, false);
    const local = await fixture.host.read(
      repoId,
      "repo.events.read",
      {
        afterRevision: initial.nextAfterRevision,
        limit: 500,
      },
      fixture.auth,
    );
    assert.deepEqual([...first.events, ...resumed.events], local.events);
    assert.equal(new Set(local.events.map((event) => event.opId)).size, local.events.length);

    const tail = resumed.nextAfterRevision;
    const idle = await read({ afterRevision: tail, limit: 1, waitMs: 5_100 });
    assert.deepEqual(idle.events, []);
    assert.equal(idle.headRevision, tail);
    assert.equal(idle.nextAfterRevision, tail);

    const [woken, opId] = await Promise.all([read({ afterRevision: tail, limit: 1, waitMs: 10_000 }), append(6)]);
    assert.equal(woken.events[0]?.opId, opId);
    await assert.rejects(
      request({ afterRevision: 0, limit: 1 }),
      (error: unknown) => error instanceof FleetRemoteError && error.code === "authentication_required",
    );
    await assert.rejects(read({ afterRevision: woken.headRevision + 1, limit: 1 }), { code: "invalid_cursor" });
    await assert.rejects(read({ afterRevision: 0, limit: 501 }), { code: "invalid_request" });
  },
);
