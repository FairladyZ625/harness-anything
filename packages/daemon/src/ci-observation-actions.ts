import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ciRunObservationWritePlan,
  consumeKnownError,
  isNativeCommitSha,
  validateCurrentCiRunObservationEvent,
  type CiRunObservationEventV2,
  type CiRunObservationEventV3,
  type TaskProjection,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { runProcessTextAsync } from "./process-port.ts";
import { localGitObjectRefStore, resolveHarnessLayout } from "../../kernel/src/index.ts";
import type { RepoCellActionContext, RepoCellOperationalContext } from "./repo-cell-action-context.ts";

type CiRunArtifactGate =
  | CiRunObservationEventV3["payload"]["gates"][number]
  | CiRunObservationEventV2["payload"]["gates"][number];
type CiRunArtifact = Omit<CiRunObservationEventV3["payload"], "verification" | "gates"> & {
  readonly schema: "ci-run-artifact/v1";
  readonly gates: readonly CiRunArtifactGate[];
};
type CiWorkflowRun = { readonly databaseId: number; readonly headBranch: string; readonly createdAt: string };
type CiRunListEntry = CiWorkflowRun & {
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | null;
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
type RunGh = (command: string, args: readonly string[], options: { readonly cwd: string }) => Promise<string>;
type FetchedCiRun = {
  readonly databaseId: number;
  readonly summary: CiRunSummary;
  readonly artifacts: readonly CiRunArtifact[];
};
type CiObservationFetch = {
  readonly requestedRuns: number;
  readonly workflows: readonly string[];
  readonly runs: readonly FetchedCiRun[];
};

// Every gh call finishes before the pull enters the repository write queue: GitHub can stall
// without bound, and the queue waits only on the event appends in ingestCiObservations.
export async function fetchCiObservations(
  cell: Pick<RepoCellOperationalContext, "rootDir" | "cellCodedError" | "settings"> & {
    readonly projection?: Pick<TaskProjection, "read">;
  },
  action: RepoTaskAction,
  runGh: RunGh = (command, args, options) => runProcessTextAsync(command, args, options.cwd),
): Promise<CiObservationFetch> {
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
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "ha-ci-observe-"));
  try {
    const listed =
        namedRuns === null
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
                          "databaseId,headBranch,headSha,createdAt,status,conclusion",
                        ],
                        { cwd: cell.rootDir },
                      ),
                    ) as readonly CiRunListEntry[],
                ),
              )
            ).flat()
          : [],
      witnessRuns = taskId === null ? null : await selectTaskWitnessRun(cell, taskId, listed, runGh),
      runs: readonly Pick<CiWorkflowRun, "databaseId">[] =
        namedRuns?.map((databaseId) => ({ databaseId })) ?? witnessRuns ?? selectCiObservationRuns(listed, limit);
    const fetchResults = await Promise.all(
      runs.map(async (run): Promise<{ fetched: FetchedCiRun | null } | { failure: unknown }> => {
        try {
          const summary = JSON.parse(
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
          ) as CiRunSummary;
          const { status: runLifecycleState } = summary;
          // Publish immutable observations only for main runs that have a final conclusion.
          if (summary.headBranch !== "main" || runLifecycleState !== "completed") {
            if (namedRuns)
              throw cell.cellCodedError(
                "invalid_command",
                `CI run ${run.databaseId} is ${runLifecycleState} on ${summary.headBranch}; ` +
                  "only completed main runs can be imported.",
              );
            return { fetched: null };
          }
          const runRoot = path.join(temporaryRoot, String(run.databaseId));
          try {
            await runGh(
              "gh",
              ["run", "download", String(run.databaseId), "--pattern", "ci-observation-*", "--dir", runRoot],
              {
                cwd: cell.rootDir,
              },
            );
          } catch (error) {
            // A run without ci-observation-* artifacts fails the download; whatever landed is used below.
            consumeKnownError(error);
          }
          // The run conclusion is the completion verdict; a run that uploads no artifacts still
          // yields one observation synthesized from its summary (tests/gates stay empty).
          const artifacts = readArtifacts(runRoot);
          return {
            fetched: {
              databaseId: run.databaseId,
              summary,
              artifacts: artifacts.length
                ? artifacts
                : [
                    {
                      schema: "ci-run-artifact/v1",
                      run: {
                        runId: `${run.databaseId}.${summary.attempt}`,
                        sha: summary.headSha,
                        branch: summary.headBranch,
                        prNumber: null,
                        job: summary.workflowName,
                        wallclockMs: 0,
                        runner: "github-actions",
                      },
                      tests: [],
                      gates: [],
                    },
                  ],
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
    if (!namedRuns) {
      const authoredRoot = resolveHarnessLayout(cell.rootDir).authoredRoot;
      if (existsSync(authoredRoot)) {
        const branch = localGitObjectRefStore.currentBranch(authoredRoot),
          sha = branch ? localGitObjectRefStore.resolveCommit(authoredRoot, `refs/heads/${branch}`) : null;
        // A ledger commit that is also in the public repository belongs to the
        // GitHub observation path; synthesize only for private-ledger commits. `git rev-parse`
        // echoes any 40-hex string back, so existence must be asked with `cat-file -e`.
        if (branch && sha && !localGitObjectRefStore.hasCommit(cell.rootDir, sha))
          fetched.push({
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
            artifacts: [
              {
                schema: "ci-run-artifact/v1",
                run: {
                  runId: `ledger-${sha}`,
                  sha,
                  branch,
                  prNumber: null,
                  job: "ledger-publication",
                  wallclockMs: 0,
                  runner: "write-coordinator",
                },
                tests: [],
                gates: [],
              },
            ],
          });
      }
    }
    return { requestedRuns: namedRuns?.length ?? witnessRuns?.length ?? limit, workflows, runs: fetched };
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
  for (const { databaseId, summary, artifacts } of fetched.runs)
    for (const artifact of artifacts) {
      const digest = createHash("sha256")
          .update(`verified-v3\u0000${artifact.run.runId}\u0000${artifact.run.job}`)
          .digest("hex"),
        opId = `ci-observation-${digest}`;
      if (cell.store.readEvent(opId)) {
        duplicate += 1;
        eventRefs.push(`event:${opId}`);
        continue;
      }
      const event: CiRunObservationEventV3 = {
          schema: "ci-run-observation/v3",
          eventId: `event-${digest}`,
          workspaceRevision: (cell.store.readHead()?.revision ?? 0) + 1,
          opId,
          type: "ci_run_observed",
          actor: binding.actor,
          source: binding.source,
          occurredAt: cell.now(),
          payload: {
            run: artifact.run,
            tests: artifact.tests,
            gates: normalizeArtifactGates(artifact.gates),
            verification:
              summary.workflowName === "ledger-publication"
                ? {
                    source: "write-coordinator" as const,
                    workflow: "ledger-publication" as const,
                    runId: artifact.run.runId,
                    attempt: 1,
                    headSha: summary.headSha,
                    conclusion: "success",
                  }
                : fetched.workflows.includes(summary.workflowName) &&
                    summary.headBranch === "main" &&
                    artifact.run.branch === "main" &&
                    artifact.run.sha === summary.headSha &&
                    artifact.run.runId === `${databaseId}.${summary.attempt}`
                  ? {
                      source: "github-actions",
                      workflow: summary.workflowName,
                      runId: String(databaseId),
                      attempt: summary.attempt,
                      headSha: summary.headSha,
                      conclusion: summary.conclusion,
                      event: summary.event,
                    }
                  : null,
          },
        },
        errors = validateCurrentCiRunObservationEvent(event);
      if (errors.length) throw cell.cellCodedError("invalid_command", errors.join("; "));
      const plan = ciRunObservationWritePlan(event),
        appended = cell.store.append({ event, plan, blobs: [] });
      cell.projection.apply(event, plan);
      lastRevision = appended.revision;
      imported += 1;
      eventRefs.push(`event:${opId}`);
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
    summary: `Imported ${imported} CI observation(s); ${duplicate} already existed.\n` + eventRefs.join("\n"),
  } as WriteReceipt;
}

function normalizeArtifactGates(gates: readonly CiRunArtifactGate[]): CiRunObservationEventV3["payload"]["gates"] {
  return gates.map((gate) =>
    "result" in gate ? gate : { gate: gate.gate, result: gate.pass ? "pass" : "fail", metrics: gate.metrics },
  );
}

export function selectCiObservationRuns(runs: readonly CiWorkflowRun[], limit: number): readonly CiWorkflowRun[] {
  return runs
    .filter((run) => run.headBranch === "main")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.databaseId - left.databaseId)
    .slice(0, limit);
}

// --task resolves the submitted execution's delivery commit, then walks completed main runs
// newest-first and takes the first covering run whose conclusion is success; covering
// cancelled/failure runs are skipped so callers never retry the same mechanical step.
async function selectTaskWitnessRun(
  cell: {
    readonly rootDir: string;
    readonly cellCodedError: RepoCellOperationalContext["cellCodedError"];
    readonly projection?: Pick<TaskProjection, "read">;
  },
  taskId: string,
  listed: readonly CiRunListEntry[],
  runGh: RunGh,
): Promise<readonly Pick<CiWorkflowRun, "databaseId">[]> {
  const snapshot = cell.projection?.read(taskId).snapshot,
    delivery = snapshot?.executions.find(
      (candidate) => candidate.iteration === snapshot.task?.iteration && candidate.submission !== null,
    )?.submission?.commitSha;
  if (!isNativeCommitSha(delivery))
    throw cell.cellCodedError(
      "ci_witness_delivery_unresolved",
      `Task ${taskId} has no submitted execution with a delivery commit. ` +
        `next: submit the task delivery, then retry ha ci observe pull --task ${taskId}.`,
    );
  const mainRuns = listed
      .filter((run) => run.headBranch === "main")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.databaseId - left.databaseId),
    completed = mainRuns.filter((run) => run.status === "completed"),
    pending = mainRuns.filter((run) => run.status !== "completed");
  for (const run of completed)
    if (run.conclusion === "success" && (await coversCommit(runGh, cell.rootDir, delivery, run.headSha)))
      return [{ databaseId: run.databaseId }];
  for (const run of pending)
    if (await coversCommit(runGh, cell.rootDir, delivery, run.headSha))
      throw cell.cellCodedError(
        "ci_witness_not_found",
        `No completed successful main CI run covers delivery ${delivery} of ${taskId}. ` +
          `next: run ${run.databaseId} is ${run.status}; retry after it concludes.`,
      );
  throw cell.cellCodedError(
    "ci_witness_not_found",
    `No completed successful main CI run covers delivery ${delivery} of ${taskId}. ` +
      "next: no covering run exists yet; retry after the next main run completes.",
  );
}

// A main run covers the delivery when the delivery commit is an ancestor of the run head:
// GitHub compare reports "ahead"/"identical" only when base is contained in head's history.
async function coversCommit(runGh: RunGh, cwd: string, base: string, head: string): Promise<boolean> {
  const compare = JSON.parse(await runGh("gh", ["api", `repos/:owner/:repo/compare/${base}...${head}`], { cwd })) as {
    readonly status?: string;
  };
  return compare.status === "ahead" || compare.status === "identical";
}

function readArtifacts(root: string): readonly CiRunArtifact[] {
  return walk(root)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(file, "utf8")))
    .filter(
      (value) =>
        value?.schema === "ci-run-artifact/v1" && value.run && Array.isArray(value.tests) && Array.isArray(value.gates),
    );
}

function walk(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}
