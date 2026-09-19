/** Shared fixture for completion-review dispatch tests: repo cell, fake reviewer providers,
 * settlement drivers, and outcome polling. `failProvider` true fails every launch; a number
 * fails only that many first launches, then hangs. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  makeTaskEventReader,
  openSqliteEventStore,
  ownedContentForDeclarationEvent,
  requireEntityStoreKindContract,
  sha256Text,
  type AgentDefinitionSnapshot,
  type EntityUpsertEventV1,
} from "../../kernel/src/index.ts";
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
// Settings writes are principal-gated: the executor actor above owns the task lifecycle while this
// binding stands in for the dispatching principal applying repository-level settings changes.
export const principal = withRoleBinding(
  {
    actor: { principal: owner.actor.principal, executor: null },
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
  reviewReturnBudget?: number,
  options: {
    readonly autoSubmit?: boolean;
    /** False stops after submit: the cut awaits the owner's triage. */
    readonly autoForward?: boolean;
    readonly closeoutProfile?: "standard" | "strict";
    readonly create?: Readonly<Record<string, unknown>>;
    /** Migration-window fixture: install the default reviewer in the pre-runtimes declaration
     * shape (`runtime_type` string plus top-level `model`) before the cell opens, appended as a
     * raw canonical command exactly the way the old daemon wrote it (current write paths refuse
     * that shape by design). The cell must open over it and the review gate must stop with the
     * reinstall command instead of leaking the schema error. */
    readonly legacyReviewer?: boolean;
  } = {},
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
      `  closeout:\n    profile: ${options.closeoutProfile ?? "strict"}\n`,
  );
  if (options.legacyReviewer) appendLegacyReviewerDeclaration(repoId, canonicalRoot(root));
  let cell = await open();
  const run = (action: Parameters<typeof cell.run>[0]) => cell.run(action, owner);
  const created = await run({
    kind: "task-create",
    taskId,
    title: "Completion Review",
    presetId: artifactDelivery || hybridDelivery ? "standard-task" : "docs-task",
    ...(reviewReturnBudget === undefined ? {} : { reviewReturnBudget }),
    ...options.create,
  });
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
    // The hybrid delivery commits repo Git directly, so the cell must finish publishing the cuts of
    // the writes above first; otherwise the two HEAD writers race and git dies with
    // `cannot lock ref 'HEAD'`.
    await cell.settlePendingMaterialization("hybrid fixture delivery");
    writeFileSync(path.join(root, "README.md"), "# Reviewed hybrid delivery\n");
    git(root, "add", "README.md");
    git(root, "commit", "-qm", "docs: update hybrid fixture delivery");
    delivery = git(root, "rev-parse", "HEAD");
    const report = `${packagePath}/artifacts/hybrid.md`;
    mkdirSync(path.dirname(path.join(root, "harness", report)), { recursive: true });
    writeFileSync(path.join(root, "harness", report), "Frozen hybrid evidence.\n");
    const accepted = await run({ kind: "doc-submit", taskId });
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    delivery = `${delivery} artifact:${report}@${accepted.revision}`;
  }
  const submit = async () => {
    writeFileSync(
      path.join(root, "harness", packagePath, "closeout.md"),
      `# Closeout\n\n## Summary\n\nReviewed delivery ${delivery}\n\n## Verification\n\nREADME bytes checked.\n\n` +
        "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nReview dispatch retry.\n",
    );
    const receipt = await run({ kind: "task-submit", taskId, executionId });
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    return receipt;
  };
  // The owner's forward order opens the review gate and dispatches the independent reviewer
  // (owner adjudication 2026-09-19); submit alone leaves the cut awaiting triage.
  const forward = async (reason = "Owner forwards the cut for independent review.") =>
    run({ kind: "task-adjudicate", taskId, executionId, forward: true, reason });
  const returnCut = async (reason: string, reviewId?: string) =>
    run({
      kind: "task-adjudicate",
      taskId,
      executionId,
      return: true,
      reason,
      ...(reviewId === undefined ? {} : { reviewId }),
    });
  const consent = (reviewId: string) => run({ kind: "task-review-consent", taskId, executionId, reviewId });
  if (options.autoSubmit !== false) {
    await submit();
    if (options.autoForward !== false) assert.equal((await forward()).outcome, "applied");
  }
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
    enableInstances: () => {
      instancesAvailable = true;
    },
    run,
    runPrincipal: (action: Parameters<typeof cell.run>[0]) => cell.run(action, principal),
    events,
    cell: () => cell,
    submit,
    forward,
    returnCut,
    consent,
    complete: () => run({ kind: "task-complete", taskId, executionId }),
    install: async () => {
      const installed = await run({
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "closeout-reviewer",
          name: "Independent reviewer",
          instructions: "Inspect submitted bytes and record your independent verdict.",
          runtimes: [{ type: "codex", model: "review-model" }],
          instance: "review-first",
          role: "worker",
          fallback: { providerPriority: ["review-first", "review-second"], backoff: { baseMs: 1, maxMs: 2 } },
        },
      });
      assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    },
    reopen: async () => {
      await cell.close();
      cell = await open();
    },
    createPlannedTask: async (extraTaskId: string) => {
      const created = await run({
        kind: "task-create",
        taskId: extraTaskId,
        title: `Completion Review ${extraTaskId}`,
        presetId: "docs-task",
      });
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await waitForFixturePublication(cell, created.opId, owner);
      return String((created as Record<string, unknown>).packagePath);
    },
    submitExtraTask: async (extraTaskId: string, extraExecutionId: string) => {
      const created = await run({
        kind: "task-create",
        taskId: extraTaskId,
        title: `Completion Review ${extraTaskId}`,
        presetId: "docs-task",
      });
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await waitForFixturePublication(cell, created.opId, owner);
      const extraPackage = String((created as Record<string, unknown>).packagePath);
      await realizeTaskPlanFixture(root, extraPackage, (planPath) => run({ kind: "doc-submit", paths: [planPath] }));
      assert.equal(
        (await run({ kind: "task-start", taskId: extraTaskId, executionId: extraExecutionId })).outcome,
        "applied",
      );
      assert.equal(
        (
          await run({
            kind: "fact-record",
            taskId: extraTaskId,
            statement: "README contains the reviewed delivery.",
            evidenceSource: "README.md",
            confidence: "high",
            memoryClass: "episodic",
            memoryTags: [],
          })
        ).outcome,
        "applied",
      );
      writeFileSync(
        path.join(root, "harness", extraPackage, "closeout.md"),
        `# Closeout\n\n## Summary\n\nReviewed delivery ${git(root, "rev-parse", "HEAD")}\n\n## Verification\n\nREADME bytes checked.\n\n` +
          "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nReview dispatch retry.\n",
      );
      assert.equal(
        (await run({ kind: "task-submit", taskId: extraTaskId, executionId: extraExecutionId })).outcome,
        "applied",
      );
      return extraPackage;
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

/** The pre-runtimes reviewer declaration (`runtime_type` + top-level `model`), appended to the
 * ledger as one raw entity_upserted command under the same writer holder the fixture fence
 * acquires ("direct-store"), so the cell's later writes keep the same single-writer lineage. */
function appendLegacyReviewerDeclaration(repoId: string, rootDir: string): void {
  const contract = requireEntityStoreKindContract("agent"),
    value = {
      schema: "agent-declaration/v1",
      id: "closeout-reviewer",
      name: "Independent reviewer",
      instructions: "Inspect submitted bytes and record your independent verdict.",
      runtime_type: "codex",
      model: "review-model",
    },
    body = `${JSON.stringify(value, null, 2)}\n`,
    claim = {
      path: "agents/closeout-reviewer.json",
      sha256: sha256Text(body),
      size: Buffer.byteLength(body),
      mediaType: contract.entityStore.document.mediaType,
      policyId: contract.entityStore.document.policyId,
    },
    // No ownedContent field: ownedContentForDeclarationEvent recovers the accepted pre-manifest
    // shape (exactly one declaration document) from the claim, same as the kernel window fixture.
    seed: EntityUpsertEventV1 = {
      schema: "entity-event/v1",
      eventId: "event-legacy-closeout-reviewer",
      workspaceRevision: 1,
      opId: "op-legacy-closeout-reviewer",
      actor: { principal: { personId: "person_synthetic" }, executor: null },
      source: "local",
      occurredAt: "2026-09-18T00:00:00.000Z",
      type: "entity_upserted",
      payload: { entityKind: "agent", entityId: "closeout-reviewer", declarationDocumentClaim: claim },
    },
    event = { ...seed, payload: { ...seed.payload, ownedContent: ownedContentForDeclarationEvent(seed) } },
    fence = { repoId, holder: "direct-store", epoch: 1 } as const,
    writer = openSqliteEventStore({ repoId, rootInput: rootDir });
  try {
    writer.claimWriter(fence);
    writer.appendCommand({
      fence,
      intent: {
        opId: seed.opId,
        intentDigest: `sha256:${"a".repeat(64)}`,
        summary: seed.type,
      },
      events: [event],
      blobs: [{ sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body }],
    });
  } finally {
    writer.close();
  }
}
