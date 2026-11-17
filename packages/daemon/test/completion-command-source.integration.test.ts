// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/storage";
import {
  INITIAL_SETTINGS_V1,
  writeRepositorySettingsFacet,
  currentGateRun,
  isTaskEvent,
  emptyTaskLifecycleSnapshot,
  reduceTaskEvent,
} from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

import { researchPackage } from "./completion-command-source.fixture.ts";

test("declared command checks submitted CSV/PNG/JSON without code: seed red, amended seed green, cold replay retains both runs", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-completion-command-")),
    ledger = path.join(root, "harness"),
    repoId = workspaceId("completion-command"),
    taskId = "task-research",
    executionId = "execution-research",
    worker = withPolicyGroup(
      {
        actor: { principal: { personId: "research-owner" }, executor: { kind: "agent" as const, id: "task-worker" } },
        source: "local" as const,
      },
      "admin",
    ),
    owner = withPolicyGroup(
      { actor: { principal: { personId: "research-owner" }, executor: null }, source: "local" as const },
      "admin",
    );
  initRepo(root);
  git(root, "branch", "-M", "main");
  writeFileSync(path.join(root, ".gitignore"), "harness/\n.harness/\n.worktrees/\nsource/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-qm", "test: fixture exclusions");
  mkdirSync(ledger);
  initRepo(ledger);
  const source = researchPackage(root),
    assets = path.join(root, "verticals/research"),
    verticalId = "research/experiments";
  cpSync(new URL("../../preset/assets/software-coding", import.meta.url), assets, { recursive: true });
  const manifestPath = path.join(source, "preset.json"),
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")),
    declarationPath = path.join(assets, "vertical.json"),
    declaration = JSON.parse(readFileSync(declarationPath, "utf8"));
  // dec_9DFDC635180975FDFC0CDB33D7/CH1: repository domains use the existing frozen completion chain.
  declaration.id = verticalId;
  declaration.completion = manifest.completion;
  manifest.vertical = verticalId;
  delete manifest.completion;
  writeFileSync(declarationPath, JSON.stringify(declaration));
  writeFileSync(manifestPath, JSON.stringify(manifest));
  cpSync(source, path.join(assets, "presets/research-checks"), { recursive: true });
  writeFileSync(
    path.join(ledger, "harness.yaml"),
    writeRepositorySettingsFacet(
      "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings: {}\n",
      {
        ...INITIAL_SETTINGS_V1,
        defaultVertical: verticalId,
        defaultPreset: "research-checks",
        defaultProfile: "experiment",
      },
    ),
  );
  let cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "completion-fixture" });
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
    await applied({ kind: "preset-install", packageSource: source });
    const inspected = await cell.run({ kind: "preset-inspect", presetId: "research-checks" }, worker);
    assert.notEqual(inspected.outcome, "op_rejected", JSON.stringify(inspected));
    assert.equal(JSON.parse(String(inspected.evidence)).snapshot.identity.verticalId, verticalId);
    const validated = await cell.run({ kind: "vertical-validate", presetId: "research-checks" }, worker);
    assert.equal(JSON.parse(String(validated.evidence)).valid, true, JSON.stringify(validated));
    const invalidAssets = path.join(root, "source", "undeclared-source");
    cpSync(new URL("../../preset/assets/software-coding", import.meta.url), invalidAssets, { recursive: true });
    const verticalPath = path.join(invalidAssets, "vertical.json"),
      vertical = JSON.parse(readFileSync(verticalPath, "utf8"));
    vertical.completion.gates["research/undeclared-gate"] = {
      source: "research/undeclared",
      appliesTo: "code",
    };
    writeFileSync(verticalPath, JSON.stringify(vertical));
    const unknown = await cell.run({ kind: "vertical-validate", verticalSource: invalidAssets }, worker);
    const unknownReport = JSON.parse(String(unknown.evidence));
    assert.equal(unknownReport.valid, false, JSON.stringify(unknownReport));
    assert.match(JSON.stringify(unknownReport), /research\/undeclared/);
    console.log("W1_UNKNOWN_SOURCE_VALIDATE=" + JSON.stringify(unknownReport));
    const created = await applied({
        kind: "task-create",
        taskId,
        title: "Reproducible experiment",
        presetId: "research-checks",
        profileId: "experiment",
        riskTier: "low",
      }),
      packagePath = String((created as { packagePath?: string }).packagePath);
    await realizeTaskPlanFixture(
      root,
      packagePath,
      (documentPath) => applied({ kind: "doc-submit", paths: [documentPath] }),
      "Reproducible experiment",
    );
    await applied({ kind: "task-start", taskId, executionId });
    mkdirSync(path.join(ledger, packagePath, "artifacts"), { recursive: true });
    writeFileSync(path.join(ledger, packagePath, "artifacts/data.csv"), "x,y\n1,2\n");
    writeFileSync(
      path.join(path.dirname(source), "chart.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    writeFileSync(path.join(ledger, packagePath, "artifacts/experiment.json"), "{}\n");
    writeFileSync(
      path.join(ledger, packagePath, "closeout.md"),
      "## Summary\nSubmitted experiment artifacts.\n## Verification\nThe source checks all submitted input bytes and the seed.\n## Residual Risk\nExternal reproducibility is unverified.\n## Same Mechanism Elsewhere\nThis source is declared in the installed preset.\n",
    );
    await applied({
      kind: "task-artifact-add",
      taskId,
      source: path.join(path.dirname(source), "chart.png"),
      destination: "chart.png",
    });
    await applied({ kind: "doc-submit", taskId });
    const red = await applied({ kind: "task-submit", taskId, executionId });
    assert.match(JSON.stringify(red), /gates\.version-pinned\.predicate\.seed/);
    const failed = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(failed.outcome, "op_rejected", JSON.stringify(failed));
    console.log("W1_SEED_MISSING_RECEIPT=" + JSON.stringify({ submit: red, complete: failed }));
    const events = () =>
      makeTaskEventReader({ repoId, rootDir: root })
        .read()
        .events.filter(isTaskEvent)
        .filter((e) => e.taskId === taskId);
    const first = events().findLast((e) => e.type === "completion_gate_verified")!;
    assert.equal(first.payload.execution.submission?.commitSha, null);
    assert.equal(currentGateRun(first.payload.execution, "version-pinned")?.result, "fail");
    const frozen = first.payload.execution.submission!.completionContract;
    const failedRun = currentGateRun(first.payload.execution, "version-pinned")!;
    for (const kind of ["task-witness-claim", "task-witness-settle", "task-witness-rerun", "task-witness-revoke"]) {
      const denied = await cell.run(
        {
          kind,
          taskId,
          executionId,
          gateId: "version-pinned",
          runId: failedRun.runId,
          reason: "Task executor cannot act as the source or owner",
        },
        worker,
      );
      assert.equal(denied.outcome, "op_rejected", JSON.stringify(denied));
    }
    await applied(
      {
        kind: "task-witness-revoke",
        taskId,
        executionId,
        gateId: "version-pinned",
        runId: failedRun.runId,
        reason: "Owner withdraws this observation",
      },
      owner,
    );
    const revoked = events().findLast((e) => e.type === "gate_run_changed")!;
    assert.equal(currentGateRun(revoked.payload.execution, "version-pinned")?.state, "cancelled");
    await applied(
      {
        kind: "task-witness-rerun",
        taskId,
        executionId,
        gateId: "version-pinned",
        runId: failedRun.runId,
        reason: "Owner requests a second observation",
      },
      owner,
    );
    const repeated = events().findLast((e) => e.type === "completion_gate_verified")!;
    assert.equal(currentGateRun(repeated.payload.execution, "version-pinned")?.result, "fail");
    assert.equal(repeated.payload.execution.gateRuns.length, 2);
    // Both current package code and mutable authored bytes disagree with the accepted input cut.
    writeFileSync(path.join(source, "scripts/anchors.mjs"), "throw new Error('Current package must not run');");
    await applied({ kind: "preset-install", packageSource: source });
    writeFileSync(path.join(ledger, packagePath, "artifacts/experiment.json"), '{"seed":42}\n');
    await applied({ kind: "doc-submit", taskId });
    await applied({ kind: "task-submit", taskId, executionId, amend: true });
    const green = events().findLast((e) => e.type === "completion_gate_verified")!;
    assert.deepEqual(green.payload.execution.submission!.completionContract, frozen);
    assert.equal(currentGateRun(green.payload.execution, "version-pinned")?.result, "pass");
    assert.equal(green.payload.execution.gateRuns.length, 3);
    console.log("W1_SEED_REPAIRED_WITNESS=" + JSON.stringify(green.payload.witness));
    // This edit never enters doc-submit: an explicit owner rerun must still read accepted seed 42.
    writeFileSync(path.join(ledger, packagePath, "artifacts/experiment.json"), '{"seed":"mutable-workspace"}\n');
    const greenRun = currentGateRun(green.payload.execution, "version-pinned")!;
    await applied(
      {
        kind: "task-witness-rerun",
        taskId,
        executionId,
        gateId: "version-pinned",
        runId: greenRun.runId,
        reason: "Verify the frozen input independently of the workspace",
      },
      owner,
    );
    const frozenAgain = events().findLast((e) => e.type === "completion_gate_verified")!;
    assert.equal(currentGateRun(frozenAgain.payload.execution, "version-pinned")?.result, "pass");
    assert.deepEqual(frozenAgain.payload.witness.predicate, { seed: 42 });
    assert.throws(
      () =>
        reduceTaskEvent(
          {
            ...emptyTaskLifecycleSnapshot(first.workspaceRevision),
            task: first.payload.task,
            executions: [first.payload.execution],
          },
          { ...revoked, actor: worker.actor },
        ),
      /Only the task owner/,
    );
    writeFileSync(path.join(ledger, packagePath, "artifacts/experiment.json"), '{"seed":42}\n');
    await cell.close();
    cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "completion-restarted" });
    const completed = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    console.log("W1_COLD_RESTART_COMPLETION=" + JSON.stringify(completed));
    await waitForFixturePublication(cell, completed.opId, owner);
    const final = events().findLast((e) => e.type === "task_completed")!;
    assert.equal(final.payload.execution.gateRuns.length, 4);
    assert.equal(currentGateRun(final.payload.execution, "version-pinned")?.result, "pass");
  } finally {
    await cell.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner rerun releases the writer turn before running the completion command so unrelated writes advance", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-completion-rerun-queue-")),
    ledger = path.join(root, "harness"),
    repoId = workspaceId("completion-rerun-queue"),
    taskId = "task-rerun-queue",
    executionId = "execution-rerun-queue",
    worker = withPolicyGroup(
      {
        actor: { principal: { personId: "research-owner" }, executor: { kind: "agent" as const, id: "task-worker" } },
        source: "local" as const,
      },
      "admin",
    ),
    owner = withPolicyGroup(
      { actor: { principal: { personId: "research-owner" }, executor: null }, source: "local" as const },
      "admin",
    );
  let holdNextRun = false,
    releaseHeldRun: (() => void) | undefined,
    notifyEntered: (() => void) | undefined;
  const enteredPromise = () =>
      new Promise<void>((resolve) => {
        notifyEntered = resolve;
      }),
    server = net.createServer((socket) => {
      if (!holdNextRun) {
        socket.end("go\n");
        return;
      }
      holdNextRun = false;
      notifyEntered?.();
      releaseHeldRun = () => socket.end("go\n");
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  const barrierScript = `import { readFileSync } from "node:fs";
import net from "node:net";
await new Promise((resolve, reject) => {
  const s = net.connect(${port}, "127.0.0.1");
  s.on("data", () => { s.destroy(); resolve(); });
  s.on("error", reject);
});
const input = JSON.parse(readFileSync(JSON.parse(process.env.HA_PRESET_INPUT).witnessInput, "utf8"));
const experiment = input.subjects.find(s => s.path.endsWith("/experiment.json"));
const metadata = JSON.parse(readFileSync(experiment.file, "utf8"));
const subjects = input.subjects.map(({file, ...anchor}) => anchor);
console.log(JSON.stringify({schema:"preset-script-result/v1", produces:[{capabilityId:"completion-witness",payload:{
result: "pass", subjects, predicateType:"research/version-pinned/v1",
predicate: metadata, diagnostic: "Seed verified"}}]}));`;
  initRepo(root);
  git(root, "branch", "-M", "main");
  writeFileSync(path.join(root, ".gitignore"), "harness/\n.harness/\n.worktrees/\nsource/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-qm", "test: fixture exclusions");
  mkdirSync(ledger);
  initRepo(ledger);
  const source = researchPackage(root, barrierScript),
    assets = path.join(root, "verticals/research"),
    verticalId = "research/experiments";
  cpSync(new URL("../../preset/assets/software-coding", import.meta.url), assets, { recursive: true });
  const manifestPath = path.join(source, "preset.json"),
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")),
    declarationPath = path.join(assets, "vertical.json"),
    declaration = JSON.parse(readFileSync(declarationPath, "utf8"));
  declaration.id = verticalId;
  declaration.completion = manifest.completion;
  manifest.vertical = verticalId;
  delete manifest.completion;
  writeFileSync(declarationPath, JSON.stringify(declaration));
  writeFileSync(manifestPath, JSON.stringify(manifest));
  cpSync(source, path.join(assets, "presets/research-checks"), { recursive: true });
  writeFileSync(
    path.join(ledger, "harness.yaml"),
    writeRepositorySettingsFacet(
      "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings: {}\n",
      {
        ...INITIAL_SETTINGS_V1,
        defaultVertical: verticalId,
        defaultPreset: "research-checks",
        defaultProfile: "experiment",
      },
    ),
  );
  const cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "completion-queue" });
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
    await applied({ kind: "preset-install", packageSource: source });
    const created = await applied({
        kind: "task-create",
        taskId,
        title: "Rerun non-blocking queue check",
        presetId: "research-checks",
        profileId: "experiment",
        riskTier: "low",
      }),
      packagePath = String((created as { packagePath?: string }).packagePath);
    await realizeTaskPlanFixture(
      root,
      packagePath,
      (documentPath) => applied({ kind: "doc-submit", paths: [documentPath] }),
      "Rerun non-blocking queue check",
    );
    await applied({ kind: "task-start", taskId, executionId });
    mkdirSync(path.join(ledger, packagePath, "artifacts"), { recursive: true });
    writeFileSync(path.join(ledger, packagePath, "artifacts/experiment.json"), '{"seed":7}\n');
    writeFileSync(
      path.join(ledger, packagePath, "closeout.md"),
      "## Summary\nSubmitted.\n## Verification\nChecked.\n## Residual Risk\nNone.\n## Same Mechanism Elsewhere\nChecked.\n",
    );
    await applied({ kind: "doc-submit", taskId });
    await applied({ kind: "task-submit", taskId, executionId });
    const events = () =>
      makeTaskEventReader({ repoId, rootDir: root })
        .read()
        .events.filter(isTaskEvent)
        .filter((e) => e.taskId === taskId);
    const initialRun = currentGateRun(
      events().findLast((e) => e.type === "completion_gate_verified")!.payload.execution,
      "version-pinned",
    )!;
    const entered = enteredPromise();
    holdNextRun = true;
    let rerunResolved = false;
    const rerunPromise = applied(
      {
        kind: "task-witness-rerun",
        taskId,
        executionId,
        gateId: "version-pinned",
        runId: initialRun.runId,
        reason: "Hold source command outside writer turn",
      },
      owner,
    ).then((receipt) => {
      rerunResolved = true;
      return receipt;
    });
    await entered;
    const unrelated = await applied({ kind: "todo-add", text: "advances while witness command runs" }, owner);
    assert.equal(unrelated.outcome, "applied");
    assert.equal(rerunResolved, false, "unrelated queued write must finish before the held witness command settles");
    releaseHeldRun?.();
    const rerunReceipt = await rerunPromise;
    assert.equal(rerunReceipt.outcome, "applied");
    assert.equal(
      currentGateRun(
        events().findLast((e) => e.type === "completion_gate_verified")!.payload.execution,
        "version-pinned",
      )?.result,
      "pass",
    );
  } finally {
    releaseHeldRun?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cell.close();
    rmSync(root, { recursive: true, force: true });
  }
});
