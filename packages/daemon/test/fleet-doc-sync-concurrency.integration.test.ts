// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { sha256Text } from "@harness-anything/kernel";
import { fleetFixture } from "./fleet-tls-session.fixture.ts";
import { readFleetRepositoryMetadataClient, runFleetWriteClient } from "../src/fleet/peer.ts";

test("edge doc writes tolerate unrelated center writes and reject changed documents atomically", async (t) => {
  const fixture = await fleetFixture(t),
    center = await fixture.center(),
    peer = {
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
      readAccessToken: async () => `device-token-${fixture.subject.nodeId}`,
    },
    base = (await readFleetRepositoryMetadataClient(peer)).baseLedgerSha,
    write = (changes: readonly { path: string; body: string; baseBlobSha256: string | null }[]) =>
      runFleetWriteClient({ ...peer, baseLedgerSha: base, channel: "collaborator", executionId: null, changes });
  const other = await write([{ path: "context/other.md", body: "# Other\n", baseBlobSha256: null }]);
  assert.equal(other.center.outcome, "applied", JSON.stringify(other));
  const target = await write([{ path: "context/target.md", body: "# Target\n", baseBlobSha256: null }]);
  assert.equal(target.center.outcome, "applied", JSON.stringify(target));
  const conflict = await write([
    { path: "context/untouched.md", body: "# Must not land\n", baseBlobSha256: null },
    { path: "context/target.md", body: "# Stale candidate\n", baseBlobSha256: null },
  ]);
  assert.equal(conflict.center.outcome, "op_rejected", JSON.stringify(conflict));
  assert.equal(conflict.center.code, "base_blob_changed");
  assert.match(String(conflict.center.receipt?.rejectionExplanation), /concurrent.*document/iu);
  assert.match(String(conflict.center.receipt?.rejectionExplanation), /sync|resolve/iu);
  const absent = await fixture.host.run(
    fixture.subject.repoId,
    { kind: "doc-show", path: "context/untouched.md" },
    fixture.auth,
  );
  assert.equal(absent.code, "document_not_found", JSON.stringify(absent));
  const updated = await write([
    { path: "context/target.md", body: "# Fresh candidate\n", baseBlobSha256: sha256Text("# Target\n") },
  ]);
  assert.equal(updated.center.outcome, "applied", JSON.stringify(updated));
});
