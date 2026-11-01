// harness-test-tier: integration
/** The product's own initializer, a repository with no installed Agent, and the default review seat.
 *  This is the contract shape `ha init` leaves behind: generated harness.yaml, no agent overrides,
 *  default preset/vertical/profile. The test opens that repository through the same bootstrap entry
 *  the CLI uses, creates a standard task with no explicit preset, submits it, and drives the
 *  bundled reviewer through a controlled runtime until its report is readable and bound to the cut. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/storage";
import type { AgentDefinitionSnapshot } from "@harness-anything/kernel";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RuntimeInstanceSummary } from "../src/agent-runtime-instances.ts";
import { resolveRepoBootstrap } from "../src/repo-bootstrap.ts";
import type { RuntimeProcess } from "../src/runtime-spawn-types.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openFencedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";

const auth = {
    transportKind: "unix-socket",
    unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0, source: "unix-socket-filesystem-owner-boundary" },
  } as unknown as DaemonAuthenticationContext,
  owner = withPolicyGroup(
    withPolicyGroup(
      {
        actor: {
          principal: { personId: "fresh-owner" },
          executor: { kind: "agent" as const, id: "fresh-implementer" },
        },
        source: "local" as const,
      },
      "admin",
    ),
    "maintainer",
  ),
  installation = {
    installationId: "installation-fresh-review",
    kindId: "codex" as const,
    executablePath: "/fixture/fresh-reviewer",
    version: "1.0.0",
    observedAt: "2026-09-12T00:00:00.000Z",
  },
  taskId = "task-fresh-default-review",
  executionId = "execution-fresh-default-review";

function instance(instanceId: string): RuntimeInstanceSummary {
  return {
    schemaVersion: 2,
    instanceId,
    name: instanceId,
    kindId: "codex",
    installationId: installation.installationId,
    providerId: "openai",
    models: ["review-model"],
    defaultModel: "review-model",
    enabled: true,
    permissionMode: "read-only",
    codex: {
      reasoningEffort: null,
      fast: false,
      baseUrl: null,
      baseUrlConfigured: false,
      wire_api: null,
      requires_openai_auth: null,
      http_headers: null,
    },
    authMode: "subscription",
    authState: "configured",
    authReadiness: { status: "ready", code: null, hint: null },
    isolationState: "enforced",
  };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function reviewerBinding(runtimeSessionId: string) {
  return withPolicyGroup(
    {
      actor: {
        principal: owner.actor.principal,
        executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
      },
      source: "local" as const,
    },
    "admin",
  );
}

test(
  "a repository initialized with product defaults dispatches the bundled reviewer and stores its report",
  { timeout: 30_000 },
  async () => {
    const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-fresh-default-review-"))),
      repoId = workspaceId("fresh-default-review"),
      launches: { prompt: string; dispatchId: string }[] = [];
    let cell: Awaited<ReturnType<typeof openFencedRepoCell>> | undefined;
    try {
      git(rootDir, "init", "-q", "-b", "main");
      git(rootDir, "config", "user.name", "Fresh Default Review Test");
      git(rootDir, "config", "user.email", "fresh@example.invalid");
      writeFileSync(path.join(rootDir, "README.md"), "# Fresh repository\n");
      git(rootDir, "add", "README.md");
      git(rootDir, "commit", "-qm", "base");
      cell = await openFencedRepoCell({
        repoId,
        rootDir: canonicalRoot(rootDir),
        ownerId: "fresh-default-review-test",
        runtimeDaemonRoute: {
          userRoot: path.join(rootDir, "user"),
          daemonId: "fresh-review",
          endpoint: path.join(rootDir, "fresh-review.sock"),
        },
        bootstrap: {
          ...resolveRepoBootstrap({ rootDir, repoId, personId: "fresh-owner", displayName: "Fresh Owner" }, auth),
          actor: owner.actor,
          keycloakAuthorization: owner.keycloakAuthorization,
        },
        runtimeInstances: () => [instance("fresh-review")],
        prepareRuntimeLaunch: (instanceId, request) => ({
          definition: {
            schema: "agent-definition-snapshot/v1",
            configVersion: 1,
            instanceId,
            installationId: installation.installationId,
            kindId: "codex",
            providerId: "openai",
            model: request.model ?? "review-model",
            reasoningEffort: null,
            fast: false,
            baseUrl: null,
            authMode: "subscription",
          } satisfies AgentDefinitionSnapshot,
          installation,
          executablePath: installation.executablePath,
          args: ["exec", "--json", "-"],
          env: {},
          cwd: request.cwd,
          prompt: request.prompt,
        }),
        runtimeLaunch: (prepared): RuntimeProcess => {
          launches.push({ prompt: prepared.prompt, dispatchId: "" });
          return {
            pid: process.pid,
            onOutput: () => undefined,
            onErrorOutput: () => undefined,
            onExit: () => undefined,
            terminate: () => undefined,
          };
        },
      });

      const config = readFileSync(path.join(rootDir, "harness", "harness.yaml"), "utf8");
      assert.match(config, /schema: harness-anything\/v1/u);
      assert.doesNotMatch(config, /^  roles:/mu, "init must leave the reviewer seat at the product default");
      const agents = (await cell.read("repo.agent.entities.list")) as { agents: readonly unknown[] };
      assert.deepEqual(agents.agents, [], "init must not install an Agent override");
      // The controlled runtime is infrastructure, not a reviewer override: enable the one stub
      // instance the fixture launches, exactly as an operator enables a runtime after init.
      const settings = (await cell.read("repo.settings.read")) as { revision: number },
        principal = withPolicyGroup(
          { actor: { principal: owner.actor.principal, executor: null }, source: "local" as const },
          "maintainer",
        ),
        allowed = await cell.run(
          {
            kind: "settings-update",
            runtimeAllowedInstances: ["fresh-review"],
            expectedVersion: settings.revision,
          },
          principal,
        );
      assert.equal(allowed.outcome, "applied", JSON.stringify(allowed));
      await waitForFixturePublication(cell, allowed.opId, principal);

      const created = await cell.run({ kind: "task-create", taskId, title: "Fresh default review" }, owner);
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await waitForFixturePublication(cell, created.opId, owner);
      const packagePath = String((created as { packagePath?: string }).packagePath);
      assert.ok(packagePath.length > 0);
      await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
        cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
      );
      assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, owner)).outcome, "applied");
      const checkout = path.join(rootDir, ".worktrees", taskId),
        delivery = (() => {
          writeFileSync(path.join(checkout, "README.md"), "# Fresh reviewed delivery\n");
          git(checkout, "add", "README.md");
          git(checkout, "commit", "-qm", "test: fresh delivery");
          return git(checkout, "rev-parse", "HEAD");
        })();
      assert.equal(
        (
          await cell.run(
            {
              kind: "fact-record",
              taskId,
              statement: "README contains the reviewed delivery.",
              evidenceSource: "README.md",
              confidence: "high",
              memoryClass: "episodic",
              memoryTags: [],
            },
            owner,
          )
        ).outcome,
        "applied",
      );
      writeFileSync(
        path.join(rootDir, "harness", packagePath, "closeout.md"),
        `# Closeout\n\n## Summary\n\nReviewed delivery ${delivery}\n\n## Verification\n\nREADME bytes checked.\n\n` +
          "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nFresh repository review dispatch.\n",
      );
      const submitted = await cell.run({ kind: "task-submit", taskId, executionId }, owner);
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      assert.equal(
        launches.length,
        1,
        `submit must dispatch the bundled default reviewer: ${JSON.stringify(submitted)}`,
      );
      assert.match(launches[0]!.prompt, /closeout-reviewer/u);

      const reader = makeTaskEventReader({ repoId, rootDir }),
        dispatch = reader
          .read()
          .events.filter((event) => event.type === "runtime_dispatch_requested" && event.payload.role === "reviewer")
          .at(-1);
      await reader.drain();
      assert.ok(dispatch?.type === "runtime_dispatch_requested");
      assert.equal(dispatch.payload.agentId, "closeout-reviewer");
      assert.equal(dispatch.payload.taskId, taskId);
      assert.equal(dispatch.payload.executionId, executionId);
      const dispatchId = String(dispatch.payload.dispatchId),
        runtimeSessionId = String(dispatch.payload.runtimeSessionId),
        report = `${packagePath}/artifacts/reports/${dispatchId}.md`,
        packet = `${packagePath}/artifacts/reports/${dispatchId}.json`;
      launches[0]!.dispatchId = dispatchId;
      assert.match(launches[0]!.prompt, new RegExp(report.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

      mkdirSync(path.dirname(path.join(rootDir, "harness", packet)), { recursive: true });
      writeFileSync(
        path.join(rootDir, "harness", report),
        "# Closeout review\n\nApproved from the bundled reviewer.\n",
      );
      writeFileSync(
        path.join(rootDir, "harness", packet),
        JSON.stringify({
          verdict: "approved",
          reason: "Inspected the submitted execution and its declared evidence.",
          evidenceChecked: ["submitted execution", "task contract"],
          findings: [],
          resolutions: [],
        }),
      );
      const reviewed = await cell.run(
        {
          kind: "task-review-execution",
          taskId,
          executionId,
          reviewId: `review-${dispatchId}`,
          fromFile: `harness/${packet}`,
        },
        reviewerBinding(runtimeSessionId),
      );
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      const shown = JSON.parse(String((await cell.run({ kind: "task-show", taskId }, owner)).evidence)) as {
          reviews: readonly { reviewId: string; verdict: string; executionId: string }[];
        },
        reportRead = await cell.run({ kind: "doc-show", path: report, raw: true }, owner);
      assert.equal(reportRead.outcome, "applied", JSON.stringify(reportRead));
      assert.equal(reportRead.evidence, "# Closeout review\n\nApproved from the bundled reviewer.\n");
      assert.equal(shown.reviews.length, 1);
      assert.equal(shown.reviews[0]!.reviewId, `review-${dispatchId}`);
      assert.equal(shown.reviews[0]!.verdict, "approved");
      assert.equal(shown.reviews[0]!.executionId, executionId, "the report is bound to the submitted cut");
    } finally {
      await cell?.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  },
);
