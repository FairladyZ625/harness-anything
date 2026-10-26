// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createEdgeJoinProgressTap, joinFleetEdge, type EdgeJoinClientPorts } from "../src/fleet/edge-join-client.ts";
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
      loginCertificate: cert.toString("utf8"),
      createdBy: "person-admin",
      ttlMs: 72 * 60 * 60 * 1000,
    }),
    registrations: string[] = [],
    syncs: Record<string, unknown>[] = [],
    progress: { readonly joinId: string; readonly repository: { repoId: string; phase: string } }[] = [],
    probes: string[] = [],
    ports: EdgeJoinClientPorts = {
      probeCenter: async () => {
        probes.push("center");
      },
      probeLogin: async () => {
        probes.push("login");
      },
      session: async () => ({
        accessToken: "person-access-token",
        authority: { url: "https://login.example", realm: "harness", certificate: cert.toString("utf8") },
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
      availableBytes: () => 10 * 1024 * 1024 * 1024,
      onProgress: (event) => progress.push(event),
    },
    result = await joinFleetEdge(
      { link: encodeEdgeJoinLink(invite.link), workspaceRoot: path.join(temp, "workspace") },
      ports,
    );

  assert.deepEqual(result.repoIds, ["repo-a", "repo-b"]);
  assert.deepEqual(probes, ["center", "login"], "both external addresses are checked before session or join use");
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
  assert.deepEqual(
    syncs.map((payload) => payload.quotaBytes),
    [4 * 1024 * 1024 * 1024, 4 * 1024 * 1024 * 1024],
    "an omitted quota follows the target volume instead of the retired 1 GiB default",
  );
  assert.ok(
    syncs.every((payload) => Number(payload.quotaBytes) > 3_346_161_664),
    "the derived quota can hold the observed 3.3 GB canonical snapshot",
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
  let loginAuthority: Record<string, unknown> | undefined;
  const mismatchedSessionPorts: EdgeJoinClientPorts = {
      ...ports,
      session: async () => ({
        accessToken: "person-access-token",
        authority: { url: "https://login.example", realm: "harness", certificate: "another-root" },
      }),
      beginLogin: async (authority) => {
        loginAuthority = authority;
        return { ok: true, pending: true };
      },
    },
    loginResult = await joinFleetEdge({ link: encodeEdgeJoinLink(invite.link) }, mismatchedSessionPorts);
  assert.deepEqual(loginResult, { ok: true, pending: true, command: "edge-join" });
  assert.equal(loginAuthority?.certificate, cert.toString("utf8"));

  const publicInvite = createEdgeJoinStore({ randomToken: () => "public-trust-token" }).create({
      centerOrigin: "https://center.example:8443",
      repoIds: ["repo-a"],
      personId: "person-edge",
      permissionSnapshot: [{ groupId: "viewer", version: "snapshot-digest" }],
      spkiSha256: "a".repeat(64),
      loginUrl: "https://login.example",
      loginRealm: "harness",
      loginClientId: "edge-client",
      createdBy: "person-admin",
      ttlMs: 72 * 60 * 60 * 1000,
    }),
    publicSessionPorts: EdgeJoinClientPorts = {
      ...ports,
      session: async () => ({
        accessToken: "person-access-token",
        authority: { url: "https://login.example", realm: "harness", certificate: "previous-root" },
      }),
      join: async () => ({
        schema: "fleet.edge.join.result/v1",
        messageId: "public-result",
        inReplyTo: "public-request",
        joinId: publicInvite.record.joinId,
        nodeId: "public-edge",
        personId: "person-edge",
        credential: "public-edge-credential",
        repositories: [],
        certificate: cert.toString("base64"),
      }),
    };
  assert.equal(
    (await joinFleetEdge({ link: encodeEdgeJoinLink(publicInvite.link) }, publicSessionPorts)).state,
    "synced",
    "an invitation without CA reuses the same authority session without comparing its CA",
  );
  assert.deepEqual(
    progress.map(({ repository }) => `${repository.repoId}:${repository.phase}`),
    [
      "repo-a:workspace",
      "repo-a:register",
      "repo-a:sync",
      "repo-a:synced",
      "repo-b:workspace",
      "repo-b:register",
      "repo-b:sync",
      "repo-b:synced",
    ],
  );
  assert.ok(progress.every(({ joinId }) => joinId === invite.record.joinId));

  const explicitQuota = 4 * 1024 * 1024 * 1024;
  await joinFleetEdge(
    { link: encodeEdgeJoinLink(invite.link), workspaceRoot: path.join(temp, "explicit"), quotaBytes: explicitQuota },
    ports,
  );
  assert.equal(syncs.at(-1)?.quotaBytes, explicitQuota, "an explicit quota is passed through unchanged");

  await assert.rejects(
    joinFleetEdge(
      { link: encodeEdgeJoinLink(invite.link), workspaceRoot: path.join(temp, "too-small"), quotaBytes: 1024 },
      {
        ...ports,
        sync: async () => {
          throw Object.assign(new Error("base backup exceeds disk quota"), { code: "replica_sync_failed" });
        },
      },
    ),
    (error: unknown) => {
      assert.equal((error as { readonly code?: unknown }).code, "replica_sync_failed");
      assert.match(String((error as Error).message), /base backup exceeds disk quota/u);
      return true;
    },
  );
});

test("both external addresses are probed before login, and each failure names its address", async () => {
  const invite = createEdgeJoinStore().create({
      centerOrigin: "https://center.example:7545",
      repoIds: ["repo-a"],
      personId: "person-edge",
      permissionSnapshot: [{ groupId: "viewer", version: "snapshot-digest" }],
      spkiSha256: "a".repeat(64),
      loginUrl: "https://login.example:18544",
      loginRealm: "harness",
      loginClientId: "edge-client",
      createdBy: "person-admin",
      ttlMs: 60_000,
    }),
    link = encodeEdgeJoinLink(invite.link);
  const run = (probeCenter: () => Promise<void>, probeLogin: () => Promise<void>, probes: string[]) =>
    joinFleetEdge(
      { link },
      {
        probeCenter: async () => {
          probes.push("center");
          await probeCenter();
        },
        probeLogin: async () => {
          probes.push("login");
          await probeLogin();
        },
        session: async () => assert.fail("both network probes must precede session lookup"),
        beginLogin: async () => assert.fail("both network probes must precede device login"),
        register: async () => undefined,
        sync: async () => ({ ok: true }),
      },
    );
  const unreachable = (address: string, code: string) =>
    Object.assign(new Error("Address " + address + " is unreachable."), { code });

  for (const [centerFails, loginFails, expectedCode, expectedMessage] of [
    [true, false, "center_address_unreachable", /center\.example:7545/u],
    [false, true, "login_address_unreachable", /login\.example:18544/u],
  ] as const) {
    const probes: string[] = [];
    await assert.rejects(
      run(
        () =>
          centerFails
            ? Promise.reject(unreachable("https://center.example:7545", "center_address_unreachable"))
            : Promise.resolve(),
        () =>
          loginFails
            ? Promise.reject(unreachable("https://login.example:18544", "login_address_unreachable"))
            : Promise.resolve(),
        probes,
      ),
      { code: expectedCode, message: expectedMessage },
    );
    assert.deepEqual(probes, ["center", "login"]);
  }

  const probes: string[] = [];
  await assert.rejects(
    run(
      () => Promise.reject(unreachable("https://center.example:7545", "center_address_unreachable")),
      () => Promise.reject(unreachable("https://login.example:18544", "login_address_unreachable")),
      probes,
    ),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "edge_join_addresses_unreachable");
      assert.match((error as Error).message, /center\.example:7545/u);
      assert.match((error as Error).message, /login\.example:18544/u);
      return true;
    },
  );
  assert.deepEqual(probes, ["center", "login"]);
});

test("login address probing preserves an authority path prefix", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-edge-login-prefix-")),
    keyFile = path.join(root, "login.key"),
    certFile = path.join(root, "login.pem");
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
      "/CN=localhost",
      "-days",
      "1",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const requests: string[] = [],
    server = createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const invite = createEdgeJoinStore().create({
      centerOrigin: "https://center.example:7545",
      repoIds: ["repo-a"],
      personId: "person-edge",
      permissionSnapshot: [],
      spkiSha256: "a".repeat(64),
      loginUrl: `https://127.0.0.1:${address.port}/auth`,
      loginServername: "localhost",
      loginRealm: "harness",
      loginClientId: "edge-client",
      loginCertificate: readFileSync(certFile, "utf8"),
      createdBy: "person-admin",
      ttlMs: 60_000,
    }),
    result = await joinFleetEdge(
      { link: encodeEdgeJoinLink(invite.link) },
      {
        probeCenter: async () => undefined,
        session: async () => undefined,
        beginLogin: async (authority) => {
          assert.equal(authority.url, `https://127.0.0.1:${address.port}/auth`);
          assert.equal(authority.servername, "localhost");
          return { ok: true, pending: true };
        },
        register: async () => undefined,
        sync: async () => ({ ok: true }),
      },
    );

  assert.deepEqual(result, { ok: true, pending: true, command: "edge-join" });
  assert.deepEqual(requests, ["/auth/realms/harness"]);
});

test("the progress tap replaces a repository's phase and never mixes two joins", () => {
  const tap = createEdgeJoinProgressTap();
  assert.deepEqual(tap.read(), { repositories: [] });

  tap.record({ joinId: "join-a", repository: { repoId: "repo-1", phase: "workspace" } });
  tap.record({ joinId: "join-a", repository: { repoId: "repo-2", phase: "register" } });
  tap.record({ joinId: "join-a", repository: { repoId: "repo-1", phase: "sync" } });
  assert.deepEqual(tap.read(), {
    joinId: "join-a",
    repositories: [
      { repoId: "repo-2", phase: "register" },
      { repoId: "repo-1", phase: "sync" },
    ],
  });

  tap.record({ joinId: "join-b", repository: { repoId: "repo-3", phase: "workspace" } });
  assert.deepEqual(tap.read(), { joinId: "join-b", repositories: [{ repoId: "repo-3", phase: "workspace" }] });
});
