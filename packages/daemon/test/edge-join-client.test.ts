// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createEdgeJoinProgressTap, joinFleetEdge, type EdgeJoinClientPorts } from "../src/fleet/edge-join-client.ts";
import { readFleetEdgeConfig } from "../src/client/fleet-edge-config.ts";
import { createEdgeJoinStore, encodeEdgeJoinLink } from "../src/fleet/edge-join.ts";
import { normalizeFleetGitRemote, readFleetCenterGitMetadata } from "../src/fleet-edge-git-preflight.ts";

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
    loginTargets: string[] = [],
    ports: EdgeJoinClientPorts = {
      probeCenter: async () => {
        probes.push("center");
      },
      probeLogin: async () => {
        probes.push("login");
      },
      session: async (loginTarget) => {
        loginTargets.push(loginTarget);
        return {
          accessToken: "person-access-token",
          authority: { url: "https://login.example", realm: "harness", certificate: cert.toString("utf8") },
        };
      },
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
            {
              repoId: "repo-a",
              harnessYaml: "schema: harness-anything/v1\nname: A\n",
              originUrl: null,
              originPushUrls: [],
              defaultBranch: null,
              defaultBranchCommit: null,
            },
            {
              repoId: "repo-b",
              harnessYaml: "schema: harness-anything/v1\nname: B\n",
              originUrl: null,
              originPushUrls: [],
              defaultBranch: null,
              defaultBranchCommit: null,
            },
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
  assert.deepEqual(loginTargets, [path.join(temp, "workspace", "repo-a")]);
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

  const mismatchWorkspace = path.join(temp, "mismatched-origin"),
    mismatchRepository = path.join(mismatchWorkspace, "repo-a"),
    wrongOrigin = path.join(temp, "wrong-origin.git"),
    centerOrigin = path.join(temp, "center-origin.git");
  mkdirSync(mismatchWorkspace, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", mismatchRepository]);
  execFileSync("git", ["-C", mismatchRepository, "remote", "add", "origin", wrongOrigin]);
  execFileSync("git", [
    "-C",
    mismatchRepository,
    "-c",
    "user.name=Edge Test",
    "-c",
    "user.email=edge@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  ]);
  let mismatchRegistered = false;
  const mismatch = await joinFleetEdge(
    { link: encodeEdgeJoinLink(invite.link), workspaceRoot: mismatchWorkspace },
    {
      ...ports,
      join: async (input) => {
        const admitted = await ports.join!(input);
        return {
          ...admitted,
          repositories: [
            {
              repoId: "repo-a",
              harnessYaml: "schema: harness-anything/v1\nname: A\n",
              originUrl: normalizeFleetGitRemote(centerOrigin),
              originPushUrls: [normalizeFleetGitRemote(centerOrigin)],
              defaultBranch: "main",
              defaultBranchCommit: "a".repeat(40),
            },
          ],
        };
      },
      register: async () => {
        mismatchRegistered = true;
        return { ok: true };
      },
      sync: async () => assert.fail("a mismatched origin must stop before sync"),
    },
  );
  assert.equal(mismatch.ok, true, "an admitted join returns a receipt even when its first sync fails");
  assert.equal(mismatch.state, "partial");
  assert.equal((mismatch.repositories as Array<{ code?: string }>)[0]?.code, "edge_default_branch_unverifiable");
  assert.equal(mismatchRegistered, true, "a prepared workspace is registered before the first sync preflight");
  assert.deepEqual(
    progress.slice(8).map(({ repository }) => `${repository.repoId}:${repository.phase}`),
    ["repo-a:workspace", "repo-a:register", "repo-a:failed"],
    "a failed preflight leaves the prepared workspace registered for repair",
  );

  let loginAuthority: Record<string, unknown> | undefined, loginTarget: string | undefined;
  const mismatchedSessionPorts: EdgeJoinClientPorts = {
      ...ports,
      session: async () => ({
        accessToken: "person-access-token",
        authority: { url: "https://login.example", realm: "harness", certificate: "another-root" },
      }),
      beginLogin: async (authority, target) => {
        loginAuthority = authority;
        loginTarget = target;
        return { ok: true, pending: true };
      },
    },
    loginResult = await joinFleetEdge({ link: encodeEdgeJoinLink(invite.link) }, mismatchedSessionPorts);
  assert.deepEqual(loginResult, { ok: true, pending: true, command: "edge-join" });
  assert.equal(loginAuthority?.certificate, cert.toString("utf8"));
  assert.equal(loginTarget, path.join(temp, "harness-edge", "repo-a"));

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
    progress.slice(0, 8).map(({ repository }) => `${repository.repoId}:${repository.phase}`),
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
  await joinFleetEdge(
    { link: encodeEdgeJoinLink({ ...invite.link, token: undefined }), workspaceRoot: path.join(temp, "member-device") },
    {
      ...ports,
      join: async (input) => {
        assert.equal(
          Object.hasOwn(input, "inviteToken"),
          false,
          "the same join port receives no token for a member link",
        );
        return ports.join!({ ...input, inviteToken: invite.link.token! });
      },
    },
  );
});

test("SSH-reverse sign-in exposes the center browser's Keycloak device page separately from its gateway", async () => {
  const invite = createEdgeJoinStore().create({
      centerOrigin: "https://127.0.0.1:8443",
      transport: "ssh-reverse",
      centerServername: "center.example",
      repoIds: ["repo-a"],
      personId: "person-edge",
      permissionSnapshot: [],
      spkiSha256: "a".repeat(64),
      loginUrl: "https://127.0.0.1:9443",
      loginServername: "login-gateway.local",
      loginBrowserUrl: "https://macbook-pro-company.local:8443",
      loginRealm: "harness",
      loginClientId: "edge-client",
      createdBy: "person-admin",
      ttlMs: 60_000,
    }),
    result = await joinFleetEdge(
      { link: encodeEdgeJoinLink(invite.link) },
      {
        probeCenter: async () => undefined,
        probeLogin: async () => undefined,
        session: async () => undefined,
        beginLogin: async (authority) => ({
          ok: true,
          pending: true,
          verificationUri: "https://127.0.0.1:9443/realms/harness/device",
          userCode: "ABCD-EFGH",
          interval: 5,
          expiresAt: Date.now() + 60_000,
          authorityBrowserUrl: authority.browserUrl,
        }),
        register: async () => assert.fail("login approval must precede registration"),
        sync: async () => assert.fail("login approval must precede sync"),
        join: async () => assert.fail("login approval must precede admission"),
      },
    );
  assert.equal(result.transport, "ssh-reverse");
  assert.equal(result.verificationUri, "https://127.0.0.1:9443/realms/harness/device");
  assert.equal(result.browserApprovalUri, "https://macbook-pro-company.local:8443/realms/harness/device");
});

test("missing origin offers an ls-remote checked address and clones the center head before registration", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-edge-join-origin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const certFile = path.join(root, "center.pem"),
    centerRoot = path.join(root, "center"),
    origin = path.join(root, "origin.git"),
    alternateOrigin = path.join(root, "origin-alias.git"),
    workspaceRoot = path.join(root, "workspaces"),
    workspace = path.join(workspaceRoot, "repo-a"),
    git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(root, "center.key"),
      "-out",
      certFile,
      "-subj",
      "/CN=center.example",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  mkdirSync(centerRoot, { recursive: true });
  git("-C", centerRoot, "init", "-q", "-b", "main");
  mkdirSync(path.join(centerRoot, "harness"), { recursive: true });
  writeFileSync(path.join(centerRoot, "harness", "harness.yaml"), "schema: harness-anything/v1\nname: Center\n");
  git("-C", centerRoot, "add", "harness/harness.yaml");
  git(
    "-C",
    centerRoot,
    "-c",
    "user.name=Center",
    "-c",
    "user.email=center@example.invalid",
    "commit",
    "-qm",
    "center base",
  );
  git("clone", "--bare", "-q", centerRoot, origin);
  git("--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main");
  git("-C", centerRoot, "remote", "add", "origin", origin);
  git("-C", centerRoot, "fetch", "-q", "origin");
  git("-C", centerRoot, "remote", "set-head", "origin", "main");
  symlinkSync(origin, alternateOrigin, "dir");
  let admissionConsumed = false;
  const centerGit = await readFleetCenterGitMetadata(centerRoot),
    cert = readFileSync(certFile),
    invite = createEdgeJoinStore().create({
      centerOrigin: "https://center.example:8443",
      repoIds: ["repo-a"],
      personId: "person-edge",
      permissionSnapshot: [],
      spkiSha256: "a".repeat(64),
      loginUrl: "https://login.example",
      loginRealm: "harness",
      loginClientId: "edge-client",
      loginCertificate: cert.toString("utf8"),
      createdBy: "person-admin",
      ttlMs: 60_000,
    }),
    admitted = {
      schema: "fleet.edge.join.result/v1",
      messageId: "join-result",
      inReplyTo: "join-request",
      joinId: invite.record.joinId,
      nodeId: "edge-node",
      personId: "person-edge",
      credential: "machine-credential",
      repositories: [
        {
          repoId: "repo-a",
          harnessYaml: "schema: harness-anything/v1\nname: Center\n",
          ...centerGit,
        },
      ],
      certificate: cert.toString("base64"),
    },
    order: string[] = [],
    admissionEvents: string[] = [],
    ports: EdgeJoinClientPorts = {
      probeCenter: async () => undefined,
      probeLogin: async () => undefined,
      session: async () => ({
        accessToken: "person-access-token",
        authority: { url: "https://login.example", realm: "harness", certificate: cert.toString("utf8") },
      }),
      beginLogin: async () => assert.fail("the matching session must be reused"),
      register: async () => {
        order.push("register");
      },
      sync: async () => {
        order.push("sync");
        return { ok: true };
      },
      join: async (input) => {
        if (!admissionConsumed) {
          admissionConsumed = true;
          admissionEvents.push("admit");
          return admitted;
        }
        if (!input.recovery) {
          admissionEvents.push("already-consumed");
          throw Object.assign(new Error("The edge join invitation was already consumed."), {
            code: "already_consumed",
          });
        }
        admissionEvents.push("recover");
        assert.equal(input.recovery.nodeId, "edge-node");
        assert.equal(input.recovery.credential, undefined, "missing-origin attempts do not persist credentials");
        return admitted;
      },
      status: async () => {
        admissionEvents.push("status");
        return { joinId: invite.record.joinId, state: "consumed", nodeId: "edge-node" };
      },
      homeDir: root,
      availableBytes: () => 10 * 1024 * 1024 * 1024,
    },
    request = { link: encodeEdgeJoinLink(invite.link), workspaceRoot };

  const missing = await joinFleetEdge(request, ports),
    missingRow = (missing.repositories as Array<Record<string, unknown>>)[0]!;
  assert.equal(missingRow.code, "edge_origin_missing");
  assert.equal(missingRow.needsOrigin, true);
  assert.equal(missingRow.defaultBranch, "main");
  assert.equal(missingRow.centerOrigin, centerGit.originAddress);
  assert.equal(existsSync(path.join(workspace, ".git")), false, "the incomplete workspace stays empty for clone");
  assert.deepEqual(order, [], "an unconfigured workspace is not registered or synced");

  const unreachable = await joinFleetEdge(
      { ...request, originUrls: { "repo-a": path.join(root, "unreachable.git") } },
      ports,
    ),
    unreachableRow = (unreachable.repositories as Array<Record<string, unknown>>)[0]!;
  assert.equal(unreachableRow.code, "edge_origin_unreachable");
  assert.equal(unreachableRow.needsOrigin, true);
  assert.equal(existsSync(path.join(workspace, ".git")), false, "failed ls-remote does not create a checkout");

  const unsupported = await joinFleetEdge({ ...request, originUrls: { "repo-a": "ext::sh -c id" } }, ports),
    unsupportedRow = (unsupported.repositories as Array<Record<string, unknown>>)[0]!;
  assert.equal(unsupportedRow.code, "edge_origin_invalid");
  assert.equal(existsSync(path.join(workspace, ".git")), false, "unsupported Git helpers are refused before execution");

  const joined = await joinFleetEdge({ ...request, originUrls: { "repo-a": alternateOrigin } }, ports);
  assert.deepEqual(admissionEvents, [
    "admit",
    "already-consumed",
    "status",
    "recover",
    "already-consumed",
    "status",
    "recover",
    "already-consumed",
    "status",
    "recover",
  ]);
  assert.equal(joined.state, "synced");
  assert.deepEqual(order, ["register", "sync"], "registration precedes the first sync");
  assert.equal(git("-C", workspace, "remote", "get-url", "origin"), alternateOrigin);
  assert.equal(git("-C", workspace, "log", "-1", "--format=%s"), "center base");
  assert.doesNotMatch(git("-C", workspace, "log", "--format=%s"), /Harness edge workspace/u);
  assert.equal(existsSync(path.join(workspace, "harness", "harness.yaml")), true);
});

test("ssh-reverse writes the login authority before the first sync", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-edge-join-login-before-sync-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const certFile = path.join(root, "center.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(root, "center.key"),
      "-out",
      certFile,
      "-subj",
      "/CN=center.example",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  const invite = createEdgeJoinStore({ randomToken: () => "pre-sync-token" }).create({
      centerOrigin: "https://127.0.0.1:8443",
      transport: "ssh-reverse",
      centerServername: "center.example",
      repoIds: ["repo-a"],
      personId: "person-edge",
      permissionSnapshot: [],
      spkiSha256: "a".repeat(64),
      loginUrl: "https://127.0.0.1:9443",
      loginServername: "login.example",
      loginBrowserUrl: "https://login.example",
      loginRealm: "harness",
      loginClientId: "harness-gui",
      createdBy: "person-admin",
      ttlMs: 60_000,
    }),
    workspaceRoot = path.join(root, "workspace");
  let configAtSync: ReturnType<typeof readFleetEdgeConfig>;
  const result = await joinFleetEdge(
    { link: encodeEdgeJoinLink(invite.link), workspaceRoot },
    {
      probeCenter: async () => undefined,
      probeLogin: async () => undefined,
      session: async () => ({
        accessToken: "person-access-token",
        authority: {
          url: "https://127.0.0.1:9443",
          realm: "harness",
          servername: "login.example",
          browserUrl: "https://login.example",
        },
      }),
      beginLogin: async () => assert.fail("the matching session must be reused"),
      register: async () => undefined,
      sync: async (payload) => {
        configAtSync = readFleetEdgeConfig(String(payload.workspaceRoot));
        return { ok: true };
      },
      join: async () => ({
        schema: "fleet.edge.join.result/v1",
        messageId: "result",
        inReplyTo: "request",
        joinId: invite.record.joinId,
        nodeId: "edge-node",
        personId: "person-edge",
        credential: "machine-credential",
        repositories: [
          {
            repoId: "repo-a",
            harnessYaml: "schema: harness-anything/v1\nname: A\n",
            originUrl: null,
            originPushUrls: [],
            defaultBranch: null,
            defaultBranchCommit: null,
          },
        ],
        certificate: readFileSync(certFile).toString("base64"),
      }),
      homeDir: root,
      availableBytes: () => 10 * 1024 * 1024 * 1024,
    },
  );
  assert.equal(result.ok, true);
  assert.equal(configAtSync?.loginUrl, "https://127.0.0.1:9443");
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
