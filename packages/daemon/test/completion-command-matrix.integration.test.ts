// harness-test-tier: integration
import { waitForDurableValue } from "../../../tools/fixtures/event-arrival.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { makeTaskEventReader, makeTaskProjection } from "@harness-anything/storage";
import { currentGateRun, isTaskEvent, resolveHarnessLayout } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
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
        riskTier: "low",
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
      repoId,
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
        removeTempRepository(root);
      },
    };
  } catch (error) {
    await cell.close();
    removeTempRepository(root);
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

for (const order of ["old-first", "new-first"] as const) {
  test(`amend and complete race with source execution: ${order} arrival retains one current run after cold replay`, async () => {
    const f = await fixture(
      frame +
        `
import { existsSync, watch, writeFileSync } from "node:fs";
writeFileSync("output/ready-" + metadata.seed, "");
await new Promise(resolve => {
  const watcher = watch("output", check);
  function check() {
    if (!existsSync("output/release")) return;
    watcher.close();
    resolve();
  }
  check();
});
` +
        output,
      { seed: 42 },
    );
    const waiting: Promise<unknown>[] = [],
      staging = path.join(resolveHarnessLayout(f.root).localRoot, "preset-runs", "staging"),
      ready = new Map<number, string>();
    const release = (seed: number) => {
      const output = ready.get(seed);
      if (output && existsSync(output)) writeFileSync(path.join(output, "release"), "");
    };
    const started = async (seed: number) => {
      const count = seed === 42 ? 1 : 2;
      await waitForDurableValue(() =>
        f
          .events()
          .some(
            (event) =>
              event.type === "gate_run_changed" &&
              event.payload.operation === "claim" &&
              event.payload.execution.gateRuns.length === count,
          )
          ? true
          : null,
      );
      ready.set(
        seed,
        await waitForDurableValue(() => {
          const child = readdirSync(staging).find((entry) =>
            existsSync(path.join(staging, entry, "output", `ready-${seed}`)),
          );
          return child === undefined ? null : path.join(staging, child, "output");
        }),
      );
    };
    try {
      const first = f.applied(f.submit);
      waiting.push(first);
      await started(42);
      const blocked = await f.cell.run(
        { kind: "task-complete", taskId: f.taskId, executionId: f.executionId },
        f.owner,
      );
      assert.equal(blocked.outcome, "op_rejected", JSON.stringify(blocked));
      writeFileSync(f.artifact, JSON.stringify({ seed: 43 }));
      await f.applied({ kind: "doc-submit", taskId: f.taskId });
      const second = f.applied({ ...f.submit, amend: true });
      waiting.push(second);
      await started(43);
      if (order === "old-first") {
        release(42);
        await first;
      }
      release(43);
      await second;
      const complete = await f.cell.run(
        { kind: "task-complete", taskId: f.taskId, executionId: f.executionId },
        f.owner,
      );
      assert.equal(complete.outcome, "applied", JSON.stringify(complete));
      await waitForFixturePublication(f.cell, complete.opId, f.owner);
      if (order === "new-first") {
        release(42);
        await first;
      }
      const witnesses = f.events().filter((event) => event.type === "completion_gate_verified");
      assert.equal(witnesses.length, 1);
      assert.deepEqual(witnesses[0]!.payload.witness.predicate, { seed: 43 });
      await f.cell.close();
      const reader = makeTaskEventReader({ repoId: f.repoId, rootDir: f.root });
      const projection = makeTaskProjection({ rootDir: f.root, eventStore: reader });
      try {
        const once = projection.rebuild(),
          twice = projection.rebuild();
        assert.equal(once.stateDigest, twice.stateDigest);
        const snapshot = projection.read(f.taskId).snapshot,
          execution = snapshot.executions[0]!;
        assert.equal(snapshot.task?.status, "done");
        assert.equal(execution.schema, "execution/v1");
        if (execution.schema !== "execution/v1") throw new Error("expected native execution");
        const current = currentGateRun(execution, "version-pinned")!;
        assert.equal(current.result, "pass");
        assert.equal(execution.gateRuns.length, 2);
        assert.equal(execution.gateRuns.filter((run) => run.submissionDigest === current.submissionDigest).length, 1);
        console.log(
          "AMEND_COMPLETE_RACE=" +
            JSON.stringify({
              order,
              currentRun: current.runId,
              result: current.result,
              historicalRuns: execution.gateRuns.length,
              coldDigest: twice.stateDigest,
            }),
        );
      } finally {
        projection.close();
      }
    } finally {
      release(42);
      release(43);
      await Promise.allSettled(waiting);
      await f.close();
    }
  });
}

test("review-exempt low-risk submit with zero blockers auto-completes to done and preserves review-waived audit", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-completion-autoclose-")),
    ledger = path.join(root, "harness"),
    repoId = workspaceId("completion-autoclose"),
    taskId = "task-autoclose-low",
    executionId = "exe-autoclose-low";
  initRepo(root);
  git(root, "branch", "-M", "main");
  writeFileSync(path.join(root, ".gitignore"), "harness/\n.harness/\n.worktrees/\nsource/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-qm", "test: baseline");
  mkdirSync(ledger);
  initRepo(ledger);
  const worker = withPolicyGroup(
      {
        actor: { principal: { personId: "research-owner" }, executor: { kind: "agent" as const, id: "task-worker" } },
        source: "local" as const,
      },
      "admin",
    ),
    cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "autoclose" });
  try {
    const created = await cell.run(
      { kind: "task-create", taskId, title: "Zero-blocker low-risk docs task", presetId: "docs-task", riskTier: "low" },
      worker,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, worker);
    const packagePath = String((created as { packagePath?: string }).packagePath);
    await realizeTaskPlanFixture(
      root,
      packagePath,
      async (p) => {
        const synced = await cell.run({ kind: "doc-submit", paths: [p] }, worker);
        if (synced.acceptance !== null) await waitForFixturePublication(cell, synced.opId, worker);
        return synced;
      },
      "Zero-blocker low-risk docs task",
    );
    const started = await cell.run({ kind: "task-start", taskId, executionId }, worker);
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    await waitForFixturePublication(cell, started.opId, worker);
    mkdirSync(path.join(ledger, packagePath, "artifacts"), { recursive: true });
    writeFileSync(path.join(ledger, packagePath, "artifacts/note.md"), "# Low-risk note\nVerified.\n");
    writeFileSync(
      path.join(ledger, packagePath, "closeout.md"),
      "## Summary\nDelivered low-risk artifact.\n## Verification\nVerified zero-blocker auto-completion.\n",
    );
    const docSynced = await cell.run({ kind: "doc-submit", taskId }, worker);
    assert.equal(docSynced.outcome, "applied", JSON.stringify(docSynced));
    await waitForFixturePublication(cell, docSynced.opId, worker);

    const submitted = (await cell.run({ kind: "task-submit", taskId, executionId }, worker)) as unknown as Record<
      string,
      unknown
    >;
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.match(
      String(submitted.summary),
      /review waived: effective risk tier low \(declared by task-worker\)/u,
      "submit receipt preserves review-waived audit notice",
    );
    const steps = (submitted.steps as readonly Record<string, unknown>[]) ?? [],
      completeStep = steps.find((step) => /^task-complete: applied/u.test(String(step.summary ?? "")));
    assert.ok(completeStep, `expected automatic task-complete step in submit receipt: ${JSON.stringify(submitted)}`);
    assert.match(
      String(completeStep.summary),
      /^task-complete: applied\nreview waived: effective risk tier low \(declared by task-worker\)$/u,
    );
    await waitForFixturePublication(cell, String(completeStep.opId), worker);

    const shown = await cell.run({ kind: "task-show", taskId }, worker),
      evidence = JSON.parse(String(shown.evidence)) as {
        readonly task: { readonly status: string };
        readonly executions: readonly { readonly state: string }[];
        readonly completionBlocker: unknown;
        readonly completionNext: unknown;
      };
    assert.equal(evidence.task.status, "done");
    assert.equal(evidence.executions[0]?.state, "accepted");
    assert.equal(evidence.completionBlocker, null);
    assert.equal(evidence.completionNext, null);

    const taskEvents = makeTaskEventReader({ repoId, rootDir: root })
      .read()
      .events.filter(isTaskEvent)
      .filter((event) => event.taskId === taskId)
      .map((event) => event.type);
    assert.ok(taskEvents.includes("execution_submitted"));
    assert.ok(taskEvents.includes("task_completed"));

    const agenda = await cell.read("repo.agenda.read", { limit: 50 });
    assert.equal(
      agenda.awaitingAdjudication.some((row) => row.taskId === taskId),
      false,
    );
    assert.equal(
      agenda.attentionItems.some((item) => item.ref === `execution/${executionId}` || item.ref === `task/${taskId}`),
      false,
    );
  } finally {
    await cell.close();
    removeTempRepository(root);
  }
});

test("review-exempt low-risk submit blocked by delivery_missing or gate_witness_missing stays submitted, surfaces in agenda, and retains rework", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-completion-blocked-submitted-")),
    ledger = path.join(root, "harness"),
    repoId = workspaceId("completion-blocked-submitted");
  initRepo(root);
  git(root, "branch", "-M", "main");
  writeFileSync(path.join(root, ".gitignore"), "harness/\n.harness/\n.worktrees/\nsource/\n");
  writeFileSync(path.join(root, "README.md"), "# Base\n");
  git(root, "add", ".gitignore", "README.md");
  git(root, "commit", "-qm", "test: baseline");
  git(root, "update-ref", "refs/remotes/origin/main", git(root, "rev-parse", "HEAD"));
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
    cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "blocked-submitted" }),
    applied = async (action: Record<string, unknown> & { kind: string }, binding = worker) => {
      const receipt = await cell.run(action, binding);
      assert.ok(
        receipt.outcome === "applied" || (receipt.outcome === "pending" && receipt.acceptance !== null),
        JSON.stringify(receipt),
      );
      if (receipt.acceptance !== null) await waitForFixturePublication(cell, receipt.opId, binding);
      return receipt;
    };
  try {
    // 1. Negative control A: low-risk code change not yet merged (delivery_missing) stays submitted + visible in agenda + reworkable
    const deliveryTaskId = "task-blocked-delivery",
      deliveryExeId = "exe-blocked-delivery",
      deliveryCreated = await applied({
        kind: "task-create",
        taskId: deliveryTaskId,
        title: "Unmerged low-risk code cut",
        presetId: "standard-task",
        riskTier: "low",
      }),
      deliveryPkg = String((deliveryCreated as { packagePath?: string }).packagePath);
    await realizeTaskPlanFixture(
      root,
      deliveryPkg,
      (p) => applied({ kind: "doc-submit", paths: [p] }),
      "Unmerged low-risk code cut",
    );
    await applied({ kind: "task-start", taskId: deliveryTaskId, executionId: deliveryExeId });
    const deliveryWorktree = path.join(root, ".worktrees", deliveryTaskId);
    writeFileSync(path.join(deliveryWorktree, "fix.txt"), "unmerged low-risk fix\n");
    git(deliveryWorktree, "add", "fix.txt");
    git(deliveryWorktree, "commit", "-qm", "fix: unmerged low-risk fix");
    writeFileSync(
      path.join(ledger, deliveryPkg, "closeout.md"),
      "## Summary\nPrepared low-risk code fix.\n## Verification\nTargeted check passed.\n## 摘要\n准备低风险代码修复。\n## 验证\n定向测试通过。\n",
    );
    await applied({ kind: "doc-submit", taskId: deliveryTaskId });
    await applied({ kind: "task-submit", taskId: deliveryTaskId, executionId: deliveryExeId });

    // 2. Negative control B: low-risk artifact task with manual completion gate (gate_witness_missing) stays submitted + visible in agenda
    const manualPreset = path.join(root, "source/manual-gate-preset");
    mkdirSync(manualPreset, { recursive: true });
    writeFileSync(
      path.join(manualPreset, "preset.json"),
      JSON.stringify({
        schema: "preset-manifest/v3",
        id: "manual-gate-preset",
        title: "Manual gate preset",
        vertical: "software/coding",
        version: "1.0.0",
        kind: "template-content",
        outputShape: "task-package-artifact",
        kernelVersionRange: { min: "1.0.0" },
        capabilityImports: [],
        profiles: [
          {
            id: "manual-check",
            title: "Manual check",
            completionGates: ["manual-signoff"],
            templateSelections: [],
          },
        ],
        defaultProfile: "manual-check",
        completion: {
          sources: {
            "ops/manual-signoff": {
              kind: "manual",
              predicateType: "ops/manual-signoff/v1",
              resultSchema: { type: "object" },
            },
          },
          gates: {
            "manual-signoff": {
              source: "ops/manual-signoff",
              appliesTo: "artifacts",
            },
          },
          closeoutDefaults: { review: false, consent: false, factDisposition: false },
        },
      }),
    );
    writeFileSync(
      path.join(manualPreset, "PRESET.md"),
      "---\nschema: preset-document/v1\ndescription: Manual signoff gate.\nwhenToUse: Manual check.\n---\n# Manual\n",
    );
    await applied({ kind: "preset-install", packageSource: manualPreset });
    const gateTaskId = "task-blocked-gate",
      gateExeId = "exe-blocked-gate",
      gateCreated = await applied({
        kind: "task-create",
        taskId: gateTaskId,
        title: "Gated low-risk artifact cut",
        presetId: "manual-gate-preset",
        profileId: "manual-check",
        riskTier: "low",
      }),
      gatePkg = String((gateCreated as { packagePath?: string }).packagePath);
    await realizeTaskPlanFixture(
      root,
      gatePkg,
      (p) => applied({ kind: "doc-submit", paths: [p] }),
      "Gated low-risk artifact cut",
    );
    await applied({ kind: "task-start", taskId: gateTaskId, executionId: gateExeId });
    mkdirSync(path.join(ledger, gatePkg, "artifacts"), { recursive: true });
    writeFileSync(path.join(ledger, gatePkg, "artifacts/checklist.md"), "# Checklist\nReady for signoff.\n");
    writeFileSync(
      path.join(ledger, gatePkg, "closeout.md"),
      "## Summary\nDelivered checklist.\n## Verification\nAwaiting manual signoff.\n## Residual Risk\nNone.\n## Same Mechanism Elsewhere\nManual witness required.\n",
    );
    await applied({ kind: "doc-submit", taskId: gateTaskId });
    await applied({ kind: "task-submit", taskId: gateTaskId, executionId: gateExeId });

    for (const id of [deliveryTaskId, gateTaskId]) {
      const shown = await cell.run({ kind: "task-show", taskId: id }, owner),
        snapshot = JSON.parse(String(shown.evidence)) as { readonly task: { readonly status: string } };
      assert.equal(snapshot.task.status, "submitted", `${id} must remain submitted when a blocker is open`);
    }
    const readerEvents = makeTaskEventReader({ repoId, rootDir: root })
      .read()
      .events.filter(isTaskEvent)
      .filter((event) => event.type === "task_completed");
    assert.equal(readerEvents.length, 0, "blocked submitted cuts must never auto-complete");

    const agenda = await cell.read("repo.agenda.read", { limit: 50 });
    assert.deepEqual(agenda.awaitingAdjudication.map((row) => row.taskId).sort(), [deliveryTaskId, gateTaskId].sort());
    const deliveryAttention = agenda.attentionItems.find((item) => item.ref === `execution/${deliveryExeId}`),
      gateAttention = agenda.attentionItems.find((item) => item.ref === `execution/${gateExeId}`);
    assert.ok(deliveryAttention, JSON.stringify(agenda.attentionItems));
    assert.equal(deliveryAttention.kind, "needs-handling");
    assert.match(deliveryAttention.title, /delivery_missing/u);
    assert.match(deliveryAttention.title, /pr-merge|merge_commit_sha/u);
    assert.ok(gateAttention, JSON.stringify(agenda.attentionItems));
    assert.equal(gateAttention.kind, "needs-handling");
    assert.match(gateAttention.title, /gate_witness_missing/u);
    assert.match(gateAttention.title, /ha task attest task-blocked-gate --gate manual-signoff/u);
    assert.match(agenda.summary, /delivery_missing/u);
    assert.match(agenda.summary, /gate_witness_missing/u);

    // Preserve rework support on a submitted cut blocked on delivery_missing
    const reworked = await applied(
      { kind: "task-rework", taskId: deliveryTaskId, executionId: deliveryExeId, reason: "Adjust fix before merge" },
      owner,
    );
    assert.equal(reworked.outcome, "applied", JSON.stringify(reworked));
    const afterRework = JSON.parse(
      String((await cell.run({ kind: "task-show", taskId: deliveryTaskId }, owner)).evidence),
    );
    assert.equal(afterRework.task.status, "active");
    assert.equal(afterRework.task.iteration, 1);
  } finally {
    await cell.close();
    removeTempRepository(root);
  }
});
