// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readDispatchStream } from "../src/daemon-host/dispatch-stream.ts";
import { resolveRuntimeCwd } from "../src/daemon-host/runtime-spawn-mission.ts";
import { fixture, owner, taskId } from "./task-completion-review.fixture.ts";

test(
  "provider fallback rebinds the task review prompt and registers under the successor dispatch",
  { timeout: 30_000 },
  async () => {
    const f = await fixture(1, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "standard",
      submitCommit: true,
      guiDelivery: true,
      create: { presetId: "standard-task" },
      keycloakSession: async () => owner.keycloakAuthorization.session,
      providerMaxRetries: 0,
      providerRoundBackoffBaseSeconds: 1,
    });
    try {
      await f.install(null);
      assert.equal((await f.submit()).outcome, "applied");
      await f.waitForLaunches(1);
      const firstDispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
      assert.ok(firstDispatch?.type === "runtime_dispatch_requested");
      const firstStream = readDispatchStream(f.root, firstDispatch.payload.dispatchId);
      assert.ok(
        firstStream?.header.fallbackAttempt,
        `first dispatch has no provider fallback chain: ${JSON.stringify(firstStream?.header)}`,
      );
      const snapshotCwd = firstStream.header.cwd;
      assert.ok(snapshotCwd, `review dispatch has no cwd: ${JSON.stringify(firstStream.header)}`);
      const marker = path.join(snapshotCwd, ".review-snapshot-marker");
      writeFileSync(marker, "initial snapshot\n");
      assert.deepEqual(
        firstStream.header.fallbackAttempt.candidates.map(({ instance }) => instance),
        ["review-first", "review-second"],
      );
      await f.awaitOutcome(String(firstDispatch.payload.runtimeSessionId));
      const settledStream = readDispatchStream(f.root, firstDispatch.payload.dispatchId);
      assert.equal(settledStream?.attemptOutcome?.classification, "provider_quota", JSON.stringify(settledStream));
      const pending = await f
        .cell()
        .readDispatchLifecycle({ by: "dispatch", dispatchIds: [firstDispatch.payload.dispatchId] });
      assert.ok(pending.status === "ready");
      assert.equal(
        pending.rows[0]?.attempt.phase,
        "closed",
        "the predecessor is closed while the group retains its snapshot",
      );
      assert.equal(pending.rows[0]?.policy.groupSettled, false);
      assert.equal(
        resolveRuntimeCwd(f.root, {
          scope: "repo-relative",
          path: path.relative(f.root, snapshotCwd),
        }),
        snapshotCwd,
        `provider fallback must still resolve its scheduled reviewer cwd (root=${f.root}, cwd=${snapshotCwd}, relative=${path.relative(f.root, snapshotCwd)})`,
      );
      assert.ok(
        existsSync(snapshotCwd),
        "the review snapshot must remain available while provider fallback is scheduled",
      );
      await f.waitForLaunches(2);

      const attempts = f.events().filter((event) => event.type === "runtime_dispatch_requested"),
        first = attempts[0]?.payload,
        successor = attempts[1]?.payload,
        prompt = f.launches[1]?.prompt ?? "";
      assert.equal(attempts.length, 2, JSON.stringify(attempts));
      assert.ok(first && successor);
      assert.deepEqual(
        f.launches.map(({ instanceId }) => instanceId),
        ["review-first", "review-second"],
        "the second dispatch must be the provider fallback attempt",
      );
      assert.equal(f.launches[1]?.cwd, snapshotCwd, "provider fallback must use the frozen review snapshot");
      assert.ok(existsSync(f.launches[1]!.cwd), "provider fallback must start inside the existing review snapshot");
      assert.equal(readFileSync(marker, "utf8"), "initial snapshot\n", "fallback must reuse the original snapshot");
      assert.notEqual(successor.dispatchId, first.dispatchId);
      assert.ok(
        prompt.includes(`review-${successor.dispatchId}`),
        "review id must belong to the actual fallback dispatch",
      );
      assert.ok(
        prompt.includes(`${f.packagePath}/artifacts/reports/${successor.dispatchId}.json`),
        "review packet path must belong to the actual fallback dispatch",
      );
      assert.ok(
        prompt.includes(`${f.packagePath}/artifacts/reports/${successor.dispatchId}.md`),
        "review report path must belong to the actual fallback dispatch",
      );
      assert.equal(
        prompt.includes(`review-${first.dispatchId}`),
        false,
        "the old review id must not remain in the prompt",
      );
      assert.equal(
        prompt.includes(`${f.packagePath}/artifacts/reports/${first.dispatchId}.json`),
        false,
        "the old review packet path must not remain in the prompt",
      );
      assert.equal(
        prompt.includes(`${f.packagePath}/artifacts/reports/${first.dispatchId}.md`),
        false,
        "the old review report path must not remain in the prompt",
      );

      const reviewed = await f.reviewDispatchedArtifacts(
        String(successor.runtimeSessionId),
        String(successor.dispatchId),
      );
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      const pendingConsent = await f.consent(`review-${String(successor.dispatchId)}`);
      assert.equal(pendingConsent.code, "review_dispatch_unsettled", JSON.stringify(pendingConsent));
      assert.equal(
        await f.settleReview(String(successor.dispatchId), String(successor.runtimeSessionId), "Review complete."),
        "succeeded",
      );
      assert.equal(
        existsSync(snapshotCwd),
        false,
        `the review snapshot is reclaimed only after the fallback chain ends (cwd=${snapshotCwd}, root=${f.root})`,
      );
      const review = f.events().find((event) => event.type === "review_recorded");
      assert.ok(review?.type === "review_recorded");
      assert.equal(review.payload.review.reviewId, `review-${successor.dispatchId}`);
      assert.ok(
        review.payload.carriedDocumentClaims?.some(
          (claim) => claim.path === `${f.packagePath}/artifacts/reports/${successor.dispatchId}.md`,
        ),
        "the registered report must be the successor dispatch's report",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "provider fallback rematerializes a missing pinned review snapshot and preserves reviewTarget",
  { timeout: 30_000 },
  async () => {
    const f = await fixture(1, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "standard",
      submitCommit: true,
      guiDelivery: true,
      create: { presetId: "standard-task" },
      keycloakSession: async () => owner.keycloakAuthorization.session,
      providerMaxRetries: 0,
      providerRoundBackoffBaseSeconds: 1,
    });
    try {
      await f.install(null);
      assert.equal((await f.submit()).outcome, "applied");
      await f.waitForLaunches(1);
      const firstDispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
      assert.ok(firstDispatch?.type === "runtime_dispatch_requested");
      const snapshotCwd = firstDispatch.payload.cwd;
      assert.ok(snapshotCwd && existsSync(snapshotCwd), `expected pinned review snapshot: ${String(snapshotCwd)}`);

      await f.awaitOutcome(String(firstDispatch.payload.runtimeSessionId));
      // Simulate a missing review worktree right before the scheduled fallback launches.
      execFileSync("git", ["-C", f.root, "worktree", "remove", "--force", snapshotCwd], { stdio: "ignore" });
      assert.equal(existsSync(snapshotCwd), false, "review snapshot should be gone before fallback fires");

      await f.waitForLaunches(2);
      const attempts = f.events().filter((event) => event.type === "runtime_dispatch_requested");
      assert.equal(attempts.length, 2, JSON.stringify(attempts));
      const first = attempts[0]!.payload,
        successor = attempts[1]!.payload;
      assert.equal(f.launches[1]?.instanceId, "review-second");
      assert.equal(f.launches[1]?.cwd, snapshotCwd);
      assert.equal(existsSync(snapshotCwd), true, "fallback must rematerialize the pinned review checkout");
      assert.deepEqual(successor.reviewTarget, first.reviewTarget);
      assert.equal(successor.executionId, first.executionId);

      const reviewed = await f.reviewDispatchedArtifacts(
        String(successor.runtimeSessionId),
        String(successor.dispatchId),
      );
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      assert.equal(
        await f.settleReview(String(successor.dispatchId), String(successor.runtimeSessionId), "Review complete."),
        "succeeded",
      );
      assert.equal(
        existsSync(snapshotCwd),
        false,
        "rematerialized review snapshot is reclaimed after group settlement",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "decision review provider fallback preserves reviewTarget and symlinked harness cwd",
  { timeout: 30_000, skip: process.platform === "win32" ? "requires POSIX symlink semantics" : false },
  async () => {
    const externalParent = mkdtempSync(path.join(tmpdir(), "ha-symlink-ledger-")),
      externalHarness = path.join(externalParent, "private-harness");
    const f = await fixture(1, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "standard",
      keycloakSession: async () => owner.keycloakAuthorization.session,
      providerMaxRetries: 0,
      providerRoundBackoffBaseSeconds: 1,
      symlinkAuthoredRoot: externalHarness,
    });
    try {
      await f.install(null);
      const proposed = await f.run({
        kind: "decision-propose",
        body: "# Symlinked ledger decision review fallback\n\n## 背景\n\nVerify decision review fallback over symlinked harness.\n\n## 权衡\n\nCompare preserving trusted reviewTarget and cwd against re-running repo-relative containment.\n\n## 结论\n\nPreserve trusted reviewTarget and authorized cwd across provider fallback.\n",
        jsonInput: JSON.stringify({
          title: "Symlinked ledger decision review fallback",
          question: "Should provider fallback preserve trusted reviewTarget and authorized cwd over symlinked harness?",
          riskTier: "medium",
          urgency: "medium",
          vertical: "software/coding",
          preset: "standard-task",
          decisionClass: "ordinary",
          appliesTo: { modules: ["daemon"], productLines: [] },
          chosen: [{ id: "CH1", text: "Preserve trusted reviewTarget and cwd across provider fallback" }],
          rejected: [
            {
              id: "RJ1",
              text: "Re-encode cwd as repo-relative",
              whyNot: "Fails repo containment on symlinked ledgers",
            },
          ],
          claims: [
            {
              id: "C1",
              text: "Fallback inherits reviewTarget and authorized cwd.",
              loadBearing: true,
            },
          ],
          fulfillments: [],
        }),
      });
      assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
      const decisionId = String((JSON.parse(String(proposed.evidence)) as { readonly decisionId: string }).decisionId);
      await f.cell().settlePendingMaterialization("decision propose");

      const dispatched = await f.run({ kind: "decision-dispatch-review", decisionId });
      assert.equal(dispatched.outcome, "applied", JSON.stringify(dispatched));
      await f.waitForLaunches(1);
      const firstDispatch = f
        .events()
        .find(
          (event) => event.type === "runtime_dispatch_requested" && event.payload.reviewTarget?.kind === "decision",
        );
      assert.ok(firstDispatch?.type === "runtime_dispatch_requested");
      const expectedDecisionCwd = realpathSync.native(
        path.join(externalHarness, "decisions", `decision-${decisionId}`),
      );
      assert.equal(f.launches[0]?.cwd, expectedDecisionCwd);

      await f.awaitOutcome(String(firstDispatch.payload.runtimeSessionId));
      await f.waitForLaunches(2);
      const decisionAttempts = f
        .events()
        .filter(
          (event) => event.type === "runtime_dispatch_requested" && event.payload.reviewTarget?.kind === "decision",
        );
      assert.equal(decisionAttempts.length, 2, JSON.stringify(decisionAttempts));
      assert.deepEqual(decisionAttempts[1]!.payload.reviewTarget, decisionAttempts[0]!.payload.reviewTarget);
      assert.equal(f.launches[1]?.instanceId, "review-second");
      assert.equal(f.launches[1]?.cwd, expectedDecisionCwd);
    } finally {
      await f.close();
      rmSync(externalParent, { recursive: true, force: true });
    }
  },
);

test(
  "exhausted review provider fallback surfaces failure reason and dispatch-review next step in task show and agenda",
  { timeout: 30_000 },
  async () => {
    const f = await fixture(true, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "standard",
      submitCommit: true,
      guiDelivery: true,
      create: { presetId: "standard-task" },
      keycloakSession: async () => owner.keycloakAuthorization.session,
      providerMaxRetries: 0,
      providerRoundBackoffBaseSeconds: 1,
    });
    try {
      await f.install(null);
      assert.equal((await f.submit()).outcome, "applied");
      await f.waitForLaunches(2);
      const attempts = f.events().filter((event) => event.type === "runtime_dispatch_requested");
      assert.equal(attempts.length, 2, JSON.stringify(attempts));
      const snapshotCwd = attempts[0]!.payload.cwd;
      await f.awaitOutcome(String(attempts[1]!.payload.runtimeSessionId));
      assert.ok(snapshotCwd);
      assert.equal(existsSync(snapshotCwd), false, "review snapshot is reclaimed after exhausted group settles");

      const shown = await f.run({ kind: "task-show", taskId });
      assert.equal(shown.outcome, "applied", JSON.stringify(shown));
      const payload = JSON.parse(String(shown.evidence)) as {
        readonly task: { readonly status: string };
        readonly completionBlocker: { readonly code: string; readonly gate: string } | null;
        readonly completionNext: { readonly action: string; readonly reason: string } | null;
      };
      assert.equal(payload.task.status, "in_review");
      assert.deepEqual(payload.completionBlocker, { code: "review_pending", gate: "review" });
      assert.equal(payload.completionNext?.action, `ha task dispatch-review ${taskId}`);
      assert.match(payload.completionNext?.reason ?? "", new RegExp(String(attempts[1]!.payload.dispatchId), "u"));
      assert.match(payload.completionNext?.reason ?? "", /Provider fallback exhausted|HTTP 429/u);
      assert.match(payload.completionNext?.reason ?? "", new RegExp(`ha task dispatch-review ${taskId}`, "u"));

      const agenda = await f.cell().read("repo.agenda.read", {}, owner);
      const item = agenda.attentionItems.find(
        (entry) => entry.ref === `task/${taskId}` && entry.kind === "needs-handling",
      );
      assert.ok(item, `expected undispatched review attention item: ${JSON.stringify(agenda.attentionItems)}`);
      assert.match(agenda.summary, /review dispatch failed:/u);
      assert.match(agenda.summary, /Provider fallback exhausted|HTTP 429/u);
      assert.match(agenda.summary, new RegExp(`ha task dispatch-review ${taskId}`, "u"));
    } finally {
      await f.close();
    }
  },
);
