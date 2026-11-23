// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeDaemonRegistryRepo } from "@harness-anything/kernel/daemon-registry";
import {
  fleetEdgeCaPath,
  fleetEdgeConfigDir,
  fleetEdgeConfigPath,
  hasAnyFleetEdgeConfig,
  readFleetEdgeConfig,
  readFleetEdgeConfigForRoot,
  removeFleetEdgeConfig,
  resolveFleetEdgeRepoIdForRoot,
  writeFleetEdgeConfig,
} from "../src/daemon-host/client/fleet-edge-config.ts";
import { resolveFleetReplicaAuthority } from "../src/daemon-host/fleet/replica-token.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

const valid = {
  schema: "fleet-edge-config/v1",
  repoId: "plt-center-testbed",
  host: "center",
  port: 7443,
  caPath: "/data/shared/fleet/fleet.crt",
  loginUrl: "https://login.example",
  loginRealm: "tenant-realm",
  nodeId: "edge-1",
  credential: "issued-at-registration",
  viewRoot: "/data/view",
  quotaBytes: 268_435_456,
};

test("a fleet-edge config lives under userRoot by repoId and carries the machine credential the center issued", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-fleet-edge-cfg-")),
    repoId = "plt-center-testbed";
  try {
    assert.equal(readFleetEdgeConfig(userRoot, repoId), null, "a repo without fleet-edge.json stays local");
    assert.equal(hasAnyFleetEdgeConfig(userRoot), false);
    assert.equal(fleetEdgeConfigDir(userRoot, repoId), path.join(path.resolve(userRoot), "fleet", "edge", repoId));
    assert.equal(
      fleetEdgeCaPath(userRoot, repoId),
      path.join(path.resolve(userRoot), "fleet", "edge", repoId, "fleet-center-ca.pem"),
    );
    const configFile = fleetEdgeConfigPath(userRoot, repoId);
    mkdirSync(path.dirname(configFile), { recursive: true });
    writeFileSync(configFile, `${JSON.stringify(valid)}\n`);
    const config = readFleetEdgeConfig(userRoot, repoId)!;
    assert.equal(config.repoId, "plt-center-testbed");
    assert.equal(config.credential, "issued-at-registration");
    assert.equal(hasAnyFleetEdgeConfig(userRoot), true);
    const { schema: _schema, ...expected } = valid;
    assert.deepEqual(config, expected);
    for (const [detail, patch] of [
      ["wrong schema", { schema: "fleet-edge/v0" }],
      ["missing host", { host: "" }],
      ["bad port", { port: 70000 }],
      ["zero quota", { quotaBytes: 0 }],
      ["no credential", { credential: undefined }],
      ["bad wait", { waitTimeoutMs: -1 }],
      ["retired assignment", { assignmentId: "old" }],
      ["retired roster", { rosterPath: "/old.json" }],
    ] as const) {
      writeFileSync(configFile, JSON.stringify({ ...valid, ...patch }));
      assert.throws(() => readFleetEdgeConfig(userRoot, repoId), /fleet_edge_config_invalid|is invalid/u, detail);
    }
    writeFileSync(configFile, "{not json");
    assert.throws(() => readFleetEdgeConfig(userRoot, repoId), /not valid JSON/u);

    writeFleetEdgeConfig(userRoot, repoId, expected);
    writeFileSync(fleetEdgeCaPath(userRoot, repoId), "pem");
    removeFleetEdgeConfig(userRoot, repoId);
    assert.equal(existsSync(configFile), false);
    assert.equal(existsSync(fleetEdgeCaPath(userRoot, repoId)), false);
  } finally {
    removeTempRepository(userRoot);
  }
});

test("resolveFleetEdgeRepoIdForRoot and readFleetEdgeConfigForRoot map registered workspace roots by repoId", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-edge-root-map-")),
    userRoot = path.join(root, "user"),
    repoA = path.join(root, "repo-a"),
    repoB = path.join(root, "repo-b");
  try {
    mkdirSync(path.join(repoA, "harness"), { recursive: true });
    mkdirSync(path.join(repoB, "harness"), { recursive: true });
    writeFileSync(path.join(repoA, "harness/harness.yaml"), "schema: harness-anything/v1\n");
    writeFileSync(path.join(repoB, "harness/harness.yaml"), "schema: harness-anything/v1\n");
    writeDaemonRegistryRepo({
      userRoot,
      canonicalRoot: repoA,
      repoId: "repo-a",
      mode: "remote-edge",
      authoredBranch: "main",
      createConvenienceLinks: false,
    });
    writeDaemonRegistryRepo({
      userRoot,
      canonicalRoot: repoB,
      repoId: "repo-b",
      mode: "remote-edge",
      authoredBranch: "main",
      createConvenienceLinks: false,
    });
    const { schema: _schema, ...base } = valid;
    writeFleetEdgeConfig(userRoot, "repo-a", { ...base, repoId: "repo-a", nodeId: "node-a" });
    writeFleetEdgeConfig(userRoot, "repo-b", { ...base, repoId: "repo-b", nodeId: "node-b" });

    assert.equal(resolveFleetEdgeRepoIdForRoot(userRoot, repoA), "repo-a");
    assert.equal(resolveFleetEdgeRepoIdForRoot(userRoot, repoB), "repo-b");
    assert.equal(readFleetEdgeConfigForRoot(userRoot, repoA)?.nodeId, "node-a");
    assert.equal(readFleetEdgeConfigForRoot(userRoot, repoB)?.nodeId, "node-b");
    assert.equal(readFleetEdgeConfigForRoot(userRoot, path.join(root, "unregistered")), null);
  } finally {
    removeTempRepository(root);
  }
});

test("a legacy edge config accepts the center's authenticated OIDC authority", () => {
  const authority = resolveFleetReplicaAuthority(
    {
      nodeId: "edge-legacy",
      loginUrl: "https://old-login.example",
      loginRealm: undefined,
      loginCertificate: undefined,
      loginServername: undefined,
    },
    { url: "https://login.example", realm: "tenant-realm", clientId: "harness-node-edge-legacy" },
  );
  assert.deepEqual(authority, {
    url: "https://login.example",
    realm: "tenant-realm",
    clientId: "harness-node-edge-legacy",
  });
});
