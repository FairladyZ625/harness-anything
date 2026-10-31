// harness-test-tier: integration
// `ha edge join <link>` from a signed-in edge daemon: each edge exchanges its own invitation for a machine
// credential over the pinned center TLS, registers a fresh workspace as a remote-edge mirror and runs the
// first sync. The credential lands only in fleet-edge.json (0600); the receipt never carries it. An
// invitation bound to another person is refused.
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:https";
import test from "node:test";
import { readFleetEdgeConfig } from "../src/client/fleet-edge-config.ts";
import { FleetFault } from "../src/fleet/center-types.ts";
import { createEdgeJoinStore, decodeEdgeJoinLink, encodeEdgeJoinLink } from "../src/fleet/edge-join.ts";
import { saveFleetCenterConfig } from "../src/fleet-center-config.ts";
import { EdgeJoinSshTunnelManager } from "../src/fleet/edge-join-ssh-tunnel.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";

test(
  "two edges join with their own invitations and see center tasks; another person's invitation is refused",
  {
    timeout: 240_000,
  },
  async (t) => {
    const invites = createEdgeJoinStore(),
      sshArgs: (readonly string[])[] = [];
    const fakeChild = (argv: readonly string[]) => {
      const emitter = new EventEmitter() as ChildProcess;
      let stderrListener: ((chunk: string) => void) | undefined;
      const stream = {
        setEncoding() {
          return stream;
        },
        on(event: string, listener: (chunk: string) => void) {
          if (event === "data") stderrListener = listener;
          return stream;
        },
      };
      emitter.stdout = stream as never;
      emitter.stderr = stream as never;
      emitter.kill = () => true;
      const lines: string[] = [];
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "-R") {
          const match = /^127\.0\.0\.1:(?:0|\d+):(.+):(\d+)$/u.exec(argv[i + 1] ?? "");
          if (match) {
            const [, host, port] = match;
            lines.push(`Allocated port ${port} for remote forward to ${host}:${port}\n`);
          }
        }
      }
      setTimeout(() => {
        for (const line of lines) stderrListener?.(line);
      }, 5);
      return emitter;
    };
    const sshTunnels = new EdgeJoinSshTunnelManager({
      spawn: ((_cmd: string, argv: readonly string[]) => {
        sshArgs.push([...argv]);
        return fakeChild(argv);
      }) as never,
    });
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true, {
      edgeJoins: invites,
      sshTunnels,
    });
    assert.equal(
      (await f.command("center-node", { kind: "task-create", taskId: "joined-0", title: "Joined 0" })).outcome,
      "applied",
    );
    const cert = readFileSync(path.join(f.root, "tls.crt")),
      spkiSha256 = createHash("sha256")
        .update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" }))
        .digest("hex"),
      loginCertificate = cert.toString(),
      loginServer = createServer({ cert, key: readFileSync(path.join(f.root, "tls.key")) }, (request, response) => {
        if (request.url !== "/realms/harness") {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      }),
      loginListening = once(loginServer, "listening"),
      harnessYaml = readFileSync(path.join(f.repo, "harness/harness.yaml"), "utf8");
    loginServer.listen(0, "::");
    await loginListening;
    t.after(
      () => new Promise<void>((resolve, reject) => loginServer.close((error) => (error ? reject(error) : resolve()))),
    );
    const loginPort = (loginServer.address() as { port: number }).port,
      loginUrl = `https://localhost:${loginPort}`;
    // Stands in for the center's Keycloak check: the edge fixture's device token names person-one.
    const center = await f.openCenter(f.host, undefined, {
      invitationClientForNode: (nodeId) => {
        const invite = invites.records().find((record) => record.nodeId === nodeId && record.consumedAt);
        return invite ? { clientId: invite.loginClientId, personId: invite.personId } : undefined;
      },
      edgeJoin: ({ joinId, inviteToken, accessToken }) => {
        const invite = invites.assertConsumable(joinId, inviteToken);
        const personId = accessToken?.startsWith("device-token-") ? "person-one" : "unknown";
        if (personId !== invite.personId) throw new FleetFault("person_mismatch", "another person's invitation");
        const issuedNodeId = `issued-${invite.joinId}`;
        invites.consume(invite.joinId, issuedNodeId);
        f.owners.keycloak.node(issuedNodeId, personId);
        f.owners.keycloak.interactiveSession(
          personId,
          issuedNodeId,
          loginUrl,
          `device-token-${issuedNodeId}`,
          invite.loginClientId,
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
    saveFleetCenterConfig(f.userRoot, "lease-center", {
      port: center.port,
      bind: "10.211.55.2",
      repoId: "lease-repo",
      keyPath: path.join(f.root, "tls.key"),
      certPath: path.join(f.root, "tls.crt"),
      stateRoot: f.stateRoot,
      quotaBytes: 1024 * 1024,
      externalUrl: `https://localhost:${center.port}`,
    });
    const rbacConfigFile = path.join(f.userRoot, "rbac", "config.json");
    const rbacConfig = JSON.parse(readFileSync(rbacConfigFile, "utf8")) as Record<string, unknown>;
    writeFileSync(
      rbacConfigFile,
      JSON.stringify({
        ...rbacConfig,
        listener: {
          certificateFile: path.join(f.root, "tls.crt"),
          port: loginPort,
          hostname: "localhost",
        },
      }),
    );
    const link = async (personId: string, pin = spkiSha256, sshReverse = false) => {
      const response = (await f.host.manageRbac(
        {
          operation: "edge-join-create",
          personId,
          repoIds: ["lease-repo"],
          groupIds: ["contributor"],
          ...(sshReverse
            ? { transport: "ssh-reverse", sshTarget: "macbook-air-via-tencent-prod" }
            : { transport: "direct" }),
        },
        localAuthFixture(),
      )) as Record<string, unknown>;
      assert.equal(response.ok, true, JSON.stringify(response));
      let linkStr = response.link as string;
      if (pin !== spkiSha256) {
        const parsed = decodeEdgeJoinLink(linkStr);
        linkStr = encodeEdgeJoinLink({ ...parsed, spkiSha256: pin });
      }
      return { joinId: response.joinId as string, link: linkStr };
    };

    const join = async (nodeId: string, invitation: string, sshReverse = false) => {
      const edge = await fleetEdgeHostFixture(t, f, {
          name: nodeId,
          nodeId,
          registerBeforeOpen: false,
          writeEdgeConfig: false,
          oidcPorts: {
            loginAuthority: async () => ({
              url: sshReverse ? `https://127.0.0.1:${loginPort}` : loginUrl,
              ...(sshReverse ? { servername: "localhost", browserUrl: loginUrl } : {}),
              realm: "harness",
              clientId: "harness-gui",
              certificate: loginCertificate,
            }),
          },
        }),
        workspaceRoot = path.join(mkdtempSync(path.join(tmpdir(), "ha-edge-join-")), "workspace");
      const response = await edge.rpc.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "daemon.rbac.manage",
        params: { operation: "edge-join", link: invitation, workspaceRoot },
      });
      return { edge, response: response as Record<string, unknown>, workspaceRoot };
    };

    const joinedEdges = new Map<string, Awaited<ReturnType<typeof fleetEdgeHostFixture>>>();
    for (const nodeName of ["node-one", "node-two"]) {
      const invitation = await link("person-one", spkiSha256, nodeName === "node-one");
      if (nodeName === "node-one") {
        assert.ok(sshArgs[0]!.includes(`127.0.0.1:0:10.211.55.2:${center.port}`));
        assert.ok(sshArgs[0]!.includes(`127.0.0.1:0:localhost:${loginPort}`));
      }
      f.owners.keycloak.interactiveSession(
        "person-one",
        nodeName,
        loginUrl,
        `device-token-${nodeName}`,
        decodeEdgeJoinLink(invitation.link).loginClientId,
      );
      const { edge, response, workspaceRoot } = await join(nodeName, invitation.link, nodeName === "node-one"),
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
      joinedEdges.set(issuedNodeId, edge);
      if (nodeName === "node-one") {
        assert.equal(config?.host, "127.0.0.1");
        assert.equal(config?.servername, "localhost");
        assert.equal(config?.loginUrl, `https://127.0.0.1:${loginPort}`);
        assert.equal(config?.loginServername, "localhost");
        assert.equal(config?.loginBrowserUrl, loginUrl);
      }
      assert.equal(statSync(path.join(repoWorkspace, "fleet-edge.json")).mode & 0o777, 0o600);
      const tasks = path.join(repoWorkspace, "harness", "tasks");
      assert.ok(
        existsSync(tasks) && readdirSync(tasks).some((name) => name.includes("joined-0")),
        "the first sync mirrors the center's task",
      );
    }

    const wrongPin = await link("person-one", "f".repeat(64));
    f.owners.keycloak.interactiveSession(
      "person-one",
      "node-three",
      loginUrl,
      "device-token-node-three",
      "harness-gui",
    );
    const pinRefused = await join("node-three", wrongPin.link);
    assert.match(JSON.stringify(pinRefused.response), /pin_mismatch/u);
    assert.equal(
      invites.status(wrongPin.joinId).state,
      "pending",
      "the pin is checked before the invite token is sent",
    );
    assert.equal(existsSync(path.join(pinRefused.workspaceRoot, "lease-repo", "fleet-edge.json")), false);

    f.owners.keycloak.account("person-two");
    const wrongPerson = await link("person-two");
    f.owners.keycloak.interactiveSession("person-one", "node-four", loginUrl, "device-token-node-four", "harness-gui");
    const refused = await join("node-four", wrongPerson.link);
    assert.equal("result" in refused.response && (refused.response.result as { ok?: unknown }).ok === true, false);
    assert.match(JSON.stringify(refused.response), /person_mismatch|another person/u);
    assert.equal(existsSync(path.join(refused.workspaceRoot, "fleet-edge.json")), false);
    const formerOwnerNodeId = [...joinedEdges.keys()][0]!,
      formerOwnerEdge = joinedEdges.get(formerOwnerNodeId)!;
    f.owners.reassign(formerOwnerNodeId, "person-two");
    assert.equal(f.owners.nodeOwner(formerOwnerNodeId), "person-two");
    const formerOwnerWrite = await formerOwnerEdge.command({
      kind: "task-create",
      taskId: "former-owner-write",
      title: "Former owner write",
    });
    assert.equal(formerOwnerWrite.code, "human_confirmation_required", JSON.stringify(formerOwnerWrite));
    assert.equal(f.owners.nodeOwner(formerOwnerNodeId), "person-two");
  },
);
