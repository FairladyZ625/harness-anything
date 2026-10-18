// harness-test-tier: integration
// `ha edge join <link>` from a signed-in edge daemon: each edge exchanges its own invitation for a machine
// credential over the pinned center TLS, registers a fresh workspace as a remote-edge mirror and runs the
// first sync. The credential lands only in fleet-edge.json (0600); the receipt never carries it. An
// invitation bound to another person is refused.
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readFleetEdgeConfig } from "../src/client/fleet-edge-config.ts";
import { FleetFault } from "../src/fleet/center-types.ts";
import { createEdgeJoinStore, encodeEdgeJoinLink } from "../src/fleet/edge-join.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";

test(
  "two edges join with their own invitations and see center tasks; another person's invitation is refused",
  {
    timeout: 240_000,
  },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
    assert.equal(
      (await f.command("center-node", { kind: "task-create", taskId: "joined-0", title: "Joined 0" })).outcome,
      "applied",
    );
    const cert = readFileSync(path.join(f.root, "tls.crt")),
      spkiSha256 = `sha256:${createHash("sha256")
        .update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" }))
        .digest("base64")}`,
      invites = createEdgeJoinStore(),
      harnessYaml = readFileSync(path.join(f.repo, "harness/harness.yaml"), "utf8");
    // Stands in for the center's Keycloak check: the edge fixture's device token names person-one.
    const center = await f.openCenter(f.host, undefined, {
      edgeJoin: ({ inviteToken, nodeId, accessToken }) => {
        const invite = invites.findByToken(inviteToken);
        if (!invite || invite.nodeId !== nodeId) throw new FleetFault("edge_join_invalid", "invalid invitation");
        const personId = accessToken?.startsWith("device-token-") ? "person-one" : "unknown";
        if (personId !== invite.personId) throw new FleetFault("person_mismatch", "another person's invitation");
        invites.consume({ link: invite, loginPersonId: personId, observedSpkiSha256: spkiSha256 });
        return { nodeId, personId, credential: `secret-${nodeId}`, repoId: "lease-repo", harnessYaml };
      },
    });
    const link = (nodeId: string, personId: string) =>
      encodeEdgeJoinLink(
        invites.create({
          centerUrl: `https://localhost:${center.port}`,
          personId,
          nodeId,
          spkiSha256,
          ttlMs: 600_000,
          loginUrl: f.owners.url,
          loginRealm: "harness",
          loginClientId: "harness-cli",
        }),
      );

    const join = async (nodeId: string, invitation: string) => {
      const edge = await fleetEdgeHostFixture(t, f, {
          name: nodeId,
          nodeId,
          registerBeforeOpen: false,
          writeEdgeConfig: false,
        }),
        workspaceRoot = path.join(mkdtempSync(path.join(tmpdir(), "ha-edge-join-")), "workspace");
      const response = await edge.rpc.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "daemon.rbac.manage",
        params: { operation: "edge-join", link: invitation, workspaceRoot },
      });
      return { response: response as Record<string, unknown>, workspaceRoot };
    };

    for (const nodeId of ["node-one", "node-two"]) {
      f.owners.keycloak.interactiveSession("person-one", nodeId, f.owners.url, `device-token-${nodeId}`, "harness-cli");
      const { response, workspaceRoot } = await join(nodeId, link(nodeId, "person-one")),
        result = response.result as Record<string, unknown>;
      assert.equal(result?.ok, true, JSON.stringify(response));
      assert.equal(result.nodeId, nodeId);
      assert.equal(JSON.stringify(response).includes(`secret-${nodeId}`), false, "the receipt carries no credential");
      const config = readFleetEdgeConfig(workspaceRoot);
      assert.equal(config?.credential, `secret-${nodeId}`);
      assert.equal(config?.humanClientId, "harness-cli");
      assert.equal(statSync(path.join(workspaceRoot, "fleet-edge.json")).mode & 0o777, 0o600);
      const tasks = path.join(workspaceRoot, "harness", "tasks");
      assert.ok(
        existsSync(tasks) && readdirSync(tasks).some((name) => name.includes("joined-0")),
        "the first sync mirrors the center's task",
      );
    }

    const refused = await join("node-three", link("node-three", "person-two"));
    assert.equal("result" in refused.response && (refused.response.result as { ok?: unknown }).ok === true, false);
    assert.match(JSON.stringify(refused.response), /person_mismatch|another person/u);
    assert.equal(existsSync(path.join(refused.workspaceRoot, "fleet-edge.json")), false);
  },
);
