// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { localUserDaemonEndpoint } from "../src/daemon-host/client/local-daemon-target.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../src/daemon-host/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../src/daemon-host/transport/unix-socket.ts";
import { definition, installation, initIngressRepo, spawnCli } from "./fixtures/runtime-ingress.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { createMultiVendorHarness, latestReviewerDispatchFor } from "./fixtures/reviewer-cross-vendor-lru.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

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
  mkdirSync(path.join(root, "tools", "gates"), { recursive: true });
  for (const file of [
    "tools/task-risk-floor.mjs",
    "tools/task-risk-manifest.json",
    "tools/check-pr-governance.mjs",
    "tools/gate-manifest.json",
    "tools/gates/git.mjs",
    "packages/kernel/src/domain/protected-surface-governance.ts",
  ]) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.resolve(file), target);
  }
  git(root, "add", "tools");
  git(root, "commit", "-qm", "test: install repository risk assessor");
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
      riskTier: "low",
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
    mkdirSync(path.join(checkout, "packages", "app", "src"), { recursive: true });
    writeFileSync(path.join(checkout, "packages", "app", "src", "auth.ts"), "export const authChange = true;\n");
    git(checkout, "add", "src/delivery.ts");
    git(checkout, "add", "packages/app/src/auth.ts");
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
    const submittedReceipt = JSON.parse(submitted.stdout) as Record<string, unknown>,
      assessment = submittedReceipt.riskTierAssessment as Record<string, unknown>;
    assert.equal(submittedReceipt.outcome, "applied");
    assert.equal(assessment.declaredTier, "low");
    assert.equal(assessment.effectiveTier, "high");
    assert.ok(
      Array.isArray(assessment.reasons) &&
        assessment.reasons.some((reason) =>
          String(reason).includes("sensitive repository surface: packages/app/src/auth.ts"),
        ),
    );
    const humanSubmitted = await spawnCli(
      ["--root", checkout, "--repo", repoId, "task", "submit", taskId, "--execution-id", executionId],
      env,
    );
    assert.equal(humanSubmitted.status, 0, `${humanSubmitted.stdout}\n${humanSubmitted.stderr}`);
    assert.match(humanSubmitted.stdout, /risk tier raised: low -> high/u);
    assert.match(humanSubmitted.stdout, /sensitive repository surface: packages\/app\/src\/auth\.ts/u);
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
    removeTempRepository(parent);
  }
});

test(
  "first task review avoids impl vendor, rotates cross-row LRU, and falls back to same-vendor when exhausted",
  { timeout: 90_000 },
  async () => {
    const h = await createMultiVendorHarness();
    try {
      await h.installAgents();

      // Task 1: impl on agy-1 (google) -> avoids google -> picks deepseek-1 (row 1).
      const t1 = await h.createAndImplementTask("task-v1", "exe-v1-1", "agy-1", "impl-v1-1");
      await h.submitCut("task-v1", "exe-v1-1");
      const r1 = latestReviewerDispatchFor(h, "task-v1");
      assert.equal(r1.payload.instanceId, "deepseek-1");
      assert.equal(r1.payload.definitionSnapshot?.model, "deepseek-v4.1-flash");
      await h.recordReviewVerdict(
        "task-v1",
        t1.packagePath,
        "exe-v1-1",
        r1.payload.dispatchId,
        r1.payload.runtimeSessionId,
        "approved",
      );
      await h.settleLast(r1.payload.runtimeSessionId, { bindSession: true });

      // Task 2: impl on agy-1 (google) -> avoids google -> LRU rotates from deepseek-1 to codex-1.
      const t2 = await h.createAndImplementTask("task-v2", "exe-v2-1", "agy-1", "impl-v2-1");
      await h.submitCut("task-v2", "exe-v2-1");
      const r2 = latestReviewerDispatchFor(h, "task-v2");
      assert.equal(r2.payload.instanceId, "codex-1");
      assert.equal(r2.payload.definitionSnapshot?.model, "gpt-5.4");
      await h.recordReviewVerdict(
        "task-v2",
        t2.packagePath,
        "exe-v2-1",
        r2.payload.dispatchId,
        r2.payload.runtimeSessionId,
        "approved",
      );
      await h.settleLast(r2.payload.runtimeSessionId, { bindSession: true });

      // Task 3: impl on codex-1 (openai) -> avoids openai -> picks deepseek-1 (older recency than agy-1 from impl-v2-1).
      const t3 = await h.createAndImplementTask("task-v3", "exe-v3-1", "codex-1", "impl-v3-1");
      await h.submitCut("task-v3", "exe-v3-1");
      const r3 = latestReviewerDispatchFor(h, "task-v3");
      assert.equal(r3.payload.instanceId, "deepseek-1");
      assert.equal(r3.payload.definitionSnapshot?.model, "deepseek-v4.1-flash");
      await h.recordReviewVerdict(
        "task-v3",
        t3.packagePath,
        "exe-v3-1",
        r3.payload.dispatchId,
        r3.payload.runtimeSessionId,
        "approved",
      );
      await h.settleLast(r3.payload.runtimeSessionId, { bindSession: true });

      // All heterogeneous reviewers disabled -> Task 4 implemented on agy-1 falls back smoothly to same-vendor agy-1.
      h.instanceState["deepseek-1"] = false;
      h.instanceState["codex-1"] = false;
      const t5 = await h.createAndImplementTask("task-v5", "exe-v5-1", "agy-1", "impl-v5-1");
      await h.submitCut("task-v5", "exe-v5-1");
      const r5 = latestReviewerDispatchFor(h, "task-v5");
      assert.equal(r5.payload.instanceId, "agy-1");
      await h.recordReviewVerdict(
        "task-v5",
        t5.packagePath,
        "exe-v5-1",
        r5.payload.dispatchId,
        r5.payload.runtimeSessionId,
        "approved",
      );
      await h.settleLast(r5.payload.runtimeSessionId, { bindSession: true });
    } finally {
      await h.close();
    }
  },
);
