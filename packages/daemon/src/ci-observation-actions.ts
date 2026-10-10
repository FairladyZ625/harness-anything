import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ciRunObservationWritePlan,
  consumeKnownError,
  isNativeCommitSha,
  validateCurrentCiRunObservationEvent,
  type CiRunObservationEventV4,
  type CiRunDetail,
  type CiObservationIdentity,
  ciDetailMeasurement,
  canonicalizeContractValue,
  type FrozenGateRequirement,
  type TaskProjection,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { runProcessTextAsync } from "./process-port.ts";
import { strandedDelivery } from "./repo-cell-ci-evidence.ts";
import { localGitObjectRefStore, resolveHarnessLayout } from "@harness-anything/kernel";
import type { RepoCellActionContext, RepoCellOperationalContext } from "./repo-cell-action-context.ts";

type CiRunArtifact = {
  readonly schema: "ci-run-artifact/v2";
  readonly run: CiRunObservationEventV4["payload"]["run"];
  readonly producer: {
    readonly repositoryId: string;
    readonly workflow: string;
    readonly databaseRunId: string;
    readonly runAttempt: number;
    readonly jobKey: string;
    readonly jobName: string;
  };
  readonly detail: CiRunDetail;
  readonly gates: CiRunObservationEventV4["payload"]["gates"];
  readonly measurementCoverage: CiRunObservationEventV4["payload"]["measurementCoverage"];
};
type PreparedCiJob = {
  readonly artifact: CiRunArtifact;
  readonly jobExecutionId: string;
  readonly body: string;
  readonly sha256: string;
  readonly measurement: ReturnType<typeof ciDetailMeasurement>;
};
type CiWorkflowRun = { readonly databaseId: number; readonly headBranch: string; readonly createdAt: string };
type CiRunListEntry = CiWorkflowRun & {
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly event: string;
};
type CiRunSummary = {
  readonly workflowName: string;
  readonly headSha: string;
  readonly headBranch: string;
  readonly status: string;
  readonly conclusion: string;
  readonly attempt: number;
  readonly event: string;
};
type FetchedCiRun = {
  readonly databaseId: number;
  readonly summary: CiRunSummary;
  readonly repositoryId: string;
  readonly workflowPath: string;
  readonly workflowId: string | null;
  readonly jobs: readonly PreparedCiJob[];
  readonly artifactUnavailable?: boolean;
  readonly attemptInventory?: NonNullable<CiRunObservationEventV4["payload"]["attemptInventory"]>;
};
export const preparedCiObservation = Symbol("preparedCiObservation");

export type CiObservationFetch = {
  readonly requestedRuns: number;
  readonly runs: readonly FetchedCiRun[];
  /** --task: the delivery and the run its frozen contract judges, reported with the run's conclusion. */
  readonly witness?: { readonly taskId: string; readonly delivery: string; readonly databaseId: number };
};
type GithubActionsOptions = Extract<
  FrozenGateRequirement["witness"],
  { readonly kind: "github-actions" }
>["adapterOptions"];

// Every gh call finishes before the pull enters the repository write queue: GitHub can stall
// until the provider deadline, and the queue waits only on the event appends in ingestCiObservations.
export async function fetchCiObservations(
  cell: Pick<RepoCellOperationalContext, "rootDir" | "cellCodedError" | "settings"> & {
    readonly projection?: Pick<TaskProjection, "read">;
  },
  action: RepoTaskAction,
  ghRunner: RunGh = runCiProviderCommand,
): Promise<CiObservationFetch> {
  // GitHub rate limits surface as gh 403 stderr; classifying them here reports rate_limited with
  // the reset hint, so callers wait instead of retrying a raw service_rejected dump that deepens
  // the limit.
  const runGh: RunGh = async (command, args, options) => {
    try {
      return await ghRunner(command, args, options);
    } catch (error) {
      throw rethrowGhFailureAsRateLimit(cell, error);
    }
  };
  const limit = Number(action.limit ?? 20),
    namedRuns = Array.isArray(action.runs) ? action.runs.map(Number) : null,
    taskId = typeof action.taskId === "string" ? action.taskId : null,
    workflows = cell.settings.read().ci.workflows;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw cell.cellCodedError("invalid_command", "CI observation pull limit must be 1..100.");
  if (namedRuns && action.limit !== undefined)
    throw cell.cellCodedError("invalid_command", "Use --run <run-id> or --limit <count>, not both.");
  if (namedRuns && taskId !== null)
    throw cell.cellCodedError("invalid_command", "Use --run <run-id> or --task <task-id>, not both.");
  if (namedRuns && (namedRuns.length > 100 || namedRuns.some((id) => !Number.isSafeInteger(id) || id < 1)))
    throw cell.cellCodedError("invalid_command", "CI observation pull accepts 1..100 positive --run ids.");
  const witness = taskId === null ? null : taskWitnessContract(cell, taskId);
  const owner = createHash("sha256")
    .update(JSON.stringify([cell.rootDir, action.occurrenceId, action.claimFence]))
    .digest("hex")
    .slice(0, 20);
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), `ha-ci-observe-${owner}-`));
  try {
    const listed =
        namedRuns === null && witness === null
          ? (
              await Promise.all(
                workflows.map(
                  async (workflow) =>
                    JSON.parse(
                      await runGh(
                        "gh",
                        [
                          "run",
                          "list",
                          "--workflow",
                          `${workflow}.yml`,
                          "--limit",
                          String(limit),
                          "--json",
                          "databaseId,headBranch,headSha,createdAt,status,conclusion,event",
                        ],
                        { cwd: cell.rootDir },
                      ),
                    ) as readonly CiRunListEntry[],
                ),
              )
            ).flat()
          : [],
      witnessRun =
        witness === null
          ? null
          : await selectTaskWitnessRun(cell, witness, witness.options.workflows ?? workflows, runGh),
      runs: readonly Pick<CiWorkflowRun, "databaseId">[] =
        namedRuns?.map((databaseId) => ({ databaseId })) ??
        (witnessRun ? [witnessRun] : selectCiObservationRuns(listed, limit));
    const fetchResults = await Promise.all(
      runs.map(async (run): Promise<{ fetched: FetchedCiRun | null } | { failure: unknown }> => {
        try {
          const fixedAttempt = (action.attempts as Readonly<Record<string, number>> | undefined)?.[run.databaseId];
          const fixed =
            fixedAttempt === undefined
              ? null
              : (JSON.parse(
                  await runGh(
                    "gh",
                    ["api", `repos/:owner/:repo/actions/runs/${run.databaseId}/attempts/${fixedAttempt}`],
                    { cwd: cell.rootDir },
                  ),
                ) as {
                  name: string;
                  head_sha: string;
                  head_branch: string;
                  status: string;
                  conclusion: string;
                  run_attempt: number;
                  event: string;
                });
          const summary: CiRunSummary = fixed
            ? {
                workflowName: fixed.name,
                headSha: fixed.head_sha,
                headBranch: fixed.head_branch,
                status: fixed.status,
                conclusion: fixed.conclusion,
                attempt: fixed.run_attempt,
                event: fixed.event,
              }
            : (JSON.parse(
                await runGh(
                  "gh",
                  [
                    "run",
                    "view",
                    String(run.databaseId),
                    "--json",
                    "workflowName,headSha,headBranch,status,conclusion,attempt,event",
                  ],
                  { cwd: cell.rootDir },
                ),
              ) as CiRunSummary);
          const { status: runLifecycleState } = summary;
          // Publish immutable observations only for main runs that have a final conclusion.
          if (summary.headBranch !== "main" || runLifecycleState !== "completed") {
            if (namedRuns && fixedAttempt === undefined)
              throw cell.cellCodedError(
                "invalid_command",
                `CI run ${run.databaseId} is ${runLifecycleState} on ${summary.headBranch}; ` +
                  "only completed main runs can be imported.",
              );
            return { fetched: null };
          }
          const runRoot = path.join(temporaryRoot, String(run.databaseId), String(summary.attempt));
          const downloaded = witness
            ? { artifacts: [], unavailable: false }
            : await downloadCiArtifacts(runGh, cell.rootDir, runRoot, run.databaseId, summary.attempt);
          const attempt = JSON.parse(
            await runGh(
              "gh",
              ["api", `repos/:owner/:repo/actions/runs/${run.databaseId}/attempts/${summary.attempt}`],
              { cwd: cell.rootDir },
            ),
          ) as {
            readonly run_attempt: number;
            readonly head_sha: string;
            readonly head_branch: string;
            readonly conclusion: string;
            readonly event: string;
            readonly path: string;
            readonly workflow_id: number;
            readonly name: string;
            readonly repository: { readonly full_name: string };
          };
          if (
            attempt.run_attempt !== summary.attempt ||
            attempt.head_sha !== summary.headSha ||
            attempt.head_branch !== summary.headBranch ||
            attempt.conclusion !== summary.conclusion
          )
            throw cell.cellCodedError(
              "invalid_result",
              "CI attempt metadata changed while fetching; no observation accepted.",
            );
          if (witness)
            return {
              fetched: {
                databaseId: run.databaseId,
                summary,
                repositoryId: attempt.repository.full_name,
                workflowPath: attempt.path,
                workflowId: String(attempt.workflow_id),
                jobs: [],
              },
            };
          const artifacts = downloaded.artifacts.filter(
            (artifact) =>
              artifact.producer.databaseRunId === String(run.databaseId) &&
              artifact.producer.runAttempt === summary.attempt,
          );
          const jobs: PreparedCiJob[] = [];
          let apiJobs: readonly { readonly id: number; readonly name: string; readonly conclusion?: string | null }[];
          {
            // gh --slurp keeps every paginated page in one JSON array, avoiding concatenated
            // transport JSON; gh rejects --jq/--template alongside --slurp, so the pages
            // flatten here instead of in a jq program.
            apiJobs = (
              JSON.parse(
                await runGh(
                  "gh",
                  [
                    "api",
                    "--paginate",
                    "--slurp",
                    `repos/:owner/:repo/actions/runs/${run.databaseId}/attempts/${summary.attempt}/jobs?per_page=100`,
                  ],
                  { cwd: cell.rootDir },
                ),
              ) as readonly {
                readonly jobs: readonly {
                  readonly id: number;
                  readonly name: string;
                  readonly conclusion?: string | null;
                }[];
              }[]
            ).flatMap((page) => page.jobs);
            for (const artifact of artifacts) {
              const matching = apiJobs.filter((job) => job.name === artifact.producer.jobName);
              if (
                matching.length !== 1 ||
                artifact.producer.repositoryId !== attempt.repository.full_name ||
                artifact.producer.workflow !== attempt.path ||
                artifact.run.sha !== attempt.head_sha ||
                artifact.run.runId !== `${run.databaseId}.${summary.attempt}`
              )
                throw cell.cellCodedError(
                  "invalid_result",
                  "CI artifact has ambiguous or mismatched attempt/job provenance.",
                );
              const body = JSON.stringify(artifact.detail);
              jobs.push({
                artifact,
                jobExecutionId: String(matching[0]!.id),
                body,
                sha256: createHash("sha256").update(body).digest("hex"),
                measurement: ciDetailMeasurement(artifact.detail),
              });
            }
          }
          return {
            fetched: {
              databaseId: run.databaseId,
              summary,
              artifactUnavailable: downloaded.unavailable,
              repositoryId: attempt.repository.full_name,
              workflowPath: attempt.path,
              workflowId: String(attempt.workflow_id),
              jobs,
              attemptInventory: {
                jobs: apiJobs
                  .map((job) => ({
                    jobExecutionId: String(job.id),
                    name: job.name,
                    conclusion: job.conclusion ?? null,
                  }))
                  .sort((a, b) => a.jobExecutionId.localeCompare(b.jobExecutionId)),
                missingArtifactJobIds: apiJobs
                  .filter(
                    (job) =>
                      job.conclusion !== "skipped" &&
                      !jobs.some((prepared) => prepared.jobExecutionId === String(job.id)),
                  )
                  .map((job) => String(job.id))
                  .sort(),
              },
            },
          };
        } catch (failure) {
          return { failure };
        }
      }),
    );
    const failedFetch = fetchResults.find((result) => "failure" in result);
    if (failedFetch && "failure" in failedFetch) throw failedFetch.failure;
    const fetched = fetchResults.flatMap((result) =>
      "fetched" in result && result.fetched !== null ? [result.fetched] : [],
    );
    if (!namedRuns) fetched.push(...privateLedgerRuns(cell));
    return {
      requestedRuns: namedRuns?.length ?? (witnessRun ? 1 : limit),
      runs: fetched,
      ...(witness && witnessRun
        ? { witness: { taskId: witness.taskId, delivery: witness.delivery, databaseId: witnessRun.databaseId } }
        : {}),
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function ingestCiObservations(
  cell: RepoCellActionContext,
  binding: RepoCellBinding,
  fetched: CiObservationFetch,
): WriteReceipt {
  const eventRefs: string[] = [];
  let imported = 0,
    duplicate = 0,
    lastRevision = cell.store.readHead()?.revision ?? 0;
  for (const { databaseId, summary, repositoryId, workflowPath, workflowId, jobs, attemptInventory } of fetched.runs) {
    const identity: CiObservationIdentity = {
      provider: databaseId === 0 ? "write-coordinator" : "github-actions",
      repositoryId,
      workflow: databaseId === 0 ? "ledger-publication" : summary.workflowName,
      workflowPath,
      workflowId,
      databaseRunId: databaseId === 0 ? `ledger-${summary.headSha}` : String(databaseId),
      runAttempt: summary.attempt,
      jobExecutionId: null,
      jobKey: null,
    };
    const run: CiRunObservationEventV4["payload"]["run"] = {
      runId: databaseId === 0 ? `ledger-${summary.headSha}` : `${databaseId}.${summary.attempt}`,
      sha: summary.headSha,
      branch: summary.headBranch,
      prNumber: null,
      job: summary.workflowName,
      wallclockMs: 0,
      runner: databaseId === 0 ? "write-coordinator" : "github-actions",
    };
    const verification: CiRunObservationEventV4["payload"]["verification"] =
      databaseId === 0
        ? {
            source: "write-coordinator",
            workflow: "ledger-publication",
            runId: run.runId,
            attempt: 1,
            headSha: summary.headSha,
            conclusion: summary.conclusion,
          }
        : {
            source: "github-actions",
            workflow: summary.workflowName,
            runId: String(databaseId),
            attempt: summary.attempt,
            headSha: summary.headSha,
            conclusion: summary.conclusion,
            event: summary.event,
          };
    const payloads: { readonly payload: CiRunObservationEventV4["payload"]; readonly body: string | null }[] = [
      {
        payload: {
          scope: "workflow",
          identity,
          run,
          verification,
          gates: [],
          measurementCoverage: {
            status: "no-test-artifact",
            missingReason: null,
            startedFileCount: null,
            completedFileCount: null,
          },
          testSummary: null,
          failedTests: [],
          fileOutcomes: [],
          shardDurations: [],
          detailRef: null,
        },
        body: null,
      },
      ...jobs.map(({ artifact, jobExecutionId, body, sha256, measurement }) => ({
        payload: {
          scope: "job" as const,
          identity: { ...identity, jobExecutionId, jobKey: artifact.producer.jobKey },
          run: artifact.run,
          verification: null,
          gates: artifact.gates,
          measurementCoverage: artifact.measurementCoverage,
          ...measurement,
          detailRef: {
            schema: "ci-run-detail/v1" as const,
            sha256,
            mediaType: "application/json" as const,
            encoding: "identity" as const,
            encodedBytes: Buffer.byteLength(body),
            decodedBytes: Buffer.byteLength(body),
          },
        },
        body,
      })),
    ];
    if (attemptInventory)
      payloads.push({
        payload: { ...payloads[0]!.payload, scope: "attempt", verification: null, attemptInventory },
        body: null,
      });
    for (const { payload, body } of payloads) {
      const digest = createHash("sha256")
        .update(
          JSON.stringify([
            identity.provider,
            repositoryId,
            databaseId === 0 ? identity.databaseRunId : databaseId,
            summary.attempt,
            payload.scope,
            payload.identity.jobExecutionId,
            ...(payload.scope === "attempt" ? [payload.attemptInventory] : []),
          ]),
        )
        .digest("hex");
      const opId = `ci-observation-${digest}`;
      const existing = cell.store.readEvent(opId);
      if (existing) {
        if (
          JSON.stringify(canonicalizeContractValue(existing.payload)) !==
          JSON.stringify(canonicalizeContractValue(payload))
        )
          throw cell.cellCodedError("op_conflict", "CI observation identity has conflicting content.");
        duplicate += 1;
        eventRefs.push(`event:${opId}`);
        continue;
      }
      const event: CiRunObservationEventV4 = {
        schema: "ci-run-observation/v4",
        eventId: `event-${digest}`,
        workspaceRevision: (cell.store.readHead()?.revision ?? 0) + 1,
        opId,
        type: "ci_run_observed",
        actor: binding.actor,
        source: binding.source,
        occurredAt: cell.now(),
        payload,
      };
      const errors = validateCurrentCiRunObservationEvent(event);
      if (errors.length) throw cell.cellCodedError("invalid_result", errors.join("; "));
      const ref = payload.detailRef,
        plan = ciRunObservationWritePlan(event);
      const appended = cell.store.append({
        event,
        plan,
        blobs:
          ref && body !== null ? [{ sha256: ref.sha256, size: ref.encodedBytes, mediaType: ref.mediaType, body }] : [],
      });
      cell.projection.apply(event, plan);
      imported += 1;
      lastRevision = appended.revision;
      eventRefs.push(`event:${opId}`);
    }
  }
  const appliedCut = cell.projection.readCiRunObservations(1).watermark,
    visible = appliedCut >= lastRevision;
  return {
    outcome: visible ? "applied" : "pending",
    opId: `ci-observe-pull-${Date.now()}`,
    revision: lastRevision,
    evidence: JSON.stringify({
      schema: "ci-observe-pull/v1",
      imported,
      duplicate,
      requestedRuns: fetched.requestedRuns,
      eventRefs,
    }),
    visibility: "center",
    proof: {
      committedRevision: lastRevision,
      appliedCut,
      durable: true,
      canonicalVisible: visible,
      worktreeVisible: false,
    },
    summary:
      taskWitnessSummary(fetched) +
      `Imported ${imported} CI observation(s); ${duplicate} already existed.\n` +
      eventRefs.join("\n"),
  } as WriteReceipt;
}

export function selectCiObservationRuns(runs: readonly CiWorkflowRun[], limit: number): readonly CiWorkflowRun[] {
  return runs
    .filter((run) => run.headBranch === "main")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.databaseId - left.databaseId)
    .slice(0, limit);
}

type TaskWitness = { readonly taskId: string; readonly delivery: string; readonly options: GithubActionsOptions };

// --task resolves the submitted execution's delivery commit and the github-actions options its
// completion contract froze.
function taskWitnessContract(
  cell: {
    readonly rootDir: string;
    readonly cellCodedError: RepoCellOperationalContext["cellCodedError"];
    readonly projection?: Pick<TaskProjection, "read">;
  },
  taskId: string,
): TaskWitness {
  const snapshot = cell.projection?.read(taskId).snapshot,
    submission = snapshot?.executions.find(
      (candidate) => candidate.iteration === snapshot.task?.iteration && candidate.submission !== null,
    )?.submission,
    delivery = submission?.commitSha;
  if (!isNativeCommitSha(delivery))
    throw cell.cellCodedError(
      "ci_witness_delivery_unresolved",
      `Task ${taskId} has no submitted execution with a delivery commit. ` +
        `next: submit the task delivery; the center CI Schedule will collect its witness.`,
    );
  if (strandedDelivery(cell.rootDir, submission))
    throw cell.cellCodedError(
      "ci_witness_not_found",
      `No CI run can ever cover delivery ${delivery} of ${taskId}: the commit is gone or its changes ` +
        "landed under another commit. next: the task owner returns the cut with " +
        `ha task adjudicate ${taskId} --return --review-id <review-id> --note <reason>, then resubmits the landed commit.`,
    );
  const witness = submission!.completionContract.gates.find(
    (requirement) => requirement.witness.kind === "github-actions",
  )?.witness;
  if (witness?.kind !== "github-actions")
    throw cell.cellCodedError(
      "invalid_command",
      `Task ${taskId} has no github-actions gate in its completion contract; no CI run witnesses it.`,
    );
  return { taskId, delivery, options: witness.adapterOptions };
}

// Selects the run the frozen contract judges, exactly as completion does: completed main runs of
// the frozen event, newest run first, the first covering run whose conclusion is a verdict
// (cancelled/skipped carry none). A red verdict is imported and reported, never skipped for an
// older green. Runs are looked up per head commit along main's first-parent history, newest first:
// GitHub's branch-filtered run listing intermittently serves a days-old page, while head_sha
// lookups stayed current (F-6AFABACF, F-50599A2B).
async function selectTaskWitnessRun(
  cell: { readonly rootDir: string; readonly cellCodedError: RepoCellOperationalContext["cellCodedError"] },
  { taskId, delivery, options }: TaskWitness,
  workflows: readonly string[],
  runGh: RunGh,
): Promise<Pick<CiWorkflowRun, "databaseId">> {
  const cwd = cell.rootDir,
    workflowPaths = new Set(workflows.map((workflow) => `.github/workflows/${workflow}.yml`)),
    heads =
      options.coverage === "exact"
        ? [delivery]
        : firstParentHistory(
            JSON.parse(
              await runGh(
                "gh",
                [
                  "api",
                  "repos/:owner/:repo/commits?sha=main&per_page=100",
                  "--jq",
                  "[.[] | {sha, parents: [.parents[].sha]}]",
                ],
                { cwd },
              ),
            ) as readonly { readonly sha: string; readonly parents: readonly string[] }[],
          );
  let pending: { readonly databaseId: number; readonly status: string } | undefined;
  for (const head of heads) {
    // Main's first-parent history is linear: once a head does not contain the delivery, no older one does.
    if (options.coverage !== "exact" && !(await coversCommit(runGh, cwd, delivery, head))) break;
    const runs = (
      JSON.parse(
        await runGh(
          "gh",
          [
            "api",
            `repos/:owner/:repo/actions/runs?head_sha=${head}&per_page=100`,
            "--jq",
            "[.workflow_runs[] | {databaseId: .id, path, headBranch: .head_branch, event, status, conclusion}]",
          ],
          { cwd },
        ),
      ) as readonly (Pick<CiRunListEntry, "databaseId" | "headBranch" | "event" | "status" | "conclusion"> & {
        readonly path: string;
      })[]
    )
      .filter((run) => run.headBranch === "main" && run.event === options.event && workflowPaths.has(run.path))
      .sort((left, right) => right.databaseId - left.databaseId);
    const verdict = runs.find(
      (run) => run.status === "completed" && run.conclusion !== "cancelled" && run.conclusion !== "skipped",
    );
    if (verdict) return { databaseId: verdict.databaseId };
    pending ??= runs.find((run) => run.status !== "completed");
  }
  if (pending)
    throw cell.cellCodedError(
      "ci_witness_not_found",
      `No completed main CI run covers delivery ${delivery} of ${taskId}. ` +
        `next: run ${pending.databaseId} is ${pending.status}; retry after it concludes.`,
    );
  throw cell.cellCodedError(
    "ci_witness_not_found",
    `No completed main CI run covers delivery ${delivery} of ${taskId}. ` +
      "next: no covering run exists yet; retry after the next main run completes.",
  );
}

// Main's push runs sit on its first-parent chain; the page lists the tip first.
function firstParentHistory(page: readonly { readonly sha: string; readonly parents: readonly string[] }[]): string[] {
  const parents = new Map(page.map((commit) => [commit.sha, commit.parents[0]]));
  const chain: string[] = [];
  for (let sha: string | undefined = page[0]?.sha; sha !== undefined && parents.has(sha); sha = parents.get(sha))
    chain.push(sha);
  return chain;
}

function taskWitnessSummary({ witness, runs }: CiObservationFetch): string {
  const run = witness && runs.find((candidate) => candidate.databaseId === witness.databaseId);
  return run
    ? `${witness.taskId} CI witness: run ${run.databaseId} (${run.summary.workflowName}) concluded ` +
        `${run.summary.conclusion} on ${run.summary.headSha}, covering delivery ${witness.delivery}.\n`
    : "";
}

// A main run covers the delivery when the delivery commit is an ancestor of the run head:
// GitHub compare reports "ahead"/"identical" only when base is contained in head's history.
async function coversCommit(runGh: RunGh, cwd: string, base: string, head: string): Promise<boolean> {
  const compare = JSON.parse(
    await runGh("gh", ["api", `repos/:owner/:repo/compare/${base}...${head}`, "--jq", "{status: .status}"], { cwd }),
  ) as {
    readonly status?: string;
  };
  return compare.status === "ahead" || compare.status === "identical";
}

const ghRateLimitText = /rate limit|HTTP 429/iu;
const ghRateLimitResetText = /(?:reset in|try again in) ((?:[0-9]+[a-z]+)+)/iu;

function ghFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error),
    stderr =
      typeof error === "object" && error !== null && typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr
        : "";
  return `${message}\n${stderr}`;
}

// Non-rate-limit gh failures pass through untouched; rate limits rethrow as rate_limited with
// the reset hint parsed out of gh's stderr so the receipt names a wait, not a retry.
function rethrowGhFailureAsRateLimit(cell: Pick<RepoCellOperationalContext, "cellCodedError">, error: unknown): never {
  const detail = ghFailureDetail(error);
  if (!ghRateLimitText.test(detail)) throw error;
  const reset = ghRateLimitResetText.exec(detail)?.[1];
  throw cell.cellCodedError(
    "rate_limited",
    `GitHub rate-limited the gh call while observing CI.${reset ? ` Rate limit resets in ${reset}.` : ""} ` +
      "next: the center CI Schedule resumes reconciliation after the reset.",
  );
}

function readArtifacts(root: string): readonly CiRunArtifact[] {
  return walk(root)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(file, "utf8")))
    .filter(
      (value) =>
        value?.schema === "ci-run-artifact/v2" &&
        value.run &&
        value.producer &&
        value.detail?.schema === "ci-run-detail/v1" &&
        Array.isArray(value.detail.tests) &&
        Array.isArray(value.gates),
    );
}

function walk(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

/** Prepare the existing private-ledger witness; the occurrence owns its acceptance too. */
export function privateLedgerCiObservations(cell: Pick<RepoCellOperationalContext, "rootDir">): CiObservationFetch {
  return { requestedRuns: 0, runs: privateLedgerRuns(cell) };
}

function privateLedgerRuns(cell: Pick<RepoCellOperationalContext, "rootDir">): readonly FetchedCiRun[] {
  const authoredRoot = resolveHarnessLayout(cell.rootDir).authoredRoot;
  if (existsSync(authoredRoot)) {
    const branch = localGitObjectRefStore.currentBranch(authoredRoot),
      sha = branch ? localGitObjectRefStore.resolveCommit(authoredRoot, `refs/heads/${branch}`) : null;
    // A ledger commit that is also in the public repository belongs to the
    // GitHub observation path; synthesize only for private-ledger commits. `git rev-parse`
    // echoes any 40-hex string back, so existence must be asked with `cat-file -e`.
    if (branch && sha && !localGitObjectRefStore.hasCommit(cell.rootDir, sha))
      return [
        {
          databaseId: 0,
          summary: {
            workflowName: "ledger-publication",
            headSha: sha,
            headBranch: branch,
            status: "completed",
            conclusion: "success",
            attempt: 1,
            event: "push",
          },
          repositoryId: cell.rootDir,
          workflowPath: "ledger-publication",
          workflowId: null,
          jobs: [],
        },
      ];
  }
  return [];
}

export type RunGh = (command: string, args: readonly string[], options: { readonly cwd: string }) => Promise<string>;
export interface CiArtifactMetadata {
  readonly id: number;
  readonly name: string;
  readonly expired: boolean;
}

export const runCiProviderCommand: RunGh = (command, args, options) =>
  runProcessTextAsync(command, args, options.cwd, undefined, undefined, undefined, { timeoutMs: 30_000 });

export async function listCiArtifacts(gh: RunGh, cwd: string, runId: number): Promise<readonly CiArtifactMetadata[]> {
  const pages = JSON.parse(
    await gh(
      "gh",
      ["api", "--paginate", "--slurp", `repos/:owner/:repo/actions/runs/${runId}/artifacts?per_page=100`],
      { cwd },
    ),
  ) as readonly {
    readonly artifacts: readonly CiArtifactMetadata[];
  }[];
  return pages.flatMap((page) => page.artifacts);
}

// Unaccepted preparation belongs to a repository/run/attempt, not an occurrence claim.
// Retain completed units after a provider interruption; acceptance still uses the current fence.
const partialCiDownloads = new Map<string, Map<number, readonly CiRunArtifact[]>>();

async function downloadCiArtifacts(
  gh: RunGh,
  cwd: string,
  root: string,
  runId: number,
  attempt: number,
): Promise<{ readonly artifacts: readonly CiRunArtifact[]; readonly unavailable: boolean }> {
  const key = JSON.stringify([cwd, runId, attempt]);
  const artifacts = (await listCiArtifacts(gh, cwd, runId)).filter(
    (entry) => entry.name.startsWith(`ci-observation-${runId}-${attempt}-`) && !entry.expired,
  );
  const completed = partialCiDownloads.get(key) ?? new Map<number, readonly CiRunArtifact[]>();
  try {
    for (const artifact of artifacts) {
      if (completed.has(artifact.id)) continue;
      const dir = path.join(root, String(artifact.id));
      await gh("gh", ["run", "download", String(runId), "-n", artifact.name, "--dir", dir], { cwd });
      completed.set(artifact.id, readArtifacts(dir));
      partialCiDownloads.set(key, completed);
    }
    partialCiDownloads.delete(key);
    return { artifacts: artifacts.flatMap((artifact) => completed.get(artifact.id)!), unavailable: false };
  } catch (error) {
    if (isTransientCiProviderFailure(error)) throw error;
    partialCiDownloads.delete(key);
    if (isFatalCiProviderFailure(error)) throw error;
    if (!/\bHTTP [45]\d\d\b|Not Found/iu.test(ghFailureDetail(error))) throw error;
    consumeKnownError(error);
    return { artifacts: [], unavailable: true };
  }
}

function isFatalCiProviderFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    /\bHTTP (?:401|403|429)\b|rate.limit|\b(?:ENOSPC|EACCES|EPERM|ENOENT|EROFS|EIO|EMFILE|ENFILE)\b/iu.test(
      ghFailureDetail(error),
    )
  );
}

/** Only provider transport failures are resumable; authority and local IO fail closed. */
export function isTransientCiProviderFailure(error: unknown): boolean {
  return (
    !isFatalCiProviderFailure(error) &&
    ((error instanceof Error &&
      "killed" in error &&
      error.killed === true &&
      "signal" in error &&
      error.signal === "SIGTERM" &&
      "code" in error &&
      error.code === null) ||
      /\b(?:EOF|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b|connection reset|connection refused|network is unreachable|no such host|TLS handshake|TLS connection|x509:|unexpected EOF/iu.test(
        ghFailureDetail(error),
      ))
  );
}
