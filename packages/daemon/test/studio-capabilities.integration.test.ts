// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { localUserDaemonEndpoint, mkdirSecurely } from "../src/client/local-daemon-target.ts";
import { serveJsonRpcStream } from "../src/transport/json-rpc-stream.ts";
import { auth, rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { registerSettledBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { signInPolicyTestUser, revokeTestPolicyActions } from "./keycloak-policy.fixtures.ts";
import { actionDeclarations } from "@harness-anything/kernel";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";
import { localAuthFixture } from "./fleet-tls-session.fixture.ts";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-studio-rpc-")),
    userRoot = path.join(root, "user"),
    repo = path.join(root, "repo"),
    endpoint = localUserDaemonEndpoint(userRoot, "studio");
  rosterRepo(repo, "studio");
  await registerSettledBootstrappedDaemonRepo({ repoId: "studio", canonicalRoot: repo, userRoot });
  signInPolicyTestUser(userRoot, "reader", ["studio"], "viewer");
  const host = await openDaemonHost({ daemonId: "studio", userRoot });
  const listener = net.createServer((socket) => {
    serveJsonRpcStream({
      input: socket,
      output: socket,
      transportKind: "unix-socket",
      authContext: { ...auth },
      createProtocolServer: (authContext, emit, connectionId, signal) =>
        createJsonRpcProtocolServer({
          host,
          build: { commit: null },
          authContext: { ...authContext, connectionSignal: signal },
          sessionPrincipal: (method, params) => host.sessionPrincipal(authContext, method, params),
          emit,
          connectionId,
        }),
    });
  });
  t.after(async () => {
    if (listener.listening)
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    await host.close();
    rmSync(root, { recursive: true, force: true });
  });
  await host.attachmentsSettled();
  if (process.platform !== "win32") mkdirSecurely(path.dirname(endpoint));
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(endpoint, resolve);
  });
  const request = (method: string, params: Parameters<typeof requestDaemonJsonRpcAt>[2]) =>
    requestDaemonJsonRpcAt(endpoint, method, params, 5_000);
  return { request, userRoot, host };
}

test("hello advertises the Studio daemon capabilities", async (t) => {
  const { request } = await fixture(t);
  const hello = await request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion });
  for (const method of [
    "daemon.skillEval.version.register",
    "repo.tasks.runtimeContext.read",
    "repo.reckoning.signals.read",
    "repo.policy.metadata.read",
  ])
    assert.ok(Array.isArray(hello.methods) && hello.methods.includes(method), method);
});

test("a repository reader can read context, signals and policy metadata over a real socket", async (t) => {
  const { request } = await fixture(t),
    context = await request("repo.tasks.runtimeContext.read", {
      repo: { repoId: "studio" },
      payload: { taskId: "missing" },
    }),
    signals = await request("repo.reckoning.signals.read", {
      repo: { repoId: "studio" },
      payload: { generatedAt: "2026-11-02T00:00:00.000Z", windowHours: 24 },
    }),
    policy = await request("repo.policy.metadata.read", { repo: { repoId: "studio" } });
  assert.equal(context.schema, "task-runtime-context-read/v3");
  assert.equal(signals.schema, "reckoning-signals/v1");
  assert.equal(policy.schema, "policy-metadata/v1");
  assert.ok(
    Array.isArray(policy.groups) &&
      policy.groups.some((group) => group && typeof group === "object" && "id" in group && group.id === "viewer"),
  );
  assert.ok(Array.isArray(policy.actions) && policy.actions.length > 0);
  t.diagnostic(JSON.stringify({ context, signals, policy }));
});

test("authenticated drafters register immutable versions with server-owned attribution", async (t) => {
  const { request } = await fixture(t),
    params = {
      skillId: "report",
      version: "1.0.0",
      body: "Return a verified report.",
      usageMarker: "<!-- skill:report -->",
    },
    registered = await request("daemon.skillEval.version.register", params);
  assert.equal(registered.ok, true, JSON.stringify(registered));
  assert.ok(registered.skill && typeof registered.skill === "object" && !Array.isArray(registered.skill));
  assert.equal(registered.skill.createdBy, "reader");
  assert.equal(registered.skill.status, "draft");
  assert.match(String(registered.skill.digest), /^[a-f0-9]{64}$/u);
  const duplicate = await request("daemon.skillEval.version.register", { ...params, body: "overwrite" });
  assert.equal(duplicate.code, "CONFLICT");
  const denied = await request("daemon.skillEval.run", { skillId: "report", version: "1.0.0" });
  assert.equal(denied.code, "FORBIDDEN");
  t.diagnostic(JSON.stringify({ registered, duplicate, denied }));
});

test("repository reads refuse readers without the repository grant", async (t) => {
  const { request, userRoot } = await fixture(t);
  signInPolicyTestUser(userRoot, "outsider", ["other"], "viewer");
  revokeTestPolicyActions("outsider", "studio", [
    actionDeclarations.find((action) => action.kind === "repository-read")!.policyAction,
  ]);
  for (const [method, params] of [
    ["repo.tasks.runtimeContext.read", { repo: { repoId: "studio" }, payload: { taskId: "missing" } }],
    ["repo.reckoning.signals.read", { repo: { repoId: "studio" }, payload: {} }],
    ["repo.policy.metadata.read", { repo: { repoId: "studio" } }],
  ] as const) {
    const denied = await request(method, params);
    assert.equal(denied.code, "authorization_denied", JSON.stringify(denied));
    t.diagnostic(JSON.stringify({ method, denied }));
  }
});

test(
  "two edges read the same canonical context and signals and fetch live policy metadata from the center",
  { timeout: 120_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, () => "2026-11-02T00:00:00.000Z", undefined, true),
      authority = await f.host.keycloakCenter();
    await authority.provider.syncBasePolicy(authority.accessToken);
    const created = await f.command("center-node", {
      kind: "task-create",
      taskId: "studio-context",
      title: "Canonical handoff",
    });
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const firstFact = await f.host.run(
      "lease-repo",
      {
        kind: "fact-record",
        factId: "F-ABCDEF01",
        statement: "Initial observation",
        evidenceSource: "test:studio-rpc",
        confidence: "high",
        memoryClass: "semantic",
      },
      localAuthFixture(),
    );
    assert.equal(firstFact.outcome, "applied", JSON.stringify(firstFact));
    const corrected = await f.host.run(
      "lease-repo",
      {
        kind: "fact-record",
        factId: "F-ABCDEF02",
        statement: "Corrected observation",
        evidenceSource: "test:studio-rpc",
        confidence: "high",
        memoryClass: "semantic",
        supersedes: { factRef: "fact/F-ABCDEF01", rationale: "New evidence" },
      },
      localAuthFixture(),
    );
    assert.equal(corrected.outcome, "applied", JSON.stringify(corrected));
    await waitForFleetPublication(f.host, "lease-repo", corrected.opId, localAuthFixture());
    const edges = [];
    for (const nodeId of ["node-one", "node-two"]) {
      const viewRoot = path.join(f.root, `view-${nodeId}`);
      await catchUpReplica({ ...f.peer(nodeId), viewRoot, diskQuotaBytes: 64 * 1024 * 1024 });
      edges.push(await fleetEdgeHostFixture(t, f, { name: nodeId, nodeId, viewRoot }));
    }
    // This group is created after both replicas were copied: serving policy from a replica or an
    // edge's own empty catalog cannot satisfy the assertion.
    await authority.provider.writePolicyGroup(authority.accessToken, {
      id: "studio-readers",
      displayName: "Studio readers",
      base: false,
      scopes: [],
      composites: ["viewer"],
    });
    const reads = await Promise.all(
      edges.map(async (edge) => ({
        context: await edge.host.read(
          "lease-repo",
          "repo.tasks.runtimeContext.read",
          { taskId: "studio-context" },
          localAuthFixture(),
        ),
        signals: await edge.host.read(
          "lease-repo",
          "repo.reckoning.signals.read",
          { generatedAt: "2026-11-02T00:00:01.000Z", windowHours: 24 },
          localAuthFixture(),
        ),
        policy: await edge.host.read("lease-repo", "repo.policy.metadata.read", {}, localAuthFixture()),
      })),
    );
    for (const read of reads) {
      assert.equal(read.context.snapshot.task?.title, "Canonical handoff");
      assert.ok(read.context.cut && read.context.freshness);
      assert.ok(
        read.signals.signals.some((signal) => signal.kind === "corrected-fact" && signal.key === "fact/F-ABCDEF01"),
      );
      assert.ok(read.policy.groups.some((group) => group.id === "studio-readers"));
    }
    assert.deepEqual(reads[0]!.context.snapshot, reads[1]!.context.snapshot);
    assert.deepEqual(reads[0]!.signals.signals, reads[1]!.signals.signals);
    assert.deepEqual(reads[0]!.policy, reads[1]!.policy);
    t.diagnostic(
      JSON.stringify({ context: reads[0]!.context, signals: reads[0]!.signals, policyGroups: reads[0]!.policy.groups }),
    );
  },
);
