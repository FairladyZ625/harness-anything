// harness-test-tier: integration
// `ha daemon fleet edge sync` (syncFleetEdgeMirror) admission errors against a real TLS center:
// TLS name handling, and every center rejection keeps its code with operator advice that fits it —
// no registration advice for an internal failure, the original cause for a crashed handler,
// a grant request for a recognized node whose owner lacks the action. Migrated from the
// admission cases of the retired replica-cut-responsiveness test (dec_9284BD6119D453EEECEED62450).
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { syncFleetEdgeMirror } from "../src/fleet-center-admission.ts";
import { openPeer } from "../src/fleet/peer.ts";
import { fleetFixture } from "./fleet-tls-session.fixture.ts";

type Fixture = Awaited<ReturnType<typeof fleetFixture>>;
const sync = (f: Fixture, port: number, view: string) =>
  syncFleetEdgeMirror(
    {
      payload: {
        host: "127.0.0.1",
        port,
        caPath: f.certFile,
        servername: "localhost",
        nodeId: f.subject.nodeId,
        credential: "machine-secret",
        repoId: f.subject.repoId,
        viewRoot: path.join(f.root, view),
        quotaBytes: 64 * 1024 * 1024,
        workspaceRoot: f.repo,
      },
    },
    async () => `device-token-${f.subject.nodeId}`,
  );

test("default TLS name remains localhost and explicit servername is honored", async (t) => {
  const f = await fleetFixture(t);
  t.after(() => f.close());
  const center = await f.center();
  for (const hostname of [undefined, "localhost", "127.0.0.1"]) {
    const peer = await openPeer({
      readAccessToken: async () => `device-token-${f.subject.nodeId}`,
      hostname,
      port: center.port,
      ca: f.cert,
      nodeId: f.subject.nodeId,
      credential: "machine-secret",
    });
    peer.close();
  }
  await assert.rejects(
    openPeer({
      readAccessToken: async () => `device-token-${f.subject.nodeId}`,
      hostname: "127.0.0.1",
      port: center.port,
      ca: f.cert,
      servername: "wrong.example",
      nodeId: f.subject.nodeId,
      credential: "machine-secret",
    }),
    { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
  );
});

test("internal admission failure retains its code without registration advice", async (t) => {
  const f = await fleetFixture(t);
  t.after(() => f.close());
  const center = await f.center();
  f.failOwnerLookup(new Error("registry unreadable"));
  await assert.rejects(sync(f, center.port, "failed-edge"), (error: unknown) => {
    assert.equal((error as { code: string }).code, "handler_failed");
    assert.match(String(error), /Center replica admission failed/u);
    assert.doesNotMatch(String(error), /Register the node|credential/u);
    return true;
  });
  assert.match(String((f.transportErrors[0] as { error: unknown }).error), /registry unreadable/u);
});

test("captured worker OOM error reaches the edge without a closed-schema rejection", async (t) => {
  const f = await fleetFixture(t);
  t.after(() => f.close());
  const center = await f.center();
  const message = "Worker terminated due to reaching memory limit: JS heap out of memory";
  f.failOwnerLookup(Object.assign(new Error(message), { code: "ERR_WORKER_OUT_OF_MEMORY" }));
  await assert.rejects(sync(f, center.port, "oom-edge"), (error: unknown) => {
    assert.equal((error as { code: string }).code, "handler_failed");
    assert.equal((error as Error).message, `Center replica admission failed: handler_failed: ${message}`);
    return true;
  });
});

test("a recognized node whose owner lacks the action is told to request a grant", async (t) => {
  const f = await fleetFixture(t);
  t.after(() => f.close());
  f.owners.keycloak.account("person-denied");
  f.owners.keycloak.node(f.subject.nodeId, "person-denied");
  f.owners.keycloak.interactiveSession(
    "person-denied",
    f.subject.nodeId,
    f.owners.url,
    `device-token-${f.subject.nodeId}`,
  );
  const center = await f.center();
  await assert.rejects(sync(f, center.port, "denied-edge"), (error: unknown) => {
    assert.equal((error as { code: string }).code, "authorization_denied");
    assert.match(String(error), /Ask a center administrator to grant the node's owner repository-read/u);
    return true;
  });
});
