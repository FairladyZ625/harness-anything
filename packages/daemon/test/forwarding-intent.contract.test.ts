// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { IdentitySessionPort } from "@harness-anything/kernel";
import { forwardingIntentForAction, forwardingIntentIssue } from "../src/fleet/forwarding-intent.ts";
import { forward } from "../src/fleet/forwarding-port.ts";

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
});
