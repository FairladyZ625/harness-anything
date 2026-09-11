import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ciRunObservationWritePlan,
  consumeKnownError,
  validateCurrentCiRunObservationEvent,
  type CiRunObservationEventV2,
  type CiRunObservationEventV3,
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
type CiRunSummary = {
  readonly workflowName: string;
  readonly headSha: string;
  readonly headBranch: string;
  readonly status: string;
  readonly conclusion: string;
  readonly attempt: number;
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
  cell: Pick<RepoCellOperationalContext, "rootDir" | "cellCodedError" | "settings">,
  action: RepoTaskAction,
  runGh: RunGh = (command, args, options) => runProcessTextAsync(command, args, options.cwd),
): Promise<CiObservationFetch> {
  const limit = Number(action.limit ?? 20),
    namedRuns = Array.isArray(action.runs) ? action.runs.map(Number) : null,
    workflows = cell.settings.read().ci.workflows;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw cell.cellCodedError("invalid_command", "CI observation pull limit must be 1..100.");
  if (namedRuns && action.limit !== undefined)
    throw cell.cellCodedError("invalid_command", "Use --run <run-id> or --limit <count>, not both.");
  if (namedRuns && (namedRuns.length > 100 || namedRuns.some((id) => !Number.isSafeInteger(id) || id < 1)))
    throw cell.cellCodedError("invalid_command", "CI observation pull accepts 1..100 positive --run ids.");
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "ha-ci-observe-"));
  try {
    const runs: readonly Pick<CiWorkflowRun, "databaseId">[] =
      namedRuns?.map((databaseId) => ({ databaseId })) ??
      selectCiObservationRuns(
        (
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
                      "databaseId,headBranch,createdAt",
                    ],
                    { cwd: cell.rootDir },
                  ),
                ) as readonly CiWorkflowRun[],
            ),
          )
        ).flat(),
        limit,
      );
    const fetched: FetchedCiRun[] = [];
    for (const run of runs) {
      const summary = JSON.parse(
        await runGh(
          "gh",
          [
            "run",
            "view",
            String(run.databaseId),
            "--json",
            "workflowName,headSha,headBranch,status,conclusion,attempt",
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
        continue;
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
        consumeKnownError(error);
        continue;
      }
      fetched.push({ databaseId: run.databaseId, summary, artifacts: readArtifacts(runRoot) });
    }
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
    return { requestedRuns: namedRuns?.length ?? limit, workflows, runs: fetched };
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
    summary: `Imported ${imported} CI observation artifact(s); ${duplicate} already existed.\n` + eventRefs.join("\n"),
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
