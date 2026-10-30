/** Shared fixture for completion-review dispatch tests: repo cell, fake reviewer providers,
 * settlement drivers, and outcome polling. `failProvider` true fails every launch; a number
 * fails only that many first launches, then hangs. */
import { readSubmissionArtifact } from "../src/submission-artifacts.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  makeTaskEventReader,
  openSqliteEventStore,
  requireEntityStoreKindContract,
  sha256Text,
  type AgentDefinitionSnapshot,
  type EntityUpsertEventV1,
  type EntityOwnedContentV1,
} from "@harness-anything/kernel";
import type { RuntimeInstanceSummary } from "../src/agent-runtime-instances.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { appendRuntimeWorkerRecord, readDispatchStream } from "../src/dispatch-stream.ts";
import type { RuntimeProcess } from "../src/runtime-spawn-types.ts";
import type { Snapshot } from "../src/repo-cell-types.ts";
import { waitForArrival } from "./event-arrival.ts";
import {
  acceptedWorkDecision,
  openBootstrappedRepoCell as openRepoCell,
  waitForFixturePublication,
} from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

// The fixture's owner writes and closes: closing a task is the maintainer tier's, so it holds both roles.
export const owner = withPolicyGroup(
  withPolicyGroup(
    {
      actor: { principal: { personId: "completion-owner" }, executor: { kind: "agent" as const, id: "implementer" } },
      source: "local" as const,
    },
    "contributor",
  ),
  "maintainer",
);
// Settings writes are principal-gated: the executor actor above owns the task lifecycle while this
// binding stands in for the dispatching principal applying repository-level settings changes.
export const principal = withPolicyGroup(
  withPolicyGroup(
    {
      actor: { principal: owner.actor.principal, executor: null },
      source: "local" as const,
    },
    "contributor",
  ),
  "maintainer",
);
export const taskId = "task-completion-review",
  executionId = "execution-completion-review";
export function reviewerExecutionBinding(runtimeSessionId: string, dispatchId: string) {
  return withPolicyGroup(
    {
      actor: {
        principal: owner.actor.principal,
        executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
      },
      source: "local" as const,
      executionPrincipal: {
        personId: owner.actor.principal.personId,
        repoId: "completion-review",
        dispatchId,
        runtimeSessionId,
        taskId,
        executionId,
        role: "reviewer" as const,
        source: "local" as const,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
    "admin",
  );
}
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

function boundWorktree(root: string): string {
  const entries = git(root, "worktree", "list", "--porcelain").split("\n\n");
  const pathLine = entries
    .map((entry) => entry.split("\n").find((line) => line.startsWith("worktree ")))
    .find((line) => line !== undefined && path.resolve(line.slice("worktree ".length)) !== path.resolve(root));
  assert.ok(pathLine, `expected a task worktree for ${root}`);
  return path.resolve(pathLine.slice("worktree ".length));
}
export async function fixture(
  failProvider: boolean | number = false,
  available = true,
  artifactDelivery = false,
  noInstances = false,
  hybridDelivery = false,
  options: {
    readonly autoSubmit?: boolean;
    readonly submitCommit?: boolean;
    readonly guiDelivery?: boolean;
    readonly providerRoundBackoffBaseSeconds?: number;
    readonly stallTimeoutMs?: number;
    /** Simulate a provider rejecting its first input before a turn can start. */
    readonly providerInputLimit?: number;
    readonly autoProviderSession?: boolean;
    readonly failProviderResume?: boolean;
    readonly closeoutProfile?: "standard" | "strict";
    readonly keycloakSession?: Parameters<typeof openRepoCell>[0]["keycloakSession"];
    readonly create?: Readonly<Record<string, unknown>>;
    /** Override reviewer catalog and declaration model spellings for runtime-resolution tests. */
    readonly catalogModel?: string;
    readonly agentModel?: string;
    /** Repository setup steps used to prove runtime admission precedes worktree preparation. */
    readonly worktreeSetup?: readonly string[];
    /** Migration-window fixture: install the default reviewer in the pre-runtimes declaration
     * shape (`runtime_type` string plus top-level `model`) before the cell opens, appended as a
     * raw canonical command exactly the way the old daemon wrote it (current write paths refuse
     * that shape by design). The cell must open over it and the review gate must stop with the
     * reinstall command instead of leaking the schema error. */
    readonly legacyReviewer?: boolean;
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-completion-review-")),
    repoId = workspaceId("completion-review"),
    catalogModel = options.catalogModel ?? "review-model",
    agentModel = options.agentModel ?? catalogModel;
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Completion Review Test");
  git(root, "config", "user.email", "review@example.invalid");
  git(root, "commit", "--allow-empty", "-qm", "test: base");
  git(root, "update-ref", "refs/remotes/origin/main", git(root, "rev-parse", "HEAD"));
  writeFileSync(path.join(root, "README.md"), "# Reviewed delivery\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "docs: fixture delivery");
  const launches: { prompt: string; instanceId: string; model: string; args: readonly string[]; cwd: string }[] = [],
    launchWaiters = new Set<() => void>();
  const pendingProviders: {
    output?: (chunk: string) => void;
    exit?: (code: number | null) => void;
  }[] = [];
  // A settled session exposes its outcome from the local dispatch stream one write before the
  // daemon publishes the canonical `runtime_session_outcome_observed` event. `awaitOutcome`
  // subscribes to the daemon's outcome callback before each ledger read, so a publish that lands
  // between the read and the wait cannot lose its only wake-up.
  const outcomeArrivals = new Map<string, Set<() => void>>(),
    noteOutcome = (runtimeSessionId: string) => {
      const waiters = outcomeArrivals.get(runtimeSessionId);
      if (!waiters) return;
      outcomeArrivals.delete(runtimeSessionId);
      for (const resolve of waiters) resolve();
    },
    subscribeOutcome = (runtimeSessionId: string, arrive: () => void) => {
      const waiters = outcomeArrivals.get(runtimeSessionId) ?? new Set<() => void>();
      waiters.add(arrive);
      outcomeArrivals.set(runtimeSessionId, waiters);
      return () => {
        waiters.delete(arrive);
        // Only drop the entry this subscription owns: a later wait may already have replaced it.
        if (waiters.size === 0 && outcomeArrivals.get(runtimeSessionId) === waiters)
          outcomeArrivals.delete(runtimeSessionId);
      };
    };
  let instancesAvailable = available,
    remainingProviderFailures =
      typeof failProvider === "number" ? failProvider : failProvider ? Number.POSITIVE_INFINITY : 0,
    failProviderResume = options.failProviderResume === true,
    providerSessionStarted = false;
  const open = () =>
    openRepoCell({
      repoId,
      rootDir: canonicalRoot(root),
      ownerId: "completion-review",
      ...(options.keycloakSession ? { keycloakSession: options.keycloakSession } : {}),
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
              ...(instancesAvailable
                ? ["review-first", "review-second"].map((instanceId) => ({
                    ...instance(instanceId),
                    models: [catalogModel],
                    defaultModel: catalogModel,
                  }))
                : []),
            ],
      onRuntimeOutcome: (event) => noteOutcome(event.payload.runtimeSessionId),
      prepareRuntimeLaunch: (instanceId, request) => ({
        definition: {
          schema: "agent-definition-snapshot/v1",
          configVersion: 1,
          instanceId,
          installationId: installation.installationId,
          kindId: "codex",
          providerId: "openai",
          model: request.model ?? (instanceId === "ambient-first" ? "flash-model" : catalogModel),
          reasoningEffort: null,
          fast: false,
          baseUrl: null,
          authMode: "subscription",
        } satisfies AgentDefinitionSnapshot,
        installation,
        executablePath: installation.executablePath,
        args: request.providerSessionId
          ? ["exec", "resume", "--json", "--dangerously-bypass-approvals-and-sandbox", request.providerSessionId, "-"]
          : ["exec", "--json", "--sandbox", "danger-full-access", "-"],
        env: {},
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      runtimeLaunch: (prepared, persistence): RuntimeProcess => {
        if (options.providerInputLimit !== undefined && prepared.prompt.length > options.providerInputLimit)
          throw new Error(`input_too_large: ${prepared.prompt.length} > ${options.providerInputLimit}`);
        const providerSessionId = prepared.args.includes("review-provider-session")
          ? "review-provider-session"
          : providerSessionStarted
            ? "review-provider-session-new"
            : "review-provider-session";
        providerSessionStarted = true;
        launches.push({
          prompt: prepared.prompt,
          instanceId: prepared.definition.instanceId,
          model: prepared.definition.model,
          args: prepared.args,
          cwd: prepared.cwd,
        });
        providerSessionStarted = true;
        for (const notify of launchWaiters) notify();
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
            if (options.autoProviderSession) {
              const reportedSession =
                failProviderResume && prepared.args.includes("review-provider-session")
                  ? "provider-rejected-resume"
                  : providerSessionId;
              if (reportedSession !== providerSessionId) failProviderResume = false;
              setImmediate(() =>
                listener(`${JSON.stringify({ type: "thread.started", thread_id: reportedSession })}\n`),
              );
            }
          },
          onErrorOutput: () => undefined,
          terminate: () => undefined,
          onExit: (listener) => {
            pending.exit = (code) => {
              pending.exit = undefined;
              listener(code);
            };
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
  const harnessConfig = (worktreeSetup?: readonly string[]) =>
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n" +
    "settings:\n  defaultVertical: software/coding\n  defaultPreset: standard-task\n  defaultProfile: baseline\n" +
    `  closeout:\n    profile: ${options.closeoutProfile ?? "strict"}\n` +
    (options.providerRoundBackoffBaseSeconds === undefined && options.stallTimeoutMs === undefined
      ? ""
      : `  runtime:\n${options.providerRoundBackoffBaseSeconds === undefined ? "" : `    providerRoundBackoffBaseSeconds: ${String(options.providerRoundBackoffBaseSeconds)}\n`}${options.stallTimeoutMs === undefined ? "" : `    stallTimeoutMs: ${String(options.stallTimeoutMs)}\n`}`) +
    (worktreeSetup?.length
      ? `  worktree:\n    setup:\n${worktreeSetup.map((step) => `      - ${JSON.stringify(step)}\n`).join("")}`
      : "");
  writeFileSync(path.join(root, "harness", "harness.yaml"), harnessConfig(options.worktreeSetup));
  if (options.legacyReviewer) appendLegacyReviewerDeclaration(repoId, canonicalRoot(root));
  let cell = await open();
  const run = (action: Parameters<typeof cell.run>[0]) => cell.run(action, owner);
  const createOptions =
    options.create?.taskClass === "work" && options.create.decisionRef === undefined
      ? { ...options.create, decisionRef: await acceptedWorkDecision(cell, owner, taskId) }
      : options.create;
  const created = await run({
    kind: "task-create",
    taskId,
    title: "Completion Review",
    presetId: artifactDelivery || hybridDelivery ? "standard-task" : "docs-task",
    ...createOptions,
  });
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  await waitForFixturePublication(cell, created.opId, owner);
  const packagePath = String((created as Record<string, unknown>).packagePath);
  await realizeTaskPlanFixture(root, packagePath, (planPath) => run({ kind: "doc-submit", paths: [planPath] }));
  assert.equal((await run({ kind: "task-start", taskId, executionId })).outcome, "applied");
  if (options.guiDelivery) {
    await cell.settlePendingMaterialization("GUI fixture delivery");
    const checkout = boundWorktree(root),
      guiPath = "packages/gui/src/App.tsx";
    mkdirSync(path.dirname(path.join(checkout, guiPath)), { recursive: true });
    writeFileSync(path.join(checkout, guiPath), "export const App = () => null;\n");
    git(checkout, "add", guiPath);
    git(checkout, "commit", "-qm", "feat: fixture GUI delivery");
  }
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
  const submit = async (roundExecutionId = executionId, binding: typeof owner = owner) => {
    // A returned blocking review belongs to the next implementation round. Freeze the worker's
    // response to every still-unanswered blocking finding before cutting that round; the lifecycle
    // contract rejects a submit that silently carries a prior rebuttal forward.
    const shown = await run({ kind: "task-show", taskId }),
      snapshot = JSON.parse(String(shown.evidence)) as Snapshot,
      responded = new Set(
        (snapshot.reviewResponses ?? []).map((response) => `${response.reviewId}\0${response.findingId}`),
      ),
      pendingResponses = snapshot.reviews
        .filter(
          (review) =>
            review.verdict === "changes_requested" &&
            snapshot.executions.some(
              (execution) => execution.executionId === review.executionId && execution.state === "changes_requested",
            ),
        )
        .flatMap((review) =>
          (review.findings ?? [])
            .filter((finding) => finding.blocking)
            .filter((finding) => !responded.has(`${review.reviewId}\0${finding.findingId}`))
            .map((finding) => ({
              reviewId: review.reviewId,
              findingId: finding.findingId,
              disposition: "adopt" as const,
              rationale: `Fixture worker addressed ${review.reviewId}/${finding.findingId}.`,
            })),
        );
    if (pendingResponses.length) {
      const response = await run({
        kind: "task-respond-review",
        taskId,
        executionId: roundExecutionId,
        jsonInput: JSON.stringify({ responses: pendingResponses }),
      });
      assert.equal(response.outcome, "applied", JSON.stringify(response));
    }
    writeFileSync(
      path.join(root, "harness", packagePath, "closeout.md"),
      `# Closeout\n\n## Summary\n\nReviewed delivery ${delivery}\n\n## Verification\n\nREADME bytes checked.\n\n` +
        "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nReview dispatch retry.\n",
    );
    const commitSha = options.submitCommit
      ? (() => {
          const checkout = boundWorktree(root);
          execFileSync("git", ["-C", checkout, "commit", "--allow-empty", "-qm", "test: bound delivery"]);
          return git(checkout, "rev-parse", "HEAD");
        })()
      : undefined;
    const receipt = await cell.run(
      {
        kind: "task-submit",
        taskId,
        executionId: roundExecutionId,
        ...(commitSha ? { commitSha } : {}),
      },
      binding,
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    return receipt;
  };
  const consent = (reviewId: string) => run({ kind: "task-review-consent", taskId, executionId, reviewId });
  // Submit lands a review-required cut in in_review and the reviewer dispatch rides the same
  // write; review-lifted cuts complete straight off submitted (dec_E369B861 CH3).
  if (options.autoSubmit !== false) await submit();
  // One reader serves every events() call for the fixture's life: a fresh connection per call
  // both cost a SQLite open and left the handle for the GC (which blocks deleting the fixture
  // tree on Windows). close() drains it before the tree goes away.
  let eventsReader: ReturnType<typeof makeTaskEventReader> | null = null;
  const events = () => (eventsReader ??= makeTaskEventReader({ repoId, rootDir: root })).read().events;
  const awaitOutcome = async (runtimeSessionId: string) => {
    // Bind the wait to the canonical outcome event. The settle predicate becomes true when the
    // dispatch stream records the terminal outcome, one queued write before the daemon publishes
    // `runtime_session_outcome_observed`; reading the ledger at that earlier moment is the race
    // that reddened integration-shard(2) under load. `waitForArrival` subscribes before it reads,
    // so an event published between the read and the wait still wakes this waiter.
    return await waitForArrival(
      () => {
        const outcome = events().find(
          (event) =>
            event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
        );
        return outcome?.type === "runtime_session_outcome_observed" ? outcome.payload.outcome : null;
      },
      (arrive) => subscribeOutcome(runtimeSessionId, arrive),
    );
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
    consent,
    complete: () => run({ kind: "task-complete", taskId, executionId }),
    install: async (instanceId: string | null = "review-first") => {
      const installed = await run({
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "closeout-reviewer",
          name: "Independent reviewer",
          instructions: "Inspect submitted bytes and record your independent verdict.",
          runtimes: [{ type: "codex", model: agentModel }],
          ...(instanceId === null ? {} : { instance: instanceId }),
          role: "worker",
        },
      });
      assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    },
    reopen: async () => {
      await cell.close();
      cell = await open();
    },
    setWorktreeSetup: async (steps: readonly string[]) => {
      writeFileSync(path.join(root, "harness", "harness.yaml"), harnessConfig(steps));
      await cell.close();
      cell = await open();
    },
    createPlannedTask: async (
      extraTaskId: string,
      presetId = "docs-task",
      create: Readonly<Record<string, unknown>> = {},
    ) => {
      const created = await run({
        kind: "task-create",
        taskId: extraTaskId,
        title: `Completion Review ${extraTaskId}`,
        presetId,
        ...create,
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
      if (reviewedCommit === null) {
        const reader = makeTaskEventReader({ repoId, rootDir: root }),
          reviewCell = {
            store: reader,
            cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
          };
        try {
          for (const anchor of submitted.payload.execution.submission.artifacts!) {
            readSubmissionArtifact(reviewCell, packagePath, anchor.path, anchor.revision, anchor.blobSha256);
          }
        } finally {
          await reader.drain();
        }
        if (artifactDelivery) assert.match(launches.at(-1)!.prompt, /ha doc show --path <anchor.path> --raw/u);
      } else if (hybridDelivery) {
        assert.match(String(reviewedCommit), /^[0-9a-f]{40}$/u);
        assert.match(launches.at(-1)!.prompt, /ha doc show --path <anchor.path> --raw/u);
      } else assert.equal(git(root, "show", `${reviewedCommit}:README.md`), "# Reviewed delivery");
      assert.match(
        readFileSync(path.join(root, "harness", packagePath, "closeout.md"), "utf8"),
        /README bytes checked/u,
      );
      const packet = `${packagePath}/artifacts/reports/${reviewId}.json`,
        report = `${packagePath}/artifacts/reports/${reviewId.startsWith("review-") ? reviewId.slice("review-".length) : reviewId}.md`;
      mkdirSync(path.dirname(path.join(root, "harness", packet)), { recursive: true });
      writeFileSync(path.join(root, "harness", report), `# Review ${reviewId}\n\nPhysical review findings.\n`);
      writeFileSync(
        path.join(root, "harness", packet),
        JSON.stringify({
          verdict: "approved",
          reason:
            reviewedCommit === null || hybridDelivery
              ? "Inspected center-accepted artifact contents and submitted closeout."
              : "Independently inspected committed README and submitted closeout.",
          evidenceChecked:
            reviewedCommit === null || hybridDelivery
              ? submitted.payload.execution.submission.artifacts!.map((anchor) => `${anchor.path}@${anchor.revision}`)
              : [`${reviewedCommit}:README.md`, "closeout.md"],
          findings: [],
          resolutions: [],
        }),
      );
      return cell.run(
        { kind: "task-review-execution", taskId, executionId, reviewId, fromFile: `harness/${packet}` },
        withPolicyGroup(
          {
            actor: {
              principal: owner.actor.principal,
              executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` },
            },
            source: "local",
          },
          "admin",
        ),
      );
    },
    reviewDispatchedArtifacts: async (
      runtimeSessionId: string,
      dispatchId: string,
      reviewedExecutionId: string = executionId,
    ) => {
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
          findings: [],
          resolutions: [],
        }),
      );
      return cell.run(
        {
          kind: "task-review-execution",
          taskId,
          executionId: reviewedExecutionId,
          reviewId: `review-${dispatchId}`,
          fromFile: `harness/${packet}`,
        },
        withPolicyGroup(
          {
            actor: {
              principal: owner.actor.principal,
              executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` },
            },
            source: "local",
          },
          "admin",
        ),
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
    waitForLaunches: (count: number) => {
      if (launches.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const waiter = () => {
          if (launches.length < count) return;
          launchWaiters.delete(waiter);
          resolve();
        };
        launchWaiters.add(waiter);
      });
    },
    waitForProviderBinding: async (dispatchId: string, expected: string) => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        if (readDispatchStream(root, dispatchId)?.providerSessionId === expected) return;
        if (Date.now() >= deadline) throw new Error(`provider binding ${expected} was not recorded for ${dispatchId}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    },
    /** Provider-success driver for a dispatched decision reviewer: the reviewer authored its own
     * artifacts under the Decision package, so the settlement only needs the provider turn. */
    settleDecisionReview: async (runtimeSessionId: string, resultText: string) => {
      const pending = pendingProviders.at(-1)!;
      pending.output?.(`${JSON.stringify({ type: "thread.started", thread_id: "review-provider-session" })}\n`);
      pending.output?.(
        `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: resultText } })}\n`,
      );
      pending.output?.(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
      pending.exit?.(0);
      return awaitOutcome(runtimeSessionId);
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
      for (const pending of pendingProviders) pending.exit?.(1);
      await cell.close();
      await eventsReader?.drain();
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
    // This historical declaration owns exactly its declaration file. Keep the fixture manifest
    // explicit: the current declaration compiler correctly rejects the legacy runtime fields.
    ownedContent: EntityOwnedContentV1 = {
      schema: "entity-owned-content/v1",
      ownerRef: `agent/${value.id}`,
      schemaId: contract.schema.$id,
      schemaVersion: 1,
      content: [{ sha256: claim.sha256, byteLength: claim.size, mediaType: claim.mediaType }],
      bindings: [{ path: claim.path, contentSha256: claim.sha256, policyId: claim.policyId }],
      directories: [],
      retirements: [],
      directoryRetirements: [],
    },
    event = { ...seed, payload: { ...seed.payload, ownedContent } },
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
