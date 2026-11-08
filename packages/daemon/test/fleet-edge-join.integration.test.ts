// harness-test-tier: integration
// `ha edge join <link>` from a signed-in edge daemon: each edge exchanges its own invitation for a machine
// credential over the pinned center TLS, registers a fresh workspace as a remote-edge mirror and runs the
// first sync. The credential lands only in fleet-edge.json (0600); the receipt never carries it. An
// invitation bound to another person is refused.
import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:https";
import test from "node:test";
import { readFleetEdgeConfig, writeFleetEdgeConfig } from "../src/client/fleet-edge-config.ts";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization-keycloak";
import { keycloakNodeRegistry } from "../src/fleet-center-admission.ts";
import { AccessAdminService } from "../src/access-admin-service.ts";
import { createIdentitySession } from "../src/authorization-provider.ts";
import { FleetFault } from "../src/fleet/center-types.ts";
import { createEdgeJoinStore, decodeEdgeJoinLink, encodeEdgeJoinLink } from "../src/fleet/edge-join.ts";
import { saveFleetCenterConfig } from "../src/fleet-center-config.ts";
import { EdgeJoinSshTunnelManager } from "../src/fleet/edge-join-ssh-tunnel.ts";
import { joinFleetEdge } from "../src/fleet/edge-join-client.ts";
import { listenFleetTls } from "../src/fleet/center.ts";
import { requestFleetEdgeJoinStatusPinned } from "../src/fleet/peer.ts";
import { keycloakUrl } from "./keycloak.fixtures.ts";
import { accessAdminFixture, edgeJoinCenter } from "./access-admin-service.fixture.ts";
import { readFleetCenterConfig } from "../src/fleet-center-config.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";

test(
  "an invited edge issues a token-free member link for its second device; both sync and wrong-person joins fail",
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
      // Deliver after the caller has attached its stderr listener, without scheduling by wall clock.
      queueMicrotask(() => {
        for (const line of lines) stderrListener?.(line);
      });
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
    f.owners.keycloak.accessAdmin("lease-owner");
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
    const memberAdmin = new AccessAdminService(
      createIdentitySession(f.userRoot, { fetch: f.owners.keycloak.fetch }),
      f.userRoot,
      { fetch: f.owners.keycloak.fetch, daemonId: "lease-center", edgeJoins: invites },
    );
    t.after(() => memberAdmin.close());
    const adapter = new KeycloakPolicyAdapter(
      { url: f.owners.url, realm: "harness", resourceServerClientId: "harness-center" },
      f.owners.keycloak.fetch,
    );
    let droppedCredential: string | undefined;
    const center = await f.openCenter(f.host, undefined, {
      ...keycloakNodeRegistry(async () => ({
        url: f.owners.url,
        realm: "harness",
        clientId: "harness-center",
        accessToken: "center-token",
        provider: adapter,
      })),
      ...{ edgeJoinStatus: (input: { joinId: string; accessToken: string }) => memberAdmin.edgeJoinStatus(input) },
      createMemberEdgeJoin: (repos, person, token) => memberAdmin.createMemberEdgeJoin(repos, person, token),
      edgeJoin: async (input) => {
        const admitted = await memberAdmin.admitEdgeJoin(input);
        const invite = invites.get(input.joinId)!;
        f.owners.keycloak.interactiveSession(
          admitted.personId,
          admitted.nodeId,
          loginUrl,
          `device-token-${admitted.nodeId}`,
          invite.loginClientId,
        );
        if (droppedCredential === undefined) {
          droppedCredential = admitted.credential;
          throw new FleetFault("join_reply_lost", "Admission committed before credential delivery.");
        }
        return {
          joinId: admitted.joinId,
          nodeId: admitted.nodeId,
          personId: admitted.personId,
          credential: admitted.credential,
          repositories: [
            {
              repoId: "lease-repo",
              harnessYaml,
              originUrl: null,
              originPushUrls: [],
              defaultBranch: null,
              defaultBranchCommit: null,
            },
          ],
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
          // The join client resolves the repository as workspaceRoot/repoId. Keep the
          // fixture directory aligned with the lease-repo id while nodeId remains unique.
          name: "lease-repo",
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
          beforeOpen: (edgeRoot) => {
            execFileSync("git", ["-C", edgeRoot, "rm", "--cached", "harness/harness.yaml"]);
            writeFileSync(
              path.join(edgeRoot, ".gitignore"),
              "harness/\n.harness/\nfleet-edge.json\nfleet-center-ca.pem\n",
            );
            execFileSync("git", ["-C", edgeRoot, "add", ".gitignore"]);
            execFileSync("git", [
              "-C",
              edgeRoot,
              "-c",
              "user.name=Edge Test",
              "-c",
              "user.email=edge@example.invalid",
              "commit",
              "-qm",
              "ignore private edge layout",
            ]);
          },
        }),
        workspaceRoot = path.dirname(edge.edgeRoot);
      const initialHead = execFileSync("git", ["-C", edge.edgeRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const response = await edge.rpc.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "daemon.rbac.manage",
        params: { operation: "edge-join", link: invitation, workspaceRoot },
      });
      assert.equal(
        execFileSync("git", ["-C", edge.edgeRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        initialHead,
        "edge join must not create a project repository commit",
      );
      assert.equal(
        execFileSync("git", ["-C", edge.edgeRoot, "status", "--porcelain"], { encoding: "utf8" }).trim(),
        "",
        "ignored edge layout and connection files must leave the checkout clean",
      );
      return { edge, response: response as Record<string, unknown>, workspaceRoot };
    };

    const joinedEdges = new Map<string, Awaited<ReturnType<typeof fleetEdgeHostFixture>>>();
    for (const nodeName of ["node-one", "node-two"]) {
      const firstEdge = [...joinedEdges.values()][0];
      const memberReply = firstEdge
        ? await firstEdge.rpc.handle({
            jsonrpc: "2.0",
            id: 21,
            method: "daemon.rbac.manage",
            params: {
              operation: "edge-join-create",
              joinMode: "member-device",
              repoId: "lease-repo",
              repoIds: ["lease-repo"],
            },
          })
        : undefined;
      const memberResult = memberReply?.result as Record<string, unknown> | undefined;
      if (firstEdge) assert.equal(memberResult?.ok, true, JSON.stringify(memberReply));
      const invitation = memberResult
        ? { joinId: String(memberResult.joinId), link: String(memberResult.link) }
        : await link("person-one", spkiSha256, true);
      if (memberResult) assert.equal(Object.hasOwn(decodeEdgeJoinLink(invitation.link), "token"), false);
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
      const joined = await join(nodeName, invitation.link, nodeName === "node-one"),
        { edge, workspaceRoot } = joined;
      let response = joined.response;
      if (nodeName === "node-one") {
        assert.match(JSON.stringify(response), /join_reply_lost/u);
        assert.equal(existsSync(path.join(workspaceRoot, "lease-repo", "fleet-edge.json")), false);
        response = (await edge.rpc.handle({
          jsonrpc: "2.0",
          id: 22,
          method: "daemon.rbac.manage",
          params: { operation: "edge-join", link: invitation.link, workspaceRoot },
        })) as Record<string, unknown>;
      }
      const result = response.result as Record<string, unknown>;
      assert.equal(result?.ok, true, JSON.stringify(response));
      assert.equal(result.joinId, invitation.joinId);
      assert.equal(result.state, "synced");
      const issuedNodeId = String(result.nodeId);
      const credential = f.owners.keycloak.nodeClients.get(`harness-node-${issuedNodeId}`)!.secret;
      assert.equal(JSON.stringify(response).includes(credential), false, "the receipt carries no credential");
      const repoWorkspace = path.join(workspaceRoot, "lease-repo"),
        config = readFleetEdgeConfig(repoWorkspace);
      assert.equal(config?.nodeId, issuedNodeId);
      assert.equal(config?.credential, credential);
      assert.equal(await adapter.authenticateNode(issuedNodeId, credential), true);
      if (nodeName === "node-one") {
        assert.notEqual(credential, droppedCredential);
        assert.equal(await adapter.authenticateNode(issuedNodeId, droppedCredential!), false);
      }
      const count = f.owners.keycloak.nodeClients.size;
      const repeated = await edge.rpc.handle({
        jsonrpc: "2.0",
        id: 23,
        method: "daemon.rbac.manage",
        params: { operation: "edge-join", link: invitation.link, workspaceRoot },
      });
      assert.equal((repeated.result as Record<string, unknown>)?.ok, true, JSON.stringify(repeated));
      assert.equal((repeated.result as Record<string, unknown>).nodeId, issuedNodeId);
      assert.equal(readFleetEdgeConfig(repoWorkspace)!.credential, credential);
      assert.equal(f.owners.keycloak.nodeClients.size, count);
      assert.equal(JSON.stringify(repeated).includes(credential), false);
      joinedEdges.set(issuedNodeId, edge);
      if (nodeName === "node-one") {
        assert.equal(config?.host, "127.0.0.1");
        assert.equal(config?.servername, "localhost");
        assert.equal(config?.loginUrl, `https://127.0.0.1:${loginPort}`);
        assert.equal(config?.loginRealm, "harness");
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

    assert.equal(joinedEdges.size, 2, "the member's second device has an independent node identity");
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
    assert.match(JSON.stringify(refused.response), /person_mismatch|another person|human_confirmation_required/u);
    assert.equal(existsSync(path.join(refused.workspaceRoot, "fleet-edge.json")), false);
    const formerOwnerNodeId = [...joinedEdges.keys()][0]!,
      formerOwnerEdge = joinedEdges.get(formerOwnerNodeId)!;
    f.owners.reassign(formerOwnerNodeId, "person-two");
    assert.equal(f.owners.nodeOwner(formerOwnerNodeId), "person-two");
    // This edge joined a different center/node than the fixture's pre-join defaults. Use the
    // accepted workspace config, so the positive control reaches its actual resident replica.
    const {
      loginUrl: _loginUrl,
      loginRealm: _loginRealm,
      loginServername: _loginServername,
      loginBrowserUrl: _loginBrowserUrl,
      loginCertificate: _loginCertificate,
      ...joinedConfig
    } = readFleetEdgeConfig(formerOwnerEdge.edgeRoot)!;
    let postJoinId = 100;
    const joinedCommand = async (action: Record<string, unknown>) => {
      const reply = await formerOwnerEdge.rpc.handle({
        jsonrpc: "2.0",
        id: postJoinId++,
        method: "daemon.fleet.task.run",
        params: { payload: { ...joinedConfig, workspaceRoot: formerOwnerEdge.edgeRoot, action } },
      });
      assert.ok(reply && !Array.isArray(reply) && "result" in reply, JSON.stringify(reply));
      return reply.result as Record<string, unknown>;
    };
    const formerOwnerWrite = await joinedCommand({
      kind: "task-create",
      taskId: "former-owner-write",
      title: "Former owner write",
    });
    // dec_E610E1D99A39003886D1B5EE7C CH1: device ownership does not replace the current token person.
    assert.equal(formerOwnerWrite.outcome, "applied", JSON.stringify(formerOwnerWrite));
    f.owners.keycloak.endInteractiveSession("device-token-node-one");
    const revokedWrite = await joinedCommand({
      kind: "task-create",
      taskId: "revoked-user-write",
      title: "Revoked user write",
    });
    assert.equal(revokedWrite.code, "human_confirmation_required", JSON.stringify(revokedWrite));
    assert.equal(f.owners.nodeOwner(formerOwnerNodeId), "person-two");
  },
);

test(
  "a dropped admission reply recovers over pinned TLS, persists 0600 credentials and reuses them on repeat join",
  { timeout: 60_000 },
  async (t) => {
    const f = await edgeJoinCenter(t, await accessAdminFixture(t));
    t.after(() => f.admin.close());
    f.keycloak.account("alice");
    f.keycloak.account("bob");
    f.keycloak.permit("alice", "repo-a", ["repository-read"]);
    f.signIn("alice", []);
    const config = readFleetCenterConfig(f.root, "default")!;
    let drop = true;
    const issued: Awaited<ReturnType<typeof f.admin.admitEdgeJoin>>[] = [];
    const center = await listenFleetTls({
      host: { status: () => ({ repos: [] }) } as never,
      stateRoot: path.join(f.root, "recovery-center"),
      port: 0,
      key: readFileSync(config.keyPath),
      cert: readFileSync(config.certPath),
      authenticate: () => false,
      nodeOwner: () => null,
      edgeJoinStatus: (input) => f.admin.edgeJoinStatus(input),
      edgeJoin: async (input) => {
        const result = await f.admin.admitEdgeJoin(input);
        issued.push(result);
        if (drop) {
          drop = false;
          throw new FleetFault("join_reply_lost", "Admission committed before reply delivery.");
        }
        return {
          joinId: result.joinId,
          nodeId: result.nodeId,
          personId: result.personId,
          credential: result.credential,
          repositories: [
            {
              repoId: "repo-a",
              harnessYaml: "schema: harness-anything/v1\n",
              originUrl: null,
              originPushUrls: [],
              defaultBranch: null,
              defaultBranchCommit: null,
            },
          ],
        };
      },
    });
    t.after(() => center.close());
    const created = await f.run({ operation: "edge-join-create", joinMode: "member-device", repoIds: ["repo-a"] });
    // The in-memory realm has an HTTP control plane; the client uses the injected HTTPS login session below.
    const rawLink = JSON.parse(
      Buffer.from(String(created.link).slice("harness-edge://join/".length), "base64url").toString("utf8"),
    );
    const link = { ...rawLink, loginUrl: "https://login.example", centerOrigin: `https://127.0.0.1:${center.port}` };
    f.keycloak.interactiveSession("alice", "existing-device", keycloakUrl, "alice-recovery", link.loginClientId);
    f.keycloak.interactiveSession("bob", "other-device", keycloakUrl, "bob-recovery", link.loginClientId);
    const address = {
      hostname: "127.0.0.1",
      port: center.port,
      spkiSha256: link.spkiSha256,
      joinId: link.joinId,
      accessToken: "bob-recovery",
    };
    await assert.rejects(requestFleetEdgeJoinStatusPinned(address), { code: "human_confirmation_required" });
    const ports = {
      probeLogin: async () => {},
      session: async () => ({
        accessToken: "alice-recovery",
        authority: { url: link.loginUrl, realm: link.loginRealm },
      }),
      beginLogin: async () => assert.fail("already authenticated"),
      register: async () => ({ ok: true }),
      sync: async () => ({ ok: true, knownHead: { sequence: 1 } }),
    };
    const request = {
      link: encodeEdgeJoinLink(link),
      workspaceRoot: path.join(f.root, "recovered-workspaces"),
      quotaBytes: 1024 * 1024,
    };
    const edgeRepo = path.join(request.workspaceRoot, "repo-a");
    mkdirSync(edgeRepo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", edgeRepo]);
    writeFileSync(path.join(edgeRepo, ".gitignore"), "harness/\n");
    execFileSync("git", ["-C", edgeRepo, "add", ".gitignore"]);
    execFileSync("git", [
      "-C",
      edgeRepo,
      "-c",
      "user.name=Edge Test",
      "-c",
      "user.email=edge@example.invalid",
      "commit",
      "-qm",
      "edge checkout",
    ]);
    await assert.rejects(joinFleetEdge(request, ports), { code: "join_reply_lost" });
    const recovered = await joinFleetEdge(request, ports),
      saved = readFleetEdgeConfig(path.join(request.workspaceRoot, "repo-a"))!;
    assert.equal(recovered.state, "synced");
    assert.equal(saved.nodeId, issued[0]!.nodeId);
    assert.notEqual(saved.credential, issued[0]!.credential);
    assert.equal(await f.provider.authenticateNode(saved.nodeId, issued[0]!.credential), false);
    assert.equal(await f.provider.authenticateNode(saved.nodeId, saved.credential), true);
    if (process.platform !== "win32")
      assert.equal(statSync(path.join(request.workspaceRoot, "repo-a", "fleet-edge.json")).mode & 0o777, 0o600);
    const count = f.keycloak.nodeClients.size;
    writeFleetEdgeConfig(path.join(request.workspaceRoot, "repo-a"), {
      ...saved,
      waitTimeoutMs: 3456,
      maxAgeMs: 123,
      maxLagRevisions: 2,
      quotaBytes: 64 * 1024 * 1024,
    });
    const repeated = await joinFleetEdge({ link: request.link, workspaceRoot: request.workspaceRoot }, ports);
    assert.equal(repeated.nodeId, saved.nodeId);
    assert.equal(readFleetEdgeConfig(path.join(request.workspaceRoot, "repo-a"))!.credential, saved.credential);
    assert.equal(f.keycloak.nodeClients.size, count);
    assert.equal(JSON.stringify([recovered, repeated, f.journal()]).includes(saved.credential), false);
    const status = await f.admin.edgeJoinStatus({ joinId: link.joinId, accessToken: "alice-recovery" });
    assert.deepEqual(status, { joinId: link.joinId, state: "consumed", nodeId: saved.nodeId });
  },
);
