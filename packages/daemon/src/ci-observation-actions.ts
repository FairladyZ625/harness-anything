import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ciRunObservationWritePlan,
  consumeKnownError,
  validateCurrentCiRunObservationEvent,
  type CiRunObservationEventV4,
  type CiRunDetail,
  type CiObservationIdentity,
  ciDetailMeasurement,
  canonicalizeContractValue,
  type TaskProjection,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { localGitObjectRefStore, resolveHarnessLayout } from "@harness-anything/kernel";
import type { RepoCellActionContext, RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import { ciFailureDetail } from "./ci-failure-detail.ts";
import {
  selectTaskWitnessRun,
  taskWitnessContract,
  taskWitnessSummary,
  type TaskWitness,
} from "./ci-task-witness-run.ts";
import {
  listTaskBranchRuns,
  listCiArtifacts,
  runCiProviderCommand,
  scrubCiProviderLog,
  selectCiBranchRuns,
  type CiRunListEntry,
  type CiWorkflowRun,
  type RunGh,
} from "./ci-observation-provider.ts";
export type { RunGh } from "./ci-observation-provider.ts";
import {
  detectHostingProvider,
  hostingCredentialConfigurationAdvice,
  type HostingProvider,
} from "./hosting-provider.ts";
export type CiRunArtifact = {
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
  readonly artifactName?: string;
};
type PreparedCiJob = {
  readonly artifact: CiRunArtifact;
  readonly jobExecutionId: string;
  readonly body: string;
  readonly sha256: string;
  readonly measurement: ReturnType<typeof ciDetailMeasurement>;
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
  readonly provenanceIssues?: readonly CiProvenanceIssue[];
  readonly provider?: "github-actions" | "gitlab-pipeline";
};
export type CiRunUnavailable = {
  readonly runId: number;
  readonly attempt: number;
  readonly reason: string;
};
type FetchedCiRunOutcome = { fetched: FetchedCiRun | null } | { failure: unknown; runId: number; attempt: number };
export const preparedCiObservation = Symbol("preparedCiObservation");
export type CiObservationFetch = {
  readonly requestedRuns: number;
  readonly runs: readonly FetchedCiRun[];
  readonly unavailable?: readonly CiRunUnavailable[];
  /** --task: the delivery and the run its frozen contract judges, reported with the run's conclusion. */
  readonly witness?: { readonly taskId: string; readonly delivery: string; readonly databaseId: number };
};
export type CiProvenanceIssue = {
  readonly runId: number;
  readonly attempt: number;
  readonly artifactName: string;
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
};
export async function fetchCiObservations(
  cell: Pick<RepoCellOperationalContext, "rootDir" | "cellCodedError" | "settings" | "input"> & {
    readonly projection?: Pick<TaskProjection, "read" | "readRuntimeDispatch">;
  },
  action: RepoTaskAction,
  ghRunner: RunGh = runCiProviderCommand,
  hostingProvider?: "github" | "gitlab" | null,
): Promise<CiObservationFetch> {
  const hosting =
    hostingProvider !== undefined
      ? hostingProvider === null
        ? null
        : { kind: hostingProvider }
      : ghRunner === runCiProviderCommand
        ? await detectHostingProvider(cell.rootDir)
        : ({ kind: "github" } as const);
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
    observeBranch = taskId !== null && action.observeBranch === true,
    workflows = cell.settings.read().ci.workflows;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw cell.cellCodedError("invalid_command", "CI observation pull limit must be 1..100.");
  if (namedRuns && action.limit !== undefined)
    throw cell.cellCodedError("invalid_command", "Use --run <run-id> or --limit <count>, not both.");
  if (namedRuns && taskId !== null)
    throw cell.cellCodedError("invalid_command", "Use --run <run-id> or --task <task-id>, not both.");
  if (namedRuns && (namedRuns.length > 100 || namedRuns.some((id) => !Number.isSafeInteger(id) || id < 1)))
    throw cell.cellCodedError("invalid_command", "CI observation pull accepts 1..100 positive --run ids.");
  const witness = taskId === null || observeBranch ? null : taskWitnessContract(cell, taskId);
  if (hosting?.kind === "gitlab" && "apiBaseUrl" in hosting)
    return fetchGitLabCiObservations(cell, action, hosting, witness, limit, namedRuns);
  if (!hosting) return { requestedRuns: namedRuns?.length ?? limit, runs: [] };
  const owner = createHash("sha256")
    .update(JSON.stringify([cell.rootDir, action.occurrenceId, action.claimFence]))
    .digest("hex")
    .slice(0, 20);
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), `ha-ci-observe-${owner}-`));
  try {
    const branchRuns = observeBranch ? await listTaskBranchRuns(runGh, cell.rootDir, taskId!) : [];
    const listed =
        namedRuns === null && witness === null
          ? observeBranch
            ? branchRuns
            : (
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
        (witnessRun
          ? [witnessRun]
          : observeBranch
            ? selectCiBranchRuns(listed, taskId!, limit)
            : selectCiObservationRuns(listed, limit));
    const fetchResults = await Promise.all(
      runs.map(async (run): Promise<FetchedCiRunOutcome> => {
        let runAttempt = (action.attempts as Readonly<Record<string, number>> | undefined)?.[run.databaseId] ?? 1;
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
          runAttempt = summary.attempt;
          const { status: runLifecycleState } = summary;
          const expectedBranch = observeBranch ? taskId : "main";
          if (summary.headBranch !== expectedBranch || runLifecycleState !== "completed") {
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
          let apiJobs: readonly {
            readonly id: number;
            readonly name: string;
            readonly status?: string;
            readonly conclusion?: string | null;
            readonly html_url?: string;
          }[];
          {
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
                  readonly status?: string;
                  readonly conclusion?: string | null;
                  readonly html_url?: string;
                }[];
              }[]
            ).flatMap((page) => page.jobs);
            const provenanceIssues: CiProvenanceIssue[] = [];
            for (const artifact of artifacts) {
              const matching = apiJobs.filter((job) => job.name === artifact.producer.jobName);
              const checks: readonly [string, string, string][] = [
                [
                  "job",
                  "exactly one matching job",
                  matching.length === 1 ? "exactly one matching job" : String(matching.length),
                ],
                ["repository", attempt.repository.full_name, artifact.producer.repositoryId],
                ["workflow", attempt.path, artifact.producer.workflow],
                ["sha", attempt.head_sha, artifact.run.sha],
                ["runId", `${run.databaseId}.${summary.attempt}`, artifact.run.runId],
              ];
              const mismatch = checks.find(([, expected, actual]) => expected !== actual);
              if (mismatch) {
                provenanceIssues.push({
                  runId: run.databaseId,
                  attempt: summary.attempt,
                  artifactName: artifact.artifactName ?? artifact.producer.jobName,
                  field: mismatch[0],
                  expected: mismatch[1],
                  actual: mismatch[2],
                });
                continue;
              }
              const body = JSON.stringify(artifact.detail);
              jobs.push({
                artifact,
                jobExecutionId: String(matching[0]!.id),
                body,
                sha256: createHash("sha256").update(body).digest("hex"),
                measurement: ciDetailMeasurement(artifact.detail),
              });
            }
            if (provenanceIssues.length)
              return {
                fetched: {
                  databaseId: run.databaseId,
                  summary,
                  repositoryId: attempt.repository.full_name,
                  workflowPath: attempt.path,
                  workflowId: String(attempt.workflow_id),
                  jobs: [],
                  provenanceIssues,
                },
              };
            for (const job of apiJobs) {
              if (job.conclusion !== "failure" || jobs.some((prepared) => prepared.jobExecutionId === String(job.id)))
                continue;
              const log = await runGh(
                "gh",
                ["api", "--allow-escape-sequences", `repos/:owner/:repo/actions/jobs/${job.id}/logs`],
                { cwd: cell.rootDir },
              );
              const detail = ciFailureDetail(scrubCiProviderLog(log)),
                body = JSON.stringify(detail),
                artifact: CiRunArtifact = {
                  schema: "ci-run-artifact/v2",
                  run: {
                    runId: `${run.databaseId}.${summary.attempt}`,
                    sha: attempt.head_sha,
                    branch: attempt.head_branch,
                    prNumber: null,
                    job: job.name,
                    wallclockMs: 0,
                    runner: "github-actions",
                  },
                  producer: {
                    repositoryId: attempt.repository.full_name,
                    workflow: attempt.path,
                    databaseRunId: String(run.databaseId),
                    runAttempt: summary.attempt,
                    jobKey: String(job.id),
                    jobName: job.name,
                  },
                  detail,
                  gates: [],
                  measurementCoverage: {
                    status: detail.tests.length ? "partial" : "unknown",
                    missingReason: "derived from bounded provider log",
                    startedFileCount: null,
                    completedFileCount: null,
                  },
                };
              jobs.push({
                artifact,
                jobExecutionId: String(job.id),
                body,
                sha256: createHash("sha256").update(body).digest("hex"),
                measurement: ciDetailMeasurement(detail),
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
          return { failure, runId: run.databaseId, attempt: runAttempt };
        }
      }),
    );
    const unavailable: CiRunUnavailable[] = [];
    for (const result of fetchResults) {
      if (!("failure" in result)) continue;
      const detail = result.failure instanceof SyntaxError ? result.failure.message : String(result.failure);
      if (
        result.failure instanceof SyntaxError ||
        (result.failure &&
          typeof result.failure === "object" &&
          "code" in result.failure &&
          result.failure.code === "invalid_result")
      ) {
        unavailable.push({ runId: result.runId, attempt: result.attempt, reason: `CI run import rejected: ${detail}` });
        continue;
      }
      throw result.failure;
    }
    const fetched = fetchResults.flatMap((result) =>
      "fetched" in result && result.fetched !== null ? [result.fetched] : [],
    );
    if (!namedRuns) fetched.push(...privateLedgerRuns(cell));
    return {
      requestedRuns: namedRuns?.length ?? (witnessRun ? 1 : limit),
      runs: fetched,
      ...(unavailable.length ? { unavailable } : {}),
      ...(witness && witnessRun
        ? { witness: { taskId: witness.taskId, delivery: witness.delivery, databaseId: witnessRun.databaseId } }
        : {}),
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
async function fetchGitLabCiObservations(
  cell: Pick<RepoCellOperationalContext, "rootDir" | "cellCodedError" | "settings" | "input">,
  action: RepoTaskAction,
  hosting: Extract<HostingProvider, { readonly kind: "gitlab" }>,
  witness: TaskWitness | null,
  limit: number,
  namedRuns: number[] | null,
): Promise<CiObservationFetch> {
  const projectId = encodeURIComponent(hosting.projectPath),
    instanceId = typeof action.instanceId === "string" ? action.instanceId : witness?.instanceId;
  if (!instanceId)
    throw cell.cellCodedError(
      "runtime_credential_unavailable",
      `CI observer requires its daemon hosting credential. ${hostingCredentialConfigurationAdvice("gitlab")}.`,
    );
  const environment = await cell.input.prepareDaemonGitEnvironment?.(instanceId, "gitlab");
  const token = environment?.GITLAB_TOKEN ?? environment?.HARNESS_GITLAB_TOKEN;
  if (!token)
    throw cell.cellCodedError(
      "runtime_credential_unavailable",
      "The dispatch instance has no configured GitLab credential. " +
        `${hostingCredentialConfigurationAdvice("gitlab", instanceId)}.`,
    );
  const request = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${hosting.apiBaseUrl}/projects/${projectId}${path}`, {
      headers: { "PRIVATE-TOKEN": token },
    });
    if (!response.ok)
      throw cell.cellCodedError(
        "task_ci_read_failed",
        `GitLab API ${response.status}: ${(await response.text()).slice(0, 512)}`,
      );
    return (path.endsWith("/trace") ? await response.text() : await response.json()) as T;
  };
  type Pipeline = {
    id: number;
    status: string;
    ref: string;
    sha: string;
    created_at: string;
    source?: string;
    web_url?: string;
  };
  let pipelines: readonly Pipeline[];
  if (namedRuns) {
    pipelines = await Promise.all(namedRuns.map((id) => request<Pipeline>(`/pipelines/${id}`)));
  } else if (witness) {
    pipelines = await request<readonly Pipeline[]>(
      `/pipelines?sha=${encodeURIComponent(witness.delivery)}&ref=${encodeURIComponent(witness.options.branch)}&per_page=100`,
    );
  } else {
    const ref = action.observeBranch === true && typeof action.taskId === "string" ? action.taskId : "main";
    pipelines = await request<readonly Pipeline[]>(`/pipelines?ref=${encodeURIComponent(ref)}&per_page=${limit}`);
  }
  const selected = [...pipelines]
    .filter((pipeline) => !witness || pipeline.ref === witness.options.branch)
    .filter((pipeline) => !witness || pipeline.sha === witness.delivery)
    .filter((pipeline) => !witness || (pipeline.source ?? "push") === witness.options.event)
    .sort((a, b) => b.id - a.id)
    .slice(0, witness ? 1 : limit);
  const runs = await Promise.all(
    selected.map(async (pipeline): Promise<FetchedCiRun> => {
      const jobs = await request<readonly { id: number; name: string; status: string; web_url?: string }[]>(
        `/pipelines/${pipeline.id}/jobs?per_page=100`,
      );
      const preparedJobs: PreparedCiJob[] = await Promise.all(
        jobs.map(async (job) => {
          const trace =
            job.status === "failed"
              ? (await request<string>(`/jobs/${job.id}/trace`)).replaceAll(token, "[REDACTED]")
              : "";
          const detail = trace ? ciFailureDetail(scrubCiProviderLog(trace, [token])) : ciFailureDetail("");
          const body = JSON.stringify(detail),
            sha256 = createHash("sha256").update(body).digest("hex");
          const artifact: CiRunArtifact = {
            schema: "ci-run-artifact/v2",
            run: {
              runId: String(pipeline.id),
              sha: pipeline.sha,
              branch: pipeline.ref,
              prNumber: null,
              job: job.name,
              wallclockMs: 0,
              runner: "gitlab-pipeline",
            },
            producer: {
              repositoryId: `${hosting.host}/${hosting.projectPath}`,
              workflow: ".gitlab-ci.yml",
              databaseRunId: String(pipeline.id),
              runAttempt: pipeline.id,
              jobKey: String(job.id),
              jobName: job.name,
            },
            detail,
            gates: [],
            measurementCoverage: {
              status: detail.tests.length ? "partial" : "unknown",
              missingReason: trace ? "derived from bounded provider log" : null,
              startedFileCount: null,
              completedFileCount: null,
            },
          };
          return {
            artifact,
            jobExecutionId: String(job.id),
            body,
            sha256,
            measurement: ciDetailMeasurement(detail),
          };
        }),
      );
      return {
        databaseId: pipeline.id,
        summary: {
          workflowName: ".gitlab-ci.yml",
          headSha: pipeline.sha,
          headBranch: pipeline.ref,
          status: pipeline.status === "success" || pipeline.status === "failed" ? "completed" : pipeline.status,
          conclusion:
            pipeline.status === "success" ? "success" : pipeline.status === "failed" ? "failure" : pipeline.status,
          attempt: 1,
          event: pipeline.source ?? "push",
        },
        repositoryId: `${hosting.host}/${hosting.projectPath}`,
        workflowPath: ".gitlab-ci.yml",
        workflowId: null,
        jobs: preparedJobs,
        provider: "gitlab-pipeline",
      };
    }),
  );
  return {
    requestedRuns: namedRuns?.length ?? limit,
    runs,
    ...(witness && selected[0]
      ? { witness: { taskId: witness.taskId, delivery: witness.delivery, databaseId: selected[0].id } }
      : {}),
  };
}
export function ingestCiObservations(
  cell: RepoCellActionContext,
  binding: RepoCellBinding,
  fetched: CiObservationFetch,
): WriteReceipt {
  const eventRefs: string[] = [];
  const unavailable: CiRunUnavailable[] = [];
  let imported = 0,
    duplicate = 0,
    lastRevision = cell.store.readHead()?.revision ?? 0;
  for (const {
    databaseId,
    summary,
    repositoryId,
    workflowPath,
    workflowId,
    jobs,
    attemptInventory,
    provider = "github-actions",
  } of fetched.runs) {
    const identity: CiObservationIdentity = {
      provider: databaseId === 0 ? "write-coordinator" : provider,
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
      runner: databaseId === 0 ? "write-coordinator" : provider,
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
        : summary.headBranch === "main"
          ? {
              source: provider,
              workflow: summary.workflowName,
              runId: String(databaseId),
              attempt: summary.attempt,
              headSha: summary.headSha,
              conclusion: summary.conclusion,
              event: summary.event,
            }
          : null;
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
    for (const { payload } of payloads) {
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
      const existing = cell.store.readEvent(`ci-observation-${digest}`);
      if (
        existing &&
        JSON.stringify(canonicalizeContractValue(existing.payload)) !==
          JSON.stringify(canonicalizeContractValue(payload))
      )
        throw cell.cellCodedError("op_conflict", "CI observation identity has conflicting content.");
    }
    const validationErrors = payloads.flatMap(({ payload }) => {
      const candidate: CiRunObservationEventV4 = {
        schema: "ci-run-observation/v4",
        eventId: "event-validation",
        workspaceRevision: 1,
        opId: "ci-observation-validation",
        type: "ci_run_observed",
        actor: binding.actor,
        source: binding.source,
        occurredAt: cell.now(),
        payload,
      };
      return validateCurrentCiRunObservationEvent(candidate);
    });
    if (validationErrors.length) {
      unavailable.push({
        runId: databaseId,
        attempt: summary.attempt,
        reason: `CI run import rejected: ${validationErrors.join("; ")}`,
      });
      continue;
    }
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
      ...(unavailable.length ? { unavailable } : {}),
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
/** Prepare the existing private-ledger witness; the occurrence owns its acceptance too. */
export function privateLedgerCiObservations(cell: Pick<RepoCellOperationalContext, "rootDir">): CiObservationFetch {
  return { requestedRuns: 0, runs: privateLedgerRuns(cell) };
}
function privateLedgerRuns(cell: Pick<RepoCellOperationalContext, "rootDir">): readonly FetchedCiRun[] {
  const authoredRoot = resolveHarnessLayout(cell.rootDir).authoredRoot;
  if (existsSync(authoredRoot)) {
    const branch = localGitObjectRefStore.currentBranch(authoredRoot),
      sha = branch ? localGitObjectRefStore.resolveCommit(authoredRoot, `refs/heads/${branch}`) : null;
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
export type { CiArtifactMetadata } from "./ci-observation-provider.ts";
export { listCiArtifacts } from "./ci-observation-provider.ts";
export { runCiProviderCommand } from "./ci-observation-provider.ts";
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
    return {
      artifacts: artifacts.flatMap((artifact) =>
        completed.get(artifact.id)!.map((entry) => ({ ...entry, artifactName: artifact.name })),
      ),
      unavailable: false,
    };
  } catch (error) {
    if (isTransientCiProviderFailure(error)) throw error;
    partialCiDownloads.delete(key);
    if (isFatalCiProviderFailure(error)) throw error;
    if (!/\bHTTP [45]\d\d\b|Not Found/iu.test(ghFailureDetail(error))) throw error;
    consumeKnownError(error);
    return { artifacts: [], unavailable: true };
  }
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
