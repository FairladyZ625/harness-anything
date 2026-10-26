// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { definition, installation, initIngressRepo, spawnCli } from "./fixtures/runtime-ingress.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";

// dec_6A77D43B8523823ABA1F5E4D3C CH1: a matching path reviewer *replaces* the default seat. The
// old contract dispatched both and demanded two dispatches; a cut now holds exactly one seat, so
// this test asserts the replacement instead of the retired pair.
test("CLI submit of a pushed delivery seats the matching path reviewer instead of the default", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-submit-review-cli-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "submit-review-cli",
    taskId = "task-auto-review",
    executionId = "execution-auto-review",
    daemonId = "submit-review-cli",
    uid = process.getuid?.() ?? 0;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  initIngressRepo(root, uid);
  git(root, "branch", "-M", "main");
  const settingsPath = path.join(root, "harness", "harness.yaml");
  writeFileSync(
    settingsPath,
    readFileSync(settingsPath, "utf8").replace(
      "settings:\n",
      "settings:\n  closeout:\n    profile: strict\n  roles:\n    defaultReviewer: auto-reviewer\n" +
        "  review:\n    pathReviewers:\n      - path-reviewer src/\n",
    ),
  );
  git(root, "add", "harness/harness.yaml");
  git(root, "commit", "-qm", "test: configure automatic review");
  const origin = path.join(parent, "origin.git");
  execFileSync("git", ["clone", "--bare", root, origin], { stdio: "pipe" });
  git(root, "remote", "add", "origin", origin);
  git(root, "fetch", "origin");
  signInPolicyTestUser(userRoot, "owner", [repoId], "admin");
  registerBootstrappedDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });
  const executablePath = writeProviderExecutable(path.join(parent, "codex-stub.mjs"), "process.exit(0);\n"),
    auth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: { ownerUid: uid, source: "unix-socket-filesystem-owner-boundary" },
    } as const;
  const host = await openDaemonHost({
    daemonId,
    userRoot,
    runtimeDiscover: () => [{ ...installation, executablePath }],
    runtimeLaunch: () => {
      return {
        pid: 4310,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      };
    },
  });
  await host.attachmentsSettled();
  const endpoint = localUserDaemonEndpoint(userRoot, daemonId),
    transport = createUnixSocketTransportServer({
      daemonId,
      socketPath: endpoint,
      createProtocolServer: (authContext, emit) =>
        createJsonRpcProtocolServer({ host, build: { commit: null }, authContext, emit }),
    });
  await transport.start();
  try {
    await host.runtimeInstance(
      "daemon.runtimeInstance.create",
      {
        instanceId: definition.instanceId,
        name: "Isolated reviewer",
        kindId: definition.kindId,
        installationId: definition.installationId,
        providerId: definition.providerId,
        models: [definition.model],
        permissionMode: "workspace-write",
        isolationState: "enforced",
        authMode: "subscription",
      },
      auth,
    );
    const run = (action: Parameters<typeof host.run>[1]) => host.run(repoId, action, auth),
      publish = async (opId: string) => {
        const receipt = await run({
          kind: "receipt-show",
          opId,
          waitFor: ["git_verified", "worktree_visible"],
          timeoutMs: 5000,
        });
        assert.equal(receipt.wait?.state, "satisfied", JSON.stringify(receipt));
      };
    for (const id of ["auto-reviewer", "path-reviewer"])
      assert.equal(
        (
          await run({
            kind: "agent-install",
            declaration: {
              schema: "agent-declaration/v1",
              id,
              name: id,
              instructions: "Independently review the submitted cut.",
              runtimes: [{ type: "codex", model: definition.model }],
              instance: definition.instanceId,
              role: "reviewer",
            },
          })
        ).outcome,
        "applied",
      );
    const created = await run({
      kind: "task-create",
      taskId,
      title: "Automatic CLI review",
      presetId: "standard-task",
      riskTier: "high",
    });
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await publish(created.opId);
    const packagePath = String((created as Record<string, unknown>).packagePath);
    await realizeTaskPlanFixture(root, packagePath, (planPath) => run({ kind: "doc-submit", paths: [planPath] }));
    const started = await run({ kind: "task-start", taskId, executionId });
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    await publish(started.opId);
    const checkout = path.join(root, ".worktrees", taskId);
    mkdirSync(path.join(checkout, "src"), { recursive: true });
    writeFileSync(path.join(checkout, "src", "delivery.ts"), "export const delivered = true;\n");
    git(checkout, "add", "src/delivery.ts");
    git(checkout, "commit", "-qm", "feat: deliver the reviewed change");
    git(checkout, "push", "-u", "origin", taskId);
    writeFileSync(
      path.join(root, "harness", packagePath, "closeout.md"),
      "# Closeout\n\n## Summary\n\nDeliver the source change pushed to the isolated local origin.\n\n" +
        "## Verification\n\nInspect real CLI submit and dispatches output.\n\n" +
        "## Residual Risk\n\nProvider execution uses an isolated stub.\n\n" +
        "## Same Mechanism Elsewhere\n\nSubmit and amend share cut review dispatch.\n",
    );
    const env = {
        ...process.env,
        HARNESS_DAEMON_USER_ROOT: userRoot,
        HARNESS_DAEMON_ID: daemonId,
        HARNESS_DAEMON_ENDPOINT: endpoint,
        HARNESS_DAEMON_REPO_ID: undefined,
        HARNESS_ACTOR: undefined,
        HARNESS_EXECUTION_CREDENTIAL: undefined,
        HARNESS_DAEMON_RELAY: undefined,
      },
      cli = (args: string[]) => spawnCli(["--root", checkout, "--repo", repoId, "--json", ...args], env);
    const submitted = await cli(["task", "submit", taskId, "--execution-id", executionId]);
    t.diagnostic(`ha task submit ${taskId}\n${submitted.stdout}${submitted.stderr}`);
    assert.equal(submitted.status, 0, JSON.stringify(submitted));
    assert.equal(JSON.parse(submitted.stdout).outcome, "applied");
    const dispatches = await cli(["task", "dispatches", taskId]);
    t.diagnostic(`ha task dispatches ${taskId}\n${dispatches.stdout}${dispatches.stderr}`);
    assert.equal(dispatches.status, 0, JSON.stringify(dispatches));
    assert.match(dispatches.stdout, /path-reviewer/u);
    assert.doesNotMatch(dispatches.stdout, /auto-reviewer/u);
    const initialDispatches = JSON.parse(dispatches.stdout).dispatches as { dispatchId: string; agentId: string }[];
    assert.equal(
      initialDispatches.length,
      1,
      "the path rule replaces the default seat rather than opening a second review gate",
    );
    assert.equal(initialDispatches[0]?.agentId, "path-reviewer");
    const retry = await cli(["task", "submit", taskId, "--execution-id", executionId]);
    t.diagnostic(`repeat ha task submit ${taskId}\n${retry.stdout}${retry.stderr}`);
    assert.equal(retry.status, 0, JSON.stringify(retry));
    const repeated = await cli(["task", "dispatches", taskId]);
    assert.equal(repeated.status, 0, JSON.stringify(repeated));
    assert.deepEqual(
      JSON.parse(repeated.stdout).dispatches.map(({ dispatchId }: { dispatchId: string }) => dispatchId),
      initialDispatches.map(({ dispatchId }) => dispatchId),
      "repeated submit preserves the seat's dispatch identity",
    );
  } finally {
    await transport.stop();
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
