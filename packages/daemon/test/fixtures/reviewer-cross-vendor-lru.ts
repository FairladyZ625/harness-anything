import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTaskEventReader } from "@harness-anything/storage";
import { type AgentDefinitionSnapshot, type AgentRuntimeEventV1 } from "@harness-anything/kernel";
import { realizeTaskPlanFixture } from "../../../../tools/fixtures/task-plan.mjs";
import type { RuntimeInstanceSummary } from "../../src/daemon-host/agent-runtime-instances.ts";
import { appendRuntimeWorkerRecord } from "../../src/daemon-host/dispatch-stream.ts";
import { canonicalRoot, workspaceId } from "../../src/daemon-host/protocol/daemon-protocol.contract.ts";
import type { RuntimeProcess } from "../../src/daemon-host/runtime-spawn-types.ts";
import {
  grantTestPolicyGroups,
  policyTestRealm,
  revokeTestPolicyActions,
  withPolicyGroup,
} from "../keycloak-policy.fixtures.ts";
import { acceptedWorkDecision, openBootstrappedRepoCell, waitForFixturePublication } from "../repo-settings.fixture.ts";
import { fixtureRuntimeProcess } from "./runtime-process.ts";
import { removeTempRepository } from "../../../../tools/fixtures/remove-temp-repository.ts";

const REWORK_REVIEWER_PERSON = "cross-vendor-rework-reviewer";

export const multiVendorReviewerOwner = withPolicyGroup(
  withPolicyGroup(
    {
      actor: { principal: { personId: "cross-vendor-owner" }, executor: { kind: "agent" as const, id: "implementer" } },
      source: "local" as const,
    },
    "contributor",
  ),
  "maintainer",
);

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeInstance(
  instanceId: string,
  kindId: "agy" | "deepseek-harness" | "codex",
  providerId: string,
  model: string,
  enabled: boolean,
): RuntimeInstanceSummary {
  return {
    schemaVersion: 2,
    instanceId,
    name: instanceId,
    kindId,
    installationId: `inst-${kindId}`,
    providerId,
    models: [model],
    defaultModel: model,
    enabled,
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

export async function createMultiVendorHarness() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-reviewer-cross-vendor-")),
    repoId = workspaceId("cross-vendor-lru"),
    owner = multiVendorReviewerOwner,
    runtimeStops: Array<() => unknown> = [],
    launches: {
      readonly role: string;
      readonly instanceId: string;
      readonly kindId: string;
      readonly model: string;
      readonly args: readonly string[];
      readonly prompt: string;
    }[] = [],
    pendingProviders: {
      readonly kindId: string;
      readonly args: readonly string[];
      output?: (chunk: string) => void;
      exit?: (code: number | null) => void;
    }[] = [];

  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Cross Vendor Test");
  git(root, "config", "user.email", "cross-vendor@example.invalid");
  git(root, "commit", "--allow-empty", "-qm", "test: base");
  git(root, "update-ref", "refs/remotes/origin/main", git(root, "rev-parse", "HEAD"));
  writeFileSync(path.join(root, "README.md"), "# Cross-vendor delivery\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "docs: base delivery");

  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(
    path.join(root, "harness", "harness.yaml"),
    [
      "schema: harness-anything/v1",
      "layout:",
      "  authoredRoot: harness",
      "  localRoot: .harness",
      "settings:",
      "  defaultVertical: software/coding",
      "  defaultPreset: docs-task",
      "  defaultProfile: baseline",
      "  closeout:",
      "    profile: strict",
    ].join("\n"),
  );

  const instanceState = {
    "agy-1": true,
    "deepseek-1": true,
    "codex-1": true,
  };
  let failNextResume = false;
  let resumeSessionSeq = 0;

  const cell = await openBootstrappedRepoCell({
    repoId,
    rootDir: canonicalRoot(root),
    ownerId: "cross-vendor-owner",
    runtimeDaemonRoute: {
      userRoot: path.join(root, "user"),
      daemonId: "fixture",
      endpoint: path.join(root, "user.sock"),
    },
    reclaimRuntimeTempDirectory: (instanceId, runtimeSessionId) => {
      removeTempRepository(path.join(root, "user", "runtime-instances", instanceId, "tmp", runtimeSessionId));
      return null;
    },
    runtimeInstances: () => [
      makeInstance("agy-1", "agy", "google", "gemini-3.1-pro-high", instanceState["agy-1"]),
      makeInstance("deepseek-1", "deepseek-harness", "deepseek", "deepseek-v4.1-flash", instanceState["deepseek-1"]),
      makeInstance("codex-1", "codex", "openai", "gpt-5.4", instanceState["codex-1"]),
    ],
    prepareRuntimeLaunch: (instanceId, request) => {
      const config =
        instanceId === "agy-1"
          ? { kindId: "agy", providerId: "google", defaultModel: "gemini-3.1-pro-high" }
          : instanceId === "deepseek-1"
            ? { kindId: "deepseek-harness", providerId: "deepseek", defaultModel: "deepseek-v4.1-flash" }
            : { kindId: "codex", providerId: "openai", defaultModel: "gpt-5.4" };
      return {
        definition: {
          schema: "agent-definition-snapshot/v1",
          configVersion: 1,
          instanceId,
          installationId: `inst-${config.kindId}`,
          kindId: config.kindId,
          providerId: config.providerId,
          model: request.model ?? config.defaultModel,
          reasoningEffort: null,
          fast: false,
          endpointKind: "official",
          baseUrlHash: null,
          authMode: "subscription",
        } satisfies AgentDefinitionSnapshot,
        installation: {
          installationId: `inst-${config.kindId}`,
          kindId: config.kindId as "agy" | "deepseek-harness" | "codex",
          executablePath: `/fixture/${config.kindId}`,
          version: "1.0.0",
          observedAt: "2026-11-15T00:00:00.000Z",
        },
        executablePath: `/fixture/${config.kindId}`,
        args: request.providerSessionId ? ["resume", request.providerSessionId] : ["exec"],
        env: {},
        cwd: request.cwd,
        prompt: request.prompt,
      };
    },
    runtimeLaunch: (prepared, persistence): RuntimeProcess => {
      launches.push({
        role: prepared.args[0] ?? "exec",
        instanceId: prepared.definition.instanceId,
        kindId: prepared.definition.kindId,
        model: prepared.definition.model,
        args: prepared.args,
        prompt: prepared.prompt,
      });
      const runtime = fixtureRuntimeProcess(
        {
          after: (stop) => {
            runtimeStops.push(stop);
          },
        },
        persistence,
      );
      appendRuntimeWorkerRecord(persistence.rootDir, persistence.dispatchId, {
        kind: "process_started",
        occurredAt: new Date().toISOString(),
        pid: runtime.pid,
      });
      const pending: (typeof pendingProviders)[number] = {
        kindId: prepared.definition.kindId,
        args: prepared.args,
      };
      pendingProviders.push(pending);
      return {
        pid: runtime.pid,
        onOutput: (listener) => {
          pending.output = listener;
        },
        onErrorOutput: () => undefined,
        terminate: runtime.terminate,
        terminateTree: runtime.terminateTree,
        onExit: (listener) => {
          pending.exit = (code) => {
            pending.exit = undefined;
            listener(code);
          };
        },
      };
    },
  });

  let eventsReader: ReturnType<typeof makeTaskEventReader> | null = null;
  const events = () =>
    (eventsReader ??= makeTaskEventReader({ repoId, rootDir: root })).read().events as readonly AgentRuntimeEventV1[];
  const awaitOutcome = async (runtimeSessionId: string) => {
    await cell.awaitRuntimeOutcome(runtimeSessionId);
    await cell.settlePendingMaterialization("runtime settlement assertion");
    const outcome = events().find(
      (event) =>
        event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
    );
    assert.ok(outcome?.type === "runtime_session_outcome_observed");
    return outcome;
  };
  const settleLast = async (
    runtimeSessionId: string,
    options: { readonly bindSession?: boolean; readonly outcome?: "succeeded" | "failed" } = {},
  ) => {
    const pending = pendingProviders.at(-1)!;
    const sid = `provider-session-${++resumeSessionSeq}`;
    if (pending.kindId === "codex") {
      if (options.bindSession) {
        pending.output?.(
          `${JSON.stringify({ type: "thread.started", thread_id: failNextResume && pending.args[0] === "resume" ? "bad-resume-id" : sid })}\n`,
        );
      }
      if (options.outcome === "failed") {
        pending.output?.(`${JSON.stringify({ type: "turn.failed", error: { message: "failed" } })}\n`);
        pending.exit?.(1);
      } else {
        pending.output?.(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
        pending.exit?.(0);
      }
    } else if (pending.kindId === "agy") {
      const reportedSid = failNextResume && pending.args[0] === "resume" ? "bad-resume-id" : sid;
      if (options.bindSession) {
        pending.output?.(`${JSON.stringify({ event: "init", conversation_id: reportedSid })}\n`);
      }
      pending.output?.(
        `${JSON.stringify({
          event: "result",
          result: { status: options.outcome === "failed" ? "FAILED" : "SUCCESS", response: "ok" },
        })}\n`,
      );
      pending.exit?.(options.outcome === "failed" ? 1 : 0);
    } else {
      if (options.bindSession) {
        pending.output?.(`${JSON.stringify({ type: "acp.session", sessionId: sid })}\n`);
      }
      pending.output?.(
        `${JSON.stringify({
          type: "acp.result",
          ...(options.bindSession ? { sessionId: sid } : {}),
          stopReason: options.outcome === "failed" ? "error" : "end_turn",
          finalText: "ok",
        })}\n`,
      );
      pending.exit?.(options.outcome === "failed" ? 1 : 0);
    }
    return awaitOutcome(runtimeSessionId);
  };

  const installAgents = async () => {
    for (const declaration of [
      {
        schema: "agent-declaration/v1",
        id: "implementer",
        name: "Implementer",
        instructions: "Implement task",
        runtimes: [
          { type: "agy", model: "gemini-3.1-pro-high" },
          { type: "codex", model: "gpt-5.4" },
        ],
        role: "worker",
      },
      {
        schema: "agent-declaration/v1",
        id: "closeout-reviewer",
        name: "Closeout Reviewer",
        instructions: "Independently review submitted cut",
        selectionStrategy: "lru",
        runtimes: [
          { type: "agy", model: "gemini-3.1-pro-high" },
          { type: "deepseek-harness", model: "deepseek-v4.1-flash" },
          { type: "codex", model: "gpt-5.4" },
        ],
        role: "worker",
      },
    ]) {
      const res = await cell.run({ kind: "agent-install", declaration }, owner);
      assert.equal(res.outcome, "applied", JSON.stringify(res));
    }
  };

  const createAndImplementTask = async (
    taskId: string,
    executionId: string,
    implInstanceId: "agy-1" | "codex-1",
    implDispatchKey: string,
  ) => {
    const decisionRef = await acceptedWorkDecision(cell, owner, taskId);
    const created = await cell.run(
      { kind: "task-create", taskId, title: `Task ${taskId}`, presetId: "docs-task", decisionRef },
      owner,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, String((created as Record<string, unknown>).opId), owner);
    const packagePath = String((created as Record<string, unknown>).packagePath);
    await realizeTaskPlanFixture(root, packagePath, (planPath) =>
      cell.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, owner)).outcome, "applied");
    const spawnRes = await cell.spawnRuntime(
      {
        agentId: "implementer",
        runtimeInstanceId: implInstanceId,
        taskId,
        dispatchKey: implDispatchKey,
      },
      owner,
    );
    assert.equal(spawnRes.outcome, "applied", JSON.stringify(spawnRes));
    await settleLast(String((spawnRes as Record<string, unknown>).runtimeSessionId));
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, owner)).outcome, "applied");
    assert.equal(
      (
        await cell.run(
          {
            kind: "fact-record",
            taskId,
            statement: "README documents the change.",
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
    return { packagePath };
  };

  const recordReviewVerdict = async (
    taskId: string,
    packagePath: string,
    executionId: string,
    dispatchId: string,
    runtimeSessionId: string,
    verdict: "approved" | "changes_requested",
  ) => {
    grantTestPolicyGroups([REWORK_REVIEWER_PERSON], "admin");
    revokeTestPolicyActions(REWORK_REVIEWER_PERSON, repoId, ["runtime-spawn"]);
    const reportPath = `${packagePath}/artifacts/reports/${dispatchId}.md`,
      packetPath = `${packagePath}/artifacts/reports/review-${dispatchId}.json`;
    mkdirSync(path.dirname(path.join(root, "harness", reportPath)), { recursive: true });
    writeFileSync(
      path.join(root, "harness", reportPath),
      `# Review ${dispatchId}\n\n${verdict === "approved" ? "Approved." : "Rework requested."}\n`,
    );
    writeFileSync(
      path.join(root, "harness", packetPath),
      JSON.stringify({
        verdict,
        reason: verdict === "approved" ? "Looks good." : "Needs rework.",
        evidenceChecked: ["README.md"],
        findings: verdict === "changes_requested" ? [{ findingId: "F-1", blocking: true, text: "Please refine." }] : [],
        resolutions: [],
      }),
    );
    const res = await cell.run(
      {
        kind: "task-review-execution",
        taskId,
        executionId,
        reviewId: `review-${dispatchId}`,
        fromFile: path.join(root, "harness", ...packetPath.split("/")),
      },
      withPolicyGroup(
        {
          actor: {
            principal: { personId: REWORK_REVIEWER_PERSON },
            executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
          },
          source: "local" as const,
        },
        "admin",
      ),
    );
    assert.equal(res.outcome, "applied", JSON.stringify(res));
  };

  const submitCut = async (taskId: string, executionId: string) => {
    const shown = await cell.run({ kind: "task-show", taskId }, owner),
      snapshot = JSON.parse(String(shown.evidence)) as {
        readonly reviews: readonly {
          readonly reviewId: string;
          readonly findings?: readonly { readonly findingId: string; readonly blocking: boolean }[];
        }[];
        readonly reviewResponses?: readonly { readonly reviewId: string; readonly findingId: string }[];
      };
    const responded = new Set((snapshot.reviewResponses ?? []).map((r) => `${r.reviewId}:${r.findingId}`));
    for (const review of snapshot.reviews) {
      for (const finding of review.findings ?? []) {
        if (!finding.blocking || responded.has(`${review.reviewId}:${finding.findingId}`)) continue;
        const resp = await cell.run(
          {
            kind: "task-respond-review",
            taskId,
            executionId,
            jsonInput: JSON.stringify({
              responses: [
                {
                  reviewId: review.reviewId,
                  findingId: finding.findingId,
                  disposition: "adopt" as const,
                  rationale: `Addressed ${review.reviewId}/${finding.findingId}.`,
                },
              ],
            }),
          },
          owner,
        );
        assert.equal(resp.outcome, "applied", JSON.stringify(resp));
      }
    }
    const delivery = git(root, "rev-parse", "HEAD"),
      res = await cell.run(
        {
          kind: "task-submit",
          taskId,
          executionId,
          summary: "Ready for review",
          delivery,
          evidenceRefs: ["README.md"],
        },
        owner,
      );
    assert.equal(res.outcome, "applied", JSON.stringify(res));
    return res;
  };

  return {
    cell,
    launches,
    instanceState,
    setFailNextResume: (value: boolean) => {
      failNextResume = value;
    },
    events,
    installAgents,
    createAndImplementTask,
    submitCut,
    settleLast,
    recordReviewVerdict,
    close: async () => {
      for (const pending of pendingProviders) pending.exit?.(1);
      await cell.close();
      for (const stop of runtimeStops) await stop();
      for (const event of events()) {
        if (event.type === "runtime_dispatch_requested")
          policyTestRealm.keycloak.nodeClients.delete(`harness-execution-${event.payload.dispatchId}`);
      }
      await eventsReader?.drain();
      removeTempRepository(root);
    },
  };
}

/** Returns the most recent reviewer dispatch event recorded for a task in a multi-vendor test harness. */
export function latestReviewerDispatchFor(h: Awaited<ReturnType<typeof createMultiVendorHarness>>, id: string) {
  return h
    .events()
    .filter((e) => e.type === "runtime_dispatch_requested" && e.payload.taskId === id && e.payload.role === "reviewer")
    .at(-1)!;
}
