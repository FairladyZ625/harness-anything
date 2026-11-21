// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  INITIAL_SETTINGS_V1,
  submissionDigest,
  writeRepositorySettingsFacet,
  type FrozenGateRequirement,
  type TaskLifecycleSnapshot,
} from "@harness-anything/kernel";
import type { PresetProcessService } from "@harness-anything/preset";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { collectCommandWitness } from "../src/daemon-host/repo-cell-command-witness.ts";
import { acquireWorkspaceLock } from "../src/daemon-host/repo-cell-lock.ts";
import { openRepoWriterCell } from "../src/daemon-host/repo-cell-open.ts";
import type {
  RepoCellOperationalContext,
  RepoCellWriteQueueHead,
  Snapshot,
} from "../src/daemon-host/repo-cell-types.ts";
import {
  policyTestCenter,
  policyTestRealm,
  provisionPolicyTestRepository,
  withPolicyGroup,
} from "./keycloak-policy.fixtures.ts";
import {
  fixtureFence,
  openBootstrappedRepoCell,
  settleSettingsEvent,
  waitForFixturePublication,
} from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function initLedgerFixture(prefix: string): { root: string; ledger: string } {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const ledger = path.join(root, "harness");
  initRepo(root);
  git(root, "branch", "-M", "main");
  writeFileSync(path.join(root, ".gitignore"), "harness/\n.harness/\n.worktrees/\nsource/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-qm", "test: fixture exclusions");
  mkdirSync(ledger);
  initRepo(ledger);
  return { root, ledger };
}

test(
  "HA09-11/12/13: atomic serial completion blocks concurrent v1->v2 upstream drift at discrete sync point, preserves non-owner isolation, allows explicit owner rerun, and rejects substituted direct canonical ref",
  { timeout: 120_000 },
  async (t) => {
    const { root, ledger } = initLedgerFixture("ha-office-freshness-race-");
    const repoId = workspaceId("office-freshness-race");
    writeFileSync(
      path.join(ledger, "harness.yaml"),
      writeRepositorySettingsFacet(
        "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings: {}\n",
        {
          ...INITIAL_SETTINGS_V1,
          defaultVertical: "office/collab",
          defaultPreset: "deliverable-task",
          defaultProfile: "upstream-verified",
        },
      ),
    );
    // Exercise the real single writer cell directly (without the host proxy's 1-in-flight request
    // queue) so task-complete's externalRead overlaps with an in-flight doc-submit(v2) on writeQueue.
    provisionPolicyTestRepository(repoId);
    const fence = fixtureFence(repoId, canonicalRoot(root), path.join(root, ".harness", "fixture-writer-epochs"));
    await settleSettingsEvent({ repoId, rootDir: canonicalRoot(root), writerEpochFence: fence });
    const lock = await acquireWorkspaceLock(canonicalRoot(root));
    const cell = await openRepoWriterCell(
      {
        repoId,
        rootDir: canonicalRoot(root),
        ownerId: "office-owner",
        keycloakCenter: policyTestCenter,
        defaultWriterEpochFence: fence,
      },
      lock,
    );
    let releasePendingQueue = () => {};
    t.after(async () => {
      releasePendingQueue();
      await cell.close();
      rmSync(root, { recursive: true, force: true });
    });

    const owner = withPolicyGroup(
      { actor: { principal: { personId: "office-owner" }, executor: null }, source: "local" as const },
      "admin",
    );
    const nonOwner = withPolicyGroup(
      { actor: { principal: { personId: "collab-member" }, executor: null }, source: "local" as const },
      "admin",
    );
    const technicalExecutor = withPolicyGroup(
      {
        actor: {
          principal: { personId: "office-owner" },
          executor: { kind: "agent" as const, id: "contributor" },
        },
        source: "local" as const,
      },
      "admin",
    );

    const applied = async (action: Record<string, unknown> & { kind: string }, binding = owner) => {
      const receipt = await cell.run(action, binding);
      assert.ok(
        receipt.outcome === "applied" || (receipt.outcome === "pending" && receipt.acceptance !== null),
        JSON.stringify(receipt),
      );
      if (receipt.acceptance !== null) await waitForFixturePublication(cell, receipt.opId, binding);
      return receipt;
    };
    const readTaskSnapshot = async (taskId: string): Promise<TaskLifecycleSnapshot> => {
      const shown = await cell.run({ kind: "task-show", taskId }, owner);
      assert.equal(shown.outcome, "applied", JSON.stringify(shown));
      return JSON.parse(String(shown.evidence)) as TaskLifecycleSnapshot;
    };
    const readLiveDocSha = async (docPath: string): Promise<string | null> => {
      const shown = await cell.run({ kind: "doc-show", path: docPath }, owner);
      if (shown.outcome !== "applied") return null;
      const direct = (shown as { evidenceBlobSha256?: string }).evidenceBlobSha256;
      if (typeof direct === "string") return direct;
      return typeof shown.evidence === "string" ? sha256(shown.evidence) : null;
    };

    // 1. Create two accepted canonical upstream documents: charter (v1) and unrelated other doc (v1)
    const upstreamCreated = await applied({
      kind: "task-create",
      title: "Upstream Charter",
      verticalId: "office/collab",
      presetId: "deliverable-task",
      profileId: "baseline",
      riskTier: "low",
    });
    const upstreamPkg = String((upstreamCreated as { packagePath?: string }).packagePath);
    const upstreamLogical = `${upstreamPkg}/artifacts/charter.md`;
    const otherLogical = `${upstreamPkg}/artifacts/other.md`;
    const charterV1 = "# Upstream Charter\n\nApproved Q4 scope v1.\n";
    const charterV1Sha = sha256(charterV1);
    const otherV1 = "# Unrelated Summary\n\nFixed v1 content.\n";
    const otherV1Sha = sha256(otherV1);
    mkdirSync(path.join(ledger, upstreamPkg, "artifacts"), { recursive: true });
    writeFileSync(path.join(ledger, upstreamLogical), charterV1);
    writeFileSync(path.join(ledger, otherLogical), otherV1);
    await applied({ kind: "doc-submit", paths: [upstreamLogical, otherLogical] });

    const prepareSubmittedTask = async (
      title: string,
      baselines: readonly Record<string, unknown>[],
    ): Promise<{ taskId: string; packagePath: string; executionId: string }> => {
      const created = await applied({
        kind: "task-create",
        title,
        verticalId: "office/collab",
        presetId: "deliverable-task",
        profileId: "upstream-verified",
        riskTier: "low",
      });
      const taskId = String((created as { taskId?: string }).taskId);
      const pkg = String((created as { packagePath?: string }).packagePath);
      await realizeTaskPlanFixture(root, `harness/${pkg}`, (docPath: string) =>
        applied({ kind: "doc-submit", paths: [docPath] }),
      );
      await applied({ kind: "task-start", taskId });
      const deliverableBody =
        "# Quarterly Deliverable\n\n## Executive Summary\n\nAligned with charter.\n\n## Action Plan\n\n- Deliver review packet\n";
      const deliverableSha = sha256(deliverableBody);
      mkdirSync(path.join(ledger, pkg, "artifacts"), { recursive: true });
      writeFileSync(path.join(ledger, pkg, "artifacts/deliverable.md"), deliverableBody);
      writeFileSync(
        path.join(ledger, pkg, "artifacts/deliverable-manifest.json"),
        JSON.stringify({
          schema: "office-collab/deliverable-manifest/v1",
          title,
          deliverableKind: "report",
          owner: "coordinator",
          audience: "operations",
          documentPath: "artifacts/deliverable.md",
          documentSha256: deliverableSha,
          requiredSections: ["## Executive Summary", "## Action Plan"],
        }),
      );
      writeFileSync(
        path.join(ledger, pkg, "artifacts/upstream-freshness.json"),
        JSON.stringify({
          schema: "office-collab/upstream-freshness/v1",
          checkedAt: "2026-11-21T09:00:00Z",
          baselines,
        }),
      );
      writeFileSync(
        path.join(ledger, pkg, "closeout.md"),
        "# Closeout\n\n## Summary\n\nVerified deliverable and upstream anchor.\n\n## Verification\n\nManifests synced.\n",
      );
      await applied({
        kind: "doc-submit",
        paths: [
          `${pkg}/artifacts/deliverable.md`,
          `${pkg}/artifacts/deliverable-manifest.json`,
          `${pkg}/artifacts/upstream-freshness.json`,
          `${pkg}/closeout.md`,
        ],
      });
      await applied({ kind: "task-submit", taskId });
      const snap = await readTaskSnapshot(taskId);
      const exec = snap.executions.find((e) => e.schema === "execution/v1" && e.state === "submitted")!;
      return { taskId, packagePath: pkg, executionId: exec.executionId };
    };

    // 2. Submit downstream task pinned directly to canonical charter v1 -> passes at submit with verifiedAnchors
    const raced = await prepareSubmittedTask("Raced Downstream Task", [
      { ref: upstreamLogical, expectedSha256: charterV1Sha },
    ]);
    const initialSnap = await readTaskSnapshot(raced.taskId);
    const initialExec = initialSnap.executions.find((e) => e.executionId === raced.executionId)!;
    assert.equal(initialExec.schema, "execution/v1");
    if (initialExec.schema !== "execution/v1") return;
    const initialUpstreamRuns = (initialExec.gateRuns ?? []).filter((r) => r.gateId === "upstream-fresh");
    assert.equal(initialUpstreamRuns.length, 1);
    assert.equal(initialUpstreamRuns[0]!.result, "pass");
    assert.equal(
      (initialExec.gateRuns ?? []).find((r) => r.gateId === "deliverable-contract")?.result,
      "pass",
      JSON.stringify(initialExec.gateRuns),
    );

    // 3. HA09-13 discrete synchronization point:
    // Queue doc-submit(v2) at the front of RepoCell's serial writeQueue while paused on its Keycloak
    // authorization fetch. Meanwhile, launch task-complete so its externalRead (runCompletionSources)
    // completes while live canonical charter is STILL v1, and task-complete chains into writeQueue
    // behind doc-submit(v2). Then release doc-submit(v2): v2 commits first, and task-complete runs
    // serially immediately after -> completeTask MUST reject atomically with gate_witness_missing!
    const charterV2 = "# Upstream Charter\n\nApproved Q4 scope v2 (concurrent update).\n";
    const charterV2Sha = sha256(charterV2);
    assert.equal(await readLiveDocSha(upstreamLogical), charterV1Sha);
    const revBeforeV2 = cell.status().ledgerRevision;
    assert.equal(typeof revBeforeV2, "number");
    writeFileSync(path.join(ledger, upstreamLogical), charterV2);

    // Pause doc-submit(v2) at the served Keycloak HTTP policy endpoint (crossing the worker thread
    // cleanly, as in queued-authorization-current-cut.integration.test.ts):
    //   docSubmitEvals #1: doc-submit(v2) inside enqueuePublication (holds RepoCell's serial writeQueue head).
    //   taskCompleteEvals #1: task-complete's externalRead preflight authorizeAtCurrentCut (ledger is STILL at v1).
    //   taskCompleteEvals #2: task-complete's queued enqueuePublication authorizeAtCurrentCut (ledger is NOW at v2).
    let docPausedResolve!: () => void;
    const docPaused = new Promise<void>((resolve) => {
      docPausedResolve = resolve;
    });
    let releaseDocResolve!: () => void;
    const releaseDoc = new Promise<void>((resolve) => {
      releaseDocResolve = resolve;
    });
    let completeEnqueuedResolve!: () => void;
    const completeEnqueued = new Promise<void>((resolve) => {
      completeEnqueuedResolve = resolve;
    });
    releasePendingQueue = releaseDocResolve;

    const originalFetch = policyTestRealm.keycloak.fetch;
    let docSubmitEvals = 0;
    let taskCompleteEvals = 0;
    let preflightRevision: number | null | undefined = undefined;
    let observedPreflightSha: string | null = null;
    const scopesFromBody = (init?: RequestInit): string[] => {
      if (typeof init?.body !== "string") return [];
      const parsed = JSON.parse(init.body) as { resources?: { scopes?: { name?: string }[] }[] };
      return (parsed.resources ?? []).flatMap((resource) => (resource.scopes ?? []).map((scope) => scope.name ?? ""));
    };
    policyTestRealm.keycloak.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/authz/resource-server/policy/evaluate")) {
        const scopes = scopesFromBody(init);
        if (scopes.includes("doc-submit")) {
          docSubmitEvals += 1;
          if (docSubmitEvals === 1) {
            docPausedResolve();
            await releaseDoc;
          }
        } else if (scopes.includes("task-complete")) {
          taskCompleteEvals += 1;
          if (taskCompleteEvals === 1) {
            preflightRevision = cell.status().ledgerRevision;
            observedPreflightSha = await readLiveDocSha(upstreamLogical);
          }
        }
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    t.after(() => {
      policyTestRealm.keycloak.fetch = originalFetch;
    });

    let observedBlockingHead: RepoCellWriteQueueHead | null | undefined = undefined;
    const completeQueueObservation = {
      label: { command: "task-complete", requestId: "ha09-race" },
      get head(): RepoCellWriteQueueHead | null | undefined {
        return observedBlockingHead;
      },
      set head(value: RepoCellWriteQueueHead | null | undefined) {
        observedBlockingHead = value;
        completeEnqueuedResolve();
      },
    };

    let docV2Receipt: Awaited<ReturnType<typeof cell.run>>;
    let completeRacedReceipt: Awaited<ReturnType<typeof cell.run>>;
    try {
      const docV2Promise = cell.run({ kind: "doc-submit", paths: [upstreamLogical] }, owner);
      await Promise.race([
        docPaused,
        docV2Promise.then((receipt) => {
          throw new Error(`doc-submit settled before pausing on policy evaluate: ${JSON.stringify(receipt)}`);
        }),
      ]);

      const completeRacedPromise = cell.run(
        { kind: "task-complete", taskId: raced.taskId },
        owner,
        undefined,
        undefined,
        completeQueueObservation,
      );
      // Resolves synchronously at the exact instant task-complete finishes externalRead (runCompletionSources)
      // on v1 and appends onto RepoCell's serial writeQueue directly behind the paused doc-submit(v2).
      await Promise.race([
        completeEnqueued,
        completeRacedPromise.then((receipt) => {
          throw new Error(`task-complete settled before enqueueing behind doc-submit: ${JSON.stringify(receipt)}`);
        }),
      ]);
      assert.equal(
        preflightRevision,
        revBeforeV2,
        "canonical ledger must still be at v1 revision during task-complete externalRead preflight",
      );
      assert.equal(
        observedPreflightSha,
        charterV1Sha,
        "live canonical charter must still be v1 during task-complete externalRead preflight",
      );
      assert.equal(
        observedBlockingHead?.command,
        "doc-submit",
        "task-complete must be queued directly behind the in-flight doc-submit(v2)",
      );

      // Release doc-submit(v2) immediately so it commits v2 before completeTask executes serially.
      releaseDocResolve();
      [docV2Receipt, completeRacedReceipt] = await Promise.all([docV2Promise, completeRacedPromise]);
    } finally {
      policyTestRealm.keycloak.fetch = originalFetch;
    }
    assert.equal(docSubmitEvals, 1, "doc-submit(v2) must have paused once inside enqueuePublication");
    assert.ok(
      taskCompleteEvals >= 2,
      `expected >=2 task-complete policy evaluations (preflight + queued serial write), got ${taskCompleteEvals}`,
    );
    assert.ok(
      docV2Receipt.outcome === "applied" || (docV2Receipt.outcome === "pending" && docV2Receipt.acceptance !== null),
      JSON.stringify(docV2Receipt),
    );
    if (docV2Receipt.acceptance !== null) await waitForFixturePublication(cell, docV2Receipt.opId, owner);
    const docV2Revision = (docV2Receipt as { revision?: number }).revision;
    assert.equal(typeof docV2Revision, "number", JSON.stringify(docV2Receipt));
    assert.equal(
      (completeRacedReceipt as { authorizationDecision?: { evaluatedAtCut?: string } }).authorizationDecision
        ?.evaluatedAtCut,
      `canonical:${docV2Revision}`,
      "queued task-complete must execute serially on the exact cut left by doc-submit(v2)",
    );
    assert.equal(await readLiveDocSha(upstreamLogical), charterV2Sha);

    assert.equal(completeRacedReceipt.outcome, "op_rejected", JSON.stringify(completeRacedReceipt));
    assert.equal(completeRacedReceipt.code, "gate_witness_missing", JSON.stringify(completeRacedReceipt));
    assert.match(JSON.stringify(completeRacedReceipt), /Live upstream drift/u);
    assert.equal((await readTaskSnapshot(raced.taskId)).task?.status, "submitted");

    // 4. HA09-12: Non-owner & technical executor invocations MUST NOT mutate gateRuns or forge owner rerun
    const nonOwnerWitnessRun = await cell.run(
      {
        kind: "task-witness-run",
        taskId: raced.taskId,
        executionId: raced.executionId,
        gateId: "upstream-fresh",
      },
      nonOwner,
    );
    assert.equal(nonOwnerWitnessRun.outcome, "no_changes", JSON.stringify(nonOwnerWitnessRun));

    const techComplete = await cell.run({ kind: "task-complete", taskId: raced.taskId }, technicalExecutor);
    assert.equal(techComplete.outcome, "op_rejected", JSON.stringify(techComplete));
    assert.equal(techComplete.code, "gate_witness_missing", JSON.stringify(techComplete));

    const nonOwnerComplete = await cell.run({ kind: "task-complete", taskId: raced.taskId }, nonOwner);
    assert.equal(nonOwnerComplete.outcome, "op_rejected", JSON.stringify(nonOwnerComplete));
    assert.equal(nonOwnerComplete.code, "gate_witness_missing", JSON.stringify(nonOwnerComplete));

    const afterAuthChecksSnap = await readTaskSnapshot(raced.taskId);
    const afterAuthChecksExec = afterAuthChecksSnap.executions.find((e) => e.executionId === raced.executionId)!;
    assert.equal(afterAuthChecksExec.schema, "execution/v1");
    if (afterAuthChecksExec.schema !== "execution/v1") return;
    assert.deepEqual(
      (afterAuthChecksExec.gateRuns ?? []).filter((r) => r.gateId === "upstream-fresh").map((r) => r.runId),
      [initialUpstreamRuns[0]!.runId],
      "no implicit or owner-impersonating gate_run_changed may be written by task-complete or task-witness-run",
    );

    // Non-owner explicit task-witness-rerun is rejected (owner-only), while real owner rerun succeeds and records fail
    const nonOwnerRerun = await cell.run(
      {
        kind: "task-witness-rerun",
        taskId: raced.taskId,
        executionId: raced.executionId,
        gateId: "upstream-fresh",
        runId: initialUpstreamRuns[0]!.runId,
        reason: "non-owner attempt",
      },
      nonOwner,
    );
    assert.equal(nonOwnerRerun.outcome, "op_rejected", JSON.stringify(nonOwnerRerun));

    const ownerRerun = await applied(
      {
        kind: "task-witness-rerun",
        taskId: raced.taskId,
        executionId: raced.executionId,
        gateId: "upstream-fresh",
        runId: initialUpstreamRuns[0]!.runId,
        reason: "owner re-verifying after upstream v2",
      },
      owner,
    );
    assert.equal(ownerRerun.outcome, "applied", JSON.stringify(ownerRerun));
    const afterOwnerRerunSnap = await readTaskSnapshot(raced.taskId);
    const afterOwnerRerunExec = afterOwnerRerunSnap.executions.find((e) => e.executionId === raced.executionId)!;
    assert.equal(afterOwnerRerunExec.schema, "execution/v1");
    if (afterOwnerRerunExec.schema !== "execution/v1") return;
    const rerunList = (afterOwnerRerunExec.gateRuns ?? []).filter((r) => r.gateId === "upstream-fresh");
    assert.equal(rerunList.length, 2);
    assert.equal(rerunList[1]!.result, "fail");
    assert.equal(rerunList[1]!.supersedesRunId, initialUpstreamRuns[0]!.runId);
    assert.equal(rerunList[1]!.actor.principal.personId, "office-owner");
    assert.deepEqual(rerunList[1]!.actor.executor, {
      kind: "agent",
      id: "completion-source:office-collab/upstream-fresh",
    });

    // 5. HA09-11: Direct canonical ref CANNOT be substituted via sourcePath pointing to unrelated v1 document
    const substituted = await prepareSubmittedTask("Substituted Canonical Ref Task", [
      { ref: upstreamLogical, sourcePath: otherLogical, expectedSha256: otherV1Sha },
    ]);
    const substitutedComplete = await cell.run({ kind: "task-complete", taskId: substituted.taskId }, owner);
    assert.equal(substitutedComplete.outcome, "op_rejected", JSON.stringify(substitutedComplete));
    assert.equal(substitutedComplete.code, "gate_witness_missing", JSON.stringify(substitutedComplete));
    assert.match(JSON.stringify(substitutedComplete), /sourcePath is not allowed for direct canonical ref/u);

    // 6. Positive control: direct canonical ref aligned to live v2 passes and completes cleanly
    const aligned = await prepareSubmittedTask("Aligned Direct Canonical Ref Task", [
      { ref: upstreamLogical, expectedSha256: charterV2Sha },
    ]);
    const alignedComplete = await applied({ kind: "task-complete", taskId: aligned.taskId }, owner);
    assert.equal(alignedComplete.outcome, "applied", JSON.stringify(alignedComplete));
    assert.equal((await readTaskSnapshot(aligned.taskId)).task?.status, "done");
  },
);

test(
  "HA09-12: non-office custom command gates whose subject JSON contains baselines/ref/sourcePath/expectedSha256 are never invalidated or re-run",
  { timeout: 120_000 },
  async (t) => {
    const { root, ledger } = initLedgerFixture("ha-custom-command-baselines-");
    const repoId = workspaceId("custom-command-baselines");
    const verticalId = "custom/metrics";
    const assets = path.join(root, "verticals/custom-metrics");
    cpSync(new URL("../../preset/assets/software-coding", import.meta.url), assets, { recursive: true });
    const declarationPath = path.join(assets, "vertical.json");
    const declaration = JSON.parse(readFileSync(declarationPath, "utf8")) as Record<string, unknown>;
    declaration.id = verticalId;
    declaration.completion = {
      sources: {
        "custom/metrics-check": {
          kind: "command",
          entrypoint: "metrics-task/check-metrics",
          predicateType: "custom/metrics/v1",
          resultSchema: {
            type: "object",
            required: ["ok"],
            additionalProperties: false,
            properties: { ok: { type: "boolean", const: true } },
          },
        },
      },
      gates: {
        "metrics-check": {
          source: "custom/metrics-check",
          appliesTo: "artifacts",
          subjects: ["artifacts/metrics.json"],
        },
      },
      closeoutDefaults: { review: false, consent: false, factDisposition: false },
    };
    writeFileSync(declarationPath, JSON.stringify(declaration));

    const presetDir = path.join(assets, "presets/metrics-task");
    mkdirSync(path.join(presetDir, "checks"), { recursive: true });
    writeFileSync(
      path.join(presetDir, "preset.json"),
      JSON.stringify({
        schema: "preset-manifest/v3",
        id: "metrics-task",
        title: "Metrics Task",
        vertical: verticalId,
        version: "1.0.0",
        kind: "template-content",
        outputShape: "task-package-artifact",
        kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
        capabilityImports: [{ id: "completion-witness", kind: "checker", version: "1", required: true }],
        entrypoints: {
          "check-metrics": {
            type: "script",
            intent: "Verify custom metrics artifact",
            inputs: [{ name: "witnessInput", type: "string", required: true }],
            requires: [],
            produces: [{ id: "completion-witness", kind: "checker", version: "1" }],
            sideEffects: [],
            command: "checks/check-metrics.mjs",
          },
        },
        profiles: [
          {
            id: "baseline",
            title: "Baseline",
            completionGates: ["metrics-check"],
            templateSelections: [],
            closeoutOverrides: { review: false, consent: false },
          },
        ],
        defaultProfile: "baseline",
      }),
    );
    writeFileSync(
      path.join(presetDir, "PRESET.md"),
      "---\nschema: preset-document/v1\ndescription: Custom business metrics verification preset.\nwhenToUse: Non-office custom command gates.\n---\n# Metrics Task\n",
    );
    writeFileSync(
      path.join(presetDir, "checks/check-metrics.mjs"),
      `import { readFileSync } from "node:fs";
const inputPath = JSON.parse(process.env.HA_PRESET_INPUT ?? "{}").witnessInput;
const witness = JSON.parse(readFileSync(inputPath, "utf8"));
const subjects = (witness.subjects ?? []).map(({ file: _file, ...identity }) => identity);
const hasCanonicalDocs = Object.hasOwn(witness, "canonicalDocuments");
console.log(JSON.stringify({
  schema: "preset-script-result/v1",
  produces: [{
    capabilityId: "completion-witness",
    payload: {
      result: hasCanonicalDocs ? "fail" : "pass",
      subjects,
      predicateType: "custom/metrics/v1",
      predicate: hasCanonicalDocs ? {} : { ok: true },
      diagnostic: hasCanonicalDocs ? "unexpected canonicalDocuments in non-office witness input" : "custom pass"
    }
  }]
}));
`,
    );
    writeFileSync(
      path.join(ledger, "harness.yaml"),
      writeRepositorySettingsFacet(
        "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings: {}\n",
        {
          ...INITIAL_SETTINGS_V1,
          defaultVertical: verticalId,
          defaultPreset: "metrics-task",
          defaultProfile: "baseline",
        },
      ),
    );

    const cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "custom-owner" });
    t.after(async () => {
      await cell.close();
      rmSync(root, { recursive: true, force: true });
    });
    const owner = withPolicyGroup(
      { actor: { principal: { personId: "custom-owner" }, executor: null }, source: "local" as const },
      "admin",
    );
    const applied = async (action: Record<string, unknown> & { kind: string }) => {
      const receipt = await cell.run(action, owner);
      assert.ok(
        receipt.outcome === "applied" || (receipt.outcome === "pending" && receipt.acceptance !== null),
        JSON.stringify(receipt),
      );
      if (receipt.acceptance !== null) await waitForFixturePublication(cell, receipt.opId, owner);
      return receipt;
    };

    const readCustomTaskSnapshot = async (taskId: string): Promise<TaskLifecycleSnapshot> => {
      const shown = await cell.run({ kind: "task-show", taskId }, owner);
      assert.equal(shown.outcome, "applied", JSON.stringify(shown));
      return JSON.parse(String(shown.evidence)) as TaskLifecycleSnapshot;
    };

    await applied({ kind: "preset-install", packageSource: presetDir });

    const refDocPath = "context/custom-ref.md";
    mkdirSync(path.join(ledger, "context"), { recursive: true });
    writeFileSync(path.join(ledger, refDocPath), "v1\n");
    await applied({ kind: "doc-submit", paths: [refDocPath] });

    const created = await applied({
      kind: "task-create",
      title: "Custom Metrics Run",
      presetId: "metrics-task",
      profileId: "baseline",
      riskTier: "low",
    });
    const taskId = String((created as { taskId?: string }).taskId);
    const pkg = String((created as { packagePath?: string }).packagePath);
    await realizeTaskPlanFixture(root, `harness/${pkg}`, (docPath: string) =>
      applied({ kind: "doc-submit", paths: [docPath] }),
    );
    await applied({ kind: "task-start", taskId });
    mkdirSync(path.join(ledger, pkg, "artifacts"), { recursive: true });
    writeFileSync(
      path.join(ledger, pkg, "artifacts/metrics.json"),
      JSON.stringify({
        schema: "custom/business-metrics/v1",
        baselines: [{ ref: refDocPath, sourcePath: refDocPath, expectedSha256: sha256("v1\n") }],
      }),
    );
    writeFileSync(
      path.join(ledger, pkg, "closeout.md"),
      "# Closeout\n\n## Summary\n\nCustom gate test.\n\n## Verification\n\nMetrics synced.\n",
    );
    await applied({ kind: "doc-submit", paths: [`${pkg}/artifacts/metrics.json`, `${pkg}/closeout.md`] });
    await applied({ kind: "task-submit", taskId });

    const snapBefore = await readCustomTaskSnapshot(taskId);
    const execBefore = snapBefore.executions.find((e) => e.schema === "execution/v1" && e.state === "submitted")!;
    assert.equal(execBefore.schema, "execution/v1");
    if (execBefore.schema !== "execution/v1") return;
    const initialRunIds = (execBefore.gateRuns ?? []).map((r) => r.runId);
    assert.equal(initialRunIds.length, 1);

    // Mutate the referenced document from v1 -> v2; non-office custom gate MUST remain unaffected!
    writeFileSync(path.join(ledger, refDocPath), "v2\n");
    await applied({ kind: "doc-submit", paths: [refDocPath] });

    const completed = await applied({ kind: "task-complete", taskId });
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    const snapAfter = await readCustomTaskSnapshot(taskId);
    assert.equal(snapAfter.task?.status, "done");
    const execAfter = snapAfter.executions.find((e) => e.executionId === execBefore.executionId)!;
    assert.equal(execAfter.schema, "execution/v1");
    if (execAfter.schema !== "execution/v1") return;
    assert.deepEqual(
      (execAfter.gateRuns ?? []).map((r) => r.runId),
      initialRunIds,
      "non-office custom command gate must never be re-run or invalidated by office freshness logic",
    );
  },
);

test("HA09-16: non-office all-artifacts command gates perform 0 live document reads and receive unchanged frozen witness input", async () => {
  const packagePath = "tasks/task_non_office_all_artifacts";
  const blobs = new Map<string, Uint8Array>();
  const claims: Array<{ path: string; sha256: string }> = [];
  const artifacts: Array<{ path: string; revision: number; blobSha256: string }> = [];
  for (let i = 0; i < 6; i += 1) {
    const content = Buffer.from(`artifact-content-${i}\n`, "utf8");
    const digest = sha256(content);
    const fullPath = `${packagePath}/artifacts/item-${i}.txt`;
    blobs.set(digest, content);
    claims.push({ path: fullPath, sha256: digest });
    artifacts.push({ path: fullPath, revision: 11, blobSha256: digest });
  }
  const readDocumentPaths: string[] = [];
  const fakeCell = {
    input: { repoId: "repo_non_office_spy" },
    rootDir: "/tmp/non-office-spy",
    cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    projection: {
      read: () => ({ packagePath }),
      readPresetSnapshot: () => ({
        snapshot: {
          digest: "sha256:" + "a".repeat(64),
          completionPackages: {
            "custom/all-artifacts-source": { id: "custom-preset" },
          },
        },
      }),
      readDocument: (docPath: string) => {
        readDocumentPaths.push(docPath);
        return { document: null };
      },
    },
    store: {
      readEventAtRevision: (revision: number) =>
        revision === 11
          ? {
              schema: "doc-event/v1",
              opId: "op_doc_accept_11",
              workspaceRevision: 11,
              payload: {
                changes: claims.map((claim) => ({
                  path: claim.path,
                  candidate: { sha256: claim.sha256, size: blobs.get(claim.sha256)!.length, mediaType: "text/plain" },
                })),
              },
            }
          : null,
      readContentBlob: (digest: string) => blobs.get(digest) ?? null,
    },
  } as unknown as RepoCellOperationalContext;

  const requirement: FrozenGateRequirement = {
    gateId: "all-artifacts-gate",
    appliesTo: "artifacts",
    subjects: "all-artifacts",
    witness: {
      kind: "command",
      adapterId: "custom/all-artifacts-source",
      entrypoint: "custom-preset/check",
      predicateType: "custom/all-artifacts/v1",
      resultSchema: {
        type: "object",
        required: ["ok"],
        additionalProperties: false,
        properties: { ok: { type: "boolean", const: true } },
      },
    },
  };
  const submission = {
    commitSha: null,
    artifacts,
    completionContract: {
      presetSnapshotDigest: "sha256:" + "a".repeat(64),
      gates: [requirement],
    },
  };
  const digest = submissionDigest(submission as Parameters<typeof submissionDigest>[0]);
  const execution = {
    schema: "execution/v1",
    taskId: "task_non_office_all_artifacts",
    executionId: "exe_non_office_1",
    iteration: 1,
    state: "submitted",
    submission,
    gateRuns: [
      {
        gateId: "all-artifacts-gate",
        runId: "run_non_office_1",
        sourceId: "custom/all-artifacts-source",
        state: "running",
        claimFence: 1,
        submissionDigest: digest,
      },
    ],
  } as unknown as Snapshot["executions"][number];

  let capturedWitnessInput: Record<string, unknown> | undefined;
  const fakeProcess = {
    startFrozen: async (
      _req: unknown,
      frozen: { readonly inputFiles: Record<string, Uint8Array> },
      hooks: {
        readonly onSettled: () => void;
        readonly publish: (item: Record<string, unknown>) => Promise<{ outcome: string }>;
      },
    ) => {
      capturedWitnessInput = JSON.parse(Buffer.from(frozen.inputFiles["witness.json"]!).toString("utf8")) as Record<
        string,
        unknown
      >;
      const published = await hooks.publish({
        kind: "completion-witness",
        result: "pass",
        subjects: artifacts,
        predicateType: "custom/all-artifacts/v1",
        predicate: { ok: true },
        diagnostic: "verified",
      });
      assert.equal(published.outcome, "applied", JSON.stringify(published));
      hooks.onSettled();
      return { runId: "preset_run_spy_1" };
    },
    status: () => ({ outcome: "applied" }),
  } as unknown as PresetProcessService;

  const evidence = await collectCommandWitness(fakeCell, requirement, execution, fakeProcess);
  assert.equal(evidence.result, "pass");
  assert.deepEqual(
    readDocumentPaths,
    [],
    "non-office all-artifacts command gate must perform 0 live canonical document reads",
  );
  assert.ok(capturedWitnessInput, "expected witness.json to be constructed");
  assert.equal(
    Object.hasOwn(capturedWitnessInput, "canonicalDocuments"),
    false,
    "non-office witness.json must not include canonicalDocuments",
  );
  assert.deepEqual(Object.keys(capturedWitnessInput).sort(), [
    "artifacts",
    "code",
    "executionId",
    "gateId",
    "gateRunId",
    "iteration",
    "packagePath",
    "repoId",
    "schema",
    "subjects",
    "submissionDigest",
    "taskId",
  ]);
});

test(
  "HA09-15: real daemon completes 450-entry upstream manifest within 64 KiB witness budget and blocks live drift on entry #450 via pinned manifest readback",
  { timeout: 120_000 },
  async (t) => {
    const { root, ledger } = initLedgerFixture("ha-office-450-upstream-");
    const repoId = workspaceId("office-450-upstream");
    writeFileSync(
      path.join(ledger, "harness.yaml"),
      writeRepositorySettingsFacet(
        "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings: {}\n",
        {
          ...INITIAL_SETTINGS_V1,
          defaultVertical: "office/collab",
          defaultPreset: "deliverable-task",
          defaultProfile: "upstream-verified",
        },
      ),
    );
    const cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "office-owner" });
    t.after(async () => {
      await cell.close();
      rmSync(root, { recursive: true, force: true });
    });
    const owner = withPolicyGroup(
      { actor: { principal: { personId: "office-owner" }, executor: null }, source: "local" as const },
      "admin",
    );
    const applied = async (action: Record<string, unknown> & { kind: string }) => {
      const receipt = await cell.run(action, owner);
      assert.ok(
        receipt.outcome === "applied" || (receipt.outcome === "pending" && receipt.acceptance !== null),
        JSON.stringify(receipt),
      );
      if (receipt.acceptance !== null) await waitForFixturePublication(cell, receipt.opId, owner);
      return receipt;
    };

    const refDir = path.join(ledger, "context", "upstream-baselines");
    mkdirSync(refDir, { recursive: true });
    const refPaths: string[] = [];
    const baselineBodyV1 = "# Canonical Baseline\nApproved v1.\n";
    const baselineShaV1 = sha256(baselineBodyV1);
    for (let i = 0; i < 450; i += 1) {
      const relPath = `context/upstream-baselines/ref-${String(i).padStart(3, "0")}.md`;
      writeFileSync(path.join(ledger, relPath), baselineBodyV1);
      refPaths.push(relPath);
    }
    await applied({ kind: "doc-submit", paths: refPaths });
    const baselines = refPaths.map((ref) => ({ ref, expectedSha256: baselineShaV1 }));

    const submit450Task = async (title: string): Promise<string> => {
      const created = await applied({
        kind: "task-create",
        title,
        verticalId: "office/collab",
        presetId: "deliverable-task",
        profileId: "upstream-verified",
        riskTier: "low",
      });
      const taskId = String((created as { taskId?: string }).taskId);
      const pkg = String((created as { packagePath?: string }).packagePath);
      await realizeTaskPlanFixture(root, `harness/${pkg}`, (docPath: string) =>
        applied({ kind: "doc-submit", paths: [docPath] }),
      );
      await applied({ kind: "task-start", taskId });
      const deliverableBody = "## Executive Summary\n\nAligned with all 450 baselines.\n\n## Action Plan\n\nShip.\n";
      mkdirSync(path.join(ledger, pkg, "artifacts"), { recursive: true });
      writeFileSync(path.join(ledger, pkg, "artifacts/deliverable.md"), deliverableBody);
      writeFileSync(
        path.join(ledger, pkg, "artifacts/deliverable-manifest.json"),
        JSON.stringify({
          schema: "office-collab/deliverable-manifest/v1",
          title,
          deliverableKind: "report",
          owner: "coordinator",
          audience: "operations",
          documentPath: "artifacts/deliverable.md",
          documentSha256: sha256(deliverableBody),
          requiredSections: ["## Executive Summary", "## Action Plan"],
        }),
      );
      writeFileSync(
        path.join(ledger, pkg, "artifacts/upstream-freshness.json"),
        JSON.stringify({
          schema: "office-collab/upstream-freshness/v1",
          checkedAt: "2026-11-21T09:15:00Z",
          baselines,
        }),
      );
      writeFileSync(
        path.join(ledger, pkg, "closeout.md"),
        "# Closeout\n\n## Summary\n\n450 upstream baselines checked.\n\n## Verification\n\nSynced.\n",
      );
      await applied({
        kind: "doc-submit",
        paths: [
          `${pkg}/artifacts/deliverable.md`,
          `${pkg}/artifacts/deliverable-manifest.json`,
          `${pkg}/artifacts/upstream-freshness.json`,
          `${pkg}/closeout.md`,
        ],
      });
      await applied({ kind: "task-submit", taskId });
      return taskId;
    };

    // Positive: 450 aligned baselines pass submit and complete cleanly within 64 KiB budget
    const passTaskId = await submit450Task("Large 450-Baseline Pass Task");
    const completed = await applied({ kind: "task-complete", taskId: passTaskId });
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));

    // Negative: second task passes submit with 450 aligned baselines, then entry #450 drifts before completeTask
    const driftTaskId = await submit450Task("Large 450-Baseline Drift Task");
    const lastRef = refPaths[449]!;
    writeFileSync(path.join(ledger, lastRef), "# Canonical Baseline\nUpdated v2 after submit.\n");
    await applied({ kind: "doc-submit", paths: [lastRef] });
    const blocked = await cell.run({ kind: "task-complete", taskId: driftTaskId }, owner);
    assert.equal(blocked.outcome, "op_rejected", JSON.stringify(blocked));
    assert.equal(blocked.code, "gate_witness_missing", JSON.stringify(blocked));
    assert.match(
      String(blocked.rejectionExplanation ?? ""),
      /Live upstream drift on "context\/upstream-baselines\/ref-449\.md"/u,
    );
  },
);

test(
  "HA09-14: G38 measured read probes cli-vertical-list and repo.vertical.list stay flat across 10x task-history scaling",
  { timeout: 120_000 },
  async () => {
    const { READ_PROBES, measureReadScale } = await import("./fixtures/g38-read-cost.mjs");
    const { READ_MARGINS } = await import("../../../tools/gates/cost-budget-reads.mjs");
    const probeIds = ["cli-vertical-list", "repo.vertical.list"] as const;
    for (const id of probeIds) assert.ok(READ_PROBES[id], `missing G38 probe ${id}`);
    const small = await measureReadScale("sqlite", "task-history", 200, { probeIds: [...probeIds] });
    const large = await measureReadScale("sqlite", "task-history", 2000, { probeIds: [...probeIds] });
    for (const id of probeIds) {
      assert.equal(small[id].resultSize, 2, `${id} small resultSize`);
      assert.equal(large[id].resultSize, 2, `${id} large resultSize`);
      assert.equal(small[id].firstResultSize, 2, `${id} small firstResultSize`);
      assert.equal(large[id].firstResultSize, 2, `${id} large firstResultSize`);
      for (const phase of ["counts", "firstCall"] as const) {
        for (const [metric, margin] of Object.entries(READ_MARGINS)) {
          const smallVal = small[id][phase][metric];
          const largeVal = large[id][phase][metric];
          assert.ok(
            largeVal <= smallVal + margin,
            `${id} (${phase}/${metric}): small=${smallVal} -> large=${largeVal} exceeds margin ${margin}`,
          );
        }
      }
    }
  },
);
