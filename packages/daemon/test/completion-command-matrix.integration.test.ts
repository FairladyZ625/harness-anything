// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { currentGateRun, isTaskEvent, makeTaskEventReader } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { researchPackage } from "./completion-command-source.fixture.ts";

const frame = `import { readFileSync } from "node:fs";
const input=JSON.parse(readFileSync(JSON.parse(process.env.HA_PRESET_INPUT).witnessInput,"utf8"));
const metadata=JSON.parse(readFileSync(input.subjects.find(s=>s.path.endsWith("/experiment.json")).file,"utf8"));
const subjects=input.subjects.map(({file,...anchor})=>anchor);
const result={result:"pass",subjects,predicateType:"research/version-pinned/v1",predicate:metadata,diagnostic:"checked frozen inputs"};
`;
const output = `console.log(JSON.stringify({schema:"preset-script-result/v1",produces:[{capabilityId:"completion-witness",payload:result}]}));`;

async function fixture(script: string, metadata: unknown, mixed = false) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-completion-matrix-")),
    ledger = path.join(root, "harness"),
    repoId = workspaceId("completion-matrix"),
    taskId = "task-matrix",
    executionId = "execution-matrix";
  initRepo(root);
  git(root, "branch", "-M", "main");
  writeFileSync(path.join(root, ".gitignore"), "harness/\n.harness/\n.worktrees/\nsource/\n");
  writeFileSync(path.join(root, "experiment-code.txt"), "frozen code\n");
  git(root, "add", ".gitignore", "experiment-code.txt");
  git(root, "commit", "-qm", "test: frozen experiment code");
  mkdirSync(ledger);
  initRepo(ledger);
  const worker = withPolicyGroup(
      {
        actor: { principal: { personId: "research-owner" }, executor: { kind: "agent" as const, id: "task-worker" } },
        source: "local" as const,
      },
      "admin",
    ),
    owner = withPolicyGroup(
      { actor: { principal: { personId: "research-owner" }, executor: null }, source: "local" as const },
      "admin",
    ),
    cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "matrix" });
  const applied = async (action: Record<string, unknown> & { kind: string }, binding = worker) => {
    const receipt = await cell.run(action, binding);
    assert.ok(
      receipt.outcome === "applied" || (receipt.outcome === "pending" && receipt.acceptance !== null),
      JSON.stringify(receipt),
    );
    if (receipt.acceptance !== null) await waitForFixturePublication(cell, receipt.opId, binding);
    return receipt;
  };
  try {
    await applied({
      kind: "preset-install",
      packageSource: researchPackage(root, script, mixed ? "repository-diff" : "task-package-artifact"),
    });
    const created = await applied({
        kind: "task-create",
        taskId,
        title: "Witness matrix",
        presetId: "research-checks",
        profileId: "experiment",
      }),
      packagePath = String((created as { packagePath?: string }).packagePath);
    await realizeTaskPlanFixture(
      root,
      packagePath,
      (p) => applied({ kind: "doc-submit", paths: [p] }),
      "Witness matrix",
    );
    await applied({ kind: "task-start", taskId, executionId });
    if (mixed) {
      const delivery = path.join(root, ".worktrees", taskId);
      writeFileSync(path.join(delivery, "experiment-code.txt"), "frozen code\n");
      writeFileSync(path.join(delivery, "delivered.txt"), "delivery change\n");
      git(delivery, "add", "experiment-code.txt", "delivered.txt");
      git(delivery, "commit", "-qm", "feat: deliver experiment");
    }
    mkdirSync(path.join(ledger, packagePath, "artifacts"), { recursive: true });
    const artifact = path.join(ledger, packagePath, "artifacts/experiment.json");
    writeFileSync(artifact, JSON.stringify(metadata));
    writeFileSync(
      path.join(ledger, packagePath, "closeout.md"),
      "## Summary\nFrozen experiment delivered.\n## Verification\nValidate declared source output against accepted inputs.\n## Residual Risk\nExternal reproduction unverified.\n## Same Mechanism Elsewhere\nAll source kinds bind the submission cut.\n",
    );
    await applied({ kind: "doc-submit", taskId });
    const submit = { kind: "task-submit", taskId, executionId };
    const events = () =>
      makeTaskEventReader({ repoId, rootDir: root })
        .read()
        .events.filter(isTaskEvent)
        .filter((e) => e.taskId === taskId);
    return {
      root,
      cell,
      worker,
      owner,
      taskId,
      executionId,
      artifact,
      submit,
      applied,
      events,
      close: async () => {
        await cell.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await cell.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

for (const scenario of [
  { name: "wrong seed type", script: frame + output, metadata: { seed: "42" }, detail: /seed/ },
  {
    name: "seed differs from frozen metadata",
    script: frame + "result.predicate={seed:43};" + output,
    metadata: { seed: 42 },
    detail: /seed/,
  },
  {
    name: "subject identity differs",
    script: frame + "result.subjects=result.subjects.map(s=>({...s,revision:s.revision+1}));" + output,
    metadata: { seed: 42 },
    detail: /subjects/,
  },
  {
    name: "stdout and stderr pass are not a result frame",
    script: 'console.log("pass");console.error("pass");',
    metadata: { seed: 42 },
    detail: /result|JSON/i,
  },
  {
    name: "process failure",
    script: 'throw new Error("source process failed");',
    metadata: { seed: 42 },
    detail: /exited|source process failed/i,
  },
  {
    name: "process timeout",
    script: "setInterval(()=>{},1000); await new Promise(()=>{});",
    metadata: { seed: 42 },
    detail: /exited|exceeded|timeout/i,
  },
])
  test(`declared source ${scenario.name} publishes unavailable and no canonical pass`, async () => {
    const f = await fixture(scenario.script, scenario.metadata);
    try {
      await f.applied(f.submit);
      const settled = f.events().findLast((e) => e.type === "gate_run_changed" && e.payload.operation === "settle");
      assert.ok(settled, JSON.stringify(f.events().map((e) => e.type)));
      const run = currentGateRun(settled.payload.execution, "version-pinned")!;
      assert.equal(run.availability, "unavailable");
      assert.equal(run.result, null);
      assert.match(run.diagnostic, scenario.detail);
      assert.equal(f.events().filter((e) => e.type === "completion_gate_verified").length, 0);
      const completed = await f.cell.run(
        { kind: "task-complete", taskId: f.taskId, executionId: f.executionId },
        f.owner,
      );
      assert.equal(completed.outcome, "op_rejected", JSON.stringify(completed));
    } finally {
      await f.close();
    }
  });

test("mixed code and artifacts freeze both inputs; a new artifact cut invalidates the previous pass", async () => {
  const f = await fixture(
    frame +
      'if(!input.code || readFileSync(input.code.directory+"/experiment-code.txt","utf8")!=="frozen code\\n") throw new Error("mixed code missing");' +
      output,
    { seed: 42 },
    true,
  );
  try {
    await f.applied(f.submit);
    const first = f.events().findLast((e) => e.type === "completion_gate_verified");
    assert.ok(first);
    assert.equal(currentGateRun(first.payload.execution, "version-pinned")?.result, "pass");
    writeFileSync(f.artifact, JSON.stringify({ seed: "changed" }));
    await f.applied({ kind: "doc-submit", taskId: f.taskId });
    await f.applied({ ...f.submit, amend: true });
    const changed = f.events().findLast((e) => e.type === "gate_run_changed")!;
    const run = currentGateRun(changed.payload.execution, "version-pinned")!;
    assert.equal(run.availability, "unavailable");
    assert.notEqual(run.submissionDigest, currentGateRun(first.payload.execution, "version-pinned")?.submissionDigest);
    assert.equal(f.events().filter((e) => e.type === "completion_gate_verified").length, 1, "old pass is history only");
    const completed = await f.cell.run(
      { kind: "task-complete", taskId: f.taskId, executionId: f.executionId },
      f.owner,
    );
    assert.equal(completed.outcome, "op_rejected", JSON.stringify(completed));
  } finally {
    await f.close();
  }
});
