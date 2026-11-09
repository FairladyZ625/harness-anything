// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { createRealizedTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { localAuthFixture } from "./fleet-tls-session.fixture.ts";
import { registerFixtureRuntimeInstance } from "./repo-settings.fixture.ts";
import { rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import type { DaemonHost } from "../src/daemon-host.ts";

// A doc-show that carries an execution credential opts into the forwarding port, but only a
// remote-edge repository has a forwarding target. Local and remote-center cells must serve the
// read themselves instead of rejecting the opt-in as a mode admission failure.
test(
  "doc-show with an execution credential reads local and remote-center repositories",
  { timeout: 120_000 },
  async (t) => {
    const probeRoot = mkdtempSync(path.join(tmpdir(), "ha-forwarding-probe-"));
    t.after(() => rmSync(probeRoot, { recursive: true, force: true }));
    const executablePath = writeProviderExecutable(
      path.join(probeRoot, "codex-probe.mjs"),
      `import fs from "node:fs";
if (process.argv[2] === "login" && process.argv[3] === "status") process.exit(0);
fs.readFileSync(0, "utf8");
console.log(JSON.stringify({ type: "thread.started", thread_id: "probe" }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));`,
    );
    const installation = {
      installationId: "forwarding-codex",
      kindId: "codex" as const,
      executablePath,
      version: "1.0.0",
      observedAt: "2026-11-01T00:00:00.000Z",
    };
    const credentials = new Map<string, string>();
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, false, {
      runtimeDiscover: async () => [installation],
      runtimeLaunch: (prepared) => {
        const repoId = String(prepared.env.HARNESS_DAEMON_REPO_ID),
          credential = prepared.env.HARNESS_EXECUTION_CREDENTIAL;
        if (credential) credentials.set(repoId, credential);
        return {
          pid: process.pid,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: () => undefined,
        };
      },
    });
    const adminScopes = effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin");
    f.owners.keycloak.permit("lease-owner", "forward-center", adminScopes);
    f.owners.keycloak.permit("person-center", "forward-center", adminScopes);
    const centerRoot = path.join(f.root, "center-repo");
    rosterRepo(centerRoot, "forward-center");
    const registered = await f.host.admin(
      { kind: "register", rootDir: centerRoot, repoId: "forward-center", mode: "remote-center" },
      localAuthFixture(),
    );
    assert.equal(registered.outcome, "applied", JSON.stringify(registered));
    const centerAuth = f.owners.auth({ nodeId: "center-node" });

    const readPlan = async (
      repoId: string,
      rootDir: string,
      writeAuth: Parameters<DaemonHost["run"]>[2],
      executionAuth: Parameters<DaemonHost["run"]>[2],
    ) => {
      const bootstrap = await f.host.run(
        repoId,
        { kind: "settings-update", locale: "en-US", idempotencyKey: `forwarding-settings-${repoId}` },
        writeAuth,
      );
      assert.ok(["applied", "no_changes"].includes(bootstrap.outcome), JSON.stringify(bootstrap));
      const runtimeInstanceId = `forwarding-codex-${repoId}`;
      await registerFixtureRuntimeInstance(f.host, repoId, localAuthFixture(), {
        instanceId: runtimeInstanceId,
        name: "Forwarding read Codex",
        kindId: "codex",
        installationId: installation.installationId,
        providerId: "openai",
        models: ["gpt-5.6-sol"],
        authMode: "subscription",
      });
      const taskId = `task-read-${repoId}`,
        created = await createRealizedTaskPlanFixture(
          rootDir,
          () => f.host.run(repoId, { kind: "task-create", taskId, title: "Forwarding read" }, writeAuth),
          (planPath) => f.host.run(repoId, { kind: "doc-submit", paths: [planPath] }, writeAuth),
          "Forwarding read",
        ),
        started = await f.host.run(
          repoId,
          { kind: "task-start", taskId, executionId: `execution-read-${repoId}` },
          executionAuth,
        ),
        spawned = await f.host.spawnRuntime(
          repoId,
          {
            runtimeInstanceId,
            cwd: { scope: "repo-root" },
            taskId,
            prompt: "Show the task plan.",
            dispatchKey: `dispatch-read-${repoId}`,
          },
          executionAuth,
        );
      assert.equal(started.outcome, "applied", JSON.stringify(started));
      assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
      assert.equal(credentials.size > 0, true, "the spawn must deliver an execution credential");
      const shown = await f.host.run(
        repoId,
        { kind: "doc-show", path: `${String(created.packagePath)}/task_plan.md` },
        { ...executionAuth, executionCredential: credentials.get(repoId) },
      );
      assert.equal(shown.outcome, "applied", `${repoId}: ${JSON.stringify(shown)}`);
      assert.match(String(shown.evidence), /Forwarding read/u);
    };

    await readPlan("lease-repo", f.repo, localAuthFixture(), localAuthFixture());
    await readPlan("forward-center", centerRoot, localAuthFixture(), centerAuth);
  },
);
