// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fleetEdgeRegistration } from "../src/daemon/fleet-command-route.ts";
import type { ThinCommand } from "../src/cli/thin-command.ts";

// 2026-09-02 现场:一条指向已删临时目录的 e2e 残留登记(甚至已 disabled)让每一条走路由的
// ha 命令都报 invalid_root。路由只关心 enabled 且根目录还在的条目,其余必须被忽略。
test("a registered repo whose root no longer exists does not break routing for other repos", async (t) => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-dead-registry-"));
  t.after(() => rmSync(userRoot, { recursive: true, force: true }));
  const liveRoot = path.join(userRoot, "live-repo");
  mkdirSync(liveRoot);
  writeFileSync(
    path.join(userRoot, "registry.json"),
    JSON.stringify({
      schema: "harness-daemon-registry/v2",
      connections: [{ id: "local", kind: "local", displayName: "This device", state: "enabled" }],
      repos: [
        repo("dead-disabled", "/nonexistent/parent/dead-one", "disabled"),
        repo("dead-enabled", "/nonexistent/parent/dead-two", "enabled"),
        repo("live", liveRoot, "enabled"),
      ],
    }),
  );
  const command = { rootDir: liveRoot } as ThinCommand;
  // local mode → no fleet reroute; the point is that it resolves instead of throwing invalid_root.
  assert.equal(await fleetEdgeRegistration(command, { HARNESS_DAEMON_USER_ROOT: userRoot }), null);
});

// A relayed runtime carries its canonical root and repo id from the dispatcher. The fleet mode
// probe must read the workspace-owned fleet-edge.json and match the injected repo, because the
// host registry that records remote-edge mode is not readable inside the sandbox.
test("relay fleet routing reads the workspace fleet-edge.json instead of the host registry", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-relay-fleet-route-"))),
    userRoot = path.join(root, "sealed-user"),
    outside = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-relay-fleet-outside-"))),
    worktree = path.join(root, "worktrees", "worker");
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(worktree, { recursive: true });
  // The injected registry is unreadable; a read here would throw instead of routing.
  mkdirSync(path.join(userRoot, "registry.json"), { recursive: true });
  writeFileSync(
    path.join(root, "fleet-edge.json"),
    `${JSON.stringify({
      schema: "fleet-edge-config/v1",
      repoId: "relay-repo",
      host: "center.invalid",
      port: 7443,
      caPath: "/fleet/ca.pem",
      nodeId: "edge-one",
      credential: "machine-secret",
      viewRoot: path.join(root, "view"),
      quotaBytes: 64 * 1024 * 1024,
    })}\n`,
  );
  const env = {
      HARNESS_DAEMON_RELAY: "1",
      HARNESS_DAEMON_USER_ROOT: userRoot,
      HARNESS_DAEMON_REPO_ID: "relay-repo",
      HARNESS_CANONICAL_ROOT: root,
    },
    routed = await fleetEdgeRegistration({ rootDir: worktree } as ThinCommand, env);
  assert.equal(routed?.repoId, "relay-repo");
  assert.equal(routed?.workspaceRoot, root);
  assert.equal(
    await fleetEdgeRegistration({ rootDir: worktree } as ThinCommand, { ...env, HARNESS_DAEMON_REPO_ID: "other" }),
    null,
    "a repo that does not match the injected id keeps the command on the relay",
  );
  assert.equal(
    await fleetEdgeRegistration({ rootDir: outside } as ThinCommand, env),
    null,
    "a root outside the injected canonical root keeps the command on the relay",
  );
  rmSync(path.join(root, "fleet-edge.json"));
  assert.equal(
    await fleetEdgeRegistration({ rootDir: worktree } as ThinCommand, env),
    null,
    "a local workspace without fleet-edge.json stays on the relay",
  );
});

function repo(repoId: string, canonicalRoot: string, state: "enabled" | "disabled") {
  return {
    repoId,
    canonicalRoot,
    displayName: repoId,
    authoredBranch: "main",
    mode: "local",
    connectionId: "local",
    state,
    registeredAt: "2026-07-07T00:00:00.000Z",
  };
}
