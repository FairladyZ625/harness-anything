// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { joinFleetEdge, type EdgeJoinClientPorts } from "../src/fleet/edge-join-client.ts";
import { createEdgeJoinStore, encodeEdgeJoinLink } from "../src/fleet/edge-join.ts";

test("one invitation creates and syncs an independent workspace for every repository", async (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "ha-edge-join-client-")),
    certFile = path.join(temp, "center.crt"),
    keyFile = path.join(temp, "center.key");
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-subj",
      "/CN=center.example",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(certFile),
    invite = createEdgeJoinStore({ randomToken: () => "short-lived-token" }).create({
      centerOrigin: "https://center.example:8443",
      repoIds: ["repo-a", "repo-b"],
      personId: "person-edge",
      permissionSnapshot: [{ groupId: "viewer", version: "snapshot-digest" }],
      spkiSha256: "a".repeat(64),
      loginUrl: "https://login.example",
      loginRealm: "harness",
      loginClientId: "edge-client",
      createdBy: "person-admin",
      ttlMs: 72 * 60 * 60 * 1000,
    }),
    registrations: string[] = [],
    syncs: Record<string, unknown>[] = [],
    ports: EdgeJoinClientPorts = {
      session: async () => ({
        accessToken: "person-access-token",
        authority: { url: "https://login.example", realm: "harness" },
      }),
      beginLogin: async () => assert.fail("an existing matching session must not start a login"),
      register: async (workspaceRoot, repoId) => {
        registrations.push(`${repoId}:${workspaceRoot}`);
        return { ok: true };
      },
      sync: async (payload) => {
        syncs.push(payload);
        return { ok: true, knownHead: { sequence: 2 } };
      },
      join: async (input) => {
        assert.equal(input.joinId, invite.record.joinId);
        assert.equal(input.inviteToken, invite.link.token);
        assert.equal(input.spkiSha256, invite.link.spkiSha256);
        return {
          schema: "fleet.edge.join.result/v1",
          messageId: "join-result",
          inReplyTo: "join-request",
          joinId: invite.record.joinId,
          nodeId: "edge-node",
          personId: "person-edge",
          credential: "machine-credential",
          repositories: [
            { repoId: "repo-a", harnessYaml: "schema: harness-anything/v1\nname: A\n" },
            { repoId: "repo-b", harnessYaml: "schema: harness-anything/v1\nname: B\n" },
          ],
          certificate: cert.toString("base64"),
        };
      },
      homeDir: temp,
    },
    result = await joinFleetEdge(
      { link: encodeEdgeJoinLink(invite.link), workspaceRoot: path.join(temp, "workspace") },
      ports,
    );

  assert.deepEqual(result.repoIds, ["repo-a", "repo-b"]);
  assert.equal(result.state, "synced");
  assert.equal(result.ok, true);
  assert.deepEqual(
    registrations.map((value) => value.split(":")[0]),
    ["repo-a", "repo-b"],
  );
  assert.deepEqual(
    syncs.map((payload) => payload.repoId),
    ["repo-a", "repo-b"],
  );
  const workspaceRoots = syncs.map((payload) => String(payload.workspaceRoot));
  assert.notEqual(workspaceRoots[0], workspaceRoots[1]);
  for (const [index, repoId] of ["repo-a", "repo-b"].entries()) {
    const workspaceRoot = workspaceRoots[index]!;
    assert.equal(path.basename(workspaceRoot), repoId);
    assert.equal(existsSync(path.join(workspaceRoot, "fleet-center-ca.pem")), true);
    assert.equal(existsSync(path.join(workspaceRoot, "harness", "harness.yaml")), true);
    assert.equal(syncs[index]?.nodeId, "edge-node");
    assert.equal(syncs[index]?.credential, "machine-credential");
  }
  assert.equal(JSON.stringify(result).includes("machine-credential"), false);
});
