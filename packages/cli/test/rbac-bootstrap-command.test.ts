// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";
import { awaitDeviceLogin } from "../src/daemon/device-login.ts";
import { runCommandThroughDaemon } from "../src/daemon/client.ts";

test("device polling follows pending replies and ends at the device deadline", async () => {
  let polls = 0;
  const request = async () =>
    ++polls === 1 ? { ok: true, pending: true, interval: 0.001 } : { ok: true, authenticated: true, personId: "alice" };
  const signed = await awaitDeviceLogin(
    { ok: true, pending: true, interval: 0.001, expiresAt: Date.now() + 1_000 },
    request,
    () => undefined,
  );
  assert.equal(signed.personId, "alice");
  assert.equal(polls, 2);
  const expired = await awaitDeviceLogin(
    { ok: true, pending: true, interval: 600, expiresAt: Date.now() - 1 },
    request,
    () => undefined,
  );
  assert.equal(expired.code, "oidc_device_expired");
  assert.equal(polls, 2, "an expired device code never starts a token request");
});

test("device polling re-announces a replacement code and preserves the last transport cause at expiry", async () => {
  const phases: string[] = [];
  let polls = 0;
  const signed = await awaitDeviceLogin(
    {
      ok: true,
      pending: true,
      userCode: "OLD-CODE",
      interval: 0.001,
      expiresAt: Date.now() + 2_000,
    },
    async () => {
      polls += 1;
      return polls === 1
        ? {
            ok: false,
            code: "oidc_device_transport_unavailable",
            rejectionExplanation:
              "The Keycloak device authorization request failed (cause: read ECONNRESET [ECONNRESET]).",
          }
        : polls === 2
          ? {
              ok: true,
              pending: true,
              userCode: "NEW-CODE",
              verificationUri: "https://identity.example.test/device",
              interval: 0.001,
              expiresAt: Date.now() + 2_000,
            }
          : { ok: true, authenticated: true, personId: "alice" };
    },
    (receipt) => phases.push(String(receipt.userCode ?? "")),
  );
  assert.equal(signed.personId, "alice");
  assert.deepEqual(phases, ["OLD-CODE", "NEW-CODE"]);

  let failedPolls = 0;
  const expired = await awaitDeviceLogin(
    {
      ok: true,
      pending: true,
      interval: 0.01,
      expiresAt: Date.now() + 100,
    },
    async () => {
      failedPolls += 1;
      return {
        ok: false,
        code: "oidc_device_transport_unavailable",
        rejectionExplanation: "The Keycloak device authorization request failed (cause: read ECONNRESET [ECONNRESET]).",
      };
    },
    () => undefined,
  );
  assert.ok(failedPolls > 0, "the existing CLI interval retries before its deadline");
  assert.match(String(expired.rejectionExplanation), /read ECONNRESET \[ECONNRESET\]/u);
});

test("device login prints the browser entry, code and expiry while session receipts show identity and the session deadline", () => {
  const pending = renderCliReceipt({
    ok: true,
    pending: true,
    verificationUri: "https://center.test/device",
    userCode: "TEST-CODE",
    expiresAt: 60_000,
  });
  assert.match(pending.text, /https:\/\/center.test\/device/u);
  assert.match(pending.text, /TEST-CODE/u);
  assert.match(pending.text, /1970-01-01T00:01:00.000Z/u);
  // The daemon reports the session lifetime deadline (not the access token's), so the labelled
  // line is the session's own expiry.
  const signedIn = renderCliReceipt({ ok: true, authenticated: true, personId: "alice", expiresAt: 60_000 }).text;
  assert.match(signedIn, /Signed in as alice/u);
  assert.match(signedIn, /Session expires: 1970-01-01T00:01:00.000Z/u);
  // An offline session (the edge device client) has no locally inferred deadline; the daemon reports
  // expiresAt null and the render must not coerce that into the 1970 epoch.
  const offline = renderCliReceipt({ ok: true, authenticated: true, personId: "alice", expiresAt: null }).text;
  assert.match(offline, /Signed in as alice/u);
  assert.doesNotMatch(offline, /1970/u);
  assert.match(offline, /Session expires: no locally known deadline/u);
  assert.equal(renderCliReceipt({ ok: true, authenticated: false }).text, "Signed out.");
});

test("ha bootstrap login/session/logout share the daemon entry without credentials on argv", () => {
  for (const operation of ["login", "session", "logout"]) {
    const parsed = parseThinCommand(["bootstrap", "--operation", operation], "/repo");
    assert.equal(parsed.ok, true, operation);
    if (!parsed.ok) continue;
    assert.equal(parsed.command.method, "daemon.rbac.manage");
    assert.deepEqual(parsed.command.action, { kind: "rbac-bootstrap", operation, rootDir: "/repo" });
  }
  assert.equal(parseThinCommand(["bootstrap", "--operation", "login", "--access-token", "secret"], "/repo").ok, false);
});

test("ha bootstrap routes managed lifecycle options to the daemon", () => {
  const parsed = parseThinCommand(["bootstrap", "--operation", "backup", "--backup-dir", "/tmp/rbac-backup"], "/repo");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.command.method, "daemon.rbac.manage");
  assert.deepEqual(parsed.command.action, {
    kind: "rbac-bootstrap",
    operation: "backup",
    backupDir: "/tmp/rbac-backup",
  });
});

test("ha bootstrap exposes edge invitation, status, list, and revoke operations on the daemon route", () => {
  const created = parseThinCommand(
    [
      "bootstrap",
      "--operation",
      "edge-join-create",
      "--username",
      "edge.operator",
      "--email",
      "edge@example.test",
      "--display-name",
      "Edge Operator",
      "--person-id",
      "person-edge",
      "--join-repo",
      "repo-a",
      "--join-repo",
      "repo-b",
      "--join-group",
      "contributor",
    ],
    "/repo",
  );
  assert.equal(created.ok, true);
  if (created.ok) {
    assert.equal(created.command.method, "daemon.rbac.manage");
    assert.equal(created.command.action.operation, "edge-join-create");
    assert.deepEqual(created.command.action.repoIds, ["repo-a", "repo-b"]);
    assert.deepEqual(created.command.action.groupIds, ["contributor"]);
  }
  // An existing member is invited by identity alone; the daemon demands new-user fields only for
  // a person it does not know yet, so the CLI no longer decides that for it.
  const renewed = parseThinCommand(
    [
      "bootstrap",
      "--operation",
      "edge-join-create",
      "--person-id",
      "person-edge",
      "--join-repo",
      "repo-a",
      "--join-group",
      "contributor",
    ],
    "/repo",
  );
  assert.equal(renewed.ok, true);
  if (renewed.ok)
    assert.deepEqual(renewed.command.action, {
      kind: "rbac-bootstrap",
      operation: "edge-join-create",
      personId: "person-edge",
      repoIds: ["repo-a"],
      groupIds: ["contributor"],
    });
  assert.equal(
    parseThinCommand(["bootstrap", "--operation", "edge-join-create", "--join-repo", "repo-a"], "/repo").ok,
    false,
  );
  const listed = parseThinCommand(["bootstrap", "--operation", "edge-join-list"], "/repo");
  assert.equal(listed.ok, true);
  if (listed.ok) assert.equal(listed.command.action.operation, "edge-join-list");

  const revoked = parseThinCommand(["bootstrap", "--operation", "edge-join-revoke", "--join-id", "join-123"], "/repo");
  assert.equal(revoked.ok, true);
  if (revoked.ok)
    assert.deepEqual(revoked.command.action, {
      kind: "rbac-bootstrap",
      operation: "edge-join-revoke",
      joinId: "join-123",
    });

  assert.equal(parseThinCommand(["bootstrap", "--operation", "edge-join-consume"], "/repo").ok, false);
});

test("ha edge join is one operation of the managed RBAC surface", () => {
  const link = "harness-edge://join/eyJ2ZXJzaW9uIjoxLCJqb2luSWQiOiJqb2luLTEyMyJ9";
  const parsed = parseThinCommand(["edge", "join", link], "/edge");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.command.method, "daemon.rbac.manage");
  assert.deepEqual(parsed.command.action, {
    kind: "rbac-bootstrap",
    operation: "edge-join",
    link,
  });

  assert.equal(parseThinCommand(["edge", "join", link, "--repo-id", "repo-a"], "/edge").ok, false);
});

test("ha bootstrap parses one external Keycloak through the same command", () => {
  const parsed = parseThinCommand(
    [
      "bootstrap",
      "--mode",
      "external",
      "--url",
      "https://id.example",
      "--realm",
      "fleet",
      "--client-id",
      "harness-center",
      "--client-secret-stdin",
    ],
    "/repo",
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.command.action, {
    kind: "rbac-bootstrap",
    mode: "external",
    url: "https://id.example",
    realm: "fleet",
    clientId: "harness-center",
    clientSecretStdin: true,
  });
});

test("ha bootstrap reads and sets the session lifetime through the same daemon method", () => {
  const read = parseThinCommand(["bootstrap", "--operation", "session-lifetime"], "/repo");
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.command.action, { kind: "rbac-bootstrap", operation: "session-lifetime" });
  const set = parseThinCommand(
    [
      "bootstrap",
      "--operation",
      "session-lifetime-set",
      "--seconds",
      "43200",
      "--expected-version",
      "21600",
      "--operation-id",
      "lifetime-change-1",
    ],
    "/repo",
  );
  assert.equal(set.ok, true);
  if (!set.ok) return;
  assert.equal(set.command.method, "daemon.rbac.manage");
  assert.deepEqual(set.command.action, {
    kind: "rbac-bootstrap",
    operation: "session-lifetime-set",
    sessionLifetimeSeconds: 43_200,
    expectedVersion: "21600",
    operationId: "lifetime-change-1",
  });
  assert.equal(
    parseThinCommand(["bootstrap", "--operation", "session-lifetime-set", "--seconds", "soon"], "/repo").ok,
    false,
  );
});

test("ha bootstrap reads and sets the listener edge nodes sign in through", () => {
  const read = parseThinCommand(["bootstrap", "--operation", "listener"], "/repo");
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.command.action, { kind: "rbac-bootstrap", operation: "listener" });
  const set = parseThinCommand(
    [
      "bootstrap",
      "--operation",
      "listener-set",
      "--listen-address",
      "192.0.2.10",
      "--hostname",
      "center.example.test",
      "--port",
      "8443",
      "--certificate-file",
      "/etc/harness/center.crt",
      "--certificate-key-file",
      "/etc/harness/center.key",
      "--expected-version",
      "version-1",
    ],
    "/repo",
  );
  assert.equal(set.ok, true);
  if (!set.ok) return;
  assert.equal(set.command.method, "daemon.rbac.manage");
  assert.deepEqual(set.command.action, {
    kind: "rbac-bootstrap",
    operation: "listener-set",
    expectedVersion: "version-1",
    listenAddress: "192.0.2.10",
    hostname: "center.example.test",
    port: 8443,
    certificateFile: "/etc/harness/center.crt",
    certificateKeyFile: "/etc/harness/center.key",
  });
  assert.equal(parseThinCommand(["bootstrap", "--operation", "listener-set", "--port", "https"], "/repo").ok, false);
});

test("ha bootstrap lists, registers, and unregisters fleet nodes through the same daemon method", () => {
  const action = (args: readonly string[]) => {
    const parsed = parseThinCommand(["bootstrap", ...args], "/repo");
    assert.equal(parsed.ok, true, args.join(" "));
    if (!parsed.ok) return undefined;
    assert.equal(parsed.command.method, "daemon.rbac.manage");
    return parsed.command.action;
  };
  assert.deepEqual(action(["--operation", "node-list"]), { kind: "rbac-bootstrap", operation: "node-list" });
  const register = ["--operation", "node-register", "--node-id", "edge-one", "--person-id", "alice"];
  assert.deepEqual(action([...register, "--operation-id", "r-1", "--credential-file", "/secrets/edge-one"]), {
    kind: "rbac-bootstrap",
    operation: "node-register",
    operationId: "r-1",
    nodeId: "edge-one",
    personId: "alice",
    credentialFile: "/secrets/edge-one",
  });
  // A first registration mints the credential, so it is refused before anything is sent when there is
  // no file to receive it. Moving an existing node to another person mints nothing and needs no file.
  const fileless = parseThinCommand(["bootstrap", ...register], "/repo");
  assert.equal(fileless.ok, false);
  if (!fileless.ok) {
    assert.equal(fileless.code, "missing_field");
    assert.match(fileless.nextAction, /--credential-file/u);
  }
  // The daemon writes the file, so a relative path is resolved where the caller stands.
  assert.equal(
    action([...register, "--credential-file", "edge-one.credential"])?.credentialFile,
    path.resolve("edge-one.credential"),
  );
  assert.deepEqual(action([...register, "--expected-version", "version-1"]), {
    kind: "rbac-bootstrap",
    operation: "node-register",
    expectedVersion: "version-1",
    nodeId: "edge-one",
    personId: "alice",
  });
  assert.deepEqual(
    action([
      "--operation",
      "node-unregister",
      "--node-id",
      "edge-one",
      "--expected-version",
      "version-1",
      "--operation-id",
      "u-1",
    ]),
    {
      kind: "rbac-bootstrap",
      operation: "node-unregister",
      expectedVersion: "version-1",
      operationId: "u-1",
      nodeId: "edge-one",
    },
  );
  assert.equal(parseThinCommand(["bootstrap", "--operation", "node-remove"], "/repo").ok, false);
});

test("ha bootstrap exposes grant and revoke through the daemon access administration method", () => {
  for (const operation of ["grant", "revoke", "grant-list", "group-list"]) {
    const parsed = parseThinCommand(
      [
        "bootstrap",
        "--operation",
        operation,
        "--person-id",
        "alice",
        "--group-id",
        "admin",
        "--resource",
        "repo-a",
        "--operation-id",
        "op-1",
      ],
      "/repo",
    );
    assert.equal(parsed.ok, true, operation);
    if (!parsed.ok) continue;
    assert.equal(parsed.command.method, "daemon.rbac.manage");
    assert.deepEqual(parsed.command.action, {
      kind: "rbac-bootstrap",
      operation,
      operationId: "op-1",
      personId: "alice",
      groupId: "admin",
      resource: "repo-a",
    });
  }
});

test("first administrator CLI takes a password file and rejects password argv", () => {
  const argv = [
    "bootstrap",
    "--operation",
    "bootstrap-admin",
    "--username",
    "owner",
    "--email",
    "owner@example.invalid",
    "--display-name",
    "Owner",
    "--person-id",
    "person-owner",
    "--password-file",
    "/tmp/owner-password",
  ];
  const parsed = parseThinCommand(argv, "/repo");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.command.action, {
    kind: "rbac-bootstrap",
    operation: "bootstrap-admin",
    username: "owner",
    email: "owner@example.invalid",
    displayName: "Owner",
    personId: "person-owner",
    passwordFile: "/tmp/owner-password",
  });
  assert.equal(parseThinCommand(argv.slice(0, -2), "/repo").ok, false);
  assert.equal(parseThinCommand([...argv, "--password", "secret"], "/repo").ok, false);
  assert.equal(parseThinCommand(["bootstrap", "--operation", "bootstrap-status"], "/repo").ok, true);
});

test("work team commands carry the native team id and observed version", () => {
  for (const operation of ["team-update", "team-delete", "team-member-add", "team-member-remove"]) {
    const parsed = parseThinCommand(
      [
        "bootstrap",
        "--operation",
        operation,
        "--team-id",
        "team-1",
        "--team-name",
        "Builders",
        "--person-id",
        "alice",
        "--expected-version",
        "v1",
        "--operation-id",
        "edit-1",
      ],
      "/repo",
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) continue;
    assert.equal(parsed.command.method, "daemon.rbac.manage");
    assert.deepEqual(parsed.command.action, {
      kind: "rbac-bootstrap",
      operation,
      teamId: "team-1",
      teamName: "Builders",
      personId: "alice",
      expectedVersion: "v1",
      operationId: "edit-1",
    });
  }
});

test("edge join prepares its workspace root before reaching the daemon", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-edge-join-root-")),
    workspaceRoot = path.join(userRoot, "edge", "workspace");
  try {
    const parsed = parseThinCommand(["edge", "join", "harness-edge://join/test", "--root", workspaceRoot], userRoot);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    // The autostart spawns the daemon from the invoking root as its cwd, so edge join creates the
    // missing --root before the first connection attempt; the request itself then fails offline.
    await assert.rejects(
      runCommandThroughDaemon(parsed.command, () => undefined, {
        autostart: false,
        env: { HARNESS_DAEMON_USER_ROOT: userRoot, HARNESS_DAEMON_ID: "edge-join-root" },
      }),
    );
    assert.equal(existsSync(workspaceRoot), true, "edge join creates the missing --root in one command");
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
