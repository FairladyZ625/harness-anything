// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  channelDigest32,
  connectionGeneration,
  openLocalAuthorityKeyStore
} from "../../../daemon/src/index.ts";
import { createAuthorityKeyRegistryV1, firstPinAuthorityKeyV1 } from "../../../application/src/index.ts";
import {
  decisionEntityId,
  createTaskPackagePath,
  executionDeclaration,
  moduleEntityId,
  sha256Text,
  taskEntityId
} from "../../../kernel/src/index.ts";
import { defaultCliAdapterProvider } from "../../src/composition/adapter-registry.ts";
import type { EntityId, ExecutionRecord } from "../../../kernel/src/index.ts";
import type { ParsedCommand } from "../../src/cli/types.ts";
import { daemonActorAttribution } from "../../src/composition/actor-attribution.ts";
import { parseRecordArgs } from "../../src/cli/parsers/record.ts";
import { parseNewTaskArgs } from "../../src/cli/parsers/new-task.ts";
import { createCliCommandService } from "../../src/daemon/command-service.ts";
import { authorityNamespaceProofBytes } from "../../src/daemon/authority-production-state.ts";
import { createGitCanonicalPublicationInspector } from "../../src/daemon/authority-publication-evidence.ts";
import { createProductionAuthorityLifecycle } from "../../src/daemon/production-authority-lifecycle.ts";
import {
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  runRawJsonMaybeFail,
  stopDaemon
} from "../helpers/daemon-cli.ts";

test("production service route preserves progress dry-run and publishes a slugged task append", { timeout: 30_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const env = {
    HARNESS_ACTOR: "agent:codex",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000"
  };
  try {
    for (const [repoId, canonicalRoot] of [
      ["canonical", fixture.repoRoot],
      ["auxiliary", fixture.auxiliaryRoot]
    ] as const) {
      const registered = runDaemonCommand(fixture.repoRoot, [
        "daemon", "repo", "register", "--repo-id", repoId, "--canonical-root", canonicalRoot,
        "--user-root", userRoot, "--no-link", "--json"
      ], env);
      assert.equal(registered.ok, true, JSON.stringify(registered));
    }
    try {
      runDaemonCommand(fixture.repoRoot, [
        "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
      ], env);
    } catch {
      // Production authority startup can outlive the command's fixed six-second reachability wait.
      // Keep observing the same detached service instead of replacing it with an in-process fixture.
    }
    const status = await pollUntil(
      () => runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env),
      (status) => status.reachable === true,
      (status, error) => JSON.stringify({ status, error: error instanceof Error ? error.message : String(error ?? "") }),
      { timeoutMs: 20_000 }
    );
    assert.equal(status.repoCount, 2, JSON.stringify(status));

    const dryRunHead = git(fixture.authoredRoot, "rev-parse", "HEAD");
    const dryRun = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "progress", "append", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4",
      "--text", "service-route dry-run probe", "--dry-run"
    ], env);
    assert.equal(dryRun.status, 0, JSON.stringify(dryRun.receipt));
    assert.equal(dryRun.receipt.ok, true, JSON.stringify(dryRun.receipt));
    const dryRunHeadAfter = git(fixture.authoredRoot, "rev-parse", "HEAD");

    const append = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "progress", "append", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8",
      "--text", "service-route slugged append"
    ], env);
    assert.equal(append.status, 0, JSON.stringify(append.receipt));
    assert.equal(append.receipt.ok, true, JSON.stringify(append.receipt));
    assert.match(
      readFileSync(path.join(fixture.authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8-production-route/progress.md"), "utf8"),
      /service-route slugged append/u
    );
    const operation = latestAuthorityOperation(fixture.serviceRoot);
    assert.equal(operation.state, "COMMITTED", JSON.stringify(operation));
    assert.equal(operation.receipt?.tag, "COMMITTED", JSON.stringify(operation));
    assert.equal(typeof operation.opId, "string", JSON.stringify(operation));
    const publication = await createGitCanonicalPublicationInspector(fixture.authoredRoot)
      .findPublicationForOperation(operation.opId!);
    assert.equal(publication.commitSha, operation.commitSha);
    assert.equal(publication.previousCommit, dryRunHead);
    assert.equal(publication.parentCommits.length, 2);
    assert.deepEqual(publication.physicalChanges.map((change) => change.path).sort(), [
      `attribution-events/${sha256Text(operation.opId!)}.jsonl`,
      "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8-production-route/progress.md"
    ].sort());
    assert.equal(publication.pipelineGeneratedPaths.length, 1);
    assert.equal(publication.pipelineGeneratedPaths[0], publication.physicalChanges.find((change) => change.path.startsWith("attribution-events/"))?.path);
    git(fixture.authoredRoot, "diff", "--quiet", publication.commitSha, publication.parentCommits[1]!);
    assert.equal(dryRunHeadAfter, dryRunHead, "typed service dry-run must not create a commit");
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    if (process.env.KEEP_AUTHORITY_SERVICE_FIXTURE !== "1") rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("production canonical ingress accepts and journals one write for every canonical kind", async () => {
  const fixture = createFixture();
  const daemon = defaultCliAdapterProvider().createMultiRepoDaemonRuntime({
    repos: [{ repoId: "canonical", rootDir: fixture.repoRoot }],
    materializerPollMs: 5,
    materializerMaxBranchesPerBatch: 1
  });
  try {
    await daemon.start();
    const runtime = daemon.getRepoRuntime("canonical");
    assert.ok(runtime);
    const lifecycle = createProductionAuthorityLifecycle({ manifestPath: fixture.manifestPath });
    const started = await lifecycle.startRepo(
      { repoId: "canonical", canonicalRoot: fixture.repoRoot },
      runtime
    );
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    if (!started.ok) return;
    const actor = fixture.actor;
    const submission = started.component.bindConnection({
      schema: "authority-connection-context/v1",
      connectionId: "canonical-ingress",
      connectionGeneration: connectionGeneration("canonical-ingress-generation"),
      actor,
      repoId: "canonical",
      channelBinding: { digest: channelDigest32(Buffer.alloc(32, 0x61)), source: "transport-observed" },
      peerCredential: {
        schema: "os-observed-peer-credential/v1",
        platform: "darwin",
        source: "getpeereid",
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0
      }
    });
    const cases: ReadonlyArray<{
      readonly kind: string;
      readonly action: ParsedCommand["action"];
      readonly canonicalEntityId: EntityId;
      readonly authoredPath: string;
      readonly authoredMarker: RegExp;
    }> = [{
      kind: "task",
      action: { kind: "progress-append", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0", text: "nine-kind task ingress\n", dryRun: false },
      canonicalEntityId: taskEntityId("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0"),
      authoredPath: "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/progress.md",
      authoredMarker: /nine-kind task ingress/u
    }, {
      kind: "decision",
      action: {
        kind: "decision-propose", decisionId: "dec_INGRESS", title: "Ingress decision",
        question: "Is the production decision writer reachable?", chosen: [{ text: "Yes." }],
        rejected: [{ text: "No.", why_not: "The ingress contract requires reachability." }],
        claims: [{ text: "The write reaches the journal." }], claimLoadBearing: false, fulfillments: [],
        riskTier: "medium", urgency: "medium", modules: [], productLines: [], evidenceRelations: [], dryRun: false
      },
      canonicalEntityId: decisionEntityId("dec_INGRESS"),
      authoredPath: "decisions/decision-dec_INGRESS/decision.md",
      authoredMarker: /dec_INGRESS/u
    }, {
      kind: "module",
      action: { kind: "module-register", moduleKey: "ingress", title: "Ingress", scope: "packages/cli/**", shared: [], dependsOn: [] },
      canonicalEntityId: moduleEntityId("ingress"),
      authoredPath: "modules.json",
      authoredMarker: /ingress/u
    }, {
      kind: "fact",
      action: {
        kind: "record-fact", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0", factId: "F-A11CE001",
        statement: "Production fact ingress reaches the journal.", source: "production canonical ingress integration",
        observedAt: "2026-07-17T00:00:00.000Z", confidence: "high", memoryClass: "episodic",
        memoryTags: [], dryRun: false
      },
      canonicalEntityId: taskEntityId("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0"),
      authoredPath: "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/facts.md",
      authoredMarker: /F-A11CE001/u
    }, {
      kind: "relation",
      action: { kind: "decision-relate", decisionId: "dec_INGRESS", anchor: "decision/dec_INGRESS", relationType: "derives", target: "task/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4", rationale: "Ingress relation coverage.", dryRun: false },
      canonicalEntityId: decisionEntityId("dec_INGRESS"),
      authoredPath: "decisions/decision-dec_INGRESS/decision.md",
      authoredMarker: /derives/u
    }, {
      kind: "session",
      action: { kind: "session-export", sessionId: "session-ingress", runtime: "codex", source: "manual", detectedAt: "2026-07-17T00:00:00.000Z", transcriptFile: fixture.transcriptPath },
      canonicalEntityId: "entity/session/session-ingress" as EntityId,
      authoredPath: "sessions/session-ingress.md",
      authoredMarker: /session-ingress/u
    }, {
      kind: "execution",
      action: { kind: "task-claim", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4", execution: true, executionId: "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG1" },
      canonicalEntityId: "execution/exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG1" as EntityId,
      authoredPath: "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/executions/exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG1.md",
      authoredMarker: /exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG1/u
    }, {
      kind: "review",
      action: {
        kind: "task-review-execution", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0", executionId: "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5",
        verdict: "changes_requested", findings: "Ingress review coverage.", evidenceChecked: ["journal"],
        rationale: "A non-approved review exercises the standalone review compiler.", archiveWarningsAcknowledged: true
      },
      canonicalEntityId: "review/rev_01KXQ4WTA7Q4XJ5GDDRS1YXNG2" as EntityId,
      authoredPath: "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/reviews/rev_01KXQ4WTA7Q4XJ5GDDRS1YXNG2.md",
      authoredMarker: /rev_01KXQ4WTA7Q4XJ5GDDRS1YXNG2/u
    }, {
      kind: "consent",
      action: {
        kind: "task-consent-record", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0", executionId: "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5",
        utterance: "Approve and complete this exact submitted execution.", consentActions: ["approve_execution", "complete_task"]
      },
      canonicalEntityId: "consent/cns_01KXQ4WTA7Q4XJ5GDDRS1YXNG3" as EntityId,
      authoredPath: "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/consents/cns_01KXQ4WTA7Q4XJ5GDDRS1YXNG3.md",
      authoredMarker: /cns_01KXQ4WTA7Q4XJ5GDDRS1YXNG3/u
    }, {
      kind: "fact-create-invalidator",
      action: {
        kind: "record-fact", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0", factId: "F-A11CE002",
        statement: "Replacement production fact.", source: "production canonical ingress integration",
        observedAt: "2026-07-17T00:02:00.000Z", confidence: "high", memoryClass: "episodic",
        memoryTags: [], dryRun: false
      },
      canonicalEntityId: taskEntityId("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0"),
      authoredPath: "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/facts.md",
      authoredMarker: /F-A11CE002/u
    }, {
      kind: "fact-invalidate",
      action: {
        kind: "fact-invalidate", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0", factId: "F-A11CE001",
        invalidatedByFactId: "F-A11CE002", rationale: "Replacement fact supersedes the original.", dryRun: false
      },
      canonicalEntityId: taskEntityId("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0"),
      authoredPath: "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/facts.md",
      authoredMarker: /supersedes-fact/u
    }, {
      kind: "code-doc-reconcile",
      action: {
        kind: "task-code-doc-reconcile", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0",
        sha: fixture.publicHead, paths: ["README.md"], force: false
      },
      canonicalEntityId: taskEntityId("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0"),
      authoredPath: "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/code-doc-anchors.json",
      authoredMarker: /code-doc-reconciliation\/v1/u
    }, {
      kind: "task-transition",
      action: { kind: "status-set", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0", status: "in_review", force: false },
      canonicalEntityId: taskEntityId("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0"),
      authoredPath: "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/INDEX.md",
      authoredMarker: /status: in_review/u
    }, {
      kind: "approved-review",
      action: {
        kind: "task-review-execution", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0", executionId: "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5",
        verdict: "approved", findings: "All production evidence verified.", evidenceChecked: ["evidence:ingress"],
        rationale: "Consent-backed evidence satisfies the closeout contract.", archiveWarningsAcknowledged: true,
        consentId: "cns_01KXQ4WTA7Q4XJ5GDDRS1YXNG3"
      },
      canonicalEntityId: "review/rev_01KXQ4WTA7Q4XJ5GDDRS1YXNG6" as EntityId,
      authoredPath: "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/reviews/rev_01KXQ4WTA7Q4XJ5GDDRS1YXNG6.md",
      authoredMarker: /"verdict": "approved"/u
    }, {
      kind: "task-complete",
      action: { kind: "task-complete", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0", reviewerId: "person_alice" },
      canonicalEntityId: "execution/exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5" as EntityId,
      authoredPath: "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/INDEX.md",
      authoredMarker: /status: done/u
    }];
    const coveredKinds = new Set(cases.map((fixtureCase) => fixtureCase.kind));
    assert.equal(["consent", "decision", "execution", "fact", "module", "relation", "review", "session", "task"]
      .every((kind) => coveredKinds.has(kind)), true);
    for (const [index, fixtureCase] of cases.entries()) {
      const sessionId = `real-cli-session-${index + 1}`;
      const receipt = await submission.submit({
        command: { rootDir: fixture.repoRoot, json: true, action: fixtureCase.action },
        attribution: daemonActorAttribution(actor, index === 0 ? null : { kind: "agent", id: "codex" }),
        currentSession: { runtime: "codex", sessionId, source: "runtime", detectedAt: "2026-07-17T00:00:00.000Z" },
        canonicalEntityId: fixtureCase.canonicalEntityId
      });
      assert.equal(receipt.tag, "COMMITTED", `${fixtureCase.kind}:${JSON.stringify(receipt)}`);
      const watermarkPath = path.join(fixture.repoRoot, ".harness/write-journal/watermark.json");
      assert.equal(existsSync(watermarkPath), true, `${fixtureCase.kind}:${JSON.stringify(receipt)}`);
      assert.equal(readFileSync(watermarkPath, "utf8").includes(receipt.opId), true, `${fixtureCase.kind}:journal-watermark:${JSON.stringify(receipt)}`);
      assert.match(readFileSync(path.join(fixture.authoredRoot, fixtureCase.authoredPath), "utf8"), fixtureCase.authoredMarker, fixtureCase.kind);
      const eventFiles = execFileSync("find", [path.join(fixture.authoredRoot, "authority-attribution-events/v2"), "-type", "f"], { encoding: "utf8" })
        .trim().split("\n").filter(Boolean);
      assert.equal(eventFiles.some((eventPath) => readFileSync(eventPath, "utf8").includes(sessionId)), true, `${fixtureCase.kind}:real-session-axis`);
    }
    const commandService = createCliCommandService(runtime, {
      resolveAuthoritySubmissionV2: () => submission
    });
    const commandActor = { ...actor, roles: ["owner"] };
    const runCommand = async (action: ParsedCommand["action"], sessionId: string) => commandService.runCommand({
      command: { rootDir: fixture.repoRoot, json: true, action },
      session: {
        runtime: "codex",
        sessionId,
        source: "runtime",
        detectedAt: "2026-07-17T00:10:00.000Z"
      }
    }, { actor: commandActor, executor: { kind: "agent", id: "codex" } });

    const appendReceipt = await runCommand({
      kind: "progress-append",
      taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4",
      text: "daemon command-service append",
      dryRun: false
    }, "smoke-progress");
    assert.equal(appendReceipt.ok, true, `progress-append:${JSON.stringify(appendReceipt)}`);

    const dryRunHead = git(fixture.authoredRoot, "rev-parse", "HEAD");
    const dryRunReceipt = await runCommand({
      kind: "progress-append",
      taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4",
      text: "must remain a preview",
      dryRun: true
    }, "smoke-dry-run");
    assert.equal(dryRunReceipt.ok, true, `progress-append-dry-run:${JSON.stringify(dryRunReceipt)}`);
    assert.equal(git(fixture.authoredRoot, "rev-parse", "HEAD"), dryRunHead, "dry-run must not create a commit");

    const explicitFact = parseRecordArgs([
      "fact", "record", "--task", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4", "--id", "F-ABCD1234",
      "--statement", "Explicit fact id smoke.", "--source", "production smoke"
    ], fixture.repoRoot, true);
    assert.ok(explicitFact?.ok);
    if (explicitFact?.ok) {
      const receipt = await runCommand(explicitFact.value.action, "smoke-fact-explicit");
      assert.equal(receipt.ok, true, `fact-explicit:${JSON.stringify(receipt)}`);
    }
    const generatedFact = parseRecordArgs([
      "fact", "record", "--task", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4",
      "--statement", "Generated fact id smoke.", "--source", "production smoke"
    ], fixture.repoRoot, true);
    assert.ok(generatedFact?.ok);
    if (generatedFact?.ok) {
      assert.match(generatedFact.value.action.kind === "record-fact" ? generatedFact.value.action.factId ?? "" : "", /^F-[0-9A-HJKMNP-TV-Z]{8}$/u);
      const receipt = await runCommand(generatedFact.value.action, "smoke-fact-generated");
      assert.equal(receipt.ok, true, `fact-generated:${JSON.stringify(receipt)}`);
    }

    const decisionReceipt = await runCommand({
      kind: "decision-propose", decisionId: "dec_SMOKE", title: "Smoke decision",
      question: "Does typed provenance remain single-op?", chosen: [{ text: "Yes." }],
      rejected: [{ text: "No.", why_not: "The authority submission must remain entity-aligned." }],
      claims: [{ text: "The command settled cleanly." }], claimLoadBearing: false, fulfillments: [],
      riskTier: "low", urgency: "low", modules: [], productLines: [], evidenceRelations: [], dryRun: false
    }, "smoke-decision");
    assert.equal(decisionReceipt.ok, true, `decision-propose:${JSON.stringify(decisionReceipt)}`);

    const sessionReceipt = await runCommand({
      kind: "session-export", sessionId: "session-smoke-explicit", runtime: "codex", source: "manual",
      detectedAt: "2026-07-17T00:10:00.000Z", transcriptFile: fixture.transcriptPath
    }, "smoke-session-export");
    assert.equal(sessionReceipt.ok, true, `session-export:${JSON.stringify(sessionReceipt)}`);

    const createdTask = parseNewTaskArgs([
      "task", "create", "--title", "Production task create smoke"
    ], fixture.repoRoot, true);
    assert.ok(createdTask?.ok);
    if (createdTask?.ok) {
      assert.match(createdTask.value.action.kind === "new-task" ? createdTask.value.action.taskId ?? "" : "", /^task_[0-9A-HJKMNP-TV-Z]{26}$/u);
      const receipt = await runCommand(createdTask.value.action, "smoke-task-create");
      assert.equal(receipt.ok, true, `task-create:${JSON.stringify(receipt)}`);
      if (createdTask.value.action.kind === "new-task") {
        const taskRoot = createTaskPackagePath(fixture.repoRoot, createdTask.value.action.taskId!, createdTask.value.action.slug);
        assert.equal(existsSync(path.join(taskRoot, "INDEX.md")), true);
        assert.equal(existsSync(path.join(taskRoot, "task-contract.json")), true);
      }
    }
    await assert.rejects(submission.submit({
      command: { rootDir: fixture.repoRoot, json: true, action: { kind: "help" } },
      attribution: daemonActorAttribution(actor, { kind: "agent", id: "codex" }),
      currentSession: { runtime: "codex", sessionId: "session-production", source: "manual", detectedAt: "2026-07-17T00:00:00.000Z" },
      canonicalEntityId: taskEntityId("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0")
    }), /AUTHORITY_TYPED_COMMAND_UNSUPPORTED.*task lifecycle closeout/u);
    await assert.rejects(submission.submit({
      command: {
        rootDir: fixture.repoRoot,
        json: true,
        action: { kind: "progress-append", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0", text: "entity mismatch evidence", dryRun: false }
      },
      attribution: daemonActorAttribution(actor, { kind: "agent", id: "codex" }),
      currentSession: { runtime: "codex", sessionId: "session-mismatch", source: "manual", detectedAt: "2026-07-17T00:00:00.000Z" },
      canonicalEntityId: moduleEntityId("wrong-entity")
    }), /AUTHORITY_CANONICAL_ENTITY_MISMATCH:submittedEntityId=module\/wrong-entity;intentEntityId=task\/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/u);
    await lifecycle.stopAll("daemon-shutdown");
  } finally {
    await daemon.stop().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-production-canonical-ingress-")));
  const repoRoot = path.join(root, "repo");
  const authoredRoot = path.join(repoRoot, "harness");
  const auxiliaryRoot = path.join(root, "auxiliary");
  const auxiliaryAuthoredRoot = path.join(auxiliaryRoot, "harness");
  const serviceRoot = path.join(root, "service-state");
  const keyStateDirectory = path.join(serviceRoot, "keys/canonical");
  mkdirSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0"), { recursive: true });
  mkdirSync(serviceRoot, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(authoredRoot, "harness.yaml"), "schema: harness-anything/v1\nproject: production-ingress\n");
  writeFileSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/INDEX.md"), taskIndexBody("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0"));
  writeFileSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/closeout.md"), "# Closeout\n\nProduction fixture qualified.\n");
  mkdirSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4"), { recursive: true });
  writeFileSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/INDEX.md"), taskIndexBody("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4"));
  mkdirSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8-production-route"), { recursive: true });
  writeFileSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8-production-route/INDEX.md"), taskIndexBody("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8"));
  const actor = {
    personId: "person_alice",
    displayName: "Alice",
    primaryEmail: "alice@example.test",
    providerId: "transport-derived/v1",
    resolvedCredential: {
      kind: "unix-socket-owner-boundary" as const,
      issuer: `host:${hostname()}`,
      subject: String(process.getuid?.() ?? 0)
    }
  };
  const submittedExecution: ExecutionRecord = {
    schema: "execution/v2", execution_id: "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5", task_ref: "task/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0", state: "submitted",
    primary_actor: { principal: { personId: "person_alice" }, executor: { kind: "agent", id: "codex" }, responsibleHuman: "person_alice" },
    claimed_at: "2026-07-17T00:00:00.000Z", submitted_at: "2026-07-17T00:01:00.000Z", closed_at: null,
    session_bindings: [], outputs: [{ evidence_id: "evidence:ingress", execution_ref: "execution/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5", locator: { substrate: "inline", text: "passed" } }],
    submission: { completion_claim: "Ingress qualified", deliverables: ["journal"], evidence_refs: ["evidence:ingress"], verification_notes: ["integration"], known_gaps: [], residual_risks: [] }
  };
  mkdirSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/executions"), { recursive: true });
  writeFileSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/executions/exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5.md"), executionDeclaration.documentCodec.encode(submittedExecution));
  const transcriptPath = path.join(root, "session-transcript.md");
  writeFileSync(transcriptPath, `${JSON.stringify({
    timestamp: "2026-07-17T00:00:00.000Z",
    type: "event_msg",
    payload: { type: "user_message", message: "Production session ingress." }
  })}\n`);
  writeFileSync(path.join(authoredRoot, "people.yaml"), [
    "schema: harness-people/v1", "people:", "  - personId: person_alice", "    displayName: Alice",
    "    primaryEmail: alice@example.test", "    roles: [owner]", "    credentials:",
    "      - kind: unix-socket-owner-boundary", `        issuer: host:${hostname()}`,
    `        subject: ${process.getuid?.() ?? 0}`, "roles:", "  - roleId: owner",
    "    commandClasses: [admin, repo-write, repo-read, arbiter]", ""
  ].join("\n"));
  const keyStore = openLocalAuthorityKeyStore({
    serviceStateRoot: serviceRoot,
    stateDirectory: keyStateDirectory,
    workspaceRoot: repoRoot,
    authorityId: "authority.production",
    issuer: "authority.production"
  });
  const now = Date.now();
  const prepublished = keyStore.createPrepublishedKey({ generation: 1, nowMs: now - 1_000 });
  const prepublishedRegistry = createAuthorityKeyRegistryV1({
    authorityId: "authority.production", generation: 1, globalRevocationEpoch: 1, revision: 1,
    entries: [prepublished]
  });
  const registry = firstPinAuthorityKeyV1({
    registry: prepublishedRegistry,
    keyId: prepublished.keyId,
    expectedPinnedKeyId: prepublished.keyId,
    pinEvidence: "fixture-out-of-band-pin",
    verifierAcknowledgement: "fixture-verifier-ack",
    activatedAtMs: now - 999
  });
  const registryPath = path.join(authoredRoot, "authority-key-registry.json");
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  const unsignedNamespace = {
    schema: "operation-namespace/v1" as const,
    workspaceId: "workspace-production",
    deviceId: "device-production",
    authorityGeneration: 1n,
    namespaceId: "namespace-production",
    expiresAt: BigInt(now + 60 * 60_000),
    issuer: "authority.production",
    keyId: prepublished.keyId
  };
  const proof = sign(null, authorityNamespaceProofBytes(unsignedNamespace), keyStore.signingProfile(registry, now).privateKey);
  const manifestPath = path.join(serviceRoot, "authority-production.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    schema: "authority-production-composition/v1",
    serviceStateRoot: serviceRoot,
    repos: [{
      repoId: "canonical", canonicalRoot: repoRoot, workspaceId: "workspace-production",
      deviceId: "device-production", viewId: "view-production", sessionId: "session-production",
      authorityId: "authority.production", issuer: "authority.production", keyRegistryPath: registryPath,
      keyStateDirectory, schemaTuple: productionTuple(), authorityGeneration: 1,
      revocationEpochs: { global: "1", workspace: "1", device: "1", view: "1", principal: "1", executor: "1" },
      admissionTokenRef: "admission-production", allowedExecutorAgentIds: ["codex"],
      operationNamespace: {
        ...unsignedNamespace,
        authorityGeneration: unsignedNamespace.authorityGeneration.toString(),
        expiresAt: unsignedNamespace.expiresAt.toString(),
        proof: proof.toString("base64url")
      }
    }]
  }, null, 2)}\n`);
  writeFileSync(path.join(repoRoot, "README.md"), "# Distinct public repository\n");
  git(repoRoot, "init", "-q");
  git(repoRoot, "add", "README.md");
  git(repoRoot, "commit", "-q", "-m", "seed distinct public fixture");
  const publicHead = git(repoRoot, "rev-parse", "HEAD");
  git(authoredRoot, "init", "-q");
  git(authoredRoot, "add", ".");
  git(authoredRoot, "commit", "-q", "-m", "seed canonical ingress fixture");
  mkdirSync(auxiliaryAuthoredRoot, { recursive: true });
  writeFileSync(path.join(auxiliaryAuthoredRoot, "harness.yaml"), "schema: harness-anything/v1\nproject: auxiliary-ingress\n");
  git(auxiliaryAuthoredRoot, "init", "-q");
  git(auxiliaryAuthoredRoot, "add", ".");
  git(auxiliaryAuthoredRoot, "commit", "-q", "-m", "seed auxiliary ingress fixture");
  return { root, repoRoot, authoredRoot, auxiliaryRoot, serviceRoot, manifestPath, actor, transcriptPath, publicHead };
}

function latestAuthorityOperation(serviceRoot: string): {
  readonly state?: string;
  readonly opId?: string;
  readonly commitSha?: string;
  readonly receipt?: { readonly tag?: string };
} {
  const operationPath = path.join(
    serviceRoot,
    "authority",
    Buffer.from("canonical", "utf8").toString("base64url"),
    "operations.jsonl"
  );
  const rows = readFileSync(operationPath, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { readonly table?: string; readonly value?: Record<string, unknown> })
    .filter((row) => row.table === "operation" && row.value);
  assert.ok(rows.length > 0, "service route must persist an authority operation");
  return rows.at(-1)!.value as {
    readonly state?: string;
    readonly opId?: string;
    readonly commitSha?: string;
    readonly receipt?: { readonly tag?: string };
  };
}

function taskIndexBody(taskId: string): string {
  return [
    "---", "schema: task-package/v2", `task_id: ${taskId}`, "title: Production ingress",
    "lifecycle:", "  bindingSchema: lifecycle-binding/v1", "  engine: local", "  status: active",
    "  ref: ", "  titleSnapshot: Production ingress", "  url: ",
    "  bindingCreatedAt: 2026-07-17T00:00:00.000Z", `  bindingFingerprint: sha256:${"b".repeat(64)}`,
    "packageDisposition: active", "vertical: default", "preset: default",
    "provenance:", "  - {runtime: \"human\", sessionId: \"fixture\", boundAt: \"2026-07-17T00:00:00.000Z\"}",
    "---", "", "# Production ingress", ""
  ].join("\n");
}

function productionTuple() {
  return {
    wire: 2, event: 2, receipt: 2, digest: 2, policy: 2,
    commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1
  } as const;
}

function git(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ZeyuLi",
      GIT_AUTHOR_EMAIL: "33339424+FairladyZ625@users.noreply.github.com",
      GIT_COMMITTER_NAME: "ZeyuLi",
      GIT_COMMITTER_EMAIL: "33339424+FairladyZ625@users.noreply.github.com"
    }
  }).trim();
}
