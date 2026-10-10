// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { OidcSessionService, type DeviceLoginRequest } from "../src/oidc-session-service.ts";
import { listenFleetTls } from "../src/fleet/center.ts";
import { reportFleetDeviceLogin } from "../src/fleet/edge.ts";
import { fleetFixture } from "./fleet-tls-session.fixture.ts";
import { signInAt } from "./keycloak.fixtures.ts";

test(
  "two nodes concurrently requesting device login each appear as a separate GUI session item",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fleetFixture(t, undefined, "standard", false);
    let now = Date.now();
    const service = new OidcSessionService(fixture.userRoot, { now: () => now });
    const center = await fixture.hold(
      listenFleetTls({
        host: fixture.host,
        stateRoot: path.join(fixture.root, "notice-center"),
        key: fixture.key,
        cert: fixture.cert,
        authenticate: (nodeId, credential) =>
          ["node-one", "node-two"].includes(nodeId) && credential === "machine-secret",
        nodeOwner: () => "person-owner",
        deviceLoginNotice: (nodeId, personId, notice) => service.receiveDeviceNotice(nodeId, personId, notice),
      }),
    );
    const peer = { port: center.port, ca: fixture.cert, credential: "machine-secret" };
    const first = { userCode: "AAAA-BBBB", createdAt: now, expiresAt: now + 60_000, pending: true };
    const second = { ...first, userCode: "CCCC-DDDD", expiresAt: now + 120_000 };
    await Promise.all([
      reportFleetDeviceLogin({ ...peer, nodeId: "node-one" }, first),
      reportFleetDeviceLogin({ ...peer, nodeId: "node-two" }, second),
    ]);
    const session = await service.status();
    const requests = session.deviceLoginRequests as readonly DeviceLoginRequest[];
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((item) => item.nodeId).sort(), ["node-one", "node-two"]);
    assert.equal(JSON.stringify(session).includes("device_code"), false);
    assert.equal(
      new URL(String((await service.deviceApproval(first.userCode)).authorizationUrl)).searchParams.get("user_code"),
      first.userCode,
    );
    await assert.rejects(
      reportFleetDeviceLogin({ ...peer, nodeId: "node-one", credential: "wrong" }, first),
      /authentication_failed/,
    );
    signInAt(fixture.userRoot, "other-person");
    assert.deepEqual((await service.status()).deviceLoginRequests, []);
    await assert.rejects(service.deviceApproval(first.userCode), /no longer pending/);
    signInAt(fixture.userRoot, "person-owner");
    await reportFleetDeviceLogin({ ...peer, nodeId: "node-one" }, { ...first, pending: false });
    assert.equal((await service.status()).deviceLoginRequests instanceof Array, true);
    assert.equal(((await service.status()).deviceLoginRequests as readonly DeviceLoginRequest[]).length, 1);
    now = second.expiresAt;
    assert.deepEqual((await service.status()).deviceLoginRequests, []);
    await assert.rejects(service.deviceApproval(second.userCode), /no longer pending/);
  },
);
