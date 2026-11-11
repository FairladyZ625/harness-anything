// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { IdentitySessionPort } from "@harness-anything/kernel";
import {
  forwardingIntentForAction,
  forwardingIntentIssue,
  runtimeForwardingIntent,
} from "../src/fleet/forwarding-intent.ts";
import { forward } from "../src/fleet/forwarding-port.ts";
import { daemonProtocolCommands } from "../src/protocol/daemon-protocol-commands.ts";

test("forwarding intent binds command identity, method and execution context", () => {
  const action = { kind: "fact-record", executionId: "execution-one", statement: "evidence" },
    intent = forwardingIntentForAction("repo.task.run", action);
  assert.equal(intent.commandId, "fact-record");
  assert.deepEqual(intent.executionContext, { executionId: "execution-one" });
  assert.equal(forwardingIntentIssue(intent), null);
});

test("forwarding intent rejects mismatched identity, method, execution and route declarations", () => {
  const action = { kind: "fact-record", executionId: "execution-one" },
    intent = forwardingIntentForAction("repo.task.run", action);
  assert.match(forwardingIntentIssue({ ...intent, commandId: "decision-propose" }) ?? "", /commandId/u);
  assert.match(forwardingIntentIssue({ ...intent, method: "repo.task.read" }) ?? "", /method/u);
  assert.match(
    forwardingIntentIssue({ ...intent, executionContext: { executionId: "execution-two" } }) ?? "",
    /execution context/u,
  );
  assert.match(
    forwardingIntentIssue(forwardingIntentForAction("repo.task.read", { kind: "task-show" })) ?? "",
    /not center-forwardable/u,
  );
});

test("forwarding accepts node-owned schedule commands while keeping replica reads local", () => {
  for (const kind of ["schedule-run-now", "schedule-settle", "schedule-missed"]) {
    assert.equal(forwardingIntentIssue(forwardingIntentForAction("repo.task.run", { kind })), null, kind);
  }
  assert.match(
    forwardingIntentIssue(forwardingIntentForAction("repo.task.read", { kind: "schedule-list" })) ?? "",
    /not center-forwardable/u,
  );
});

test("registration without an edge stays local; a registered edge requires a valid location", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-forward-role-"))),
    userRoot = path.join(root, "user"),
    workspace = path.join(root, "workspace");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(userRoot);
  mkdirSync(workspace);
  const invoke = (intent: Parameters<typeof forward>[0]["intent"]) =>
    forward({
      userRoot,
      repoId: "repo",
      intent,
      auth: { transportKind: "unix-socket" },
      oidc: {
        bind: async () => assert.fail("No forwarding node can bind an identity"),
      } as unknown as IdentitySessionPort,
      runRuntime: async () => assert.fail("No forwarding node can execute a request"),
    });
  const command = forwardingIntentForAction("repo.task.run", { kind: "schedule-disable" }),
    runtime = runtimeForwardingIntent("repo.agentRuntime.overview", {}),
    boundCommand = forwardingIntentForAction("repo.task.run", { kind: "schedule-disable" }, { requiredNodeId: "node" });
  assert.equal(await invoke(command), null, "an unregistered host has no center route");
  assert.equal(await invoke(runtime), null);
  for (const mode of ["local", "remote-center", "remote-edge"]) {
    writeFileSync(
      path.join(userRoot, "registry.json"),
      JSON.stringify({
        schema: "harness-daemon-registry/v2",
        connections: [{ id: "local", kind: "local", displayName: "Fixture", state: "enabled" }],
        repos: [
          {
            repoId: "repo",
            canonicalRoot: workspace,
            displayName: "Fixture",
            authoredBranch: "main",
            mode,
            connectionId: "local",
            state: "enabled",
            registeredAt: "2026-11-01T00:00:00.000Z",
          },
        ],
      }),
    );
    if (mode === "remote-edge") {
      await assert.rejects(invoke(command), { code: "fleet_edge_config_invalid" });
      await assert.rejects(invoke(runtime), { code: "fleet_edge_config_invalid" });
      await assert.rejects(invoke(boundCommand), { code: "fleet_edge_config_invalid" });
    } else {
      assert.equal(await invoke(command), null, `${mode}: commands stay on this host`);
      assert.equal(await invoke(runtime), null, `${mode}: runtime stays on this host`);
      assert.equal(await invoke(boundCommand), null, `${mode}: a required node cannot change the registry role`);
    }
  }
});

test("forwarding resolves workspace, view and CA again after registration moves", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-forward-location-"))),
    userRoot = path.join(root, "user"),
    workspaces = [path.join(root, "old"), path.join(root, "new")];
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(userRoot);
  for (const [index, workspace] of workspaces.entries()) {
    mkdirSync(workspace);
    writeFileSync(
      path.join(workspace, "fleet-edge.json"),
      JSON.stringify({
        schema: "fleet-edge-config/v1",
        repoId: "repo",
        host: `center-${index}`,
        port: 7443,
        caPath: `ca-${index}.pem`,
        nodeId: `node-${index}`,
        credential: "fixture",
        viewRoot: `view-${index}`,
        quotaBytes: 65536,
      }),
    );
  }
  const register = (workspace: string) =>
    writeFileSync(
      path.join(userRoot, "registry.json"),
      JSON.stringify({
        schema: "harness-daemon-registry/v2",
        connections: [{ id: "local", kind: "local", displayName: "Fixture", state: "enabled" }],
        repos: [
          {
            repoId: "repo",
            canonicalRoot: workspace,
            displayName: "Fixture",
            authoredBranch: "main",
            mode: "remote-edge",
            connectionId: "local",
            state: "enabled",
            registeredAt: "2026-11-01T00:00:00.000Z",
          },
        ],
      }),
    );
  const requests: Record<string, unknown>[] = [],
    oidc = { bind: async (auth: unknown) => auth } as unknown as IdentitySessionPort;
  for (const [index, workspace] of workspaces.entries()) {
    register(workspace);
    await forward({
      userRoot,
      repoId: "repo",
      intent: forwardingIntentForAction("repo.task.run", { kind: "schedule-disable" }),
      auth: { transportKind: "unix-socket" },
      oidc,
      runRuntime: async (request) => {
        requests.push(request);
        return {};
      },
    });
    assert.equal(requests[index]?.workspaceRoot, workspace);
    assert.equal(requests[index]?.viewRoot, path.join(workspace, `view-${index}`));
    assert.equal(requests[index]?.caPath, path.join(workspace, `ca-${index}.pem`));
    assert.equal(requests[index]?.host, `center-${index}`);
    assert.equal(requests[index]?.nodeId, `node-${index}`);
  }
  await forward({
    userRoot,
    repoId: "repo",
    intent: forwardingIntentForAction("repo.task.run", {
      kind: "schedule-run-now",
      scheduleId: "probe",
      idempotencyKey: "occurrence-one",
    }),
    auth: { transportKind: "unix-socket" },
    oidc,
    runRuntime: async (request) => {
      assert.equal(request.workspaceRoot, workspaces[1]);
      assert.deepEqual(request.action, {
        kind: "schedule-run-now",
        scheduleId: "probe",
        idempotencyKey: "occurrence-one",
      });
      return { outcome: "applied" };
    },
  });
});

test("runtime forwarding resolves the live workspace and rejects non-local ingress", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-forward-runtime-location-"))),
    userRoot = path.join(root, "user"),
    workspaces = [path.join(root, "old"), path.join(root, "new")];
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(userRoot);
  for (const [index, workspace] of workspaces.entries()) {
    mkdirSync(workspace);
    writeFileSync(
      path.join(workspace, "fleet-edge.json"),
      JSON.stringify({
        schema: "fleet-edge-config/v1",
        repoId: "repo",
        host: `center-${index}`,
        port: 7443,
        caPath: `ca-${index}.pem`,
        nodeId: `node-${index}`,
        credential: "fixture",
        viewRoot: `view-${index}`,
        quotaBytes: 65536,
      }),
    );
  }
  const register = (workspace: string) =>
      writeFileSync(
        path.join(userRoot, "registry.json"),
        JSON.stringify({
          schema: "harness-daemon-registry/v2",
          connections: [{ id: "local", kind: "local", displayName: "Fixture", state: "enabled" }],
          repos: [
            {
              repoId: "repo",
              canonicalRoot: workspace,
              displayName: "Fixture",
              authoredBranch: "main",
              mode: "remote-edge",
              connectionId: "local",
              state: "enabled",
              registeredAt: "2026-11-01T00:00:00.000Z",
            },
          ],
        }),
      ),
    requests: Record<string, unknown>[] = [];
  for (const [index, workspace] of workspaces.entries()) {
    register(workspace);
    const receipt = await forward({
      userRoot,
      repoId: "repo",
      intent: runtimeForwardingIntent("repo.agentRuntime.overview", { limit: 1 }),
      auth: { transportKind: "unix-socket" },
      runRuntime: async (payload) => {
        requests.push(payload);
        return { outcome: "applied" };
      },
    });
    assert.equal(receipt?.outcome, "applied");
    assert.equal(requests[index]?.workspaceRoot, workspace);
    assert.equal(requests[index]?.viewRoot, path.join(workspace, `view-${index}`));
    assert.equal(requests[index]?.caPath, path.join(workspace, `ca-${index}.pem`));
    assert.equal(requests[index]?.host, `center-${index}`);
    assert.equal(requests[index]?.nodeId, `node-${index}`);
  }
  const invoke = () =>
    forward({
      userRoot,
      repoId: "repo",
      intent: runtimeForwardingIntent("repo.agentRuntime.overview", {}),
      auth: { transportKind: "unix-socket" },
      oidc: {} as IdentitySessionPort,
      runRuntime: async () => assert.fail("Invalid edge configuration must never reach the runtime"),
    });
  // A registered edge must not fall back to local handling after its config vanishes or names another repo.
  writeFileSync(
    path.join(workspaces[1]!, "fleet-edge.json"),
    JSON.stringify({
      schema: "fleet-edge-config/v1",
      repoId: "another-repo",
      host: "center",
      port: 7443,
      caPath: "ca.pem",
      nodeId: "node-1",
      credential: "fixture",
      viewRoot: "view",
      quotaBytes: 65536,
    }),
  );
  await assert.rejects(invoke(), { code: "fleet_edge_config_invalid" });
  unlinkSync(path.join(workspaces[1]!, "fleet-edge.json"));
  await assert.rejects(invoke(), { code: "fleet_edge_config_invalid" });
  await assert.rejects(
    forward({
      userRoot,
      repoId: "repo",
      intent: runtimeForwardingIntent("repo.agentRuntime.overview", {}),
      auth: { transportKind: "fleet-tls", nodePrincipal: { nodeId: "node-1" } } as never,
      runRuntime: async () => ({ outcome: "applied" }),
    }),
    { code: "local_transport_required" },
  );
});

test("runtime forwarding carries the daemon lifetime into a started request and settles on close", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-forward-runtime-lifetime-"))),
    userRoot = path.join(root, "user"),
    workspace = path.join(root, "workspace");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(userRoot);
  mkdirSync(workspace);
  writeFileSync(
    path.join(workspace, "fleet-edge.json"),
    JSON.stringify({
      schema: "fleet-edge-config/v1",
      repoId: "repo",
      host: "center",
      port: 7443,
      caPath: "ca.pem",
      nodeId: "node-one",
      credential: "fixture",
      viewRoot: "view",
      quotaBytes: 65536,
    }),
  );
  writeFileSync(
    path.join(userRoot, "registry.json"),
    JSON.stringify({
      schema: "harness-daemon-registry/v2",
      connections: [{ id: "local", kind: "local", displayName: "Fixture", state: "enabled" }],
      repos: [
        {
          repoId: "repo",
          canonicalRoot: workspace,
          displayName: "Fixture",
          authoredBranch: "main",
          mode: "remote-edge",
          connectionId: "local",
          state: "enabled",
          registeredAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    }),
  );
  const lifetime = new AbortController();
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  let received: AbortSignal | undefined;
  const forwarded = forward({
    userRoot,
    repoId: "repo",
    intent: runtimeForwardingIntent("repo.tasks.autoClaimCandidates", {}),
    auth: { transportKind: "unix-socket" },
    oidc: {} as IdentitySessionPort,
    signal: lifetime.signal,
    // The consumer holds an operational read that never answers on its own; only the lifetime
    // can settle it. The handshake proves the call was in flight before close.
    runRuntime: async (_payload, auth) => {
      received = auth.connectionSignal;
      requestStarted();
      await new Promise<void>(() => undefined);
      return {};
    },
  });
  await started;
  assert.equal(received?.aborted, false);
  lifetime.abort(new Error("daemon closed"));
  await assert.rejects(forwarded, (error) => error === lifetime.signal.reason);
  assert.equal(received?.aborted, true);
});

// dec_2C49A4516E540906721AF01840: routing is derived from the complete descriptor catalog.
test("every declared center-forward command reaches the port and rejected commands stop before routing", async (t) => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-forward-catalog-"));
  t.after(() => rmSync(userRoot, { recursive: true, force: true }));
  let forwarded = 0,
    rejected = 0;
  for (const descriptor of daemonProtocolCommands) {
    const kind = ("actionKind" in descriptor ? descriptor.actionKind : undefined) ?? descriptor.id,
      admission = descriptor.admission["remote-edge"];
    if (admission !== "via-center-forward" && admission !== "rejected") continue;
    const invoke = () =>
      forward({
        userRoot,
        repoId: "unregistered",
        intent: forwardingIntentForAction(descriptor.method, { kind }),
        auth: { transportKind: "unix-socket" },
        oidc: {} as IdentitySessionPort,
        runRuntime: async () => assert.fail("Unregistered repositories must not send requests"),
      });
    if (admission === "via-center-forward") {
      assert.equal(await invoke(), null, descriptor.id);
      forwarded += 1;
    } else {
      await assert.rejects(invoke(), { code: "invalid_field" }, descriptor.id);
      rejected += 1;
    }
  }
  assert.equal(
    forwarded,
    daemonProtocolCommands.filter((command) => command.admission["remote-edge"] === "via-center-forward").length,
  );
  assert.ok(rejected > 0);
});
