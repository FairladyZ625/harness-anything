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

const script = `import { readFileSync } from "node:fs";
const input = JSON.parse(readFileSync(JSON.parse(process.env.HA_PRESET_INPUT).witnessInput, "utf8"));
if (input.code !== null) throw new Error("Expected an artifact-only submission");
const experiment = input.subjects.find(s => s.path.endsWith("/experiment.json"));
const metadata = JSON.parse(readFileSync(experiment.file, "utf8"));
const csv = input.subjects.find(s => s.path.endsWith("/data.csv"));
const png = input.subjects.find(s => s.path.endsWith("/chart.png"));
if (readFileSync(csv.file, "utf8") !== "x,y\\n1,2\\n" || readFileSync(png.file)[0] !== 137) throw new Error("Submitted bytes changed");
const subjects = input.subjects.map(({file, ...anchor}) => anchor);
console.log(JSON.stringify({schema:"preset-script-result/v1", produces:[{capabilityId:"completion-witness",payload:{
result: Number.isInteger(metadata.seed) ? "pass" : "fail", subjects, predicateType:"research/version-pinned/v1",
predicate: metadata, diagnostic: Number.isInteger(metadata.seed) ? "Seed and submitted inputs verified" : "gates.version-pinned.predicate.seed: required"}}]}));`;

function researchPackage(root: string) {
  const source = path.join(root, "source/research-checks");
  mkdirSync(path.join(source, "scripts"), { recursive: true });
  const capability = { id: "completion-witness", kind: "checker", version: "1" };
  writeFileSync(
    path.join(source, "preset.json"),
    JSON.stringify({
      schema: "preset-manifest/v3",
      id: "research-checks",
      title: "Research checks",
      vertical: "software/coding",
      version: "1.0.0",
      kind: "process-action",
      outputShape: "task-package-artifact",
      kernelVersionRange: { min: "1.0.0" },
      capabilityImports: [{ ...capability, required: true }],
      entrypoints: {
        anchors: {
          type: "script",
          intent: "Check frozen experiment inputs",
          inputs: [{ name: "witnessInput", type: "string", required: true }],
          requires: [],
          produces: [capability],
          sideEffects: [],
          command: "scripts/anchors.mjs",
        },
      },
      profiles: [
        {
          id: "experiment",
          title: "Experiment",
          completionGates: ["version-pinned"],
          templateSelections: [],
          closeoutOverrides: { fact: false },
        },
      ],
      defaultProfile: "experiment",
      completion: {
        sources: {
          "research/anchor-check": {
            kind: "command",
            entrypoint: "research-checks/anchors",
            predicateType: "research/version-pinned/v1",
            resultSchema: {
              type: "object",
              required: ["seed"],
              additionalProperties: false,
              properties: { seed: { type: "integer" } },
            },
          },
        },
        gates: {
          "version-pinned": {
            source: "research/anchor-check",
            appliesTo: "artifacts",
            subjects: "all-artifacts",
            bindings: { seed: { artifact: "artifacts/experiment.json", pointer: "/seed" } },
          },
        },
        closeoutDefaults: { review: false, consent: false, factDisposition: false, codeDoc: false },
      },
    }),
  );
  writeFileSync(
    path.join(source, "PRESET.md"),
    "---\nschema: preset-document/v1\ndescription: Validate submitted experiments.\nwhenToUse: Artifact-only research.\n---\n# Research\n",
  );
  writeFileSync(path.join(source, "scripts/anchors.mjs"), script);
  return source;
}

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
  const source = researchPackage(root);
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
    const validated = await cell.run({ kind: "vertical-validate", presetId: "research-checks" }, worker);
    assert.equal(JSON.parse(String(validated.evidence)).valid, true, JSON.stringify(validated));
    const created = await applied({
        kind: "task-create",
        taskId,
        title: "Reproducible experiment",
        presetId: "research-checks",
        profileId: "experiment",
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
    const events = () =>
      makeTaskEventReader({ repoId, rootDir: root })
        .read()
        .events.filter(isTaskEvent)
        .filter((e) => e.taskId === taskId);
    const first = events().findLast((e) => e.type === "completion_gate_verified")!;
    assert.equal(first.payload.execution.submission?.commitSha, null);
    assert.equal(currentGateRun(first.payload.execution, "version-pinned")?.result, "fail");
    const frozen = first.payload.execution.submission!.completionContract;
    // Both current package code and mutable authored bytes disagree with the accepted input cut.
    writeFileSync(path.join(source, "scripts/anchors.mjs"), "throw new Error('Current package must not run');");
    await applied({ kind: "preset-install", packageSource: source });
    writeFileSync(path.join(ledger, packagePath, "artifacts/experiment.json"), '{"seed":42}\n');
    await applied({ kind: "doc-submit", taskId });
    await applied({ kind: "task-submit", taskId, executionId, amend: true });
    const green = events().findLast((e) => e.type === "completion_gate_verified")!;
    assert.deepEqual(green.payload.execution.submission!.completionContract, frozen);
    assert.equal(currentGateRun(green.payload.execution, "version-pinned")?.result, "pass");
    assert.equal(green.payload.execution.gateRuns.length, 2);
    await cell.close();
    cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "completion-restarted" });
    const completed = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    await waitForFixturePublication(cell, completed.opId, owner);
    const final = events().findLast((e) => e.type === "task_completed")!;
    assert.equal(final.payload.execution.gateRuns.length, 2);
    assert.equal(currentGateRun(final.payload.execution, "version-pinned")?.result, "pass");
  } finally {
    await cell.close();
    rmSync(root, { recursive: true, force: true });
  }
});
