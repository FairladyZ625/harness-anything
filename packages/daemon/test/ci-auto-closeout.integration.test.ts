// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { withTempStoreAsync } from "../../kernel/test/store/helpers.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { builtinCiObserveScheduleId, seedBuiltinSchedules } from "../src/schedule-builtin-executor.ts";

const binding = withPolicyGroup(
  { actor: { principal: { personId: "closeout-owner" }, executor: null }, source: "local" },
  "admin",
);
const reviewer = withPolicyGroup(
  { actor: { principal: { personId: "reviewer" }, executor: null }, source: "local" },
  "maintainer",
);
function git(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

test("merged approved cuts resume completion after red becomes green, without manufacturing consent", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.name", "Closeout Fixture");
    git(rootDir, "config", "user.email", "closeout@example.invalid");
    git(rootDir, "commit", "--allow-empty", "-qm", "fixture base");
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "harness/harness.yaml"),
      "settings:\n  ci:\n    workflows: [rewrite-ci]\n  gates:\n    ci:\n      appliesTo: code\n      adapter: github-actions\n      branch: main\n      event: push\n      coverage: descendant\n      selection: newest\n",
    );
    const repoId = "auto-closeout",
      taskId = "task-merged",
      executionId = "exe-merged";
    const originalWip = process.env.HARNESS_TASK_WIP_LIMIT;
    process.env.HARNESS_TASK_WIP_LIMIT = "1";
    const originalPath = process.env.PATH,
      bin = path.join(rootDir, "bin"),
      statePath = path.join(rootDir, "provider.json");
    mkdirSync(bin);
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
    const center = await openBootstrappedRepoCell({
      repoId: workspaceId(repoId),
      rootDir: canonicalRoot(rootDir),
      ownerId: "closeout",
    });
    const applied = (receipt: { outcome: string }) => assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    try {
      const created = await center.run({ kind: "task-create", taskId, title: "Merged cut" }, binding);
      applied(created);
      const packagePath = String((created as unknown as { packagePath: string }).packagePath);
      await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
        center.run({ kind: "doc-submit", paths: [planPath] }, binding),
      );
      applied(await center.run({ kind: "task-start", taskId, executionId }, binding));
      await center.settlePendingMaterialization("fixture delivery");
      const deliveryRoot = path.join(rootDir, ".worktrees", taskId);
      writeFileSync(path.join(deliveryRoot, "README.md"), "# Closeout\n");
      git(deliveryRoot, "add", "README.md");
      git(deliveryRoot, "commit", "-qm", "test: delivery");
      const delivery = git(deliveryRoot, "rev-parse", "HEAD");
      git(rootDir, "update-ref", "refs/remotes/origin/main", delivery);
      writeFileSync(
        path.join(rootDir, "harness", packagePath, "closeout.md"),
        "# Closeout\n\n## Summary\n\nDelivered the fixture.\n\n## Verification\n\nFixture tested.\n\n## Residual Risk\n\nNo residual fixture risk.\n\n## Same Mechanism Elsewhere\n\nThis fixture covers CI completion.\n",
      );
      applied(
        await center.run(
          {
            kind: "fact-record",
            taskId,
            statement: "The delivery exists.",
            evidenceSource: "test:delivery",
            confidence: "high",
            memoryClass: "semantic",
            memoryTags: [],
          },
          binding,
        ),
      );
      applied(await center.run({ kind: "task-submit", taskId }, binding));
      applied(
        await center.run(
          { kind: "task-adjudicate", taskId, executionId, forward: true, reason: "Forward for review." },
          binding,
        ),
      );
      const reportPath = `${packagePath}/artifacts/reports/approved.md`;
      mkdirSync(path.dirname(path.join(rootDir, "harness", reportPath)), { recursive: true });
      writeFileSync(path.join(rootDir, "harness", reportPath), "# Review\n\nDelivery verified.\n");
      applied(await center.run({ kind: "doc-submit", paths: [reportPath] }, binding));
      writeFileSync(
        path.join(rootDir, "review.json"),
        JSON.stringify({ verdict: "approved", reason: "Approved cut.", evidenceChecked: ["tests"] }),
      );
      applied(
        await center.run(
          { kind: "task-review-execution", taskId, executionId, reviewId: "review-approved", fromFile: "review.json" },
          reviewer,
        ),
      );
      writeFileSync(
        path.join(bin, "gh"),
        `#!/usr/bin/env node
const fs = require('node:fs'); const args = process.argv.slice(2); const state=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},'utf8'));
const endpoint=args.find(a=>a.startsWith('repos/'))||'';
const metadata={name:'rewrite-ci',workflowName:'rewrite-ci',head_sha:'${delivery}',headSha:'${delivery}',head_branch:'main',headBranch:'main',status:'completed',conclusion:state.conclusion,run_attempt:1,attempt:1,event:'push',path:'.github/workflows/rewrite-ci.yml',workflow_id:1,repository:{full_name:'fixture/repository'}};
if(endpoint.includes('/compare/')) process.stdout.write(JSON.stringify({status:'identical'}));
else if(endpoint.includes('/commits?')) process.stdout.write(JSON.stringify([{sha:'${delivery}',parents:[]}]));
else if(endpoint.includes('actions/runs?head_sha=')) process.stdout.write(JSON.stringify([{databaseId:state.runId,path:metadata.path,headBranch:'main',event:'push',status:'completed',conclusion:state.conclusion}]));
else if(endpoint.includes('/workflows/')) process.stdout.write(JSON.stringify({workflow_runs:endpoint.endsWith('page=1')?[{id:state.runId,run_attempt:1,head_branch:'main',status:'completed'}]:[]}));
else if(endpoint.includes('/jobs?')) process.stdout.write(JSON.stringify([{jobs:[]}]));
else if(endpoint.includes('/artifacts')) process.stdout.write(JSON.stringify([{artifacts:[]}]));
else if(endpoint.includes('/attempts/')||args[1]==='view') process.stdout.write(JSON.stringify(metadata));
else throw new Error('unexpected provider call '+args.join(' '));
`,
        { mode: 0o755 },
      );
      process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
      await seedBuiltinSchedules({ cell: center, binding });
      let occurrence = 0;
      const run = async (runId: number, conclusion: string) => {
        writeFileSync(statePath, JSON.stringify({ runId, conclusion }));
        const receipt = await center.run(
          {
            kind: "schedule-run-now",
            scheduleId: builtinCiObserveScheduleId,
            idempotencyKey: `occurrence-${++occurrence}`,
          },
          binding,
        );
        assert.equal(receipt.code, undefined, JSON.stringify(receipt));
        return receipt;
      };
      await run(1, "success");
      const newTask = await center.run({ kind: "task-create", taskId: "task-new", title: "New work" }, binding);
      applied(newTask);
      await realizeTaskPlanFixture(
        rootDir,
        String((newTask as unknown as { packagePath: string }).packagePath),
        (planPath) => center.run({ kind: "doc-submit", paths: [planPath] }, binding),
      );
      const full = await center.run({ kind: "task-start", taskId: "task-new", executionId: "exe-new" }, binding);
      assert.equal(full.code, "task_wip_limit_reached", JSON.stringify(full));
      assert.match(
        full.rejectionExplanation!,
        /Merged approved closeouts.*task-merged: ha task review-consent task-merged --review-id review-approved; ha task complete task-merged/u,
      );
      assert.ok(
        full.rejectionExplanation!.indexOf("Merged approved closeouts") <
          full.rejectionExplanation!.indexOf("TASK_WIP_LIMIT_REACHED"),
      );
      await run(2, "failure");
      await run(2, "failure");
      const beforeConsent = JSON.parse(String((await center.run({ kind: "task-show", taskId }, binding)).evidence)).task
        .status;
      assert.equal(beforeConsent, "in_review");
      applied(
        await center.run({ kind: "task-review-consent", taskId, executionId, reviewId: "review-approved" }, binding),
      );
      const red = await center.run({ kind: "task-complete", taskId }, binding);
      assert.equal(red.code, "invalid_proof", JSON.stringify(red));
      t.diagnostic(`red complete: ${red.code} ${red.rejectionExplanation}`);
      const contenders = await Promise.all([run(3, "success"), center.run({ kind: "task-complete", taskId }, binding)]);
      assert.ok(
        contenders[1].outcome === "applied" ||
          contenders[1].outcome === "no_changes" ||
          contenders[1].code === "invalid_proof",
        JSON.stringify(contenders[1]),
      );
      await run(3, "success");
      const status = JSON.parse(String((await center.run({ kind: "task-show", taskId }, binding)).evidence)).task
        .status;
      assert.equal(status, "done", "the next green occurrence must finish the consented cut");
      await run(3, "success");
      const reader = makeTaskEventReader({ rootDir, repoId });
      try {
        assert.equal(reader.read().events.filter((event) => event.type === "task_completed").length, 1);
      } finally {
        await reader.drain();
      }
      t.diagnostic(`green occurrence: task=${status}; completion events=1`);
    } finally {
      process.env.PATH = originalPath;
      if (originalWip === undefined) delete process.env.HARNESS_TASK_WIP_LIMIT;
      else process.env.HARNESS_TASK_WIP_LIMIT = originalWip;
      await center.close();
    }
  });
});
