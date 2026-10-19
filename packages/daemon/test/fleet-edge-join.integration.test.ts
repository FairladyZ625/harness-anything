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
      spkiSha256 = createHash("sha256")
        .update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" }))
        .digest("hex"),
      invites = createEdgeJoinStore(),
      loginUrl = "https://keycloak.fixture",
      harnessYaml = readFileSync(path.join(f.repo, "harness/harness.yaml"), "utf8");
    // Stands in for the center's Keycloak check: the edge fixture's device token names person-one.
    const center = await f.openCenter(f.host, undefined, {
      edgeJoin: ({ joinId, inviteToken, accessToken }) => {
        const invite = invites.assertConsumable(joinId, inviteToken);
        const personId = accessToken?.startsWith("device-token-") ? "person-one" : "unknown";
        if (personId !== invite.personId) throw new FleetFault("person_mismatch", "another person's invitation");
        const issuedNodeId = `issued-${invite.joinId}`;
        invites.consume(invite.joinId, inviteToken, issuedNodeId);
        f.owners.keycloak.node(issuedNodeId, personId);
        f.owners.keycloak.interactiveSession(
          personId,
          issuedNodeId,
          f.owners.url,
          `device-token-${issuedNodeId}`,
          "harness-cli",
        );
        return {
          joinId: invite.joinId,
          nodeId: issuedNodeId,
          personId,
          credential: `secret-${issuedNodeId}`,
          repositories: [{ repoId: "lease-repo", harnessYaml }],
        };
      },
    });
    const link = (personId: string, pin = spkiSha256) => {
      const created = invites.create({
        centerOrigin: `https://localhost:${center.port}`,
        repoIds: ["lease-repo"],
        personId,
        permissionSnapshot: [{ groupId: "contributor", version: "scope-digest" }],
        spkiSha256: pin,
        loginUrl,
        loginRealm: "harness",
        loginClientId: "harness-cli",
        createdBy: "person-center",
        ttlMs: 600_000,
      });
      return { joinId: created.record.joinId, link: encodeEdgeJoinLink(created.link) };
    };

    const join = async (nodeId: string, invitation: string) => {
      const edge = await fleetEdgeHostFixture(t, f, {
          name: nodeId,
          nodeId,
          registerBeforeOpen: false,
          writeEdgeConfig: false,
          oidcPorts: {
            loginAuthority: async () => ({ url: loginUrl, realm: "harness", clientId: "harness-cli" }),
          },
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

    for (const nodeName of ["node-one", "node-two"]) {
      const invitation = link("person-one");
      f.owners.keycloak.interactiveSession(
        "person-one",
        nodeName,
        f.owners.url,
        `device-token-${nodeName}`,
        "harness-cli",
      );
      const { response, workspaceRoot } = await join(nodeName, invitation.link),
        result = response.result as Record<string, unknown>;
      assert.equal(result?.ok, true, JSON.stringify(response));
      assert.equal(result.joinId, invitation.joinId);
      assert.equal(result.state, "synced");
      const issuedNodeId = String(result.nodeId);
      assert.equal(
        JSON.stringify(response).includes(`secret-${issuedNodeId}`),
        false,
        "the receipt carries no credential",
      );
      const repoWorkspace = path.join(workspaceRoot, "lease-repo"),
        config = readFleetEdgeConfig(repoWorkspace);
      assert.equal(config?.nodeId, issuedNodeId);
      assert.equal(config?.credential, `secret-${issuedNodeId}`);
      assert.equal(config?.humanClientId, "harness-cli");
      assert.equal(statSync(path.join(repoWorkspace, "fleet-edge.json")).mode & 0o777, 0o600);
      const tasks = path.join(repoWorkspace, "harness", "tasks");
      assert.ok(
        existsSync(tasks) && readdirSync(tasks).some((name) => name.includes("joined-0")),
        "the first sync mirrors the center's task",
      );
    }

    const wrongPin = link("person-one", "f".repeat(64));
    f.owners.keycloak.interactiveSession(
      "person-one",
      "node-three",
      f.owners.url,
      "device-token-node-three",
      "harness-cli",
    );
    const pinRefused = await join("node-three", wrongPin.link);
    assert.match(JSON.stringify(pinRefused.response), /pin_mismatch/u);
    assert.equal(
      invites.status(wrongPin.joinId).state,
      "pending",
      "the pin is checked before the invite token is sent",
    );
    assert.equal(existsSync(path.join(pinRefused.workspaceRoot, "lease-repo", "fleet-edge.json")), false);

    const wrongPerson = link("person-two");
    f.owners.keycloak.interactiveSession(
      "person-one",
      "node-four",
      f.owners.url,
      "device-token-node-four",
      "harness-cli",
    );
    const refused = await join("node-four", wrongPerson.link);
    assert.equal("result" in refused.response && (refused.response.result as { ok?: unknown }).ok === true, false);
    assert.match(JSON.stringify(refused.response), /person_mismatch|another person/u);
    assert.equal(existsSync(path.join(refused.workspaceRoot, "fleet-edge.json")), false);
  },
);
