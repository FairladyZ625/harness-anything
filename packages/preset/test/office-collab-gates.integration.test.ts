// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  INITIAL_SETTINGS_V1,
  completionBlockers,
  emptyTaskLifecycleSnapshot,
  reduceTaskEvent,
  resolveCompletionContract,
  submissionDigest,
  type ArtifactDelivery,
  type CompletionGateWitnessV1,
  type CompletionWitnessResult,
  type ExecutionV1,
  type TaskLifecycleSnapshot,
} from "@harness-anything/kernel";
import { completionPredicateIssues } from "@harness-anything/kernel/schemas";
import { makeTaskEventStore } from "@harness-anything/storage";
import { compileRepoTaskBootstrap, createPresetProcessService, runPresetAction } from "../src/index.ts";
import { waitFor } from "./preset-process-service.fixtures.ts";
import { git } from "./preset-resolver.fixtures.ts";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function submittedSnapshot(
  task: TaskLifecycleSnapshot["task"] & {},
  contract: ReturnType<typeof resolveCompletionContract> & { ok: true },
  artifacts: readonly ArtifactDelivery[],
  gateResults: readonly {
    readonly gateId: string;
    readonly runId: string;
    readonly witness: CompletionWitnessResult;
  }[],
): TaskLifecycleSnapshot {
  const submission: NonNullable<ExecutionV1["submission"]> = {
    submittedAt: "2026-11-21T00:05:00.000Z",
    commitSha: null,
    deliverables: artifacts.map(({ path: p }) => p),
    artifacts,
    completionContract: contract.contract,
  };
  const digest = submissionDigest(submission);
  const runnerActor = { principal: { personId: "person-collab" }, executor: { kind: "agent" as const, id: "runner" } };
  const gateRuns = gateResults.map((entry) => {
    const sourceId = contract.contract.gates.find((g) => g.gateId === entry.gateId)!.witness.adapterId;
    return {
      runId: entry.runId,
      gateId: entry.gateId,
      sourceId,
      submissionDigest: digest,
      claimFence: 1,
      state: "completed" as const,
      result: entry.witness.result,
      witness: entry.witness,
      claimedAt: "2026-11-21T00:05:01.000Z",
      settledAt: "2026-11-21T00:05:02.000Z",
    };
  });
  const gateWitnesses: CompletionGateWitnessV1[] = gateResults.map((entry) => {
    const sourceId = contract.contract.gates.find((g) => g.gateId === entry.gateId)!.witness.adapterId;
    return {
      schema: "completion-gate-witness/v1",
      receiptId: `rcpt-${entry.runId}`,
      taskId: task.taskId,
      executionId: "exec-office-1",
      iteration: task.iteration,
      gateId: entry.gateId,
      commitSha: null,
      result: entry.witness.result,
      observed: true,
      subjects: entry.witness.subjects,
      predicateType: entry.witness.predicateType,
      predicate: entry.witness.predicate,
      diagnostic: entry.witness.diagnostic,
      basis: {
        taskId: task.taskId,
        executionId: "exec-office-1",
        iteration: task.iteration,
        commitSha: null,
        submissionDigest: digest,
      },
      provenance: {
        source: "runner",
        claimFence: 1,
        adapterId: sourceId,
        runId: entry.runId,
        rawResult: entry.witness.diagnostic,
      },
      actor: runnerActor,
      verifiedAt: "2026-11-21T00:05:02.000Z",
    };
  });
  const execution: ExecutionV1 = {
    schema: "execution/v1",
    executionId: "exec-office-1",
    taskId: task.taskId,
    iteration: task.iteration,
    state: "submitted",
    actor: { principal: { personId: "person-collab" }, executor: { kind: "agent", id: "contributor" } },
    startedAt: "2026-11-21T00:01:00.000Z",
    submittedAt: "2026-11-21T00:05:00.000Z",
    submission,
    gateRuns,
    evidence: [],
  };
  return {
    ...emptyTaskLifecycleSnapshot(2),
    task: { ...task, status: "submitted", currentNode: "review" },
    executions: [execution],
    gateWitnesses,
  };
}

test("office/collab presets materialize bilingual task packages and survive cold event-store materialization", async () => {
  const settings = {
    ...INITIAL_SETTINGS_V1,
    defaultVertical: "office/collab",
    defaultPreset: "deliverable-task",
    defaultProfile: "baseline",
  };
  const cases = [
    {
      presetId: "deliverable-task",
      profileId: "upstream-verified",
      locale: "zh-CN",
      extraFile: "deliverable-brief.md",
      gates: ["deliverable-contract", "upstream-fresh"],
    },
    {
      presetId: "handoff-task",
      profileId: "fresh",
      locale: "en-US",
      extraFile: "handoff.md",
      gates: ["handoff-completeness", "upstream-fresh"],
    },
    { presetId: "minutes-task", profileId: "baseline", locale: "zh-CN", extraFile: "minutes.md", gates: [] },
  ] as const;

  for (const item of cases) {
    const rootDir = mkdtempSync(path.join(tmpdir(), `ha-office-collab-${item.presetId}-`));
    try {
      git(rootDir, "init", "-q");
      git(rootDir, "config", "user.name", "Office Collab Test");
      git(rootDir, "config", "user.email", "office@example.invalid");
      git(rootDir, "commit", "--allow-empty", "-qm", "base");

      const validated = (await runPresetAction({
        rootDir,
        settings,
        action: { kind: "vertical-validate", presetId: item.presetId },
      })) as { valid: boolean; vertical?: { id: string } };
      assert.equal(validated.valid, true, item.presetId);
      assert.equal(validated.vertical?.id, "office/collab");

      const compiled = compileRepoTaskBootstrap({
        rootDir,
        settings,
        action: {
          kind: "task-create",
          title: `Office ${item.presetId}`,
          presetId: item.presetId,
          profileId: item.profileId,
          locale: item.locale,
        },
        taskId: `task-${item.presetId}`,
        actor: { principal: { personId: "person-collab" }, executor: null },
        source: "local",
        workspaceRevision: 1,
        eventId: `event-${item.presetId}`,
        opId: `op-${item.presetId}`,
        occurredAt: "2026-11-21T00:00:00.000Z",
      });
      assert.equal(compiled.snapshot.identity.verticalId, "office/collab");
      assert.deepEqual(compiled.snapshot.profile.completionGateIds, item.gates);
      assert.ok(
        compiled.documents.some((doc) => doc.relativePath === item.extraFile),
        item.extraFile,
      );

      const store = makeTaskEventStore({ repoId: `office-${item.presetId}`, rootDir });
      store.append({ event: compiled.event, plan: compiled.plan, blobs: compiled.blobs });
      await store.settlePendingMaterialization();
      for (const document of compiled.documents) {
        assert.equal(readFileSync(path.join(rootDir, "harness", document.path), "utf8"), document.body);
      }
      const reduced = reduceTaskEvent(emptyTaskLifecycleSnapshot(0), compiled.event);
      assert.equal(reduced.task?.metadata?.verticalId, "office/collab");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test("frozen preset process executes office/collab gates: red blocks completion with gate_witness_missing, repaired passes cleanly", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-office-collab-frozen-gates-"));
  const userRoot = path.join(rootDir, ".harness/presets");
  const settings = {
    ...INITIAL_SETTINGS_V1,
    defaultVertical: "office/collab",
    defaultPreset: "handoff-task",
    defaultProfile: "fresh",
  };
  const service = createPresetProcessService({ rootDir, userRoot, readSettings: () => settings });
  try {
    const compiled = compileRepoTaskBootstrap({
      rootDir,
      settings,
      action: {
        kind: "task-create",
        title: "Q4 Handoff",
        presetId: "handoff-task",
        profileId: "fresh",
        locale: "en-US",
      },
      taskId: "task-office-handoff",
      actor: { principal: { personId: "person-collab" }, executor: null },
      source: "local",
      workspaceRevision: 1,
      eventId: "event-office-handoff",
      opId: "op-office-handoff",
      occurredAt: "2026-11-21T00:00:00.000Z",
    });
    const contract = resolveCompletionContract(
      compiled.snapshot.profile.completionGateIds,
      { gates: INITIAL_SETTINGS_V1.gates, closeout: INITIAL_SETTINGS_V1.closeout },
      { digest: compiled.snapshot.digest, completion: compiled.snapshot.completion },
    );
    assert.equal(contract.ok, true);
    if (!contract.ok) return;

    const runFrozenGate = async (
      gateId: "handoff-completeness" | "upstream-fresh",
      sourceId: string,
      presetId: string,
      entrypoint: string,
      idempotencyKey: string,
      artifactFiles: Record<string, string>,
      liveCanonicalOverrides?: Record<
        string,
        { readonly path: string; readonly revision: number; readonly blobSha256: string } | null
      >,
    ) => {
      const requirement = contract.contract.gates.find((g) => g.gateId === gateId)!;
      const inputFiles: Record<string, Uint8Array> = {};
      const allSubjects: Array<ArtifactDelivery & { file: string }> = [];
      const canonicalDocuments: Record<
        string,
        { readonly path: string; readonly revision: number; readonly blobSha256: string } | null
      > = {};
      let index = 0;
      for (const [logicalPath, body] of Object.entries(artifactFiles)) {
        const key = `artifact-${index++}`;
        const bytes = Buffer.from(body, "utf8");
        const fullPath = `${compiled.packagePath}/${logicalPath}`;
        const digest = sha256(bytes);
        inputFiles[key] = bytes;
        allSubjects.push({
          path: fullPath,
          revision: 1,
          blobSha256: digest,
          file: `input/${key}`,
        });
        canonicalDocuments[fullPath] = { path: fullPath, revision: 1, blobSha256: digest };
      }
      if (liveCanonicalOverrides) {
        Object.assign(canonicalDocuments, liveCanonicalOverrides);
      }
      const names =
        requirement.subjects === undefined || requirement.subjects === "all-artifacts"
          ? null
          : requirement.subjects.map((name) => `${compiled.packagePath}/${name}`);
      const subjects = allSubjects.filter((subject) => names === null || names.includes(subject.path));
      inputFiles["witness.json"] = Buffer.from(
        JSON.stringify({
          schema: "witness-input/v1",
          packagePath: compiled.packagePath,
          code: null,
          subjects,
          artifacts: allSubjects,
          canonicalDocuments,
        }),
        "utf8",
      );
      let witness: CompletionWitnessResult | undefined;
      const started = await service.startFrozen(
        {
          presetId,
          entrypoint,
          taskId: "task-office-handoff",
          inputs: { witnessInput: "input/witness.json" },
          idempotencyKey,
        },
        {
          package: compiled.snapshot.completionPackages[sourceId]!,
          snapshotDigest: compiled.snapshot.digest,
          inputFiles,
        },
        {
          admitProduce: (kind) => kind === "completion-witness",
          publish: async ({ kind: _kind, ...payload }) => {
            witness = payload as unknown as CompletionWitnessResult;
            return { outcome: "applied" as const };
          },
        },
      );
      assert.equal(started.outcome, "started", JSON.stringify(started));
      const settled = await waitFor(
        `gate ${gateId} ${idempotencyKey}`,
        () => service.status(started.runId),
        ({ outcome }) => ["applied", "failed", "op_rejected", "outcome_unknown"].includes(outcome),
      );
      assert.equal(settled.outcome, "applied", JSON.stringify(settled));
      assert.ok(witness);
      const anchors = subjects.map(({ file: _file, ...id }) => id);
      const predicateIssues = completionPredicateIssues(requirement, witness, anchors, (logical) => {
        const raw = artifactFiles[logical];
        return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
      });
      return { witness, anchors, predicateIssues };
    };

    const runbookBody = "# Service Runbook\nVerified handover checklist.\n";
    const runbookHash = sha256(runbookBody);
    const upstreamBody = "# Upstream Charter\nApproved scope v1.\n";
    const upstreamHash = sha256(upstreamBody);

    // 1. Negative control on handoff-completeness (missing acceptanceCriteria) -> fail & gate_witness_missing
    const redHandoff = await runFrozenGate(
      "handoff-completeness",
      "office-collab/handoff-completeness",
      "handoff-task",
      "verify-handoff",
      "handoff-red",
      {
        "artifacts/runbook.md": runbookBody,
        "artifacts/handoff.json": JSON.stringify({
          schema: "office-collab/handoff/v1",
          ownerTransfer: { from: "alice", to: "bob", effectiveAt: "2026-11-21T09:00:00Z" },
          deliverables: [{ path: "artifacts/runbook.md", sha256: runbookHash, summary: "Runbook" }],
          openItems: [],
        }),
      },
    );
    assert.equal(redHandoff.witness.result, "fail");
    assert.match(redHandoff.witness.diagnostic, /acceptanceCriteria/u);
    const blockedSnapshot = submittedSnapshot(compiled.event.payload.task, contract, redHandoff.anchors, [
      { gateId: "handoff-completeness", runId: "run-1", witness: redHandoff.witness },
    ]);
    const redBlockers = completionBlockers(blockedSnapshot, "exec-office-1", {
      closeout: "ready",
      closeoutPath: `${compiled.packagePath}/closeout.md`,
      eligibleDirtyPaths: [],
      closeoutGates: { review: false, consent: false, factDisposition: false },
    });
    assert.equal(redBlockers[0]?.code, "gate_witness_missing");
    assert.equal(redBlockers[0]?.gate, "handoff-completeness");

    // 2. Negative control on upstream-fresh (stale expectedSha256) -> fail & gate_witness_missing
    const redUpstream = await runFrozenGate(
      "upstream-fresh",
      "office-collab/upstream-fresh",
      "deliverable-task",
      "verify-upstream-fresh",
      "upstream-red",
      {
        "artifacts/upstream-charter.md": upstreamBody,
        "artifacts/upstream-freshness.json": JSON.stringify({
          schema: "office-collab/upstream-freshness/v1",
          checkedAt: "2026-11-21T09:00:00Z",
          baselines: [{ ref: "artifacts/upstream-charter.md", expectedSha256: sha256("older-version") }],
        }),
      },
    );
    assert.equal(redUpstream.witness.result, "fail");
    assert.match(redUpstream.witness.diagnostic, /Upstream drift/u);

    // 2b (HA09-11): Submission retains frozen v1 copy and expectedSha256=v1, while live canonical upstream advances to v2
    const upstreamV2Hash = sha256("# Upstream Charter\nApproved scope v2.\n");
    const liveDriftedUpstream = await runFrozenGate(
      "upstream-fresh",
      "office-collab/upstream-fresh",
      "deliverable-task",
      "verify-upstream-fresh",
      "upstream-live-drift-red",
      {
        "artifacts/upstream-charter.md": upstreamBody,
        "artifacts/upstream-freshness.json": JSON.stringify({
          schema: "office-collab/upstream-freshness/v1",
          checkedAt: "2026-11-21T09:00:00Z",
          baselines: [{ ref: "artifacts/upstream-charter.md", expectedSha256: upstreamHash }],
        }),
      },
      {
        [`${compiled.packagePath}/artifacts/upstream-charter.md`]: {
          path: `${compiled.packagePath}/artifacts/upstream-charter.md`,
          revision: 2,
          blobSha256: upstreamV2Hash,
        },
      },
    );
    assert.equal(liveDriftedUpstream.witness.result, "fail");
    assert.match(liveDriftedUpstream.witness.diagnostic, /Live upstream drift/u);

    // 3. Positive case: repaired handoff + fresh upstream -> both pass with zero predicate issues & zero completion blockers
    const goodArtifacts = {
      "artifacts/runbook.md": runbookBody,
      "artifacts/upstream-charter.md": upstreamBody,
      "artifacts/handoff.json": JSON.stringify({
        schema: "office-collab/handoff/v1",
        ownerTransfer: { from: "alice", to: "bob", effectiveAt: "2026-11-21T09:00:00Z" },
        deliverables: [{ path: "artifacts/runbook.md", sha256: runbookHash, summary: "Runbook" }],
        openItems: [{ id: "OI-1", summary: "Review weekly slot", owner: "bob", nextAction: "Confirm slot" }],
        acceptanceCriteria: ["Bob confirmed runbook ownership"],
      }),
      "artifacts/upstream-freshness.json": JSON.stringify({
        schema: "office-collab/upstream-freshness/v1",
        checkedAt: "2026-11-21T09:05:00Z",
        baselines: [{ ref: "artifacts/upstream-charter.md", expectedSha256: upstreamHash }],
      }),
    };
    const greenHandoff = await runFrozenGate(
      "handoff-completeness",
      "office-collab/handoff-completeness",
      "handoff-task",
      "verify-handoff",
      "handoff-green",
      goodArtifacts,
    );
    assert.equal(greenHandoff.witness.result, "pass", greenHandoff.witness.diagnostic);
    assert.deepEqual(greenHandoff.predicateIssues, []);

    const liveDriftedSnapshot = submittedSnapshot(compiled.event.payload.task, contract, greenHandoff.anchors, [
      { gateId: "handoff-completeness", runId: "run-1", witness: greenHandoff.witness },
      { gateId: "upstream-fresh", runId: "run-live-drift", witness: liveDriftedUpstream.witness },
    ]);
    const liveDriftBlockers = completionBlockers(liveDriftedSnapshot, "exec-office-1", {
      closeout: "ready",
      closeoutPath: `${compiled.packagePath}/closeout.md`,
      eligibleDirtyPaths: [],
      closeoutGates: { review: false, consent: false, factDisposition: false },
    });
    assert.ok(
      liveDriftBlockers.some((blocker) => blocker.code === "gate_witness_missing" && blocker.gate === "upstream-fresh"),
      JSON.stringify(liveDriftBlockers),
    );

    const greenUpstream = await runFrozenGate(
      "upstream-fresh",
      "office-collab/upstream-fresh",
      "deliverable-task",
      "verify-upstream-fresh",
      "upstream-green",
      goodArtifacts,
    );
    assert.equal(greenUpstream.witness.result, "pass", greenUpstream.witness.diagnostic);
    assert.deepEqual(greenUpstream.predicateIssues, []);

    const bothPassingSnapshot = submittedSnapshot(compiled.event.payload.task, contract, greenHandoff.anchors, [
      { gateId: "handoff-completeness", runId: "run-1", witness: greenHandoff.witness },
      { gateId: "upstream-fresh", runId: "run-2", witness: greenUpstream.witness },
    ]);
    const greenBlockers = completionBlockers(bothPassingSnapshot, "exec-office-1", {
      closeout: "ready",
      closeoutPath: `${compiled.packagePath}/closeout.md`,
      eligibleDirtyPaths: [],
      closeoutGates: { review: false, consent: false, factDisposition: false },
    });
    assert.deepEqual(greenBlockers, []);
    // 4. Scale test (HA09-3): 500 unrelated frozen Markdown notes must stay well under the 64KiB result_oversize limit
    const with500Notes: Record<string, string> = { ...goodArtifacts };
    for (let i = 0; i < 500; i += 1) {
      with500Notes[`artifacts/notes/n${i}.md`] = `# Note ${i}\nUnrelated meeting scratchpad entry ${i}.\n`;
    }
    const scaledHandoff = await runFrozenGate(
      "handoff-completeness",
      "office-collab/handoff-completeness",
      "handoff-task",
      "verify-handoff",
      "handoff-500-notes",
      with500Notes,
    );
    assert.equal(scaledHandoff.witness.result, "pass", scaledHandoff.witness.diagnostic);
    assert.equal(scaledHandoff.witness.subjects.length, 1);
    assert.equal(scaledHandoff.witness.subjects[0]?.path, `${compiled.packagePath}/artifacts/handoff.json`);
    assert.deepEqual(scaledHandoff.predicateIssues, []);

    const scaledUpstream = await runFrozenGate(
      "upstream-fresh",
      "office-collab/upstream-fresh",
      "deliverable-task",
      "verify-upstream-fresh",
      "upstream-500-notes",
      with500Notes,
    );
    assert.equal(scaledUpstream.witness.result, "pass", scaledUpstream.witness.diagnostic);
    assert.equal(scaledUpstream.witness.subjects.length, 1);
    assert.equal(scaledUpstream.witness.subjects[0]?.path, `${compiled.packagePath}/artifacts/upstream-freshness.json`);
    assert.deepEqual(scaledUpstream.predicateIssues, []);

    const scaledSnapshot = submittedSnapshot(compiled.event.payload.task, contract, scaledHandoff.anchors, [
      { gateId: "handoff-completeness", runId: "run-scaled-1", witness: scaledHandoff.witness },
      { gateId: "upstream-fresh", runId: "run-scaled-2", witness: scaledUpstream.witness },
    ]);
    assert.deepEqual(
      completionBlockers(scaledSnapshot, "exec-office-1", {
        closeout: "ready",
        closeoutPath: `${compiled.packagePath}/closeout.md`,
        eligibleDirtyPaths: [],
        closeoutGates: { review: false, consent: false, factDisposition: false },
      }),
      [],
    );
  } finally {
    await service.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
