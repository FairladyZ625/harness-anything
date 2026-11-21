// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readDispatchStream } from "../src/daemon-host/dispatch-stream.ts";
import { resolveRuntimeCwd } from "../src/daemon-host/runtime-spawn-mission.ts";
import { waitForDurableCondition } from "../../../tools/fixtures/event-arrival.ts";
import { executionId, fixture, owner, taskId } from "./task-completion-review.fixture.ts";

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

test(
  "generic runtime RPC with Decision reviewTarget cannot bypass symlinked harness containment",
  { timeout: 30_000, skip: process.platform === "win32" ? "requires POSIX symlink semantics" : false },
  async () => {
    const externalParent = mkdtempSync(path.join(tmpdir(), "ha-rpc-symlink-ledger-")),
      externalHarness = path.join(externalParent, "private-harness");
    const f = await fixture(false, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "standard",
      keycloakSession: async () => owner.keycloakAuthorization.session,
      symlinkAuthoredRoot: externalHarness,
    });
    try {
      await f.install(null);
      const proposed = await f.run({
        kind: "decision-propose",
        body: "# RPC boundary test\n\n## 背景\n\nEnsure generic RPC cannot bypass managed cwd.\n\n## 权衡\n\nOnly internal review dispatch grants managed authoredRoot cwd.\n\n## 结论\n\nReject generic RPC decision reviewTarget cwd escape.\n",
        jsonInput: JSON.stringify({
          title: "RPC boundary test",
          question: "Should generic runtime RPC reject managed symlink cwd even with reviewTarget?",
          riskTier: "medium",
          urgency: "medium",
          vertical: "software/coding",
          preset: "standard-task",
          decisionClass: "ordinary",
          appliesTo: { modules: ["daemon"], productLines: [] },
          chosen: [{ id: "CH1", text: "Reject generic RPC managed cwd bypass" }],
          rejected: [{ id: "RJ1", text: "Trust caller reviewTarget", whyNot: "Lets RPC escape repo realpath" }],
          claims: [{ id: "C1", text: "Only internal review dispatch grants managed cwd.", loadBearing: true }],
          fulfillments: [],
        }),
      });
      assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
      const decisionId = String((JSON.parse(String(proposed.evidence)) as { readonly decisionId: string }).decisionId);
      await f.cell().settlePendingMaterialization("decision propose");

      await assert.rejects(
        f.cell().spawnRuntime(
          {
            agentId: "closeout-reviewer",
            role: "reviewer",
            reviewTarget: { kind: "decision", decisionId, digest: `sha256:${"a".repeat(64)}` },
            cwd: { scope: "repo-relative", path: `harness/decisions/decision-${decisionId}` },
            prompt: "Synthetic external RPC attempting managed cwd bypass",
            dispatchKey: "synthetic-rpc-decision-bypass",
          },
          owner,
        ),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "invalid_runtime_cwd" &&
          /Runtime cwd must stay inside the repository/u.test(error.message),
      );
      assert.equal(f.launches.length, 0, "external RPC must never launch inside symlinked external harness");
    } finally {
      await f.close();
      rmSync(externalParent, { recursive: true, force: true });
    }
  },
);

test(
  "ordinary dispatch fallback re-verifies repository realpath containment when cwd becomes an escaping symlink during backoff",
  { timeout: 30_000, skip: process.platform === "win32" ? "requires POSIX symlink semantics" : false },
  async () => {
    const outsideParent = mkdtempSync(path.join(tmpdir(), "ha-fallback-escape-"));
    let nowMs = Date.now() + 60_000;
    const f = await fixture(1, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "standard",
      keycloakSession: async () => owner.keycloakAuthorization.session,
      providerMaxRetries: 0,
      providerRoundBackoffBaseSeconds: 60,
      now: () => new Date(nowMs).toISOString(),
    });
    try {
      await f.install(null);
      const ordinaryDir = path.join(f.root, "ordinary-subdir");
      mkdirSync(ordinaryDir, { recursive: true });
      const spawned = await f.cell().spawnRuntime(
        {
          agentId: "closeout-reviewer",
          cwd: { scope: "repo-relative", path: "ordinary-subdir" },
          prompt: "Ordinary fallback containment verification",
          dispatchKey: "ordinary-fallback-symlink-swap",
        },
        owner,
      );
      await f.waitForLaunches(1);
      await f.awaitOutcome(String(spawned.runtimeSessionId));
      const pending = await f
        .cell()
        .readDispatchLifecycle({ by: "dispatch", dispatchIds: [String(spawned.dispatchId)] });
      assert.equal(pending.status, "ready");
      assert.equal(pending.rows[0]?.groupPhase, "waiting_backoff");

      // Replace the ordinary directory with a symlink pointing outside the repository during backoff.
      rmSync(ordinaryDir, { recursive: true, force: true });
      symlinkSync(outsideParent, ordinaryDir, "dir");
      nowMs += 65_000;
      await f.reopen();

      await waitForDurableCondition(async () => {
        const read = await f
          .cell()
          .readDispatchLifecycle({ by: "dispatch", dispatchIds: [String(spawned.dispatchId)] });
        return read.status === "ready" && read.rows[0]?.policy.groupSettled === true;
      });

      assert.equal(f.launches.length, 1, "backup provider must not launch in an escaping symlink");
      const outcomes = f
        .events()
        .filter(
          (event) =>
            event.type === "runtime_session_outcome_observed" &&
            event.payload.dispatchId === String(spawned.dispatchId),
        );
      assert.match(outcomes.at(-1)?.payload.attempt?.reason ?? "", /Runtime cwd must stay inside the repository/u);
    } finally {
      await f.close();
      rmSync(outsideParent, { recursive: true, force: true });
    }
  },
);

for (const removeOldCheckout of [false, true]) {
  test(
    `task review fallback terminates as superseded on same-execution submit --amend during backoff (checkout ${removeOldCheckout ? "removed" : "retained"})`,
    { timeout: 30_000 },
    async () => {
      let nowMs = Date.now() + 60_000;
      const f = await fixture(1, true, false, false, false, {
        autoSubmit: false,
        closeoutProfile: "standard",
        submitCommit: true,
        guiDelivery: true,
        create: { presetId: "standard-task" },
        keycloakSession: async () => owner.keycloakAuthorization.session,
        providerMaxRetries: 0,
        providerRoundBackoffBaseSeconds: 60,
        now: () => new Date(nowMs).toISOString(),
      });
      try {
        await f.install(null);
        assert.equal((await f.submit()).outcome, "applied");
        await f.waitForLaunches(1);
        const firstDispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
        assert.ok(firstDispatch?.type === "runtime_dispatch_requested");
        const oldDigest = firstDispatch.payload.reviewTarget?.digest;
        const oldCheckout = firstDispatch.payload.cwd!;
        assert.ok(oldDigest && oldCheckout && existsSync(oldCheckout));

        await f.awaitOutcome(String(firstDispatch.payload.runtimeSessionId));
        const backoffRead = await f
          .cell()
          .readDispatchLifecycle({ by: "dispatch", dispatchIds: [firstDispatch.payload.dispatchId] });
        assert.equal(backoffRead.status, "ready");
        assert.equal(backoffRead.rows[0]?.groupPhase, "waiting_backoff");

        // Amend the same execution while the old review group is waiting in backoff.
        assert.equal(
          (await f.amendSubmit(`Amended cut (${removeOldCheckout ? "removed" : "retained"})`)).outcome,
          "applied",
        );
        await f.waitForLaunches(2);
        const dispatchesAfterAmend = f.events().filter((event) => event.type === "runtime_dispatch_requested"),
          newDispatch = dispatchesAfterAmend.find(
            (event) =>
              event.payload.dispatchId !== firstDispatch.payload.dispatchId &&
              event.payload.reviewTarget?.kind === "task",
          );
        assert.ok(newDispatch, JSON.stringify(dispatchesAfterAmend));
        assert.equal(newDispatch.payload.executionId, executionId);
        assert.notEqual(newDispatch.payload.reviewTarget?.digest, oldDigest);

        // Old dispatch cannot register a review against the amended cut.
        const staleReview = await f.reviewDispatchedArtifacts(
          String(firstDispatch.payload.runtimeSessionId),
          String(firstDispatch.payload.dispatchId),
        );
        assert.equal(staleReview.outcome, "op_rejected", JSON.stringify(staleReview));

        // Complete the fresh review for the amended cut before waking the superseded fallback.
        const freshReviewed = await f.reviewDispatchedArtifacts(
          String(newDispatch.payload.runtimeSessionId),
          String(newDispatch.payload.dispatchId),
        );
        assert.equal(freshReviewed.outcome, "applied", JSON.stringify(freshReviewed));
        assert.equal(
          await f.settleReview(
            String(newDispatch.payload.dispatchId),
            String(newDispatch.payload.runtimeSessionId),
            "Amended cut reviewed.",
          ),
          "succeeded",
        );

        if (removeOldCheckout) {
          execFileSync("git", ["-C", f.root, "worktree", "remove", "--force", oldCheckout], { stdio: "ignore" });
          assert.equal(existsSync(oldCheckout), false);
        }

        // Advance clock past backoff and reopen so adoption runs reconcileFallback immediately.
        nowMs += 65_000;
        await f.reopen();

        await waitForDurableCondition(async () => {
          const read = await f
            .cell()
            .readDispatchLifecycle({ by: "dispatch", dispatchIds: [firstDispatch.payload.dispatchId] });
          return read.status === "ready" && read.rows[0]?.policy.groupSettled === true;
        });
        await f.cell().settlePendingMaterialization("superseded review worktree reclaim");

        const allDispatches = f.events().filter((event) => event.type === "runtime_dispatch_requested");
        assert.equal(
          allDispatches.filter((event) => event.payload.attemptGroupId === firstDispatch.payload.dispatchId).length,
          1,
          "superseded review group must not launch a successor attempt against the amended digest",
        );
        const terminalOld = f
          .events()
          .filter(
            (event) =>
              event.type === "runtime_session_outcome_observed" &&
              event.payload.dispatchId === firstDispatch.payload.dispatchId,
          )
          .at(-1);
        assert.equal(terminalOld?.payload.attempt?.fallbackState, "exhausted");
        assert.match(terminalOld?.payload.attempt?.reason ?? "", /^review_cut_superseded:/u);
        assert.equal(existsSync(oldCheckout), false, "superseded review checkout must be safely released");
      } finally {
        await f.close();
      }
    },
  );
}

test(
  "synchronous RuntimeProcessStartRejected schedules backup reviewer and registers review",
  { timeout: 30_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "standard",
      submitCommit: true,
      guiDelivery: true,
      create: { presetId: "standard-task" },
      keycloakSession: async () => owner.keycloakAuthorization.session,
      providerMaxRetries: 0,
      providerRoundBackoffBaseSeconds: 0,
      rejectLaunch: (instanceId) =>
        instanceId === "review-first"
          ? Object.assign(new Error("primary launcher failed Authorization: Bearer sk-primary-secret-1234567890"), {
              code: "ENOENT",
            })
          : null,
    });
    try {
      await f.install(null);
      assert.equal((await f.submit()).outcome, "applied");
      await f.waitForLaunches(1);
      const attempts = f.events().filter((event) => event.type === "runtime_dispatch_requested");
      assert.equal(attempts.length, 2, JSON.stringify(attempts));
      assert.deepEqual(
        attempts.map((event) => event.payload.instanceId),
        ["review-first", "review-second"],
      );
      const successor = attempts[1]!.payload,
        snapshotCwd = attempts[0]!.payload.cwd!;
      assert.equal(f.launches[0]?.instanceId, "review-second");
      assert.equal(f.launches[0]?.cwd, snapshotCwd);
      assert.equal(existsSync(snapshotCwd), true);
      assert.deepEqual(successor.reviewTarget, attempts[0]!.payload.reviewTarget);

      const reviewed = await f.reviewDispatchedArtifacts(
        String(successor.runtimeSessionId),
        String(successor.dispatchId),
      );
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      assert.equal(
        await f.settleReview(String(successor.dispatchId), String(successor.runtimeSessionId), "Backup review passed."),
        "succeeded",
      );
      assert.equal(existsSync(snapshotCwd), false, "review checkout is reclaimed after backup settles");
    } finally {
      await f.close();
    }
  },
);

test(
  "synchronous RuntimeProcessStartRejected tries all backups, reclaims checkout, and surfaces scrubbed error in task show and agenda",
  { timeout: 30_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "standard",
      submitCommit: true,
      guiDelivery: true,
      create: { presetId: "standard-task" },
      keycloakSession: async () => owner.keycloakAuthorization.session,
      providerMaxRetries: 0,
      providerRoundBackoffBaseSeconds: 0,
      reviewInstanceIds: ["review-first", "review-second", "review-third"],
      rejectLaunch: (instanceId) =>
        Object.assign(
          new Error(`spawn refused on ${instanceId} with Authorization: Bearer sk-secret-token-abcdef123456`),
          { code: "ENOENT" },
        ),
    });
    try {
      await f.install(null);
      assert.equal((await f.submit()).outcome, "applied");
      await waitForDurableCondition(async () => {
        const attempts = f.events().filter((event) => event.type === "runtime_dispatch_requested");
        if (attempts.length < 3) return false;
        const read = await f
          .cell()
          .readDispatchLifecycle({ by: "dispatch", dispatchIds: [attempts.at(-1)!.payload.dispatchId] });
        return read.status === "ready" && read.rows[0]?.policy.groupSettled === true;
      });
      await f.cell().settlePendingMaterialization("start-rejected worktree reclaim");

      const attempts = f.events().filter((event) => event.type === "runtime_dispatch_requested");
      assert.deepEqual(
        attempts.map((event) => event.payload.instanceId),
        ["review-first", "review-second", "review-third"],
      );
      const snapshotCwd = attempts[0]!.payload.cwd!;
      assert.equal(existsSync(snapshotCwd), false, "review checkout must be reclaimed after all backups reject start");

      const shown = await f.run({ kind: "task-show", taskId });
      assert.equal(shown.outcome, "applied", JSON.stringify(shown));
      const payload = JSON.parse(String(shown.evidence)) as {
        readonly completionBlocker: { readonly code: string; readonly gate: string } | null;
        readonly completionNext: { readonly action: string; readonly reason: string } | null;
      };
      assert.deepEqual(payload.completionBlocker, { code: "review_pending", gate: "review" });
      assert.equal(payload.completionNext?.action, `ha task dispatch-review ${taskId}`);
      assert.match(payload.completionNext?.reason ?? "", /spawn refused on review-third/u);
      assert.equal((payload.completionNext?.reason ?? "").includes("sk-secret-token-abcdef123456"), false);

      const agenda = await f.cell().read("repo.agenda.read", {}, owner);
      assert.match(agenda.summary, /spawn refused on review-third/u);
      assert.equal(agenda.summary.includes("sk-secret-token-abcdef123456"), false);
      assert.match(agenda.summary, new RegExp(`ha task dispatch-review ${taskId}`, "u"));
    } finally {
      await f.close();
    }
  },
);

test(
  "waiting_backoff review group stays in-flight across task show, agenda, and manual dispatch-review until successor runs",
  { timeout: 30_000 },
  async () => {
    let nowMs = Date.now() + 60_000;
    const f = await fixture(1, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "standard",
      submitCommit: true,
      guiDelivery: true,
      create: { presetId: "standard-task" },
      keycloakSession: async () => owner.keycloakAuthorization.session,
      providerMaxRetries: 0,
      providerRoundBackoffBaseSeconds: 60,
      now: () => new Date(nowMs).toISOString(),
    });
    try {
      await f.install(null);
      assert.equal((await f.submit()).outcome, "applied");
      await f.waitForLaunches(1);
      const firstDispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
      assert.ok(firstDispatch?.type === "runtime_dispatch_requested");
      await f.awaitOutcome(String(firstDispatch.payload.runtimeSessionId));

      const backoff = await f
        .cell()
        .readDispatchLifecycle({ by: "dispatch", dispatchIds: [firstDispatch.payload.dispatchId] });
      assert.equal(backoff.status, "ready");
      assert.equal(backoff.rows[0]?.groupPhase, "waiting_backoff");
      assert.equal(backoff.rows[0]?.policy.groupSettled, false);

      // 1. task show must report the in-flight group instead of prompting dispatch-review.
      const shown = await f.run({ kind: "task-show", taskId });
      assert.equal(shown.outcome, "applied", JSON.stringify(shown));
      const payload = JSON.parse(String(shown.evidence)) as {
        readonly completionNext: { readonly action: string; readonly reason: string } | null;
      };
      assert.equal(payload.completionNext?.action, `ha task dispatches ${taskId}`);
      assert.match(payload.completionNext?.reason ?? "", new RegExp(firstDispatch.payload.dispatchId, "u"));

      // 2. agenda must not place the cut into undispatched reviews.
      const agenda = await f.cell().read("repo.agenda.read", {}, owner);
      assert.equal(agenda.summary.includes("required review has no active dispatch"), false, agenda.summary);

      // 3. manual dispatch-review must not open a second concurrent review group.
      const manual = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
      assert.equal(manual.outcome, "applied", JSON.stringify(manual));
      const steps = (
        manual as unknown as {
          readonly dispatches: readonly { readonly outcome: string; readonly dispatchId?: string }[];
        }
      ).dispatches;
      assert.equal(steps[0]?.outcome, "already_dispatched", JSON.stringify(steps));
      assert.equal(steps[0]?.dispatchId, firstDispatch.payload.dispatchId);
      assert.equal(
        f.events().filter((event) => event.type === "runtime_dispatch_requested").length,
        1,
        "manual dispatch-review must not create a second group while waiting_backoff is active",
      );

      // 4. Advance controlled clock past backoff and reopen; automatic successor takes over cleanly.
      nowMs += 65_000;
      await f.reopen();
      await f.waitForLaunches(2);
      const attempts = f.events().filter((event) => event.type === "runtime_dispatch_requested");
      assert.equal(attempts.length, 2, JSON.stringify(attempts));
      const successor = attempts[1]!.payload;
      const reviewed = await f.reviewDispatchedArtifacts(
        String(successor.runtimeSessionId),
        String(successor.dispatchId),
      );
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      assert.equal(
        await f.settleReview(String(successor.dispatchId), String(successor.runtimeSessionId), "Successor review ok."),
        "succeeded",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "agenda and task show surface subsequent review failure after an earlier dismissed review on the same cut",
  { timeout: 30_000 },
  async () => {
    let failSubsequent = false;
    const f = await fixture(false, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "standard",
      submitCommit: true,
      guiDelivery: true,
      create: { presetId: "standard-task" },
      keycloakSession: async () => owner.keycloakAuthorization.session,
      providerMaxRetries: 0,
      providerRoundBackoffBaseSeconds: 0,
      rejectLaunch: (instanceId) =>
        failSubsequent
          ? Object.assign(new Error(`post-dismissal provider outage on ${instanceId}`), { code: "ENOENT" })
          : null,
    });
    try {
      await f.install(null);
      assert.equal((await f.submit()).outcome, "applied");
      await f.waitForLaunches(1);
      const firstDispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
      assert.ok(firstDispatch?.type === "runtime_dispatch_requested");
      const dismissed = await f.reviewDispatchedArtifacts(
        String(firstDispatch.payload.runtimeSessionId),
        String(firstDispatch.payload.dispatchId),
        executionId,
        "dismissed",
      );
      assert.equal(dismissed.outcome, "applied", JSON.stringify(dismissed));
      assert.equal(
        await f.settleReview(
          String(firstDispatch.payload.dispatchId),
          String(firstDispatch.payload.runtimeSessionId),
          "Dismissed review.",
        ),
        "succeeded",
      );

      failSubsequent = true;
      await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
      await waitForDurableCondition(async () => {
        const attempts = f.events().filter((event) => event.type === "runtime_dispatch_requested");
        if (attempts.length < 3) return false;
        const read = await f
          .cell()
          .readDispatchLifecycle({ by: "dispatch", dispatchIds: [attempts.at(-1)!.payload.dispatchId] });
        return read.status === "ready" && read.rows[0]?.policy.groupSettled === true;
      });
      await f.cell().settlePendingMaterialization("dismissed then failed review settlement");

      const shown = await f.run({ kind: "task-show", taskId });
      assert.equal(shown.outcome, "applied", JSON.stringify(shown));
      const payload = JSON.parse(String(shown.evidence)) as {
        readonly completionBlocker: { readonly code: string; readonly gate: string } | null;
        readonly completionNext: { readonly action: string; readonly reason: string } | null;
      };
      assert.deepEqual(payload.completionBlocker, { code: "review_pending", gate: "review" });
      assert.equal(payload.completionNext?.action, `ha task dispatch-review ${taskId}`);
      assert.match(payload.completionNext?.reason ?? "", /post-dismissal provider outage on review-second/u);

      const agenda = await f.cell().read("repo.agenda.read", {}, owner);
      const item = agenda.attentionItems.find(
        (entry) => entry.ref === `task/${taskId}` && entry.kind === "needs-handling",
      );
      assert.ok(
        item,
        `expected agenda attention item after dismissed + failed review: ${JSON.stringify(agenda.attentionItems)}`,
      );
      assert.match(agenda.summary, /post-dismissal provider outage on review-second/u);
      assert.match(agenda.summary, new RegExp(`ha task dispatch-review ${taskId}`, "u"));
    } finally {
      await f.close();
    }
  },
);
