// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readFleetEdgeConfig } from "../src/client/fleet-edge-config.ts";

const valid = { schema: "fleet-edge-config/v1", repoId: "plt-center-testbed", host: "center", port: 7443, caPath: "/data/shared/fleet/fleet.crt", nodeId: "edge-1", rosterPath: "/data/shared/fleet/roster.json", assignmentId: "assignment-edge-1", viewRoot: "/data/view", quotaBytes: 268_435_456 };

test("a fleet-edge config marks the workspace and names the fleet channel without duplicating the credential", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-edge-cfg-"));
  try {
    assert.equal(readFleetEdgeConfig(root), null, "a root without fleet-edge.json stays local");
    writeFileSync(path.join(root, "fleet-edge.json"), `${JSON.stringify(valid)}\n`);
    const config = readFleetEdgeConfig(root)!;
    assert.equal(config.repoId, "plt-center-testbed");
    assert.equal(config.credential, undefined);
    const { schema: _schema, ...expected } = valid;
    assert.deepEqual(config, expected);
    for (const [detail, patch] of [["wrong schema", { schema: "fleet-edge/v0" }], ["missing host", { host: "" }], ["bad port", { port: 70000 }], ["zero quota", { quotaBytes: 0 }], ["no credential source", { rosterPath: undefined }], ["bad wait", { waitTimeoutMs: -1 }]] as const) {
      writeFileSync(path.join(root, "fleet-edge.json"), JSON.stringify({ ...valid, ...patch }));
      assert.throws(() => readFleetEdgeConfig(root), /fleet_edge_config_invalid|is invalid/u, detail);
    }
    writeFileSync(path.join(root, "fleet-edge.json"), "{not json");
    assert.throws(() => readFleetEdgeConfig(root), /not valid JSON/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
