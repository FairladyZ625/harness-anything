// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createScheduleV1, makeTaskEventStore, makeTaskProjection } from "@harness-anything/kernel";
import { withTempStoreAsync } from "../../kernel/test/store/helpers.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { reconcileCiOccurrence } from "../src/ci-observe-importer.ts";
import { ingestCiObservations, type RunGh } from "../src/ci-observation-actions.ts";
import { githubActionsWitnessEvidence } from "../src/repo-cell-ci-evidence.ts";
import { projectionReady } from "../src/repo-cell-settlement.ts";

const binding = withPolicyGroup(
  { actor: { principal: { personId: "priority-owner" }, executor: null }, source: "local" },
  "admin",
);
const now = "2026-10-09T10:00:00.000Z";
function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

test("a submitted CI cut survives center reopen and is accepted before 60 pending runs or page settlement", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.name", "Priority Fixture");
    git(rootDir, "config", "user.email", "priority@example.invalid");
    git(rootDir, "commit", "--allow-empty", "-qm", "fixture base");
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "harness/harness.yaml"),
      "settings:\n  ci:\n    workflows: [rewrite-ci]\n  gates:\n    ci:\n      appliesTo: code\n      adapter: github-actions\n      branch: main\n      event: push\n      coverage: exact\n      selection: newest\n",
    );
    const repoId = "priority-fixture",
      taskId = "task-priority";
    const center = await openBootstrappedRepoCell({
      repoId: workspaceId(repoId),
      rootDir: canonicalRoot(rootDir),
      ownerId: "priority",
    });
    let delivery = "";
    try {
      const created = await center.run({ kind: "task-create", taskId, title: "Priority witness" }, binding);
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      const packagePath = String((created as unknown as { packagePath: string }).packagePath);
      await realizeTaskPlanFixture(rootDir, packagePath, (planPath: string) =>
        center.run({ kind: "doc-submit", paths: [planPath] }, binding),
      );
      assert.equal(
        (await center.run({ kind: "task-start", taskId, executionId: "priority-execution" }, binding)).outcome,
        "applied",
      );
      await center.settlePendingMaterialization("fixture delivery");
      const deliveryRoot = path.join(rootDir, ".worktrees", taskId);
      writeFileSync(path.join(deliveryRoot, "README.md"), "# Priority\n");
      git(deliveryRoot, "add", "README.md");
      git(deliveryRoot, "commit", "-qm", "test: delivery");
      delivery = git(deliveryRoot, "rev-parse", "HEAD");
      writeFileSync(
        path.join(rootDir, "harness", packagePath, "closeout.md"),
        `# Closeout\n\n## Summary\n\nDelivery ${delivery}.\n\n## Verification\n\nFixture verified.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNone.\n`,
      );
      const submitted = await center.run({ kind: "task-submit", taskId }, binding);
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    } finally {
      await center.close();
    }
    // A fresh projection has only the persisted submission, with no process-local request queue.
    const store = makeTaskEventStore({ rootDir, repoId });
    let projection = makeTaskProjection({ rootDir, eventStore: store });
    const cell = {
      rootDir,
      store,
      projection,
      projectionReady,
      now: () => now,
      settings: { read: () => ({ ci: { workflows: ["unused-current-setting"] } }) },
      cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    };
    const schedule = createScheduleV1({
      scheduleId: "builtin-ci-observe",
      name: "CI",
      mode: "detect",
      state: "armed",
      actor: binding.actor,
      occurredAt: now,
      spec: {
        trigger: { kind: "interval", everyMs: 60_000, anchorAt: now },
        target: { kind: "builtin", builtinId: "ci-observe" },
        mission: "Priority",
      },
    });
    const progress = {
      workflow: "unused-current-setting",
      workflowIndex: 0,
      scanPass: 0,
      nextPage: 1,
      nextRunId: null,
      nextAttempt: 1,
      pending: Array.from({ length: 60 }, (_, i) => ({ runId: i + 1, attempt: 1, workflow: "rewrite-ci" })),
      unavailable: [],
      lastCompletedScanAt: null,
      error: null,
      retryAt: null,
    };
    const seen: number[] = [];
    const evidence = () => {
      const snapshot = projection.read(taskId).snapshot;
      const execution = snapshot.executions.find((entry) => entry.submission !== null)!;
      const requirement = execution.submission!.completionContract.gates.find(
        (entry) => entry.witness.adapterId === "github-actions",
      )!;
      return githubActionsWitnessEvidence(cell as never, requirement, execution);
    };
    const gh: RunGh = async (_command, args) => {
      const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (endpoint.includes("actions/runs?head_sha=")) {
        assert.ok(endpoint.includes(delivery), "use the persisted delivery cut");
        return JSON.stringify([
          {
            databaseId: 900,
            path: ".github/workflows/rewrite-ci.yml",
            headBranch: "main",
            event: "push",
            status: "completed",
            conclusion: "success",
          },
        ]);
      }
      if (args[0] === "run" && args[1] === "view") {
        seen.push(Number(args[2]));
        return JSON.stringify({
          workflowName: "rewrite-ci",
          headSha: delivery,
          headBranch: "main",
          event: "push",
          status: "completed",
          conclusion: "success",
          attempt: 1,
        });
      }
      if (endpoint.includes("/artifacts?") || (args[0] === "run" && args[1] === "download"))
        assert.fail("task witness must not wait for diagnostic artifacts");
      if (endpoint.includes("/jobs?")) assert.fail("task witness requires no diagnostic job inventory");
      if (endpoint.includes("/attempts/")) {
        const run = Number(endpoint.split("/")[5]);
        if (run !== 900) {
          assert.equal(seen[0], 900, "the witness must precede the 60 pending targets");
          assert.equal(evidence()?.result, "pass", "completion can read the witness before the scan finishes");
          // Reopen again before settlement: acceptance, not the occurrence cursor, owns durability.
          projection.close();
          projection = makeTaskProjection({ rootDir, eventStore: store });
          cell.projection = projection;
          assert.equal(evidence()?.provenance.runId, "900.1");
          throw new Error("fixture interrupts remaining scan before settlement");
        }
        return JSON.stringify({
          name: "rewrite-ci",
          head_sha: delivery,
          head_branch: "main",
          event: "push",
          status: "completed",
          conclusion: "success",
          run_attempt: 1,
          path: ".github/workflows/rewrite-ci.yml",
          workflow_id: 1,
          repository: { full_name: "fixture/repository" },
        });
      }
      throw new Error(`unexpected gh call ${args.join(" ")}`);
    };
    try {
      const noRun = await reconcileCiOccurrence({
        cell: cell as never,
        schedule,
        requests: () => [],
        gh: async (_command, args) =>
          args.some((arg) => arg.includes("actions/runs?head_sha=")) ? "[]" : JSON.stringify({ workflow_runs: [] }),
        accept: async (fetched) => ingestCiObservations(cell as never, binding, fetched),
      });
      assert.equal(noRun.outcome, "succeeded", "a cut with no completed covering run permits diagnostics");
      assert.equal(evidence(), null, "absence must not fabricate a witness");
      for (const detail of [
        "HTTP 401 authentication required",
        "HTTP 403 forbidden",
        "HTTP 429 rate limit",
        "EIO local IO ECONNRESET",
      ]) {
        const fatal = await reconcileCiOccurrence({
          cell: cell as never,
          schedule,
          requests: () => [],
          gh: async () => {
            throw new Error(detail);
          },
          accept: async (fetched) => ingestCiObservations(cell as never, binding, fetched),
        });
        assert.equal(fatal.outcome, "failed");
        if (detail.includes("429")) assert.match(fatal.detail, /GitHub rate-limited/u);
        else assert.equal(fatal.detail, detail);
      }
      // A transient priority fetch leaves its durable submission for the next occurrence,
      // while the other targets and the workflow page still make progress.
      const continued: string[] = [];
      const transient = await reconcileCiOccurrence({
        cell: cell as never,
        schedule: {
          ...schedule,
          status: {
            ...schedule.status,
            ciObserve: {
              ...progress,
              pending: [{ runId: 901, attempt: 1, workflow: "rewrite-ci" }],
            },
          },
        },
        requests: () => [],
        gh: async (command, args, options) => {
          const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
          if (endpoint.includes("actions/runs?head_sha=")) {
            continued.push("submission");
            throw new Error("read ECONNRESET");
          }
          if (endpoint.includes("actions/workflows/")) {
            continued.push("page");
            return JSON.stringify({
              workflow_runs: [
                {
                  id: 902,
                  run_attempt: 1,
                  head_branch: "main",
                  status: "in_progress",
                },
              ],
            });
          }
          if (endpoint.includes("/runs/901/attempts/")) {
            continued.push("pending");
            return JSON.stringify({
              name: "rewrite-ci",
              head_sha: delivery,
              head_branch: "main",
              event: "push",
              status: "in_progress",
              conclusion: null,
              run_attempt: 1,
              path: ".github/workflows/rewrite-ci.yml",
              workflow_id: 1,
              repository: { full_name: "fixture/repository" },
            });
          }
          return gh(command, args, options);
        },
        accept: async (fetched) => ingestCiObservations(cell as never, binding, fetched),
      });
      assert.equal(transient.outcome, "succeeded", transient.detail);
      assert.deepEqual(continued, ["submission", "pending", "page"]);
      assert.equal(transient.ciObserve?.nextPage, 2);
      assert.deepEqual(
        transient.ciObserve?.pending.map((entry) => entry.runId),
        [901, 902],
      );
      assert.equal(evidence(), null, "transient failure must not publish a witness");
      t.diagnostic(
        JSON.stringify({ transient: transient.outcome, continued, nextPage: transient.ciObserve?.nextPage }),
      );
      seen.length = 0;
      const result = await reconcileCiOccurrence({
        cell: cell as never,
        schedule: { ...schedule, status: { ...schedule.status, ciObserve: progress } },
        requests: () => [],
        gh,
        accept: async (fetched) => ingestCiObservations(cell as never, binding, fetched),
      });
      assert.equal(result.outcome, "failed", "scan interruption does not fabricate successful settlement");
      assert.deepEqual(seen, [900]);
      assert.equal(evidence()?.result, "pass");
      t.diagnostic(
        JSON.stringify({
          firstRun: seen[0],
          pending: 60,
          beforeSettlement: evidence()?.result,
          reopenedRun: evidence()?.provenance.runId,
        }),
      );
      // A later center occurrence derives no work for the already passing submission.
      let calls = 0;
      const second = await reconcileCiOccurrence({
        cell: cell as never,
        schedule,
        requests: () => [],
        gh: async () => {
          calls++;
          return JSON.stringify({ workflow_runs: [] });
        },
        accept: async (fetched) => ingestCiObservations(cell as never, binding, fetched),
      });
      assert.equal(second.outcome, "succeeded", second.detail);
      assert.equal(calls, 1, "only the scan page, no repeated witness fetch");
    } finally {
      projection.close();
    }
  });
});
