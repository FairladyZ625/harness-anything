// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, registerDaemonRepo } from "@harness-anything/storage";
import { isTaskEvent } from "@harness-anything/kernel";
import type { DaemonHost } from "../src/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

/**
 * dec_E369B8616F50A6208B293997E7 CH2: task create materializes a fixed closeout skeleton and submit
 * reads it as authored prose. The red→green contrast this test carries is one body on both sides:
 * the canonically materialized `closeout.md`, untouched, now submits; before this change the same
 * scaffold comparison rejected it as `closeout_placeholder`.
 */
test("the closeout skeleton materialized with the task submits untouched", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-closeout-skeleton-")),
    ledger = path.join(rootDir, "harness"),
    repoId = workspaceId("closeout-skeleton"),
    taskId = "task-closeout-skeleton",
    executionId = "execution-closeout-skeleton",
    binding = withPolicyGroup(
      {
        actor: { principal: { personId: "owner" }, executor: { kind: "agent" as const, id: "worker-skeleton" } },
        source: "local" as const,
      },
      "admin",
    );
  initRepo(rootDir);
  mkdirSync(ledger);
  initRepo(ledger);
  const cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "skeleton-fixture" });
  try {
    // docs-task is artifact-delivering: the delivery is an accepted artifact, not a Git commit, which
    // keeps this test on the closeout boundary alone.
    const created = await cell.run(
      { kind: "task-create", taskId, title: "Closeout skeleton", presetId: "docs-task" },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const packagePath = String((created as { readonly packagePath?: string }).packagePath),
      closeoutPath = path.join(ledger, packagePath, "closeout.md"),
      skeleton = readFileSync(closeoutPath, "utf8");
    assert.deepEqual(
      [...skeleton.matchAll(/^## .+$/gmu)].map((match) => match[0]),
      ["## Summary", "## What Changed", "## Verification", "## Residual Risk", "## Same Mechanism Elsewhere"],
    );
    await realizeTaskPlanFixture(
      rootDir,
      packagePath,
      async (documentPath) => {
        const receipt = await cell.run({ kind: "doc-submit", paths: [documentPath] }, binding);
        await waitForFixturePublication(cell, receipt.opId, binding);
        return receipt;
      },
      "Closeout skeleton",
    );
    const started = await cell.run({ kind: "task-start", taskId, executionId }, binding);
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    await waitForFixturePublication(cell, started.opId, binding);
    mkdirSync(path.join(ledger, packagePath, "artifacts"), { recursive: true });
    writeFileSync(path.join(ledger, packagePath, "artifacts/report.md"), "# Evidence\n\nSkeleton boundary.\n");
    const retainedArtifact = path.join(ledger, packagePath, "artifacts/retained.md");
    writeFileSync(retainedArtifact, "# Retained evidence\n");
    const artifact = await cell.run({ kind: "doc-submit", taskId }, binding);
    assert.equal(artifact.outcome, "applied", JSON.stringify(artifact));
    await waitForFixturePublication(cell, artifact.opId, binding);

    // One eligible edit and one forbidden deletion exercise partial synchronization.
    unlinkSync(retainedArtifact);
    writeFileSync(
      path.join(ledger, packagePath, "artifacts/report.md"),
      "# Evidence\n\nUpdated artifact before submit.\n",
    );
    const pendingDocuments = await cell.run({ kind: "doc-status", taskId }, binding);
    assert.equal(pendingDocuments.detail?.kind, "doc_sync", JSON.stringify(pendingDocuments));
    assert.match(
      JSON.stringify(pendingDocuments.detail?.kind === "doc_sync" ? pendingDocuments.detail.deletions : []),
      /retained\.md/u,
      JSON.stringify(pendingDocuments),
    );
    // The untouched skeleton — prompt sentences and all — is a valid authored closeout.
    const submitted = await cell.run({ kind: "task-submit", taskId, executionId }, binding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.doesNotMatch(JSON.stringify(submitted), /materialized template|retains template prose/u);
    assert.match(
      JSON.stringify((submitted as unknown as { warnings: unknown }).warnings),
      /unsynchronized.*retained\.md.*CEO/u,
      JSON.stringify((submitted as unknown as { steps: unknown }).steps),
    );
    await waitForFixturePublication(cell, submitted.opId, binding);
    const packet = makeTaskEventReader({ repoId, rootDir })
      .read()
      .events.flatMap((event) =>
        isTaskEvent(event) && event.taskId === taskId && event.type === "execution_submitted"
          ? [event.payload.execution.submission!]
          : [],
      )
      .at(-1)!;
    // Recorded verbatim: the claim is the scaffold's own Summary paragraph, unfiltered by heading
    // normalization or locale. Compare against the skeleton body rather than a hardcoded sentence.
    const summaryStart = skeleton.indexOf("## Summary\n"),
      summaryEnd = skeleton.indexOf("\n## What Changed", summaryStart);
    assert.equal(packet.completionClaim, skeleton.slice(summaryStart + "## Summary\n".length, summaryEnd).trim());
    assert.equal(packet.verificationNotes.length, 1);
    assert.deepEqual(packet.knownGaps, packet.residualRisks);

    // Restore the locally deleted file before exercising an unrelated valid amendment.
    assert.ok(packet.artifacts?.some((artifact) => artifact.path.endsWith("/artifacts/retained.md")));
    writeFileSync(retainedArtifact, "# Retained evidence\n");
    // Dirty package prose is accepted by submit itself; no later worker doc-sync is needed.
    writeFileSync(
      closeoutPath,
      "# Closeout\n\n## Summary\nVerified delivery.\n\n## Verification\nDirected tests passed.\n\n## Residual Risk\nNo accepted risk.\n\n## Same Mechanism Elsewhere\nTask-package writes share submit.\n",
    );
    const filled = await cell.run({ kind: "task-submit", taskId, executionId, amend: true }, binding);
    assert.equal(filled.outcome, "applied", JSON.stringify(filled));
    assert.doesNotMatch(
      JSON.stringify((filled as unknown as { warnings?: unknown }).warnings ?? []),
      /materialized template/u,
    );
    assert.equal(
      (await cell.read("repo.tasks.list")).rows
        .find((row) => row.taskId === taskId)
        ?.snapshot.executions.find((execution) => execution.executionId === executionId)?.submission?.completionClaim,
      "Verified delivery.",
    );

    // Negative: every heading present but no prose in Summary derives no claim, so the Submission
    // schema rejects the cut. The refusal names the real defect, not a scaffold comparison.
    writeFileSync(
      closeoutPath,
      "# Closeout\n\n## Summary\n\n## Verification\n\n## Residual Risk\n\n## Same Mechanism Elsewhere\n",
    );
    const empty = await cell.run({ kind: "task-submit", taskId, executionId, amend: true }, binding);
    assert.notEqual(empty.outcome, "applied", JSON.stringify(empty));
    assert.equal(empty.code, "invalid_submission", JSON.stringify(empty));
    assert.match(JSON.stringify(empty.diagnostic), /completionClaim/u);
    assert.doesNotMatch(JSON.stringify(empty), /placeholder/u);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// Exercise the actual CLI and production renderer, over an isolated transport into a real RepoCell.
// No receipt or submission is synthesized: task show and doc show read the accepted canonical cut.
test(
  "incident closeout: real ha task submit → production renderer → check-pr-body",
  {
    skip: process.platform === "win32" ? "requires POSIX executable lookup for the renderer's ha subprocess" : false,
  },
  async (t) => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-closeout-incident-")),
      userRoot = path.join(rootDir, "user"),
      repoId = workspaceId("closeout-incident"),
      taskId = "task-closeout-incident",
      executionId = "execution-closeout-incident",
      binding = withPolicyGroup(
        {
          actor: { principal: { personId: "owner" }, executor: { kind: "agent" as const, id: "worker-incident" } },
          source: "local" as const,
        },
        "admin",
      ),
      sourceRoot = fileURLToPath(new URL("../../../", import.meta.url)),
      cli = path.join(sourceRoot, "packages/cli/src/index.ts"),
      execute = promisify(execFile);
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "harness"));
    initRepo(path.join(rootDir, "harness"));
    writeFileSync(
      path.join(rootDir, "harness/harness.yaml"),
      `schema: harness-anything/v1\nname: ${repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
    );
    registerDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
    const cell = await openBootstrappedRepoCell({
        repoId,
        rootDir: canonicalRoot(rootDir),
        ownerId: "incident-fixture",
      }),
      transport = createUnixSocketTransportServer({
        daemonId: "closeout-incident",
        socketPath: localUserDaemonEndpoint(userRoot, "closeout-incident"),
        createProtocolServer: (authContext, emit) =>
          createJsonRpcProtocolServer({
            host: {
              run: async (_repo: string, action: Parameters<typeof cell.run>[0]) =>
                // Submit releases the worker lease. Publication reads run as the package owner,
                // just as task push does after the worker hands back its accepted cut.
                cell.run(
                  action,
                  action.kind === "doc-show" ? { ...binding, actor: { ...binding.actor, executor: null } } : binding,
                ),
            } as unknown as DaemonHost,
            build: { loadedBuildId: null, commit: null, builtAt: null },
            authContext,
            emit,
          }),
      });
    await transport.start();
    try {
      const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("HARNESS_"))),
        HARNESS_DAEMON_USER_ROOT: userRoot,
        HARNESS_DAEMON_ID: "closeout-incident",
        HARNESS_DAEMON_REPO_ID: repoId,
        HARNESS_ACTOR: "agent:worker-incident",
        HARNESS_TASK_BOUND: "0",
        PR_BASE_SHA: "HEAD",
        PR_HEAD_SHA: "HEAD",
        PATH: `${path.join(rootDir, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      };
      const publisherEnv = {
        ...env,
        HARNESS_ACTOR: "",
        CLAUDE_CODE_SESSION_ID: "",
        CODEX_THREAD_ID: "",
        CODEX_SESSION_ID: "",
      };
      mkdirSync(path.join(rootDir, "bin"));
      // The renderer launches ha by name. This executable only forwards argv to the real CLI.
      writeFileSync(
        path.join(rootDir, "bin/ha"),
        `#!${process.execPath}\nconst r = require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(cli)}, "--root", ${JSON.stringify(rootDir)}, ...process.argv.slice(2)], { stdio: "inherit", env: process.env }); if (r.error) throw r.error; process.exit(r.status ?? 1);\n`,
        { mode: 0o755 },
      );
      for (const file of [".github/pull_request_template.md", "tools/gate-manifest.json"]) {
        mkdirSync(path.dirname(path.join(rootDir, file)), { recursive: true });
        writeFileSync(path.join(rootDir, file), readFileSync(path.join(sourceRoot, file)));
      }
      const created = await cell.run(
        { kind: "task-create", taskId, title: "Incident closeout", presetId: "docs-task" },
        binding,
      );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await waitForFixturePublication(cell, created.opId, binding);
      const packagePath = String((created as { readonly packagePath?: string }).packagePath);
      await realizeTaskPlanFixture(
        rootDir,
        packagePath,
        async (documentPath) => {
          const result = await cell.run({ kind: "doc-submit", paths: [documentPath] }, binding);
          await waitForFixturePublication(cell, result.opId, binding);
          return result;
        },
        "Incident closeout",
      );
      const started = await cell.run({ kind: "task-start", taskId, executionId }, binding);
      assert.equal(started.outcome, "applied", JSON.stringify(started));
      await waitForFixturePublication(cell, started.opId, binding);
      const incident = "# Closeout\n\n## 验收与原始结果\n\n- exit 0.\n";
      writeFileSync(path.join(rootDir, "harness", packagePath, "closeout.md"), incident);
      mkdirSync(path.join(rootDir, "harness", packagePath, "artifacts"), { recursive: true });
      writeFileSync(path.join(rootDir, "harness", packagePath, "artifacts/evidence.txt"), "Incident delivery.\n");
      const submitted = await execute(process.execPath, [cli, "--root", rootDir, "--json", "task", "submit", taskId], {
        cwd: rootDir,
        env,
      });
      t.diagnostic(`ha task submit ${taskId} exit=0\n${submitted.stdout}`);
      const receipt = JSON.parse(submitted.stdout);
      assert.equal(receipt.ok, true, submitted.stdout);
      await waitForFixturePublication(cell, receipt.opId, binding);
      const shown = await cell.run({ kind: "task-show", taskId }, binding);
      t.diagnostic(`Real task-show receipt: ${JSON.stringify(shown)}`);
      const published = await execute(
        process.execPath,
        [cli, "--root", rootDir, "doc", "show", "--path", `${packagePath}/closeout.md`, "--raw"],
        { cwd: rootDir, env: publisherEnv },
      );
      assert.equal(published.stdout, incident, "the accepted closeout is the exact incident body");
      const rendered = await execute(
        process.execPath,
        [path.join(sourceRoot, "tools/gates/render-task-pr-body.mjs"), "--task", taskId],
        { cwd: rootDir, env: publisherEnv },
      );
      t.diagnostic(`render-task-pr-body.mjs --task ${taskId} exit=0\n${rendered.stdout}`);
      assert.match(rendered.stdout, /## Verification[\s\S]*?验收与原始结果[\s\S]*?- exit 0\./u);
      const bodyPath = path.join(rootDir, "pr-body.md");
      writeFileSync(bodyPath, rendered.stdout);
      const checked = await execute(
        process.execPath,
        [path.join(sourceRoot, "tools/check-pr-body.mjs"), "--file", bodyPath],
        { cwd: rootDir, env },
      );
      t.diagnostic(`check-pr-body.mjs --file pr-body.md exit=0\n${checked.stdout}`);
      assert.match(checked.stdout, /PR body check passed/u);

      // F12: submit accepts this declaration and placeholder prose. Publishing must still exit 0;
      // the independent PR lint, rather than the renderer, owns declaration/content judgments.
      const malformed =
        "# Closeout\n\n## Summary\n\nDelivered.\n\n## Verification\n\nEvent-Migration: ha migrate invented-migration\n\n## Residual Risk\n\nTBD\n";
      writeFileSync(path.join(rootDir, "harness", packagePath, "closeout.md"), malformed);
      const amended = await execute(
        process.execPath,
        [cli, "--root", rootDir, "--json", "task", "submit", taskId, "--execution-id", executionId, "--amend"],
        { cwd: rootDir, env },
      );
      t.diagnostic(`ha task submit ${taskId} --amend exit=0\n${amended.stdout}`);
      const amendment = JSON.parse(amended.stdout);
      assert.equal(amendment.ok, true, amended.stdout);
      await waitForFixturePublication(cell, amendment.opId, binding);
      const unjudged = await execute(
        process.execPath,
        [path.join(sourceRoot, "tools/gates/render-task-pr-body.mjs"), "--task", taskId],
        { cwd: rootDir, env: publisherEnv },
      );
      assert.match(unjudged.stdout, /Event-Migration: ha migrate invented-migration/u);
      assert.match(unjudged.stdout, /## Residual Risk\n\nTBD/u);
      t.diagnostic("F12: accepted malformed declaration and placeholder also render with exit=0");
    } finally {
      await transport.stop();
      await cell.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  },
);
