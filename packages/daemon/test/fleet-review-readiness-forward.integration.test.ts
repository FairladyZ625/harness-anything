// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createIdentitySession } from "../src/authorization-provider.ts";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { forward } from "../src/fleet/forwarding-port.ts";
import { forwardingIntentForAction } from "../src/fleet/forwarding-intent.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";
import { git } from "./fleet-runtime-recovery.fixtures.ts";
import { registerBootstrappedDaemonRepo, registerFixtureRuntimeInstance } from "./repo-settings.fixture.ts";
import { definition } from "./schedule-actions.fixtures.ts";
import { catchUpReplica, startResidentReplicaSync } from "./replica-catch-up.fixture.ts";

test(
  "forward returns Git-behind diagnostics for accepted submit and manual review receipts",
  { timeout: 120_000 },
  async (t) => {
    const installation = {
      installationId: definition.installationId,
      kindId: definition.kindId,
      executablePath: "/usr/bin/true",
      version: "1.0.0",
      observedAt: "2026-11-07T00:00:00.000Z",
    };
    let origin = "";
    const f = await fleetNodeClaimFixture(
        t,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        {
          runtimeDiscover: () => [installation],
        },
        async (repo) => {
          origin = path.join(path.dirname(repo), "origin.git");
          git(repo, "branch", "-M", "main");
          git(repo, "init", "--bare", "-q", "--initial-branch=main", origin);
          git(repo, "remote", "add", "origin", origin);
          git(repo, "push", "-qu", "origin", "main");
          git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
        },
      ),
      repoId = "lease-repo",
      taskId = "task-forward-review-readiness",
      executionId = "execution-forward-review-readiness";
    await registerFixtureRuntimeInstance(f.host, repoId, localAuthFixture(), {
      instanceId: definition.instanceId,
      name: "Forward review runtime",
      kindId: definition.kindId,
      installationId: definition.installationId,
      providerId: definition.providerId,
      models: [definition.model],
      authMode: definition.authMode,
    });
    const installed = await f.host.run(
      repoId,
      {
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "closeout-reviewer",
          name: "Forward reviewer",
          instructions: "Review the forwarded cut.",
          role: "reviewer",
          runtimes: [{ type: "codex", model: definition.model }],
          instance: definition.instanceId,
        },
      },
      localAuthFixture(),
    );
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    const created = await f.command("node-one", {
      kind: "task-create",
      taskId,
      title: "Forward review readiness",
      presetId: "docs-task",
    });
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const packagePath = String(
      (created.receipt as Record<string, unknown> | undefined)?.packagePath ?? created.packagePath,
    );
    // Readiness is independent of carrying edited documents: accept the closeout on the center first.
    mkdirSync(path.join(f.repo, "harness", packagePath), { recursive: true });
    writeFileSync(
      path.join(f.repo, "harness", packagePath, "closeout.md"),
      "## Summary\nForwarded delivery.\n## Verification\nReal Git readiness.\n## Residual Risk\nNone.\n## Same Mechanism Elsewhere\nFleet receipts.\n",
    );
    f.owners.signIn(f.userRoot, "node-one");
    const documents = await f.host.run(
      repoId,
      { kind: "doc-submit", paths: [`${packagePath}/closeout.md`] },
      localAuthFixture(),
    );
    assert.equal(documents.outcome, "applied", JSON.stringify(documents));
    assert.equal((await f.command("node-one", { kind: "task-start", taskId, executionId })).outcome, "applied");
    // Open the edge host without attaching this repo, so it cannot auto-dispatch.
    // A standalone replica below supplies normal write visibility for forward().
    const edge = await fleetEdgeHostFixture(t, f, {
      name: "forward-readiness",
      registerBeforeOpen: false,
      beforeOpen: (root) => {
        git(root, "remote", "add", "origin", origin);
        git(root, "fetch", "-q", "origin");
        git(root, "checkout", "-B", "main", "origin/main");
        git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      },
    });
    await catchUpReplica({ ...f.peer("node-one"), viewRoot: edge.viewRoot, diskQuotaBytes: 64 * 1024 * 1024 });
    assert.equal(applyFleetMirrorCut(edge.viewRoot, repoId, edge.edgeRoot, "pull").outcome, "applied");
    const sync = startResidentReplicaSync({
      ...f.peer("node-one"),
      viewRoot: edge.viewRoot,
      diskQuotaBytes: 64 * 1024 * 1024,
    });
    t.after(() => sync.close());
    registerBootstrappedDaemonRepo({
      repoId,
      canonicalRoot: edge.edgeRoot,
      userRoot: edge.edgeUser,
      mode: "remote-edge",
      createConvenienceLinks: false,
    });
    git(f.repo, "commit", "--allow-empty", "-qm", "advance center main");
    git(f.repo, "push", "-q", "origin", "main");
    const oidc = createIdentitySession(edge.edgeUser, { fetch: f.owners.keycloak.fetch });
    for (const action of [
      { kind: "task-submit", taskId, executionId },
      { kind: "task-dispatch-review", taskIds: [taskId] },
    ]) {
      const receipt = await forward({
        userRoot: edge.edgeUser,
        repoId,
        intent: forwardingIntentForAction("repo.task.run", action),
        auth: localAuthFixture(),
        oidc,
        runRuntime: async () => {
          throw new Error("review readiness must not launch a runtime");
        },
      });
      assert.ok(receipt);
      assert.ok(["applied", "pending", "no_changes"].includes(String(receipt.outcome)), JSON.stringify(receipt));
      const failures = receipt.reviewDispatchFailures as {
        code: string;
        message: string;
        executionId: string;
        dispatchKey: string;
      }[];
      assert.equal(failures?.length, 1, JSON.stringify(receipt));
      assert.equal(failures[0]!.executionId, executionId);
      assert.equal(failures[0]!.code, "edge_default_branch_behind");
      assert.match(failures[0]!.message, /Node node-one:.*behind the center main by [1-9][0-9]* commits?/u);
      assert.match(failures[0]!.message, /merge --ff-only origin\/main/u);
      assert.match(String(receipt.warnings), /edge_default_branch_behind.*merge --ff-only origin\/main/u);
      assert.match(String(receipt.summary), /edge_default_branch_behind/u);
      const shown = await f.host.run(repoId, { kind: "task-show", taskId }, localAuthFixture()),
        snapshot = JSON.parse(String(shown.evidence));
      assert.deepEqual(
        snapshot.task.reviewDispatchFailure,
        failures[0],
        "forward must publish its diagnostic on the center",
      );
    }
    const agenda = await f.host.read(repoId, "repo.agenda.read", { limit: 50 }, f.owners.auth({ nodeId: "node-one" }));
    assert.match(JSON.stringify(agenda), /edge_default_branch_behind.*merge --ff-only origin\/main/u);
  },
);
