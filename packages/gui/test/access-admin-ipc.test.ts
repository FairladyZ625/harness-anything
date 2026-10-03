// harness-test-tier: contract
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { IpcMainInvokeEvent } from "electron";
import { validateDaemonRpcCall } from "@harness-anything/daemon/protocol/validation";
import { ACCESS_ADMIN_CHANNEL, type AccessAdminApi } from "../src/api/access-admin-contract.ts";
import { accessAdminParams, registerAccessAdminIpc } from "../src/main/access-admin-ipc.ts";
import { accessAdminPreloadApi } from "../src/preload/access-admin-preload.ts";

const event = { sender: { id: 7 }, senderFrame: { url: "file:///renderer/index.html" } } as IpcMainInvokeEvent,
  policy = {
    isTrustedWebContentsId: (id: number) => id === 7,
    rendererUrl: { packagedRendererUrl: event.senderFrame!.url },
  };

function fixture() {
  let handler!: (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>;
  const sent: Record<string, unknown>[] = [];
  let sequence = 0;
  registerAccessAdminIpc(
    {
      handle: (channel, listener) => {
        assert.equal(channel, ACCESS_ADMIN_CHANNEL);
        handler = listener;
      },
    },
    policy,
    {
      daemonRequest: async (params) => {
        sent.push(params);
        return { ok: true };
      },
      operationId: () => `operation-${++sequence}`,
    },
  );
  return { sent, invoke: (input: unknown, sender = event) => handler(sender, input) };
}

test("every preload method reaches the daemon as one operation the protocol contract declares", async () => {
  const { sent, invoke } = fixture(),
    api: AccessAdminApi = accessAdminPreloadApi((_channel, request) => invoke(request)),
    group = { groupId: "release", displayName: "Release", scopes: ["task-create"], composites: ["viewer"] },
    grant = { personId: "alice", groupId: "release", resource: "repo-a:task/task_1" };
  await api.groups();
  await api.createGroup(group);
  await api.updateGroup({ ...group, expectedVersion: "v1" });
  await api.deleteGroup({ groupId: "release", expectedVersion: "v1" });
  await api.grants();
  await api.grant(grant);
  await api.revoke(grant);
  await api.effectivePermissions({ personId: "alice", resource: "repo-a" });
  await api.receipts();
  await api.reconcile({ operationId: "operation-1" });
  await api.sessionLifetime();
  await api.setSessionLifetime({ sessionLifetimeSeconds: 3_600, expectedVersion: "21600" });
  await api.forRepository("server-b").groups();
  await api.nodes();
  await api.teams();
  await api.createTeam({ teamName: "Builders" });
  await api.updateTeam({ teamId: "team-1", teamName: "Reviewers", expectedVersion: "v1" });
  await api.deleteTeam({ teamId: "team-1", expectedVersion: "v1" });
  await api.addTeamMember({ teamId: "team-1", personId: "alice", expectedVersion: "v1" });
  await api.removeTeamMember({ teamId: "team-1", personId: "alice", expectedVersion: "v1" });
  assert.deepEqual(sent, [
    { operation: "group-list" },
    { operation: "group-create", ...group, operationId: "operation-1" },
    { operation: "group-update", ...group, expectedVersion: "v1", operationId: "operation-2" },
    { operation: "group-delete", groupId: "release", expectedVersion: "v1", operationId: "operation-3" },
    { operation: "grant-list" },
    { operation: "grant", ...grant, operationId: "operation-4" },
    { operation: "revoke", ...grant, operationId: "operation-5" },
    { operation: "effective-permissions", personId: "alice", resource: "repo-a" },
    { operation: "receipt-list" },
    { operation: "receipt-reconcile", operationId: "operation-1" },
    { operation: "session-lifetime" },
    {
      operation: "session-lifetime-set",
      sessionLifetimeSeconds: 3_600,
      expectedVersion: "21600",
      operationId: "operation-6",
    },
    { operation: "group-list", repoId: "server-b" },
    { operation: "node-list" },
    { operation: "team-list" },
    { operation: "team-create", teamName: "Builders", operationId: "operation-7" },
    {
      operation: "team-update",
      teamId: "team-1",
      teamName: "Reviewers",
      expectedVersion: "v1",
      operationId: "operation-8",
    },
    { operation: "team-delete", teamId: "team-1", expectedVersion: "v1", operationId: "operation-9" },
    {
      operation: "team-member-add",
      teamId: "team-1",
      personId: "alice",
      expectedVersion: "v1",
      operationId: "operation-10",
    },
    {
      operation: "team-member-remove",
      teamId: "team-1",
      personId: "alice",
      expectedVersion: "v1",
      operationId: "operation-11",
    },
  ]);
  assert.equal(Object.keys(api).length, sent.length, "the test covers every method the page can call");

  // The daemon's own contract accepts each of them: same operation names, same field types.
  for (const params of sent) assert.deepEqual(validateDaemonRpcCall({ method: "daemon.rbac.manage", params }), []);
  // Negative control: an operation the contract does not declare is what that validation refuses.
  assert.notDeepEqual(
    validateDaemonRpcCall({ method: "daemon.rbac.manage", params: { operation: "grant-everything" } }),
    [],
  );
});

test("a request outside the typed contract is refused before it reaches the daemon", async () => {
  const { sent, invoke } = fixture();
  for (const [input, refusal] of [
    [{ operation: "bootstrap-admin", username: "x", password: "y" }, /does not offer bootstrap-admin/u],
    [{ operation: "backup", backupDir: "/tmp" }, /does not offer backup/u],
    [{ operation: "invite" }, /does not offer invite/u],
    [null, /does not offer undefined/u],
    // The main process names each write; the renderer cannot pick an operation id to replay or collide with.
    [
      { operation: "grant", personId: "a", groupId: "g", resource: "r", operationId: "mine" },
      /does not take operationId/u,
    ],
    [{ operation: "group-list", url: "http://elsewhere" }, /does not take url/u],
    [{ operation: "grant", personId: "a", groupId: "g" }, /requires resource/u],
    [{ operation: "grant", personId: "a", groupId: "g", resource: " " }, /requires resource/u],
    [{ operation: "group-create", groupId: "g", displayName: "G", scopes: [1], composites: [] }, /requires scopes/u],
    [
      { operation: "session-lifetime-set", sessionLifetimeSeconds: 1.5, expectedVersion: "1" },
      /requires sessionLifetimeSeconds/u,
    ],
  ] as const)
    await assert.rejects(invoke(input), refusal);
  await assert.rejects(
    invoke({ operation: "group-list" }, { ...event, sender: { id: 99 } } as IpcMainInvokeEvent),
    /Rejected IPC/u,
  );
  assert.deepEqual(sent, []);
  assert.throws(() => accessAdminParams({ operation: "constructor" }, () => "id"), /does not offer constructor/u);
});

test("the handler returns the daemon's answer as it is, refusals and conflicts included", async () => {
  const conflict = {
    ok: false,
    code: "version_conflict",
    groupId: "release",
    expectedVersion: "a",
    currentVersion: "b",
  };
  let handler!: (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>;
  registerAccessAdminIpc({ handle: (_channel, listener) => (handler = listener) }, policy, {
    daemonRequest: async () => conflict,
    operationId: () => "operation",
  });
  assert.deepEqual(
    await handler(event, { operation: "group-delete", groupId: "release", expectedVersion: "a" }),
    conflict,
  );
});

const rendererRoot = path.resolve(import.meta.dirname, "../src/renderer"),
  pageSources = [
    "views/IdentityAccessView.tsx",
    "access-model.ts",
    ...readdirSync(path.join(rendererRoot, "components/identityAccess")).map(
      (file) => `components/identityAccess/${file}`,
    ),
  ],
  // The page talks to its preload surface only: no network call, no embedded console, no Keycloak endpoint.
  beyondThePreload =
    /\bfetch\s*\(|XMLHttpRequest|WebSocket|<iframe|<webview|\/admin\/|\/realms\/|openid-connect|from\s+["'](?:node:[^"']+|electron|@harness-anything\/daemon(?!\/protocol)[^"']*)["']/u;

test("the access control page reaches Keycloak only through its preload surface", () => {
  assert.ok(pageSources.length >= 6);
  for (const file of pageSources)
    assert.equal(beyondThePreload.exec(readFileSync(path.join(rendererRoot, file), "utf8"))?.[0], undefined, file);
  // Negative control: each way out of that boundary is something this check sees.
  for (const sample of [
    'await fetch("http://127.0.0.1:8080/x")',
    "<iframe src={consoleUrl} />",
    "`${url}/admin/${realm}/console/`",
    "`${url}/realms/${realm}/protocol/openid-connect/token`",
    'import { readFileSync } from "node:fs";',
    'import { AccessAdminService } from "@harness-anything/daemon";',
  ])
    assert.match(sample, beyondThePreload);
  assert.doesNotMatch('import type { X } from "@harness-anything/daemon/protocol";', beyondThePreload);
});

test("work team operations preserve versions and reject renderer authority fields", async () => {
  const { sent, invoke } = fixture(),
    api = accessAdminPreloadApi((_channel, request) => invoke(request)),
    change = { teamId: "team-1", expectedVersion: "v1" };
  await api.nodes();
  await api.teams();
  await api.createTeam({ teamName: "Builders" });
  await api.updateTeam({ ...change, teamName: "Reviewers" });
  await api.addTeamMember({ ...change, personId: "alice" });
  await api.removeTeamMember({ ...change, personId: "alice" });
  await api.deleteTeam(change);
  for (const params of sent) assert.deepEqual(validateDaemonRpcCall({ method: "daemon.rbac.manage", params }), []);
  assert.deepEqual(
    sent.map((params) => params.expectedVersion),
    [undefined, undefined, undefined, "v1", "v1", "v1", "v1"],
  );
  assert.throws(() =>
    accessAdminParams({ operation: "team-member-add", ...change, personId: "alice", actor: "admin" }, () => "id"),
  );
});
