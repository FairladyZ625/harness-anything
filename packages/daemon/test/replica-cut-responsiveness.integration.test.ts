// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { syncFleetEdgeMirror } from "../src/fleet-center-admission.ts";
import { openPeer } from "../src/fleet/edge.ts";
import { DatabaseSync } from "node:sqlite";
import { fleetFixture, rawPeer } from "./fleet-tls-session.fixture.ts";

test("hello responds during a large shared cut build", { timeout: 60_000 }, async (t) => {
  const f = await fleetFixture(t);
  t.after(() => f.close());
  const center = await f.center(),
    replica = f.host.replica(f.subject.repoId),
    db = new DatabaseSync(path.join(f.repo, ".harness/cache/task.sqlite"));
  try {
    // 64 MiB of authored document bodies forces the real readReplicaBasis JSON parse path.
    const body = "x".repeat(64 * 1024),
      insert = db.prepare("INSERT INTO document(path, workspace_revision, value_json) VALUES (?, ?, ?)");
    db.exec("BEGIN");
    for (let i = 0; i < 1024; i++) {
      const itemPath = `context/large-${i}.md`;
      insert.run(
        itemPath,
        1,
        JSON.stringify({
          path: itemPath,
          body,
          blobSha256: "a".repeat(64),
          size: Buffer.byteLength(body),
          mediaType: "text/markdown",
          policyId: "markdown-body-replaceable/v1",
          workspaceRevision: 1,
        }),
      );
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  let complete = false;
  const first = replica.prepare(),
    second = replica.prepare();
  const building = first.then((cut) => {
    complete = true;
    return cut;
  });
  const peer = await rawPeer(f.track, center.port, f.cert, f.subject.nodeId, "machine-secret");
  assert.equal(complete, false, "real TLS hello must finish before the large cut build");
  assert.strictEqual(first, second, "concurrent edges share the same construction promise");
  peer.close();
  const cut = await building;
  assert.ok(cut);
  assert.ok(cut.manifest.totalBytes >= 64 * 1024 * 1024);
  assert.equal(replica.latest()?.manifest.digest, cut.manifest.digest);
});

test("default TLS name uses the target DNS host and IP host", async (t) => {
  const f = await fleetFixture(t);
  t.after(() => f.close());
  const center = await f.center();
  for (const hostname of ["localhost", "127.0.0.1"]) {
    const peer = await openPeer({
      hostname,
      port: center.port,
      ca: f.cert,
      repoId: f.subject.repoId,
      nodeId: f.subject.nodeId,
      credential: "machine-secret",
    });
    peer.close();
  }
});

test("internal admission failure retains its code without registration advice", async (t) => {
  const f = await fleetFixture(t);
  t.after(() => f.close());
  const center = await f.center();
  f.failOwnerLookup(new Error("registry unreadable"));
  await assert.rejects(
    syncFleetEdgeMirror({
      payload: {
        host: "127.0.0.1",
        port: center.port,
        caPath: f.certFile,
        servername: "localhost",
        nodeId: f.subject.nodeId,
        credential: "machine-secret",
        repoId: f.subject.repoId,
        viewRoot: path.join(f.root, "failed-edge"),
        quotaBytes: 64 * 1024 * 1024,
        workspaceRoot: f.repo,
      },
    } as Parameters<typeof syncFleetEdgeMirror>[0]),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, "handler_failed");
      assert.match(String(error), /Center replica admission failed/u);
      assert.doesNotMatch(String(error), /Register the node|credential/u);
      return true;
    },
  );
  assert.match(String((f.transportErrors[0] as { error: unknown }).error), /registry unreadable/u);
});
