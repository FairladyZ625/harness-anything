/** Shared fixture for completion-review dispatch tests: repo cell, fake reviewer providers,
 * settlement drivers, and outcome polling. `failProvider` true fails every launch; a number
 * fails only that many first launches, then hangs. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTaskEventReader, type AgentDefinitionSnapshot } from "../../kernel/src/index.ts";
import type { RuntimeInstanceSummary } from "../src/agent-runtime-instances.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { appendRuntimeWorkerRecord } from "../src/dispatch-stream.ts";
import type { RuntimeProcess } from "../src/runtime-spawn-types.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

export const owner = withRoleBinding(
  {
    actor: { principal: { personId: "completion-owner" }, executor: { kind: "agent" as const, id: "implementer" } },
    source: "local" as const,
  },
  "repo-write",
);
export const taskId = "task-completion-review",
  executionId = "execution-completion-review";
const installation = {
  installationId: "installation-review",
  kindId: "codex" as const,
  executablePath: "/fixture/reviewer",
  version: "1.0.0",
  observedAt: "2026-09-12T00:00:00.000Z",
};
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
export async function fixture(
  failProvider: boolean | number = false,
  available = true,
  artifactDelivery = false,
  noInstances = false,
  hybridDelivery = false,
) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-completion-review-")),
    repoId = workspaceId("completion-review");
  git(root, "init", "-q");
  git(root, "config", "user.name", "Completion Review Test");
  git(root, "config", "user.email", "review@example.invalid");
  git(root, "commit", "--allow-empty", "-qm", "test: base");
  git(root, "update-ref", "refs/remotes/origin/main", git(root, "rev-parse", "HEAD"));
  writeFileSync(path.join(root, "README.md"), "# Reviewed delivery\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "docs: fixture delivery");
  const launches: { prompt: string; instanceId: string; model: string }[] = [];
  const pendingProviders: {
    output?: (chunk: string) => void;
    exit?: (code: number | null) => void;
  }[] = [];
  let instancesAvailable = available,
    remainingProviderFailures =
      typeof failProvider === "number" ? failProvider : failProvider ? Number.POSITIVE_INFINITY : 0;
  const open = () =>
    openRepoCell({
      repoId,
      rootDir: canonicalRoot(root),
      ownerId: "completion-review",
      runtimeDaemonRoute: {
        userRoot: path.join(root, "user"),
        daemonId: "fixture",
        endpoint: path.join(root, "user.sock"),
      },
      runtimeInstances: () =>
        noInstances
          ? []
          : [
              { ...instance("ambient-first"), models: ["flash-model"], defaultModel: "flash-model" },
              ...(instancesAvailable ? [instance("review-first"), instance("review-second")] : []),
            ],
      prepareRuntimeLaunch: (instanceId, request) => ({
        definition: {
          schema: "agent-definition-snapshot/v1",
          configVersion: 1,
          instanceId,
          installationId: installation.installationId,
          kindId: "codex",
          providerId: "openai",
          model: request.model ?? (instanceId === "ambient-first" ? "flash-model" : "review-model"),
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
      runtimeLaunch: (prepared, persistence): RuntimeProcess => {
        launches.push({
          prompt: prepared.prompt,
          instanceId: prepared.definition.instanceId,
          model: prepared.definition.model,
        });
        // The real launcher records its worker pid; without the record, post-restart adoption treats
        // a still-live reviewer as lost.
        appendRuntimeWorkerRecord(persistence.rootDir, persistence.dispatchId, {
          kind: "process_started",
          occurredAt: new Date().toISOString(),
          pid: process.pid,
        });
        const pending: (typeof pendingProviders)[number] = {};
        pendingProviders.push(pending);
        return {
          // The fake provider never exits, so it reports a genuinely live pid: after a reopen,
          // adoption must keep the session live instead of settling it lost.
          pid: process.pid,
          onOutput: (listener) => {
            pending.output = listener;
          },
          onErrorOutput: () => undefined,
          terminate: () => undefined,
          onExit: (listener) => {
            pending.exit = listener;
            if (remainingProviderFailures > 0) {
              remainingProviderFailures -= 1;
              setImmediate(() => {
                pending.output?.(
                  JSON.stringify({
                    type: "turn.failed",
                    error: { http_status: 429, code: "rate_limit", message: "HTTP 429 fixture capacity exhausted" },
                  }) + "\n",
                );
                pending.exit?.(1);
              });
            }
          },
        };
      },
    });
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(
    path.join(root, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n" +
      "settings:\n  defaultVertical: software/coding\n  defaultPreset: standard-task\n  defaultProfile: baseline\n" +
      "  closeout:\n    profile: strict\n",
  );
  let cell = await open();
  const run = (action: Parameters<typeof cell.run>[0]) => cell.run(action, owner);
  const created = await run({ kind: "task-create", taskId, title: "Completion Review", presetId: "docs-task" });
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  await waitForFixturePublication(cell, created.opId, owner);
  const packagePath = String((created as Record<string, unknown>).packagePath);
  await realizeTaskPlanFixture(root, packagePath, (planPath) => run({ kind: "doc-submit", paths: [planPath] }));
  assert.equal((await run({ kind: "task-start", taskId, executionId })).outcome, "applied");
  assert.equal(
    (
      await run({
        kind: "fact-record",
        taskId,
        statement: "README contains the reviewed delivery.",
        evidenceSource: "README.md",
        confidence: "high",
        memoryClass: "episodic",
        memoryTags: [],
      })
    ).outcome,
    "applied",
  );
  let delivery = git(root, "rev-parse", "HEAD");
  if (artifactDelivery) {
    const report = `${packagePath}/artifacts/delivery.md`;
    mkdirSync(path.dirname(path.join(root, "harness", report)), { recursive: true });
    writeFileSync(path.join(root, "harness", report), "Frozen artifact evidence.\n");
    const accepted = await run({ kind: "doc-submit", taskId });
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    delivery = `artifact:${report}@${accepted.revision}`;
  }
  if (hybridDelivery) {
    const report = `${packagePath}/artifacts/hybrid.md`;
    mkdirSync(path.dirname(path.join(root, "harness", report)), { recursive: true });
    writeFileSync(path.join(root, "harness", report), "Frozen hybrid evidence.\n");
    const accepted = await run({ kind: "doc-submit", taskId });
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    delivery = `${delivery} artifact:${report}@${accepted.revision}`;
  }
  writeFileSync(
    path.join(root, "harness", packagePath, "closeout.md"),
    `# Closeout\n\n## Summary\n\nReviewed delivery ${delivery}\n\n## Verification\n\nREADME bytes checked.\n\n` +
      "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nReview dispatch retry.\n",
  );
  assert.equal((await run({ kind: "task-submit", taskId, executionId })).outcome, "applied");
  const events = () => makeTaskEventReader({ repoId, rootDir: root }).read().events;
  const awaitOutcome = async (runtimeSessionId: string) => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const outcome = events().find(
        (event) =>
          event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
      );
      if (outcome?.type === "runtime_session_outcome_observed") return outcome.payload.outcome;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`runtime session ${runtimeSessionId} did not settle`);
  };
  return {
    root,
    packagePath,
    launches,
    disableInstances: () => {
      instancesAvailable = false;
    },
    run,
    events,
    cell: () => cell,
    complete: (consent = false) => run({ kind: "task-complete", taskId, executionId, ...(consent ? { consent } : {}) }),
    install: async () => {
      const installed = await run({
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "closeout-reviewer",
          name: "Independent reviewer",
          instructions: "Inspect submitted bytes and record your independent verdict.",
          runtime_type: "codex",
          instance: "review-first",
          role: "worker",
          model: "review-model",
          fallback: { providerPriority: ["review-first", "review-second"], backoff: { baseMs: 1, maxMs: 2 } },
        },
      });
      assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    },
    reopen: async () => {
      await cell.close();
      cell = await open();
    },
    review: async (runtimeSessionId: string, reviewId: string) => {
      // Controlled reviewer inspects the actual submitted file before entering the real RecordReview path.
      const submitted = events()
        .filter((event) => event.type === "execution_submitted")
        .at(-1);
      assert.ok(submitted?.type === "execution_submitted" && submitted.payload.execution.submission);
      const reviewedCommit = submitted.payload.execution.submission.commitSha;
      if (artifactDelivery) {
        assert.equal(reviewedCommit, null);
        assert.match(launches.at(-1)!.prompt, /Frozen artifact evidence/u);
      } else if (hybridDelivery) {
        assert.match(String(reviewedCommit), /^[0-9a-f]{40}$/u);
        assert.match(launches.at(-1)!.prompt, /Frozen hybrid evidence/u);
      } else assert.equal(git(root, "show", `${reviewedCommit}:README.md`), "# Reviewed delivery");
      assert.match(
        readFileSync(path.join(root, "harness", packagePath, "closeout.md"), "utf8"),
        /README bytes checked/u,
      );
      const packet = `${packagePath}/artifacts/reports/${reviewId}.json`;
      mkdirSync(path.dirname(path.join(root, "harness", packet)), { recursive: true });
      writeFileSync(
        path.join(root, "harness", packet),
        JSON.stringify({
          verdict: "approved",
          reason:
            artifactDelivery || hybridDelivery
              ? "Inspected center-accepted artifact contents and submitted closeout."
              : "Independently inspected committed README and submitted closeout.",
          evidenceChecked:
            artifactDelivery || hybridDelivery
              ? submitted.payload.execution.submission.artifacts!.map((anchor) => `${anchor.path}@${anchor.revision}`)
              : [`${reviewedCommit}:README.md`, "closeout.md"],
        }),
      );
      return cell.run(
        { kind: "task-review-execution", taskId, executionId, reviewId, fromFile: `harness/${packet}` },
        {
          actor: {
            principal: owner.actor.principal,
            executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` },
          },
          source: "local",
        },
      );
    },
    reviewDispatchedArtifacts: async (runtimeSessionId: string, dispatchId: string) => {
      const report = `${packagePath}/artifacts/reports/${dispatchId}.md`,
        packet = `${packagePath}/artifacts/reports/${dispatchId}.json`;
      mkdirSync(path.dirname(path.join(root, "harness", packet)), { recursive: true });
      writeFileSync(
        path.join(root, "harness", report),
        "# Closeout review\n\nApproved from the dispatched reviewer.\n",
      );
      writeFileSync(
        path.join(root, "harness", packet),
        JSON.stringify({
          verdict: "approved",
          reason: "Inspected the submitted execution and its declared evidence.",
          evidenceChecked: ["submitted execution", "task contract"],
        }),
      );
      return cell.run(
        {
          kind: "task-review-execution",
          taskId,
          executionId,
          reviewId: `review-${dispatchId}`,
          fromFile: `harness/${packet}`,
        },
        {
          actor: {
            principal: owner.actor.principal,
            executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` },
          },
          source: "local",
        },
      );
    },
    harnessStatus: () => git(root, "status", "--porcelain", "--", "harness"),
    reportPath: (dispatchId: string) =>
      path.join(root, "harness", packagePath, "artifacts", "reports", `${dispatchId}.md`),
    cancel: (runtimeSessionId: string) => cell.cancelRuntime({ runtimeSessionId }, owner),
    awaitOutcome,
    failPending: () => {
      const pending = pendingProviders.at(-1)!;
      pending.output?.(
        `${JSON.stringify({
          type: "turn.failed",
          error: { http_status: 429, code: "rate_limit", message: "HTTP 429 fixture capacity exhausted" },
        })}\n`,
      );
      pending.exit?.(1);
    },
    bindPending: () => {
      const pending = pendingProviders.at(-1)!;
      pending.output?.(`${JSON.stringify({ type: "thread.started", thread_id: "review-provider-session" })}\n`);
    },
    waitForLaunches: async (count: number) => {
      for (let attempt = 0; attempt < 500 && launches.length < count; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(launches.length >= count, true, `expected at least ${String(count)} reviewer launches`);
    },
    settleReview: async (
      dispatchId: string,
      runtimeSessionId: string,
      resultText: string,
      reportText: string | null = null,
    ) => {
      if (reportText !== null) {
        const report = path.join(root, "harness", packagePath, "artifacts", "reports", `${dispatchId}.md`);
        mkdirSync(path.dirname(report), { recursive: true });
        writeFileSync(report, reportText);
      }
      const pending = pendingProviders.at(-1)!;
      pending.output?.(`${JSON.stringify({ type: "thread.started", thread_id: "review-provider-session" })}\n`);
      pending.output?.(
        `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: resultText } })}\n`,
      );
      pending.output?.(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
      pending.exit?.(0);
      return awaitOutcome(runtimeSessionId);
    },
    close: async () => {
      await cell.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
