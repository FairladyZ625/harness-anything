// Deterministic condensed golden full-morphology Gen-3 old-data snapshot generator for
// Slice S5 / dec_3375D713F1A0D4F89FF269B990 CH3 (Tier 1 old-data-copy gate).
//
// Zero binary SQLite files are committed to git: this generator deterministically builds a real
// canonical Gen-3 workspace (harness/ git repo + activated ledger.sqlite + CAS objects/sha256/ +
// settled attach migrations + pre-populated warm cache/task.sqlite) covering every registered
// canonical event schema, retired ci-run-observation/v1..v4, retired people-event/v1, retired
// code_doc_reconciled, retired closeoutOverrides/squadRun/reviewDispatchKey/schedule.ciObserve,
// archived Facts with warm/cold parity, Decisions, Relations (including cycle), Schedules, Squads,
// KB documents, Peer Requests, Dossiers, and representative condensed scale (~2,050 events).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { canonicalEventSchemas } from "../../packages/kernel/src/domain/doc-sync-canonical-events.ts";
import { DOC_CODEC_ID, DOC_POLICY_ID, ledgerCommitSha } from "../../packages/kernel/src/domain/doc-sync.contract.ts";
import {
  OPAQUE_TEXTUAL_POLICY_ID,
  RAW_ARTIFACT_POLICY_ID,
} from "../../packages/kernel/src/domain/artifact-text-classification.ts";
import { readSettingsFacet, writeRepositorySettingsFacet } from "../../packages/kernel/src/domain/settings.ts";
import { compileSettingsChangedEvent } from "../../packages/kernel/src/domain/settings-event.ts";
import { compileVerticalDeclarationEvent } from "../../packages/kernel/src/domain/vertical-declaration.ts";
import {
  compileFactArchiveWrite,
  compileFactUnarchiveWrite,
  compileFactWrite,
} from "../../packages/kernel/src/domain/fact-event.ts";
import {
  compileDecisionWrite,
  decisionReviewContentDigest,
  reduceDecisionDocument,
} from "../../packages/kernel/src/domain/decision-event-document.ts";
import {
  compileRelationCreatedEvent,
  compileRelationRetiredEvent,
} from "../../packages/kernel/src/domain/relation-event.ts";
import { deriveRelationId, relationStrengthForType } from "../../packages/kernel/src/domain/entity-relation.ts";
import { compileEntityPinEvent } from "../../packages/kernel/src/domain/entity-pin-event.ts";
import { compileEntityDocumentRematerialization } from "../../packages/kernel/src/domain/entity-document-event.ts";
import { MIGRATION_DOCUMENT_POLICY_ID } from "../../packages/kernel/src/domain/document-policy-ids.ts";
import { sha256Text } from "../../packages/kernel/src/integrity/stable-hash.ts";
import {
  activateEmptyCanonicalGeneration,
  openSqliteEventStore,
} from "../../packages/storage/src/store/sqlite-event-store.ts";
import { closeSqliteEventStoresUnder } from "../../packages/storage/src/store/sqlite-ledger-connections.ts";
import { makeSqliteTaskEventStore } from "../../packages/storage/src/store/sqlite-task-event-store.ts";
import { applyAttachMigrations } from "../../packages/storage/src/store/attach-migrations.ts";
import { makeTaskProjection } from "../../packages/storage/src/projection/rebuildable-task-projection-factory.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixturesRoot = path.join(repoRoot, "packages", "kernel", "fixtures", "canonical-events");

export const GOLDEN_SNAPSHOT_PROFILE_VERSION = 1;
export const GOLDEN_REPO_ID = "golden-canonical";
export const GOLDEN_DEFAULT_WORKLOAD_EVENTS = 2000;
export const GOLDEN_REQUIRED_EVENT_SCHEMAS = Object.freeze(canonicalEventSchemas.map((entry) => entry.schema));

const GOLDEN_ACTOR = Object.freeze({
  principal: { personId: "person-golden" },
  executor: null,
});

const GOLDEN_ARBITER = Object.freeze({
  principal: { personId: "person-golden-arbiter" },
  executor: null,
});

const GOLDEN_PROVENANCE = Object.freeze([
  {
    runtime: "codex",
    sessionId: "sess-golden-seed",
    transcriptReachability: "by_session_id",
    boundAt: "2026-09-01T00:00:00.000Z",
  },
]);

function readFixtureJson(relativePath) {
  return JSON.parse(readFileSync(path.join(fixturesRoot, relativePath), "utf8"));
}

function goldenAt(revision) {
  return new Date(Date.UTC(2026, 8, 1, 0, 0, revision)).toISOString();
}

function goldenDispatchId(seed) {
  return `dispatch_${sha256Text(seed).slice(0, 24)}`;
}

function makeBlob(body, mediaType = "text/markdown") {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { sha256, size: bytes.byteLength, mediaType, body: typeof body === "string" ? body : bytes };
}

function makeTextBlob(body, mediaType = "text/markdown") {
  const bytes = Buffer.from(body, "utf8");
  const sha256 = sha256Text(body);
  return { sha256, size: bytes.byteLength, mediaType, body };
}

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

function createTaskSnapshot(taskId, title, revision, presetDigest, overrides = {}) {
  return {
    schema: "task/v2",
    taskId,
    taskClass: "standard",
    title,
    status: "planned",
    currentNode: "implementation",
    iteration: 0,
    pinned: false,
    packageDisposition: "active",
    contractVersion: 1,
    completionGateIds: ["ci"],
    presetSnapshotDigest: presetDigest,
    createdBy: GOLDEN_ACTOR,
    graph: {
      template: "replay/v1",
      maxIterations: 3,
      nodes: [
        { id: "implementation", kind: "work" },
        { id: "review", kind: "review" },
      ],
      edges: [
        {
          id: "implementation-submitted",
          from: "implementation",
          to: "review",
          on: "submitted",
          kind: "forward",
          actorRole: "executor",
        },
        {
          id: "review-changes-requested",
          from: "review",
          to: "implementation",
          on: "changes_requested",
          kind: "return",
          actorRole: "reviewer",
        },
      ],
    },
    metadata: {
      fromLegacyId: null,
      idempotencyKey: null,
      moduleKey: "packages/storage",
      parentTaskId: null,
      presetId: "standard-task",
      profileId: "baseline",
      riskTier: "medium",
      slug: taskId.replace(/^task_/u, "").replaceAll("_", "-"),
      surfaces: ["storage"],
      urgency: "medium",
      verticalId: "software/coding",
      workKind: "feat",
    },
    provenance: [{ ...GOLDEN_PROVENANCE[0], boundAt: goldenAt(revision) }],
    relations: [],
    supersededBy: null,
    ...overrides,
  };
}

function makePresetSnapshot(id, versionTag, extraProfile = {}) {
  const raw = {
    schema: "preset-snapshot/v1",
    identity: { id, version: versionTag },
    verticalId: "software/coding",
    completion: {
      sources: {
        local: { kind: "local-command", command: "npm test" },
      },
      gates: {
        ci: { source: "local", required: true },
      },
      closeoutDefaults: { review: true, consent: false },
    },
    profile: {
      id: "baseline",
      completionGateIds: ["ci"],
      outputShape: "repository-diff",
      ...extraProfile,
    },
  };
  const bodyWithoutDigest = JSON.stringify(raw);
  const digest = `sha256:${sha256Text(bodyWithoutDigest)}`;
  const body = JSON.stringify({ ...raw, digest });
  const blob = makeTextBlob(body, "application/json");
  return { digest, body, blob };
}

function buildCoreMorphologyEvents(harnessYaml, workloadEvents) {
  let rev = 0;
  const nextRev = () => ++rev;
  const entries = [];
  const push = (event, blobs = []) => entries.push({ event, blobs });
  const baseCut = ledgerCommitSha(GOLDEN_REPO_ID, "a".repeat(40));

  // 1. settings-event/v1 (initial + historical retired settings.ci / closeout.overrides.codeDoc / review.thresholds)
  const settingsFacet = readSettingsFacet(harnessYaml);
  const revSettings1 = nextRev();
  const settingsCompiled = compileSettingsChangedEvent({
    settings: settingsFacet,
    baseDocumentBody: harnessYaml,
    candidateDocumentBody: writeRepositorySettingsFacet(harnessYaml, settingsFacet),
    eventId: `golden-ev-settings-${revSettings1}`,
    opId: `golden-op-settings-${revSettings1}`,
    workspaceRevision: revSettings1,
    actor: GOLDEN_ACTOR,
    source: "local",
    occurredAt: goldenAt(revSettings1),
  });
  push(settingsCompiled.event, settingsCompiled.blobs);

  // Historical settings snapshot carrying retired fields to exercise attach migration + replay normalization
  const revSettingsHist = nextRev();
  const histSettingsYaml = `${harnessYaml}\n# historical retired settings marker\n`;
  const histSettingsBlob = makeTextBlob(histSettingsYaml, "application/yaml");
  push(
    {
      ...settingsCompiled.event,
      eventId: `golden-ev-settings-${revSettingsHist}`,
      opId: `golden-op-settings-${revSettingsHist}`,
      workspaceRevision: revSettingsHist,
      occurredAt: goldenAt(revSettingsHist),
      payload: {
        ...settingsCompiled.event.payload,
        settings: {
          ...settingsCompiled.event.payload.settings,
          ci: { workflows: ["rewrite-ci.yml"] },
          closeout: { overrides: { codeDoc: false } },
          review: {
            ...(settingsCompiled.event.payload.settings.review ?? {}),
            thresholds: { correctness: 0, migration: 0, securityAuth: 0 },
          },
        },
        harnessDocumentClaim: {
          ...settingsCompiled.event.payload.harnessDocumentClaim,
          sha256: histSettingsBlob.sha256,
          size: histSettingsBlob.size,
        },
      },
    },
    [histSettingsBlob],
  );

  // 2. vertical-declaration-event/v1
  const verticalFixture = readFixtureJson("vertical-declaration-event-v1/accepted.json");
  const revVertical = nextRev();
  const verticalCompiled = compileVerticalDeclarationEvent({
    type: "vertical_declared",
    definition: verticalFixture.payload.declaration.definition,
    eventId: `golden-ev-vertical-${revVertical}`,
    opId: `golden-op-vertical-${revVertical}`,
    workspaceRevision: revVertical,
    actor: GOLDEN_ACTOR,
    source: "local",
    occurredAt: goldenAt(revVertical),
  });
  push(verticalCompiled.event, verticalCompiled.blobs);

  // 3. task-bootstrap-event/v1 + 4. preset-snapshot-upgrade-event/v1
  const presetV1 = makePresetSnapshot("standard-task", "1.0.0", { closeoutOverrides: { codeDoc: false } });
  const presetV2 = makePresetSnapshot("standard-task", "1.0.1");
  const bootTaskId = "task_golden_boot_001";
  const bootPkg = `tasks/${bootTaskId}-golden-boot`;
  const revBoot = nextRev();
  const bootTask = createTaskSnapshot(bootTaskId, "Golden bootstrapped task", revBoot, presetV1.digest, {
    closeoutOverrides: { fact: true, codeDoc: false },
  });
  const bootIndexBlob = makeTextBlob(`# ${bootTask.title}\n\nGolden bootstrap index.\n`, "text/markdown");
  const bootContractBlob = makeTextBlob(
    JSON.stringify({ schema: "task-contract/v1", taskId: bootTaskId, presetSnapshotDigest: presetV1.digest }),
    "application/json",
  );
  const bootPlanBlob = makeTextBlob("# Plan\n\nGolden plan body.\n", "text/markdown");
  const bootCloseoutBlob = makeTextBlob("# Closeout\n\nPending.\n", "text/markdown");
  const bootKeepBlob = makeTextBlob("\n", "text/plain");
  push(
    {
      schema: "task-bootstrap-event/v1",
      type: "task_bootstrapped",
      eventId: `golden-ev-boot-${revBoot}`,
      opId: `golden-op-boot-${revBoot}`,
      taskId: bootTaskId,
      workspaceRevision: revBoot,
      actor: GOLDEN_ACTOR,
      source: "local",
      occurredAt: goldenAt(revBoot),
      payload: {
        task: bootTask,
        presetSnapshotClaim: {
          digest: presetV1.digest,
          mediaType: "application/json",
          sha256: presetV1.blob.sha256,
          size: presetV1.blob.size,
        },
        initialDocumentClaims: [
          {
            path: `${bootPkg}/INDEX.md`,
            owner: "machine",
            policyId: "typed-machine-writer/v1",
            mediaType: "text/markdown",
            sha256: bootIndexBlob.sha256,
            size: bootIndexBlob.size,
          },
          {
            path: `${bootPkg}/task-contract.json`,
            owner: "machine",
            policyId: "typed-machine-writer/v1",
            mediaType: "application/json",
            sha256: bootContractBlob.sha256,
            size: bootContractBlob.size,
          },
          {
            path: `${bootPkg}/task_plan.md`,
            owner: "doc-sync",
            policyId: "markdown-body-replaceable/v1",
            mediaType: "text/markdown",
            sha256: bootPlanBlob.sha256,
            size: bootPlanBlob.size,
          },
          {
            path: `${bootPkg}/closeout.md`,
            owner: "doc-sync",
            policyId: "markdown-body-replaceable/v1",
            mediaType: "text/markdown",
            sha256: bootCloseoutBlob.sha256,
            size: bootCloseoutBlob.size,
          },
          {
            path: `${bootPkg}/artifacts/.gitkeep`,
            owner: "doc-sync",
            policyId: "markdown-body-replaceable/v1",
            mediaType: "text/plain",
            sha256: bootKeepBlob.sha256,
            size: bootKeepBlob.size,
          },
        ],
      },
    },
    [presetV1.blob, bootIndexBlob, bootContractBlob, bootPlanBlob, bootCloseoutBlob, bootKeepBlob],
  );

  const revPresetUpgrade = nextRev();
  const upgradedBootTask = {
    ...bootTask,
    presetSnapshotDigest: presetV2.digest,
  };
  delete upgradedBootTask.closeoutOverrides;
  const upgradedContractBlob = makeTextBlob(
    JSON.stringify({ schema: "task-contract/v1", taskId: bootTaskId, presetSnapshotDigest: presetV2.digest }),
    "application/json",
  );
  push(
    {
      schema: "preset-snapshot-upgrade-event/v1",
      type: "preset_snapshot_upgraded",
      eventId: `golden-ev-preset-up-${revPresetUpgrade}`,
      opId: `golden-op-preset-up-${revPresetUpgrade}`,
      taskId: bootTaskId,
      workspaceRevision: revPresetUpgrade,
      actor: GOLDEN_ACTOR,
      source: "local",
      occurredAt: goldenAt(revPresetUpgrade),
      payload: {
        previousDigest: presetV1.digest,
        task: upgradedBootTask,
        presetSnapshotClaim: {
          digest: presetV2.digest,
          mediaType: "application/json",
          sha256: presetV2.blob.sha256,
          size: presetV2.blob.size,
        },
        taskContractClaim: {
          path: `${bootPkg}/task-contract.json`,
          owner: "machine",
          policyId: "typed-machine-writer/v1",
          mediaType: "application/json",
          sha256: upgradedContractBlob.sha256,
          size: upgradedContractBlob.size,
        },
      },
    },
    [presetV2.blob, upgradedContractBlob],
  );

  // 5. task-event/v1 full lifecycle + retired code_doc_reconciled
  const mainTaskId = "task_golden_main_001";
  const peerTaskId = "task_golden_peer_002";
  const revTaskMain = nextRev();
  const mainTask = createTaskSnapshot(mainTaskId, "Golden primary task", revTaskMain, presetV2.digest);
  push({
    schema: "task-event/v1",
    type: "task_created",
    eventId: `golden-ev-task-${revTaskMain}`,
    opId: `golden-op-task-${revTaskMain}`,
    taskId: mainTaskId,
    workspaceRevision: revTaskMain,
    actor: GOLDEN_ACTOR,
    source: { kind: "node", nodeId: "node-edge-golden" },
    occurredAt: goldenAt(revTaskMain),
    payload: {
      task: mainTask,
      mutation: { command: "create", reason: "seed primary task", fields: ["title"] },
      documentClaims: [],
    },
  });

  const revTaskPeer = nextRev();
  const peerTask = createTaskSnapshot(peerTaskId, "Golden peer task", revTaskPeer, presetV2.digest);
  push({
    schema: "task-event/v1",
    type: "task_created",
    eventId: `golden-ev-task-${revTaskPeer}`,
    opId: `golden-op-task-${revTaskPeer}`,
    taskId: peerTaskId,
    workspaceRevision: revTaskPeer,
    actor: GOLDEN_ACTOR,
    source: "local",
    occurredAt: goldenAt(revTaskPeer),
    payload: {
      task: peerTask,
      mutation: { command: "create", reason: "seed peer task", fields: ["title"] },
      documentClaims: [],
    },
  });

  // Historical retired code_doc_reconciled event from canonical fixture (seed its task first,
  // plus real CAS blobs for its retired 3-path documentClaims)
  const codeDocFixture = readFixtureJson("task-event-v1/accepted.json");
  const codeDocTask = {
    ...codeDocFixture.payload.task,
    title: "Fixture",
    metadata: { ...codeDocFixture.payload.task.metadata, slug: "fixture" },
  };
  const revCodeDocTask = nextRev();
  push({
    schema: "task-event/v1",
    type: "task_created",
    eventId: `golden-ev-codedoc-task-${revCodeDocTask}`,
    opId: `golden-op-codedoc-task-${revCodeDocTask}`,
    taskId: codeDocFixture.taskId,
    workspaceRevision: revCodeDocTask,
    actor: codeDocFixture.actor,
    source: "local",
    occurredAt: goldenAt(revCodeDocTask),
    payload: {
      task: { ...codeDocTask, status: "planned", currentNode: "implementation" },
      mutation: { command: "create", reason: "seed task before retired code_doc_reconciled", fields: ["title"] },
      documentClaims: [],
    },
  });
  const revCodeDoc = nextRev();
  const codeDocBlobs = [];
  const codeDocClaims = codeDocFixture.payload.documentClaims.map((claim) => {
    const body =
      claim.mediaType === "application/json"
        ? JSON.stringify({ schema: "code-doc-anchors/v1", path: claim.path, anchors: [] })
        : `# Golden Retired Code-Doc Document\n\nPath: ${claim.path}\n`;
    const blob = makeTextBlob(body, claim.mediaType);
    codeDocBlobs.push(blob);
    return { ...claim, sha256: blob.sha256, size: blob.size };
  });
  push(
    {
      ...codeDocFixture,
      eventId: `golden-ev-codedoc-${revCodeDoc}`,
      opId: `golden-op-codedoc-${revCodeDoc}`,
      workspaceRevision: revCodeDoc,
      occurredAt: goldenAt(revCodeDoc),
      payload: {
        ...codeDocFixture.payload,
        task: codeDocTask,
        documentClaims: codeDocClaims,
      },
    },
    codeDocBlobs,
  );

  // 6. execution_started on bootTaskId + task-progress-event/v1
  const revExecStart = nextRev();
  push({
    schema: "task-event/v1",
    type: "execution_started",
    eventId: `golden-ev-exec-start-${revExecStart}`,
    opId: `golden-op-exec-start-${revExecStart}`,
    taskId: bootTaskId,
    workspaceRevision: revExecStart,
    actor: GOLDEN_ACTOR,
    source: "local",
    occurredAt: goldenAt(revExecStart),
    payload: {
      task: { ...upgradedBootTask, status: "active" },
      execution: {
        schema: "execution/v1",
        executionId: "exe_golden_boot_001",
        taskId: bootTaskId,
        iteration: 0,
        nodeId: "implementation",
        state: "active",
        actor: GOLDEN_ACTOR,
        claimedAt: goldenAt(revExecStart),
        submittedAt: null,
        closedAt: null,
        submission: null,
        gateRuns: [],
      },
      lease: {
        schema: "lease/v1",
        phase: "held",
        taskId: bootTaskId,
        executionId: "exe_golden_boot_001",
        actor: GOLDEN_ACTOR,
        source: "local",
        version: 1,
        ttlMs: 86_400_000,
        expiresAt: goldenAt(revExecStart + 86_400),
      },
      leaseExpiresAt: goldenAt(revExecStart + 86_400),
      previousHolder: null,
      reason: "initial_claim",
      documentClaims: [],
    },
  });

  const revProgress = nextRev();
  const progressBody = `# Progress\n\n- Recorded at revision ${revProgress} for ${bootTaskId}.\n`;
  const progressBlob = makeTextBlob(progressBody, "text/markdown");
  push(
    {
      schema: "task-progress-event/v1",
      type: "task_progress_appended",
      eventId: `golden-ev-prog-${revProgress}`,
      opId: `golden-op-prog-${revProgress}`,
      taskId: bootTaskId,
      workspaceRevision: revProgress,
      actor: GOLDEN_ACTOR,
      source: "local",
      occurredAt: goldenAt(revProgress),
      payload: {
        taskId: bootTaskId,
        executionId: "exe_golden_boot_001",
        text: "Golden task progress entry",
        evidence: [{ type: "test", path: "tools/old-data-copy-evidence.mjs", summary: "golden fixture" }],
        baseDocumentSha256: null,
        resultDocumentClaim: {
          path: `${bootPkg}/progress.md`,
          policyId: "typed-machine-writer/v1",
          mediaType: "text/markdown",
          sha256: progressBlob.sha256,
          size: progressBlob.size,
        },
      },
    },
    [progressBlob],
  );

  // 7. decision-event/v1 (proposed, amended, review_recorded with carried artifact, accepted, rejected)
  const decisionStates = new Map();
  const activeRelations = [];
  const decisionActor = GOLDEN_ACTOR;
  const appendDecision = (decisionId, draftFn, extraBlobs = []) => {
    const rev = nextRev();
    const prev = decisionStates.get(decisionId) ?? null;
    const draft = draftFn(rev, prev);
    const compiled = compileDecisionWrite({
      event: draft,
      currentDecision: prev?.state ?? null,
      currentRelations: activeRelations.filter(
        (relation) =>
          relation.state === "active" &&
          (relation.source === `decision/${decisionId}` || relation.source.startsWith(`decision/${decisionId}/`)),
      ),
      currentDocument: prev ? { blobSha256: prev.sha256, body: prev.body } : null,
      decisionReviewRequirement: "off",
    });
    push(compiled.event, [...compiled.blobs, ...extraBlobs]);
    decisionStates.set(decisionId, {
      state: reduceDecisionDocument(prev?.state ?? null, compiled.event),
      body: compiled.body,
      sha256: compiled.event.payload.decisionDocumentClaim.sha256,
    });
    return compiled;
  };

  const makeProposalDraft = (rev, decisionId, title) => ({
    schema: "decision-event/v1",
    type: "decision_proposed",
    eventId: `golden-ev-dec-${rev}`,
    opId: `golden-op-dec-${rev}`,
    decisionId,
    workspaceRevision: rev,
    actor: decisionActor,
    source: "local",
    occurredAt: goldenAt(rev),
    payload: {
      title,
      question: `How should ${decisionId} handle golden morphology?`,
      riskTier: "medium",
      urgency: "medium",
      vertical: "software/coding",
      preset: "standard-task",
      decisionClass: "ordinary",
      appliesTo: { modules: ["packages/storage", "tools"], productLines: [] },
      chosen: [{ id: "CH1", text: "Adopt tiered old-data gate", rationale: "Fast PR feedback with full coverage." }],
      rejected: [{ id: "RJ1", text: "Skip old-data checks", whyNot: "Risks migration regressions." }],
      claims: [{ id: "C1", text: "Golden fixture covers every canonical event schema.", loadBearing: false }],
      fulfillments: [],
      relations: [],
      provenance: [{ ...GOLDEN_PROVENANCE[0], boundAt: goldenAt(rev) }],
      body: `# ${title}\n\n## 背景\n\nGolden decision fixture.\n\n## 权衡\n\nBalance speed and full schema coverage.\n\n## 结论\n\nUse tiered old-data verification.\n`,
    },
  });

  const decMainId = "dec_GOLDEN_MAIN01";
  const decHoldId = "dec_GOLDEN_HOLD02";
  appendDecision(decMainId, (rev) => makeProposalDraft(rev, decMainId, "Golden Main Decision"));
  appendDecision(decMainId, (rev, prev) => ({
    schema: "decision-event/v1",
    type: "decision_amended",
    eventId: `golden-ev-dec-${rev}`,
    opId: `golden-op-dec-${rev}`,
    decisionId: decMainId,
    workspaceRevision: rev,
    actor: decisionActor,
    source: "local",
    occurredAt: goldenAt(rev),
    payload: {
      previous: {
        title: prev.state.title,
        decisionClass: prev.state.decisionClass,
        chosen: prev.state.chosen,
        rejected: prev.state.rejected,
        claims: prev.state.claims,
        appliesTo: prev.state.appliesTo,
      },
      next: {
        title: prev.state.title,
        decisionClass: prev.state.decisionClass,
        chosen: prev.state.chosen,
        rejected: prev.state.rejected,
        claims: prev.state.claims,
        appliesTo: { modules: ["packages/storage", "packages/daemon", "tools"], productLines: ["harness-anything"] },
      },
      fields: ["appliesTo"],
      reason: "Expand scope for golden fixture",
      body: null,
    },
  }));
  const decReviewBody = "# Decision Review\n\nApproved for golden morphology.\n";
  const decReviewBlob = makeTextBlob(decReviewBody, "text/markdown");
  const decReviewPath = `decisions/decision-${decMainId}/artifacts/review.md`;
  appendDecision(
    decMainId,
    (rev, prev) => ({
      schema: "decision-event/v1",
      type: "decision_review_recorded",
      eventId: `golden-ev-dec-${rev}`,
      opId: `golden-op-dec-${rev}`,
      decisionId: decMainId,
      workspaceRevision: rev,
      actor: GOLDEN_ARBITER,
      source: "local",
      occurredAt: goldenAt(rev),
      payload: {
        reviewId: "review-golden-dec-1",
        reviewContentDigest: decisionReviewContentDigest(prev.state, prev.body),
        verdict: "approved",
        reason: "Verified golden decision",
        findings: [],
        evidenceChecked: ["CH1"],
        reportRef: decReviewPath,
        carriedDocumentClaims: [
          {
            path: decReviewPath,
            baseBlobSha256: null,
            candidate: { sha256: decReviewBlob.sha256, size: decReviewBlob.size, mediaType: "text/markdown" },
            policyId: OPAQUE_TEXTUAL_POLICY_ID,
            regionProofs: [],
          },
        ],
      },
    }),
    [decReviewBlob],
  );
  appendDecision(decMainId, (rev) => ({
    schema: "decision-event/v1",
    type: "decision_accepted",
    eventId: `golden-ev-dec-${rev}`,
    opId: `golden-op-dec-${rev}`,
    decisionId: decMainId,
    workspaceRevision: rev,
    actor: GOLDEN_ARBITER,
    source: "local",
    occurredAt: goldenAt(rev),
    payload: {
      rationale: "Accept golden main decision",
      judgmentOnlyRationale: "No load-bearing claims require external evidence.",
    },
  }));
  appendDecision(decHoldId, (rev) => makeProposalDraft(rev, decHoldId, "Golden Held Decision"));

  // 8. relation-event/v1 (derives, depends-on cycle, produces + relation_retired)
  const addRelation = (source, type, target, targetObservedVersion = null) => {
    const rev = nextRev();
    const identity = { source, type, target, direction: "directed" };
    const relationId = deriveRelationId(identity);
    const event = compileRelationCreatedEvent({
      record: {
        relation_id: relationId,
        ...identity,
        origin: "declared",
        state: "active",
        rationale: `Golden ${type} edge`,
        targetObservedVersion,
      },
      actor: GOLDEN_ACTOR,
      source: "local",
      opId: `golden-op-rel-${rev}`,
      workspaceRevision: rev,
      occurredAt: goldenAt(rev),
    });
    push(event);
    activeRelations.push({
      relation_id: relationId,
      ...identity,
      strength: relationStrengthForType(type),
      origin: "declared",
      state: "active",
      rationale: `Golden ${type} edge`,
    });
    return event.relationId;
  };
  addRelation(`decision/${decMainId}/CH1`, "derives", `task/${mainTaskId}`, revTaskMain);
  addRelation(`task/${mainTaskId}`, "depends-on", `task/${peerTaskId}`);
  addRelation(`task/${peerTaskId}`, "depends-on", `task/${mainTaskId}`);

  // 9. fact-event/v1 + 10. entity-document-event/v1 (multiple archived Facts for warm/cold parity!)
  const makeFactDraft = (rev, factId, statement, type = "fact_recorded", extraPayload = {}) => ({
    schema: "fact-event/v1",
    type,
    eventId: `golden-ev-fact-${rev}`,
    opId: `golden-op-fact-${rev}`,
    taskId: mainTaskId,
    factId,
    workspaceRevision: rev,
    actor: GOLDEN_ACTOR,
    source: "local",
    occurredAt: goldenAt(rev),
    payload: {
      statement,
      evidenceSource: "tools/old-data-copy-evidence.mjs:1",
      observedCommit: "b".repeat(40),
      observedAt: goldenAt(rev),
      confidence: "high",
      memoryClass: "semantic",
      memoryTags: ["pattern"],
      provenance: [{ ...GOLDEN_PROVENANCE[0], boundAt: goldenAt(rev) }],
      ...extraPayload,
    },
  });

  // Fact A: recorded -> archived -> unarchived -> re-archived
  const factAId = "F-G0000001";
  const factARec = compileFactWrite({ event: makeFactDraft(nextRev(), factAId, "Golden Fact A lifecycle") });
  push(factARec.event, factARec.blobs);
  const factAArch1 = compileFactArchiveWrite({
    event: makeFactDraft(nextRev(), factAId, "Golden Fact A lifecycle", "fact_archived", {
      archiveReason: "first archive pass",
    }),
    retiredDocumentSha256: factARec.event.payload.factsDocumentClaim.sha256,
  });
  push(factAArch1.event, factAArch1.blobs);
  const factAUnarchRev = nextRev();
  const factAUnarch = compileFactUnarchiveWrite({
    event: makeFactDraft(factAUnarchRev, factAId, "Golden Fact A lifecycle", "fact_unarchived", {
      archiveReason: "restore before re-archive",
    }),
    document: {
      factId: factAId,
      taskId: mainTaskId,
      statement: "Golden Fact A lifecycle",
      evidenceSource: "tools/old-data-copy-evidence.mjs:1",
      observedAt: factARec.event.payload.observedAt,
      observedCommit: "b".repeat(40),
      confidence: "high",
      state: "standing",
      workspaceRevision: factAUnarchRev,
    },
  });
  push(factAUnarch.event, factAUnarch.blobs);
  const factAArch2 = compileFactArchiveWrite({
    event: makeFactDraft(nextRev(), factAId, "Golden Fact A lifecycle", "fact_archived", {
      archiveReason: "final re-archive into document_history",
    }),
    retiredDocumentSha256: factAUnarch.event.payload.factsDocumentClaim.sha256,
  });
  push(factAArch2.event, factAArch2.blobs);

  // Fact B: recorded -> entity-document-event/v1 rematerialized -> archived
  const factBId = "F-G0000002";
  const factBRec = compileFactWrite({ event: makeFactDraft(nextRev(), factBId, "Golden Fact B rematerialized") });
  push(factBRec.event, factBRec.blobs);
  const revFactBRemat = nextRev();
  const factBRemat = compileEntityDocumentRematerialization({
    opId: `golden-op-entdoc-${revFactBRemat}`,
    entityRefs: [`fact/${factBId}`],
    updates: [
      {
        path: factBRec.path,
        body: `${factBRec.body}\nRematerialized before golden archive.\n`,
        mediaType: "text/markdown",
        policyId: factBRec.event.payload.factsDocumentClaim.policyId,
      },
    ],
    rationale: "Golden entity-document-event/v1 refresh",
    actor: GOLDEN_ACTOR,
    source: "local",
    occurredAt: goldenAt(revFactBRemat),
    workspaceRevision: revFactBRemat,
  });
  push(factBRemat.event, factBRemat.blobs);
  const factBArch = compileFactArchiveWrite({
    event: makeFactDraft(nextRev(), factBId, "Golden Fact B rematerialized", "fact_archived", {
      archiveReason: "archive after rematerialization",
    }),
    retiredDocumentSha256: factBRemat.event.payload.documentClaims[0].sha256,
  });
  push(factBArch.event, factBArch.blobs);

  // Fact C: recorded -> held by task & decision -> archived while held -> holds released -> dematerialized_terminal
  const factCId = "F-G0000003";
  const factCDraft = makeFactDraft(nextRev(), factCId, "Golden Fact C held archive");
  delete factCDraft.taskId;
  const factCRec = compileFactWrite({ event: factCDraft });
  push(factCRec.event, factCRec.blobs);
  const taskHoldRelId = addRelation(`task/${mainTaskId}`, "produces", `fact/${factCId}`);
  addRelation(`decision/${decHoldId}`, "evidenced-by", `fact/${factCId}`);
  const factCArchDraft = makeFactDraft(nextRev(), factCId, "Golden Fact C held archive", "fact_archived", {
    archiveReason: "archived while held",
  });
  delete factCArchDraft.taskId;
  const factCArch = compileFactArchiveWrite({
    event: factCArchDraft,
    retiredDocumentSha256: factCRec.event.payload.factsDocumentClaim.sha256,
  });
  push(factCArch.event, factCArch.blobs);
  const revRetireRel = nextRev();
  push(
    compileRelationRetiredEvent({
      relationId: taskHoldRelId,
      reason: "release task hold on Fact C",
      actor: GOLDEN_ACTOR,
      source: "local",
      opId: `golden-op-rel-ret-${revRetireRel}`,
      workspaceRevision: revRetireRel,
      occurredAt: goldenAt(revRetireRel),
    }),
  );
  appendDecision(decHoldId, (rev) => ({
    schema: "decision-event/v1",
    type: "decision_rejected",
    eventId: `golden-ev-dec-${rev}`,
    opId: `golden-op-dec-${rev}`,
    decisionId: decHoldId,
    workspaceRevision: rev,
    actor: GOLDEN_ARBITER,
    source: "local",
    occurredAt: goldenAt(rev),
    payload: { reason: "Unlock held archived Fact C" },
  }));

  // Fact D (superseded) + Fact E (standing replacement)
  const factDId = "F-G0000004";
  const factEId = "F-G0000005";
  const factDRec = compileFactWrite({ event: makeFactDraft(nextRev(), factDId, "Golden Fact D initial") });
  push(factDRec.event, factDRec.blobs);
  const factERec = compileFactWrite({
    event: makeFactDraft(nextRev(), factEId, "Golden Fact E supersedes D", "fact_recorded", {
      supersedes: { factRef: `fact/${factDId}`, rationale: "newer golden evidence" },
    }),
    supersededFact: {
      factId: factDId,
      baseDocumentSha256: factDRec.event.payload.factsDocumentClaim.sha256,
      taskId: mainTaskId,
      statement: factDRec.event.payload.statement,
      evidenceSource: factDRec.event.payload.evidenceSource,
      observedAt: factDRec.event.payload.observedAt,
      confidence: factDRec.event.payload.confidence,
    },
  });
  push(factERec.event, factERec.blobs);

  // 11. entity-pin-event/v1
  const revPin = nextRev();
  const pinBundle = compileEntityPinEvent({
    entityRef: `task/${mainTaskId}`,
    pinned: true,
    eventId: `golden-ev-pin-${revPin}`,
    opId: `golden-op-pin-${revPin}`,
    workspaceRevision: revPin,
    actor: GOLDEN_ACTOR,
    source: "local",
    occurredAt: goldenAt(revPin),
  });
  push(pinBundle.event, pinBundle.blobs);

  // 12. doc-event/v1 (markdown create/update, HTML artifact, raw binary artifact, retirement)
  const appendDoc = (docPath, body, baseSha, mediaType = "text/markdown", policyId = DOC_POLICY_ID) => {
    const rev = nextRev();
    const isBinary = body instanceof Uint8Array;
    const blob = body === null ? null : isBinary ? makeBlob(body, mediaType) : makeTextBlob(body, mediaType);
    const event = {
      schema: "doc-event/v1",
      type: "documents_written",
      eventId: `golden-ev-doc-${rev}`,
      opId: `golden-op-doc-${rev}`,
      workspaceRevision: rev,
      actor: GOLDEN_ACTOR,
      source: "local",
      occurredAt: goldenAt(rev),
      payload: {
        executionId: null,
        baseLedgerSha: baseCut,
        ...(blob === null ? { retirementReason: "golden doc retirement" } : {}),
        changes: [
          {
            path: docPath,
            policyId,
            baseBlobSha256: baseSha,
            candidate: blob === null ? null : { sha256: blob.sha256, size: blob.size, mediaType },
            regionProofs:
              blob === null || policyId !== DOC_POLICY_ID
                ? []
                : [
                    {
                      regionId: "heading/doc",
                      policyId,
                      codecId: DOC_CODEC_ID,
                      baseSha256: baseSha ?? sha256Text(""),
                      candidateSha256: blob.sha256,
                      insertBytes: blob.size,
                    },
                  ],
          },
        ],
      },
    };
    push(event, blob ? [blob] : []);
    return blob?.sha256 ?? null;
  };

  const docSha1 = appendDoc("context/golden-guide.md", "# Golden Guide\n\nInitial version.\n", null);
  appendDoc("context/golden-guide.md", "# Golden Guide\n\nUpdated version.\n", docSha1);
  appendDoc(
    `tasks/${mainTaskId}-golden-main/artifacts/report.html`,
    "<html><body><h1>Golden Artifact</h1></body></html>\n",
    null,
    "text/html",
    OPAQUE_TEXTUAL_POLICY_ID,
  );
  appendDoc(
    `tasks/${mainTaskId}-golden-main/artifacts/sample.bin`,
    new Uint8Array([0x00, 0x01, 0x02, 0xff, 0x48, 0x41]),
    null,
    "application/octet-stream",
    RAW_ARTIFACT_POLICY_ID,
  );
  const tempDocSha = appendDoc("context/ephemeral-golden.md", "temporary\n", null);
  appendDoc("context/ephemeral-golden.md", null, tempDocSha);

  // 13. agent-runtime-event/v1 (installation, session started, worker dispatch, legacy reviewer dispatchKey,
  //     historical flat squadRun identity, squad_run_observed, session outcome & exit)
  const revInst = nextRev();
  const instFixture = readFixtureJson(
    "agent-runtime-event-v1/accepted-runtime-installation-observed-89114110c840.json",
  );
  push({
    ...instFixture,
    eventId: `golden-ev-rt-inst-${revInst}`,
    opId: `golden-op-rt-inst-${revInst}`,
    workspaceRevision: revInst,
    occurredAt: goldenAt(revInst),
  });

  const revSessStart = nextRev();
  push({
    schema: "agent-runtime-event/v1",
    type: "runtime_session_started",
    eventId: `golden-ev-rt-start-${revSessStart}`,
    opId: `golden-op-rt-start-${revSessStart}`,
    workspaceRevision: revSessStart,
    actor: GOLDEN_ACTOR,
    source: { kind: "node", nodeId: "node-edge-golden" },
    occurredAt: goldenAt(revSessStart),
    payload: {
      runtimeSessionId: "runtime_golden_001",
      instanceId: "codex-golden",
      installationId: "installation-golden",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
      launchGeneration: 1,
      attachable: false,
    },
  });

  const defSnapshot = {
    schema: "agent-definition-snapshot/v1",
    configVersion: 1,
    instanceId: "codex-golden",
    installationId: "installation-golden",
    kindId: "codex",
    providerId: "openai",
    model: "gpt-5.4",
    reasoningEffort: null,
    endpointKind: "official",
    baseUrlHash: null,
    authMode: "subscription",
  };
  const revDispWorker = nextRev();
  push({
    schema: "agent-runtime-event/v1",
    type: "runtime_dispatch_requested",
    eventId: `golden-ev-rt-disp-${revDispWorker}`,
    opId: `golden-op-rt-disp-${revDispWorker}`,
    workspaceRevision: revDispWorker,
    actor: GOLDEN_ACTOR,
    source: "local",
    occurredAt: goldenAt(revDispWorker),
    payload: {
      dispatchId: goldenDispatchId("worker-1"),
      attemptGroupId: "group_golden_1",
      runtimeSessionId: "runtime_golden_001",
      instanceId: "codex-golden",
      installationId: "installation-golden",
      kindId: "codex",
      agentId: "worker-golden",
      taskId: mainTaskId,
      executionId: "exe_golden_001",
      dispatchKey: "dk-golden-worker-1",
      startedAt: goldenAt(revDispWorker),
      definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
      definitionSnapshot: defSnapshot,
      // Historical flat squadRun identity (triggers squad-run.subject attach migration & normalization)
      squadRun: {
        squadRunId: "squad_0123456789abcdef01234567",
        squadId: "squad-golden",
        mission: "Golden squad mission",
        leaderAgentId: "worker-golden",
        taskId: mainTaskId,
        executionId: "exe_golden_001",
      },
    },
  });

  // Historical legacy reviewer dispatchKey (without :reviewer:<agentId>) to exercise runtime.reviewDispatchKey
  const revDispReviewer = nextRev();
  const reviewDigest = `sha256:${"d".repeat(64)}`;
  push({
    schema: "agent-runtime-event/v1",
    type: "runtime_dispatch_requested",
    eventId: `golden-ev-rt-rev-${revDispReviewer}`,
    opId: `golden-op-rt-rev-${revDispReviewer}`,
    workspaceRevision: revDispReviewer,
    actor: GOLDEN_ACTOR,
    source: "local",
    occurredAt: goldenAt(revDispReviewer),
    payload: {
      dispatchId: goldenDispatchId("reviewer-1"),
      attemptGroupId: "group_golden_rev_1",
      runtimeSessionId: "runtime_golden_001",
      instanceId: "codex-golden",
      installationId: "installation-golden",
      kindId: "codex",
      agentId: "data-migration",
      role: "reviewer",
      taskId: mainTaskId,
      executionId: "exe_golden_001",
      dispatchKey: `task-review:${mainTaskId}:exe_golden_001:0:${reviewDigest}`,
      reviewTarget: { kind: "task", taskId: mainTaskId, executionId: "exe_golden_001", digest: reviewDigest },
      startedAt: goldenAt(revDispReviewer),
      definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
      definitionSnapshot: defSnapshot,
    },
  });

  // 14. schedule-event/v1 (with historical retired status.ciObserve)
  const scheduleFixture = readFixtureJson("schedule-event-v1/accepted.json");
  const revSched = nextRev();
  const scheduleObj = {
    ...scheduleFixture.payload.schedule,
    scheduleId: "golden-nightly-check",
    name: "Golden Nightly Check",
    status: {
      ...scheduleFixture.payload.schedule.status,
      ciObserve: { lastRunId: "legacy-ci-run-1" },
    },
  };
  const scheduleBlob = makeTextBlob(JSON.stringify(scheduleObj), "application/json");
  push(
    {
      ...scheduleFixture,
      eventId: `golden-ev-sched-${revSched}`,
      opId: `golden-op-sched-${revSched}`,
      workspaceRevision: revSched,
      occurredAt: goldenAt(revSched),
      entity: { id: "golden-nightly-check", kind: "schedule" },
      payload: {
        ...scheduleFixture.payload,
        schedule: scheduleObj,
        declarationDocumentClaim: {
          path: "schedules/golden-nightly-check.json",
          policyId: "typed-entity/v1",
          mediaType: "application/json",
          sha256: scheduleBlob.sha256,
          size: scheduleBlob.size,
        },
      },
    },
    [scheduleBlob],
  );

  // 15. entity-event/v1 (entity_upserted)
  const entityFixture = readFixtureJson("entity-event-v1/accepted-entity-upserted-ddcb7509cb2d.json");
  const revEntity = nextRev();
  const entityDeclBlob = makeTextBlob(
    JSON.stringify({
      schema: "agent/v1",
      id: entityFixture.payload.entityId,
      name: "Golden Entity Agent",
      role: "worker",
      runtimes: [{ kindId: "codex", model: "gpt-5.4" }],
    }),
    "application/json",
  );
  push(
    {
      ...entityFixture,
      eventId: `golden-ev-ent-${revEntity}`,
      opId: `golden-op-ent-${revEntity}`,
      workspaceRevision: revEntity,
      occurredAt: goldenAt(revEntity),
      payload: {
        ...entityFixture.payload,
        declarationDocumentClaim: {
          ...entityFixture.payload.declarationDocumentClaim,
          sha256: entityDeclBlob.sha256,
          size: entityDeclBlob.size,
        },
      },
    },
    [entityDeclBlob],
  );

  // 16. agent-entity-event/v1
  const agentEntityFixture = readFixtureJson("agent-entity-event-v1/accepted.json");
  const revAgentEntity = nextRev();
  const agentDeclBlob = makeTextBlob(
    JSON.stringify({
      schema: "agent/v1",
      id: agentEntityFixture.payload.entityId,
      name: "Golden Agent",
      role: "worker",
      runtimes: [{ kindId: "codex", model: "gpt-5.4" }],
    }),
    "application/json",
  );
  push(
    {
      ...agentEntityFixture,
      eventId: `golden-ev-agent-ent-${revAgentEntity}`,
      opId: `golden-op-agent-ent-${revAgentEntity}`,
      workspaceRevision: revAgentEntity,
      occurredAt: goldenAt(revAgentEntity),
      payload: {
        ...agentEntityFixture.payload,
        declarationDocumentClaim: {
          ...agentEntityFixture.payload.declarationDocumentClaim,
          sha256: agentDeclBlob.sha256,
          size: agentDeclBlob.size,
        },
      },
    },
    [agentDeclBlob],
  );

  // 17. dossier-synthesis-event/v1
  const dossierFixture = readFixtureJson("dossier-synthesis-event-v1/accepted.json");
  const revDossier = nextRev();
  const dossierState = {
    verticalId: dossierFixture.payload.state.verticalId,
    slotId: dossierFixture.payload.state.slotId,
    lastSynthesizedWatermark: revDossier - 2,
    synthesizedAt: goldenAt(revDossier),
    path: dossierFixture.payload.state.path,
  };
  const dossierMdBlob = makeTextBlob("# Golden Dossier Context\n\nSynthesized golden context.\n", "text/markdown");
  const dossierStateBlob = makeTextBlob(JSON.stringify(dossierState), "application/json");
  push(
    {
      ...dossierFixture,
      eventId: `golden-ev-dossier-${revDossier}`,
      opId: `golden-op-dossier-${revDossier}`,
      workspaceRevision: revDossier,
      occurredAt: goldenAt(revDossier),
      payload: {
        expectedWatermark: revDossier - 3,
        sourceWatermark: revDossier - 1,
        state: dossierState,
        documentClaims: [
          {
            ...dossierFixture.payload.documentClaims[0],
            sha256: dossierMdBlob.sha256,
            size: dossierMdBlob.size,
          },
          {
            ...dossierFixture.payload.documentClaims[1],
            sha256: dossierStateBlob.sha256,
            size: dossierStateBlob.size,
          },
        ],
      },
    },
    [dossierMdBlob, dossierStateBlob],
  );

  // 18. kb-document-event/v1
  const kbFixture = readFixtureJson("kb-document-event-v1/accepted-kb-document-upserted.json");
  const revKb = nextRev();
  const kbBody = "# Constitutional Library Guide\n\n## Overview\n\nGolden KB reference.\n";
  const kbBlob = makeTextBlob(kbBody, "text/markdown");
  push(
    {
      ...kbFixture,
      eventId: `golden-ev-kb-${revKb}`,
      opId: `golden-op-kb-${revKb}`,
      workspaceRevision: revKb,
      occurredAt: goldenAt(revKb),
      payload: {
        ...kbFixture.payload,
        source: { ...kbFixture.payload.source, sha256: kbBlob.sha256, byteLength: kbBlob.size },
        view: { ...kbFixture.payload.view, sha256: kbBlob.sha256, byteLength: kbBlob.size },
      },
    },
    [kbBlob],
  );

  // 19. peer-request-event/v1
  const peerFixture = readFixtureJson("peer-request-event-v1/accepted-peer-request-opened.json");
  const revPeer = nextRev();
  push({
    ...peerFixture,
    eventId: `golden-ev-peer-${revPeer}`,
    opId: `golden-op-peer-${revPeer}`,
    workspaceRevision: revPeer,
    occurredAt: goldenAt(revPeer),
  });

  // 20. execution-delegation-event/v1
  const delegationFixture = readFixtureJson("execution-delegation-event-v1/accepted.json");
  const revDelegation = nextRev();
  push({
    ...delegationFixture,
    eventId: `golden-ev-deleg-${revDelegation}`,
    opId: `golden-op-deleg-${revDelegation}`,
    workspaceRevision: revDelegation,
    occurredAt: goldenAt(revDelegation),
  });

  // 21. people-event/v1 (retired People audit snapshot matching YAML blob)
  const peopleFixture = readFixtureJson("people-event-v1/accepted.json");
  const revPeople = nextRev();
  const peopleYaml = stringifyYaml(peopleFixture.payload.roster);
  const peopleBlob = makeTextBlob(peopleYaml, "application/yaml");
  push(
    {
      ...peopleFixture,
      eventId: `golden-ev-people-${revPeople}`,
      opId: `golden-op-people-${revPeople}`,
      workspaceRevision: revPeople,
      occurredAt: goldenAt(revPeople),
      payload: {
        ...peopleFixture.payload,
        peopleDocumentClaim: {
          ...peopleFixture.payload.peopleDocumentClaim,
          sha256: peopleBlob.sha256,
          size: peopleBlob.size,
        },
      },
    },
    [peopleBlob],
  );

  // 22. migration-import-event/v1 (historical imported pinned task + retired closeoutOverrides.fact)
  const revMigImport = nextRev();
  const importedTaskId = "task_golden_imported_001";
  const importedPkg = `tasks/${importedTaskId}-imported`;
  const importedIndexBlob = makeTextBlob(`# Golden imported pinned task\n\nImported from v0.\n`, "text/markdown");
  const importedTask = createTaskSnapshot(
    importedTaskId,
    "Golden imported pinned task",
    revMigImport,
    presetV2.digest,
    {
      pinned: true,
      closeoutOverrides: { fact: false },
    },
  );
  push(
    {
      schema: "migration-import-event/v1",
      type: "entity_migrated",
      eventId: `golden-ev-mig-${revMigImport}`,
      opId: `golden-op-mig-${revMigImport}`,
      workspaceRevision: revMigImport,
      actor: GOLDEN_ACTOR,
      source: "migration-import/v1",
      occurredAt: goldenAt(revMigImport),
      payload: {
        migratedFrom: "legacy-task-001",
        generation: "v0",
        entity: {
          kind: "task",
          provenance: "imported_snapshot",
          originalStatus: "done",
          packagePath: importedPkg,
          task: importedTask,
          documentClaim: {
            path: `${importedPkg}/INDEX.md`,
            sha256: importedIndexBlob.sha256,
            size: importedIndexBlob.size,
            mediaType: "text/markdown",
            policyId: MIGRATION_DOCUMENT_POLICY_ID,
          },
        },
      },
    },
    [importedIndexBlob],
  );

  // 23. ledger-layout-event/v1
  const layoutFixture = readFixtureJson("ledger-layout-event-v1/accepted.json");
  const revLayout = nextRev();
  push({
    ...layoutFixture,
    eventId: `golden-ev-layout-${revLayout}`,
    opId: `golden-op-layout-${revLayout}`,
    workspaceRevision: revLayout,
    occurredAt: goldenAt(revLayout),
  });

  // 24–27. Retired ci-run-observation/v1, v2, v3, v4
  const ciV1 = readFixtureJson("ci-run-observation-v1/accepted.json");
  const ciV2 = readFixtureJson("ci-run-observation-v2/accepted.json");
  const ciV3 = readFixtureJson("ci-run-observation-v3/accepted.json");
  const ciV4Raw = readFixtureJson("ci-run-observation-v4/job.json");
  const ciV4DetailBlob = makeTextBlob(
    JSON.stringify({ schema: "ci-run-detail/v1", runId: "golden-ci-v4", gates: [], tests: [] }),
    "application/json",
  );
  const ciV4 = {
    ...ciV4Raw,
    payload: {
      ...ciV4Raw.payload,
      detailRef: {
        ...ciV4Raw.payload.detailRef,
        sha256: ciV4DetailBlob.sha256,
        decodedBytes: ciV4DetailBlob.size,
        encodedBytes: ciV4DetailBlob.size,
      },
    },
  };
  for (const [label, template, blobs] of [
    ["ci-v1", ciV1, []],
    ["ci-v2", ciV2, []],
    ["ci-v3", ciV3, []],
    ["ci-v4", ciV4, [ciV4DetailBlob]],
  ]) {
    const r = nextRev();
    push(
      {
        ...template,
        eventId: `golden-ev-${label}-${r}`,
        opId: `golden-op-${label}-${r}`,
        workspaceRevision: r,
        occurredAt: goldenAt(r),
      },
      blobs,
    );
  }

  // Condensed representative workload (~2,000 events by default) covering tasks, docs, dispatches,
  // and retired ci-run-observation/v2 & v3 rows so cold rebuild & warm attach exercise real scale
  // while staying well under 30s cross-platform.
  const docLatestSha = new Map();
  const createdTaskIds = [mainTaskId, peerTaskId];
  for (let i = 0; i < workloadEvents; i += 1) {
    const slot = i % 10;
    if (slot === 0 || slot === 1) {
      // Retired ci-run-observation/v2 and v3 rows (matching production ledger composition!)
      const r = nextRev();
      const tpl = slot === 0 ? ciV2 : ciV3;
      push({
        ...tpl,
        eventId: `golden-ev-wk-ci-${r}`,
        opId: `golden-op-wk-ci-${r}`,
        workspaceRevision: r,
        occurredAt: goldenAt(r),
      });
    } else if (slot === 2 || slot === 3) {
      // Document create/update with compact deterministic markdown payloads
      const bucket = i % 80;
      const docPath = `context/golden-workload/doc-${String(bucket).padStart(3, "0")}.md`;
      const prevSha = docLatestSha.get(docPath) ?? null;
      const body = `# Golden Workload Doc ${bucket}\n\nRevision iteration ${i}.\n${"golden-line-".repeat(16)}\n`;
      const nextSha = appendDoc(docPath, body, prevSha);
      docLatestSha.set(docPath, nextSha);
    } else if (slot === 4) {
      // Runtime dispatch requested on a task
      const r = nextRev();
      const targetTaskId = createdTaskIds[i % createdTaskIds.length];
      push({
        schema: "agent-runtime-event/v1",
        type: "runtime_dispatch_requested",
        eventId: `golden-ev-wk-disp-${r}`,
        opId: `golden-op-wk-disp-${r}`,
        workspaceRevision: r,
        actor: GOLDEN_ACTOR,
        source: "local",
        occurredAt: goldenAt(r),
        payload: {
          dispatchId: goldenDispatchId(`wk-${r}`),
          attemptGroupId: `group_golden_wk_${r}`,
          runtimeSessionId: "runtime_golden_001",
          instanceId: "codex-golden",
          installationId: "installation-golden",
          kindId: "codex",
          agentId: "worker-golden",
          taskId: targetTaskId,
          executionId: `exe_golden_wk_${r}`,
          dispatchKey: `dk-golden-wk-${r}`,
          startedAt: goldenAt(r),
          definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
          definitionSnapshot: defSnapshot,
        },
      });
    } else {
      // Task creation or amendment
      const r = nextRev();
      const taskIdx = Math.floor(i / 5);
      const taskId = `task_golden_wk_${String(taskIdx).padStart(4, "0")}`;
      if (slot === 5) {
        const snap = createTaskSnapshot(taskId, `Golden workload task ${taskIdx}`, r, presetV2.digest);
        createdTaskIds.push(taskId);
        push({
          schema: "task-event/v1",
          type: "task_created",
          eventId: `golden-ev-wk-task-${r}`,
          opId: `golden-op-wk-task-${r}`,
          taskId,
          workspaceRevision: r,
          actor: GOLDEN_ACTOR,
          source: "local",
          occurredAt: goldenAt(r),
          payload: {
            task: snap,
            mutation: { command: "create", reason: "golden workload", fields: ["title"] },
            documentClaims: [],
          },
        });
      } else {
        const targetId = createdTaskIds[i % createdTaskIds.length];
        const snap = createTaskSnapshot(targetId, `Golden workload task updated ${r}`, r, presetV2.digest);
        push({
          schema: "task-event/v1",
          type: "task_amended",
          eventId: `golden-ev-wk-amend-${r}`,
          opId: `golden-op-wk-amend-${r}`,
          taskId: targetId,
          workspaceRevision: r,
          actor: GOLDEN_ACTOR,
          source: "local",
          occurredAt: goldenAt(r),
          payload: {
            task: snap,
            mutation: { command: "amend", reason: "golden workload update", fields: ["title"] },
            documentClaims: [],
          },
        });
      }
    }
  }

  // Ensure both the in-review fixture task (which sorts first in `readTaskIndex`) and the most
  // recently updated task have runtime dispatches so `reads.taskDispatches` exercises live rows.
  for (const dispatchTaskId of [codeDocFixture.taskId, createdTaskIds.at(-1)].filter(Boolean)) {
    const r = nextRev();
    push({
      schema: "agent-runtime-event/v1",
      type: "runtime_dispatch_requested",
      eventId: `golden-ev-wk-disp-head-${r}`,
      opId: `golden-op-wk-disp-head-${r}`,
      workspaceRevision: r,
      actor: GOLDEN_ACTOR,
      source: "local",
      occurredAt: goldenAt(r),
      payload: {
        dispatchId: goldenDispatchId(`head-${r}`),
        attemptGroupId: `group_golden_head_${r}`,
        runtimeSessionId: "runtime_golden_001",
        instanceId: "codex-golden",
        installationId: "installation-golden",
        kindId: "codex",
        agentId: "worker-golden",
        taskId: dispatchTaskId,
        executionId: `exe_golden_head_${r}`,
        dispatchKey: `dk-golden-head-${r}`,
        startedAt: goldenAt(r),
        definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
        definitionSnapshot: defSnapshot,
      },
    });
  }

  return entries;
}

/**
 * Generate a deterministic condensed golden full-morphology Gen-3 canonical workspace under
 * `targetDir`, including committed `harness/harness.yaml`, activated Gen-3 `ledger.sqlite` +
 * CAS `objects/sha256/`, settled `event-shape-migration/v1` markers, and warm `cache/task.sqlite`.
 */
export function generateGoldenOldDataSnapshot(targetDir, options = {}) {
  const rootDir = path.resolve(targetDir);
  const workloadEvents = options.workloadEvents ?? GOLDEN_DEFAULT_WORKLOAD_EVENTS;
  const repoId = options.repoId ?? GOLDEN_REPO_ID;
  const harnessDir = path.join(rootDir, "harness");
  const harnessYaml = "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n";

  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(path.join(harnessDir, "harness.yaml"), harnessYaml, "utf8");
  git(harnessDir, "init", "--quiet", "-b", "main");
  git(harnessDir, "add", "harness.yaml");
  git(
    harnessDir,
    "-c",
    "core.autocrlf=false",
    "-c",
    "user.name=Golden Snapshot",
    "-c",
    "user.email=golden@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "golden harness layout",
  );

  activateEmptyCanonicalGeneration({ rootInput: rootDir, repoId });
  const entries = buildCoreMorphologyEvents(harnessYaml, workloadEvents);

  const sqliteStore = openSqliteEventStore({ repoId, rootInput: rootDir, generation: 3 });
  const fence = { repoId, holder: "golden-generator", epoch: 1 };
  const batchSize = 2500;
  try {
    for (let offset = 0; offset < entries.length; offset += batchSize) {
      const slice = entries.slice(offset, offset + batchSize);
      const events = slice.map((entry) => entry.event);
      const blobs = slice.flatMap((entry) => entry.blobs);
      const terminal = events.at(-1);
      sqliteStore.appendValidatedBundle({
        fence,
        intent: () => ({
          opId: `golden-batch-${offset}-${terminal.opId}`,
          intentDigest: `sha256:${sha256Text(`golden-batch-${offset}-${terminal.workspaceRevision}`)}`,
          summary: `golden-batch-${offset}`,
        }),
        events,
        blobs,
      });
    }
    sqliteStore.releaseWriter(fence);
  } finally {
    sqliteStore.close();
  }

  // Run production attach migrations so event-shape-migration/v1 markers and scan watermarks
  // reflect a real settled canonical Gen-3 ledger (allowing warm projection preservation on attach).
  const taskStore = makeSqliteTaskEventStore({ repoId, rootDir, generation: 3 });
  let migrationsApplied;
  try {
    const report = applyAttachMigrations({
      store: taskStore,
      now: () => "2026-09-02T00:00:00.000Z",
      actor: GOLDEN_ACTOR,
    });
    migrationsApplied = [...report.applied];
    const projection = makeTaskProjection({ rootDir, eventStore: taskStore });
    try {
      projection.rebuild();
    } finally {
      projection.close();
    }
  } finally {
    closeSqliteEventStoresUnder(rootDir);
  }

  // Verify generated ledger covers every registered canonical event schema without full JS deserialization.
  const ledgerPath = path.join(rootDir, ".harness", "store", "generations", "3", "ledger.sqlite");
  const verifyDb = new DatabaseSync(ledgerPath, { readOnly: true });
  let eventCount;
  let presentSchemas;
  try {
    eventCount = Number(verifyDb.prepare("SELECT COUNT(*) AS count FROM event").get().count);
    presentSchemas = verifyDb
      .prepare("SELECT DISTINCT json_extract(event_json, '$.schema') AS schema FROM event ORDER BY schema")
      .all()
      .map((row) => String(row.schema));
  } finally {
    verifyDb.close();
  }

  const missingSchemas = GOLDEN_REQUIRED_EVENT_SCHEMAS.filter((schema) => !presentSchemas.includes(schema));
  if (missingSchemas.length > 0) {
    throw new Error(`golden snapshot is missing canonical event schema(s): ${missingSchemas.join(", ")}`);
  }

  return {
    rootDir,
    repoId,
    profileVersion: GOLDEN_SNAPSHOT_PROFILE_VERSION,
    eventCount,
    schemaCount: presentSchemas.length,
    schemas: presentSchemas,
    migrationsApplied,
    archivedFactCount: 3,
  };
}
