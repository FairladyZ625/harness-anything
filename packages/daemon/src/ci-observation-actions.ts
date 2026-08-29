import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ciRunObservationWritePlan,
  consumeKnownError,
  validateCurrentCiRunObservationEvent,
  type CiRunObservationEventV1,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { runProcessTextAsync } from "./process-port.ts";
import type { RepoCellActionContext } from "./repo-cell-action-context.ts";

type CiRunArtifact = CiRunObservationEventV1["payload"] & { readonly schema: "ci-run-artifact/v1" };
type CiWorkflowRun = { readonly databaseId: number; readonly headBranch: string; readonly createdAt: string };
type RunGh = (command: string, args: readonly string[], options: { readonly cwd: string }) => Promise<string>;

export async function pullAndIngestCiObservations(
  cell: RepoCellActionContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  runGh: RunGh = (command, args, options) => runProcessTextAsync(command, args, options.cwd),
): Promise<WriteReceipt> {
  const limit = Number(action.limit ?? 20);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw cell.cellCodedError("invalid_command", "CI observation pull limit must be 1..100.");
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "ha-ci-observe-"));
  try {
    const runs = selectCiObservationRuns(
      (
        await Promise.all(
          ["rewrite-ci.yml", "rebuild-gates.yml"].map(
            async (workflow) =>
              JSON.parse(
                await runGh(
                  "gh",
                  [
                    "run",
                    "list",
                    "--workflow",
                    workflow,
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
    let imported = 0,
      duplicate = 0,
      lastRevision = cell.store.readHead()?.revision ?? 0;
    for (const run of runs) {
      if (run.headBranch !== "main") continue;
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
      for (const artifact of readArtifacts(runRoot)) {
        const digest = createHash("sha256").update(`${artifact.run.runId}\u0000${artifact.run.job}`).digest("hex"),
          opId = `ci-observation-${digest}`;
        if (cell.store.readEvent(opId)) {
          duplicate += 1;
          continue;
        }
        const event: CiRunObservationEventV1 = {
            schema: "ci-run-observation/v1",
            eventId: `event-${digest}`,
            workspaceRevision: (cell.store.readHead()?.revision ?? 0) + 1,
            opId,
            type: "ci_run_observed",
            actor: binding.actor,
            source: binding.source,
            occurredAt: cell.now(),
            payload: { run: artifact.run, tests: artifact.tests, gates: artifact.gates },
          },
          errors = validateCurrentCiRunObservationEvent(event);
        if (errors.length) throw cell.cellCodedError("invalid_command", errors.join("; "));
        const plan = ciRunObservationWritePlan(event),
          appended = cell.store.append({ event, plan, blobs: [] });
        cell.projection.apply(event, plan);
        lastRevision = appended.revision;
        imported += 1;
      }
    }
    const appliedCut = cell.projection.readCiRunObservations(1).watermark,
      visible = appliedCut >= lastRevision;
    return {
      outcome: visible ? "applied" : "pending",
      opId: `ci-observe-pull-${Date.now()}`,
      revision: lastRevision,
      evidence: JSON.stringify({ schema: "ci-observe-pull/v1", imported, duplicate, requestedRuns: limit }),
      visibility: "center",
      proof: {
        committedRevision: lastRevision,
        appliedCut,
        durable: true,
        canonicalVisible: visible,
        worktreeVisible: false,
      },
      summary: `Imported ${imported} CI observation artifact(s); ${duplicate} already existed.`,
      ...(visible ? {} : { nextAction: "Retry after the CI observation projection catches up." }),
    } as WriteReceipt;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
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
