// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  channelDigest32,
  connectionGeneration
} from "../../../daemon/src/index.ts";
import {
  decisionEntityId,
  createTaskPackagePath,
  moduleEntityId,
  sha256Text,
  taskEntityId
} from "../../../kernel/src/index.ts";
import { defaultCliAdapterProvider } from "../../src/composition/adapter-registry.ts";
import type { EntityId } from "../../../kernel/src/index.ts";
import type { ParsedCommand } from "../../src/cli/types.ts";
import { daemonActorAttribution } from "../../src/composition/actor-attribution.ts";
import { parseRecordArgs } from "../../src/cli/parsers/record.ts";
import { parseNewTaskArgs } from "../../src/cli/parsers/new-task.ts";
import { createCliCommandService } from "../../src/daemon/command-service.ts";
import { createGitCanonicalPublicationInspector } from "../../src/daemon/authority-publication-evidence.ts";
import { createProductionAuthorityLifecycle } from "../../src/daemon/production-authority-lifecycle.ts";
import {
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  runRawJsonAsync,
  runRawJsonMaybeFail,
  stopDaemon
} from "../helpers/daemon-cli.ts";
import {
  authorityEventBodies,
  authorityOperationRecords,
  createFixture,
  enablePresetAwareTaskCreate,
  git,
  latestAuthorityOperation,
  writeColdCodexSessionLog
} from "./fixture.ts";

test("production service route preserves progress dry-run and publishes canonical task writes", { timeout: 120_000 }, async () => {
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
    enablePresetAwareTaskCreate(fixture.authoredRoot);
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

    const decisionId = "dec_01KXQ4WTA7Q4XJ5GDDRS1YXND9";
    const proposed = runRawJsonMaybeFail(fixture.repoRoot, [
      "decision", "propose", "--id", decisionId,
      "--title", "V2 attribution vocabulary",
      "--question", "Should V2 judgment resolve the persisted propose event?",
      "--chosen", "Use the registry action vocabulary",
      "--rejected", "Use the legacy WriteOp kind",
      "--why-not", "That is not the V2 mutation action",
      "--claim", "The V2 propose event is the immutable attribution source",
      "--risk-tier", "medium", "--urgency", "medium", "--module", "cli"
    ], env);
    assert.equal(proposed.status, 0, JSON.stringify(proposed.receipt));
    assert.equal(proposed.receipt.ok, true, JSON.stringify(proposed.receipt));
    const proposeEvent = authorityEventBodies(fixture.authoredRoot).find((body) => body.includes(`decision/${decisionId}`));
    assert.ok(proposeEvent, "V2 propose must persist an attribution event before restart");
    assert.match(proposeEvent, /"action"\s*:\s*"propose"/u);
    assert.doesNotMatch(proposeEvent, /"action"\s*:\s*"decision_propose"/u);

    await stopDaemon(fixture.repoRoot, userRoot);
    runDaemonCommand(fixture.repoRoot, [
      "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
    ], env);
    await pollUntil(
      () => runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env),
      (daemonStatus) => daemonStatus.reachable === true,
      (daemonStatus, error) => JSON.stringify({ daemonStatus, error: error instanceof Error ? error.message : String(error ?? "") }),
      { timeoutMs: 20_000 }
    );
    const { HARNESS_ACTOR: _agentActor, ...humanEnv } = env;
    const accepted = runRawJsonMaybeFail(fixture.repoRoot, [
      "--actor", "human:person_alice", "decision", "transition", "active", decisionId,
      "--judgment-only", "A human verified the persisted V2 propose attribution after restart."
    ], humanEnv);
    assert.equal(accepted.status, 0, JSON.stringify(accepted.receipt));
    assert.equal(accepted.receipt.ok, true, JSON.stringify(accepted.receipt));
    assert.match(readFileSync(path.join(
      fixture.authoredRoot, `decisions/decision-${decisionId}/decision.md`
    ), "utf8"), /^state: active$/mu);

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

    const sluggedLifecycleTaskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8";
    const sluggedExecutionId = "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG7";
    const sluggedSessionId = "service-slugged-lifecycle-session";
    writeColdCodexSessionLog(fixture.repoRoot, sluggedSessionId);
    const sluggedLifecycleEnv = { ...env, CODEX_THREAD_ID: sluggedSessionId };
    const exportedLifecycleSession = runRawJsonMaybeFail(fixture.repoRoot, [
      "session", "export", "--session", sluggedSessionId, "--runtime", "codex", "--source", "runtime",
      "--detected-at", "2026-07-17T00:00:00.000Z", "--transcript-file", fixture.transcriptPath
    ], sluggedLifecycleEnv);
    assert.equal(exportedLifecycleSession.status, 0, JSON.stringify(exportedLifecycleSession.receipt));
    assert.equal(exportedLifecycleSession.receipt.ok, true, JSON.stringify(exportedLifecycleSession.receipt));
    const claimed = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "claim", sluggedLifecycleTaskId, "--execution-id", sluggedExecutionId
    ], sluggedLifecycleEnv);
    assert.equal(claimed.status, 0, JSON.stringify(claimed.receipt));
    assert.equal(claimed.receipt.ok, true, JSON.stringify(claimed.receipt));

    const reconciled = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "code-doc", "reconcile", sluggedLifecycleTaskId,
      "--commit", fixture.publicHead, "--path", "README.md"
    ], sluggedLifecycleEnv);
    assert.equal(reconciled.status, 0, JSON.stringify(reconciled.receipt));
    assert.equal(reconciled.receipt.ok, true, JSON.stringify(reconciled.receipt));
    assert.equal(existsSync(path.join(
      fixture.authoredRoot,
      `tasks/${sluggedLifecycleTaskId}-production-route/code-doc-anchors.json`
    )), true);
    assert.equal(existsSync(path.join(fixture.authoredRoot, `tasks/${sluggedLifecycleTaskId}`)), false);

    const transitioned = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "transition", sluggedLifecycleTaskId, "in_review",
      "--execution-id", sluggedExecutionId,
      "--completion-claim", "Slugged production lifecycle is complete.",
      "--deliverable", "Canonical slug-aware lifecycle intents.",
      "--verification", "Production daemon route passed.",
      "--output", "slugged lifecycle passed"
    ], sluggedLifecycleEnv);
    assert.equal(transitioned.status, 0, JSON.stringify(transitioned.receipt));
    assert.equal(transitioned.receipt.ok, true, JSON.stringify(transitioned.receipt));

    const consented = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "consent-record", sluggedLifecycleTaskId,
      "--execution-id", sluggedExecutionId,
      "--utterance", "Approve and complete the slugged production execution.",
      "--consent-action", "approve_execution", "--consent-action", "complete_task"
    ], sluggedLifecycleEnv);
    assert.equal(consented.status, 0, JSON.stringify(consented.receipt));
    assert.equal(consented.receipt.ok, true, JSON.stringify(consented.receipt));
    const sluggedConsentId = String((consented.receipt.details as { readonly data?: { readonly consentId?: string } } | undefined)?.data?.consentId ?? "");
    assert.match(sluggedConsentId, /^cns_/u, JSON.stringify(consented.receipt));

    const reviewed = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "review-execution", sluggedLifecycleTaskId,
      "--execution-id", sluggedExecutionId,
      "--verdict", "approved",
      "--findings", "Slugged production evidence is complete.",
      "--evidence-checked", "ev_cli_1",
      "--rationale", "The submitted execution and closeout evidence support approval.",
      "--acknowledge-archive-warnings", "--consent", sluggedConsentId
    ], sluggedLifecycleEnv);
    assert.equal(reviewed.status, 0, JSON.stringify(reviewed.receipt));
    assert.equal(reviewed.receipt.ok, true, JSON.stringify(reviewed.receipt));
    assert.match(readFileSync(path.join(
      fixture.authoredRoot,
      `tasks/${sluggedLifecycleTaskId}-production-route/executions/${sluggedExecutionId}.md`
    ), "utf8"), /^  "state": "submitted",$/mu);

    const completed = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "complete", sluggedLifecycleTaskId, "--ci", "passed", "--reviewer", "person_alice"
    ], sluggedLifecycleEnv);
    assert.equal(completed.status, 0, JSON.stringify(completed.receipt));
    assert.equal(completed.receipt.ok, true, JSON.stringify(completed.receipt));
    const sluggedTaskRoot = path.join(fixture.authoredRoot, `tasks/${sluggedLifecycleTaskId}-production-route`);
    assert.match(readFileSync(path.join(sluggedTaskRoot, "INDEX.md"), "utf8"), /^  status: done$/mu);
    assert.equal(existsSync(path.join(sluggedTaskRoot, `consents/${sluggedConsentId}.md`)), true);
    assert.equal(existsSync(path.join(sluggedTaskRoot, "reviews")), true);
    assert.equal(existsSync(path.join(fixture.authoredRoot, `tasks/${sluggedLifecycleTaskId}`)), false);

    const bareSessionId = "service-task-create-session";
    writeColdCodexSessionLog(fixture.repoRoot, bareSessionId);
    assert.equal(existsSync(path.join(fixture.authoredRoot, `sessions/${bareSessionId}.md`)), false);
    const beforeColdBare = authorityOperationRecords(fixture.serviceRoot).length;
    const created = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "create", "--title", "Service route task create"
    ], { ...env, CODEX_THREAD_ID: bareSessionId });
    assert.equal(created.status, 0, JSON.stringify(created.receipt));
    assert.equal(created.receipt.ok, true, JSON.stringify(created.receipt));
    const createDetails = (created.receipt.details as { readonly data?: Record<string, unknown> } | undefined)?.data ?? {};
    const createPackagePath = (created.receipt.paths as ReadonlyArray<{ readonly role?: string; readonly path?: string }> | undefined)
      ?.find((entry) => entry.role === "package")?.path ?? "";
    assert.match(String(createDetails.taskId ?? ""), /^task_[0-9A-HJKMNP-TV-Z]{26}$/u, JSON.stringify(created.receipt));
    assert.equal(existsSync(path.join(fixture.repoRoot, createPackagePath, "INDEX.md")), true);
    assert.equal(existsSync(path.join(fixture.repoRoot, createPackagePath, "task-contract.json")), true);
    const createOperation = latestAuthorityOperation(fixture.serviceRoot);
    assert.equal(createOperation.state, "COMMITTED", JSON.stringify(createOperation));
    assert.equal(createOperation.receipt?.tag, "COMMITTED", JSON.stringify(createOperation));
    assert.equal(typeof createOperation.opId, "string", JSON.stringify(createOperation));
    const createPublication = await createGitCanonicalPublicationInspector(fixture.authoredRoot)
      .findPublicationForOperation(createOperation.opId!);
    assert.equal(createPublication.commitSha, createOperation.commitSha);
    assert.equal(createPublication.physicalChanges.filter((change) => change.path.startsWith("attribution-events/")).length, 1);
    assert.equal(authorityEventBodies(fixture.authoredRoot).filter((body) => body.includes(createOperation.opId!)).length, 1);
    assert.equal(existsSync(path.join(fixture.authoredRoot, `sessions/${bareSessionId}.md`)), true);
    assert.equal(authorityOperationRecords(fixture.serviceRoot).length, beforeColdBare + 2, "cold bare create must commit session.export then task.create");

    const beforeHotBare = authorityOperationRecords(fixture.serviceRoot).length;
    const hotCreated = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "create", "--title", "Service route hot-session task create"
    ], { ...env, CODEX_THREAD_ID: bareSessionId });
    assert.equal(hotCreated.status, 0, JSON.stringify(hotCreated.receipt));
    assert.equal(hotCreated.receipt.ok, true, JSON.stringify(hotCreated.receipt));
    assert.equal(authorityOperationRecords(fixture.serviceRoot).length, beforeHotBare + 1, "hot bare create must commit only task.create");

    const presetSessionId = "service-preset-task-create-session";
    writeColdCodexSessionLog(fixture.repoRoot, presetSessionId);
    assert.equal(existsSync(path.join(fixture.authoredRoot, `sessions/${presetSessionId}.md`)), false);
    const beforeColdPreset = authorityOperationRecords(fixture.serviceRoot).length;
    const presetCreated = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "create", "--title", "Service route preset task", "--preset", "docs-task", "--locale", "en-US"
    ], { ...env, CODEX_THREAD_ID: presetSessionId });
    assert.equal(presetCreated.status, 0, JSON.stringify(presetCreated.receipt));
    assert.equal(presetCreated.receipt.ok, true, JSON.stringify(presetCreated.receipt));
    const presetDetails = (presetCreated.receipt.details as { readonly data?: Record<string, unknown> } | undefined)?.data ?? {};
    const presetPackagePath = (presetCreated.receipt.paths as ReadonlyArray<{ readonly role?: string; readonly path?: string }> | undefined)
      ?.find((entry) => entry.role === "package")?.path ?? "";
    assert.match(String(presetDetails.taskId ?? ""), /^task_[0-9A-HJKMNP-TV-Z]{26}$/u, JSON.stringify(presetCreated.receipt));
    assert.equal(existsSync(path.join(fixture.repoRoot, presetPackagePath, "INDEX.md")), true);
    assert.equal(existsSync(path.join(fixture.repoRoot, presetPackagePath, "task-contract.json")), true);
    assert.match(readFileSync(path.join(fixture.repoRoot, presetPackagePath, "INDEX.md"), "utf8"), /^preset: docs-task$/mu);
    const presetOperation = latestAuthorityOperation(fixture.serviceRoot);
    assert.equal(presetOperation.state, "COMMITTED", JSON.stringify(presetOperation));
    assert.equal(presetOperation.receipt?.tag, "COMMITTED", JSON.stringify(presetOperation));
    assert.equal(authorityEventBodies(fixture.authoredRoot).filter((body) => body.includes(presetOperation.opId!)).length, 1);
    assert.equal(existsSync(path.join(fixture.authoredRoot, `sessions/${presetSessionId}.md`)), true);
    assert.equal(authorityOperationRecords(fixture.serviceRoot).length, beforeColdPreset + 2, "cold preset create must commit session.export then task.create");

    const beforeHotPreset = authorityOperationRecords(fixture.serviceRoot).length;
    const hotPresetCreated = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "create", "--title", "Service route hot-session preset task", "--preset", "docs-task", "--locale", "en-US"
    ], { ...env, CODEX_THREAD_ID: presetSessionId });
    assert.equal(hotPresetCreated.status, 0, JSON.stringify(hotPresetCreated.receipt));
    assert.equal(hotPresetCreated.receipt.ok, true, JSON.stringify(hotPresetCreated.receipt));
    assert.equal(authorityOperationRecords(fixture.serviceRoot).length, beforeHotPreset + 1, "hot preset create must commit only task.create");

    const concurrentSessionId = "service-interleaved-shared-session";
    const interleaved = await Promise.all(Array.from({ length: 6 }, (_, index) => runRawJsonAsync(fixture.repoRoot, [
      "task", "progress", "append", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4",
      "--text", `interleaved authority and runtime event ${index}`
    ], { ...env, CODEX_THREAD_ID: concurrentSessionId })));
    assert.equal(interleaved.every((receipt) => receipt.ok === true), true, JSON.stringify(interleaved));
    const settledOperations = authorityOperationRecords(fixture.serviceRoot);
    assert.equal(settledOperations.every((record) => record.state === "COMMITTED"), true, JSON.stringify(settledOperations));
    const eventBodies = authorityEventBodies(fixture.authoredRoot);
    for (const record of settledOperations) {
      assert.equal(eventBodies.filter((body) => body.includes(record.opId ?? "missing-op")).length, 1, JSON.stringify(record));
    }
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
