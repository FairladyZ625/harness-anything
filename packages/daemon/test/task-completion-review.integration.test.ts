// harness-test-tier: integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AgentDefinitionSnapshot } from "../../kernel/src/index.ts";
import { waitForFixturePublication } from "./repo-settings.fixture.ts";
import { executionId, fixture, owner, taskId } from "./task-completion-review.fixture.ts";
import type { RuntimeInstanceSummary } from "../src/agent-runtime-instances.ts";
import { readDispatchStream, readDispatchStreamHeaders } from "../src/dispatch-stream.ts";
import { binding as transportBinding } from "../src/daemon-host-binding.ts";
import { openFleetEdgeRuntime } from "../src/fleet-edge-runtime.ts";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { listenFleetTls, type FleetAssignmentRecord, type FleetCenterOptions } from "../src/fleet/center.ts";
import { runFleetReplicaPullClient, runFleetTaskCommandClient } from "../src/fleet/edge.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";

test(
  "submit freezes the installed reviewer into the cut, reuses the cut dispatch after resubmit/reopen, and requires later owner consent",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, { autoSubmit: false });
    try {
      await f.install();
      const submitted = await f.submit();
      assert.equal(f.launches.length, 1, "canonical submit dispatches the frozen reviewer once");
      assert.equal(f.launches[0]!.instanceId, "review-first");
      const dispatchStep = (
        ((submitted as Record<string, unknown>).steps as Record<string, unknown>[] | undefined) ?? []
      ).find((step) => typeof step.dispatchId === "string");
      assert.ok(dispatchStep, `submit receipt must carry the review dispatch: ${JSON.stringify(submitted)}`);
      assert.equal(typeof dispatchStep.runtimeSessionId, "string");
      // The reviewer declaration is frozen into the cut: a later settings change cannot redirect it.
      const configured = await f.runPrincipal({ kind: "settings-update", defaultReviewer: "selected-reviewer" });
      assert.equal(configured.outcome, "applied", JSON.stringify(configured));
      const resumed = await f.run({ kind: "task-submit", taskId, executionId });
      assert.notEqual(resumed.outcome, "op_rejected", JSON.stringify(resumed));
      assert.equal(f.launches.length, 1, "the same cut never spawns a second reviewer");
      const first = (await f.complete(true)) as Record<string, unknown>;
      assert.equal(first.code, "review_missing", JSON.stringify(first));
      assert.equal(f.launches.length, 1);
      assert.equal(f.launches[0]!.instanceId, "review-first");
      assert.equal(f.events().filter((event) => event.type === "review_consent_recorded").length, 0);
      assert.match(f.launches[0]!.prompt, /RecordReview/u);
      assert.match(f.launches[0]!.prompt, new RegExp(`artifacts/reports/${String(first.dispatchId)}`));
      // Provider has not exited: this independent queue write must nevertheless finish.
      const write = await f.run({
        kind: "fact-record",
        taskId,
        statement: "Queue accepts writes while reviewer runs.",
        evidenceSource: "test:pending-reviewer",
        confidence: "high",
        memoryClass: "episodic",
        memoryTags: [],
      });
      assert.equal(write.outcome, "applied", JSON.stringify(write));
      const retry = (await f.complete()) as Record<string, unknown>;
      assert.equal(retry.dispatchId, first.dispatchId);
      assert.equal(f.launches.length, 1);
      await f.reopen();
      const recovered = (await f.complete()) as Record<string, unknown>;
      assert.equal(recovered.dispatchId, first.dispatchId);
      assert.equal(recovered.runtimeSessionId, first.runtimeSessionId);
      assert.equal(f.launches.length, 1);
      assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 1);
      const reviewed = await f.review(String(first.runtimeSessionId), "review-current");
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      const additional = await f.review(String(first.runtimeSessionId), "review-additional");
      assert.equal(additional.outcome, "applied", JSON.stringify(additional));
      const noConsent = await f.complete();
      assert.equal(noConsent.code, "consent_missing", JSON.stringify(noConsent));
      assert.equal(f.events().filter((event) => event.type === "review_consent_recorded").length, 0);
      const completed = await f.complete(true);
      assert.equal(completed.outcome, "applied", JSON.stringify(completed));
      assert.equal(f.events().filter((event) => event.type === "review_consent_recorded").length, 1);
      const consent = f.events().find((event) => event.type === "review_consent_recorded");
      assert.ok(consent?.type === "review_consent_recorded");
      assert.equal(consent.payload.consent.reviewId, "review-additional");
      assert.equal(f.events().filter((event) => event.type === "task_completed").length, 1);
    } finally {
      await f.close();
    }
  },
);

test("completion dispatches the bundled reviewer with no installed declaration and accepts its review", async () => {
  const f = await fixture();
  try {
    const result = (await f.complete()) as Record<string, unknown>;
    assert.equal(result.code, "review_missing", JSON.stringify(result));
    assert.equal(f.launches.length, 1);
    assert.equal(f.launches[0]!.instanceId, "ambient-first");
    assert.equal(f.launches[0]!.model, "flash-model");
    assert.match(f.launches[0]!.prompt, /Independently review the submitted execution/u);
    const reviewed = await f.review(String(result.runtimeSessionId), "review-bundled");
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const completed = await f.complete(true);
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
  } finally {
    await f.close();
  }
});

test("review execution publishes its dispatch-specific report and input in the review event", async () => {
  const f = await fixture();
  try {
    const dispatched = (await f.complete()) as Record<string, unknown>,
      dispatchId = String(dispatched.dispatchId),
      reviewed = await f.reviewDispatchedArtifacts(String(dispatched.runtimeSessionId), dispatchId);
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    await waitForFixturePublication(f.cell(), reviewed.opId, owner);
    const event = f
      .events()
      .find(
        (candidate) =>
          candidate.type === "review_recorded" && candidate.payload.review.reviewId === `review-${dispatchId}`,
      );
    assert.ok(event?.type === "review_recorded");
    assert.deepEqual(
      event.payload.carriedDocumentClaims?.map(({ path: candidate }) => candidate),
      [`${f.packagePath}/artifacts/reports/${dispatchId}.json`, `${f.packagePath}/artifacts/reports/${dispatchId}.md`],
    );
    assert.equal(f.harnessStatus(), "");
  } finally {
    await f.close();
  }
});

test("completion reviewer settlement keeps the report the reviewer authored at the dispatch report path", async () => {
  const f = await fixture();
  try {
    const result = (await f.complete()) as Record<string, unknown>;
    assert.equal(result.code, "review_missing", JSON.stringify(result));
    const dispatchId = String(result.dispatchId),
      authored = "# Closeout review\n\n- verdict: `approved`\n\nThe authored report, not the final message.\n";
    assert.equal(
      await f.settleReview(
        dispatchId,
        String(result.runtimeSessionId),
        "Independent review registered; report written to the dispatch report path.",
        authored,
      ),
      "succeeded",
    );
    assert.equal(readFileSync(f.reportPath(dispatchId), "utf8"), authored);
  } finally {
    await f.close();
  }
});

test("completion reviewer settlement archives the final message when no report was authored", async () => {
  const f = await fixture();
  try {
    const result = (await f.complete()) as Record<string, unknown>;
    assert.equal(result.code, "review_missing", JSON.stringify(result));
    assert.equal(
      await f.settleReview(
        String(result.dispatchId),
        String(result.runtimeSessionId),
        "# Independent review\n\nApproved.\n",
      ),
      "succeeded",
    );
  } finally {
    await f.close();
  }
});

test("bundled reviewer without a ready instance returns configuration guidance", async () => {
  const f = await fixture(false, false, false, true);
  try {
    f.disableInstances();
    const result = await f.complete();
    assert.equal(result.code, "review_missing", JSON.stringify(result));
    assert.match(JSON.stringify((result as Record<string, unknown>).next), /configured default model/u);
    assert.deepEqual(result.diagnostic, { kind: "failure", code: "agent_runtime_unavailable" });
    assert.equal(f.launches.length, 0);
  } finally {
    await f.close();
  }
});

test("completion requires a declared reviewer model instead of selecting the ambient default", async () => {
  const f = await fixture(false, true, false, false, false, undefined, { autoSubmit: false });
  try {
    // Omit model entirely, as in an unconstrained runtimes=[] declaration.
    const installed = await f.run({
      kind: "agent-install",
      declaration: {
        schema: "agent-declaration/v1",
        id: "closeout-reviewer",
        name: "Unconstrained reviewer",
        instructions: "Review the submitted delivery.",
        runtimes: [],
        instance: "ambient-first",
      },
    });
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    const submitted = await f.submit();
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.equal(f.launches.length, 0, "an unconfigured reviewer must not launch the ambient model at submit");
    const result = await f.complete();
    assert.equal(result.code, "review_missing", JSON.stringify(result));
    assert.match(JSON.stringify((result as Record<string, unknown>).next), /model/u);
    assert.equal(f.launches.length, 0, "an unconfigured reviewer must not launch the ambient model");
  } finally {
    await f.close();
  }
});

test(
  "a pre-runtimes stored reviewer stops the review gate with the reinstall command, and reinstalling recovers",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, { autoSubmit: false, legacyReviewer: true });
    try {
      // The window: this cell opened over a ledger already holding an old-shape (runtime_type +
      // top-level model) reviewer declaration; submit still records the cut.
      const submitted = await f.submit();
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      assert.equal(f.launches.length, 0, "a schema-invalid stored reviewer must not launch");
      const stopped = (await f.complete()) as Record<string, unknown>;
      assert.equal(stopped.code, "review_missing", JSON.stringify(stopped));
      const guidance = JSON.stringify(stopped.next);
      assert.match(guidance, /ha agent install --source harness\/agents\/closeout-reviewer\.json/u);
      assert.match(guidance, /runtime_type|agent-declaration\/v1/u, JSON.stringify(stopped));
      assert.equal(f.launches.length, 0);
      // Reinstalling the same identity with the current shape is not locked out by the stored
      // legacy row, and the review gate dispatches the recovered reviewer.
      await f.install();
      const dispatched = (await f.complete()) as Record<string, unknown>;
      assert.equal(typeof dispatched.dispatchId, "string", JSON.stringify(dispatched));
      assert.equal(f.launches.length, 1, "the reinstalled reviewer dispatches");
      const reviewed = await f.review(String(dispatched.runtimeSessionId), "review-recovered");
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      const completed = await f.complete(true);
      assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    } finally {
      await f.close();
    }
  },
);

test(
  "an amended submitted cut rejects the old canonical reviewer and dispatches a fresh reviewer",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    try {
      await f.install();
      const first = (await f.complete()) as Record<string, unknown>;
      assert.equal(first.code, "review_missing", JSON.stringify(first));
      const approved = await f.review(String(first.runtimeSessionId), "review-old-cut");
      assert.equal(approved.outcome, "applied", JSON.stringify(approved));
      const closeoutPath = path.join(f.root, "harness", f.packagePath, "closeout.md");
      writeFileSync(
        closeoutPath,
        readFileSync(closeoutPath, "utf8").replace("Reviewed delivery ", "Amended reviewed delivery "),
      );
      let amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
      for (let attempt = 0; amended.outcome === "pending" && attempt < 4; attempt += 1) {
        await waitForFixturePublication(f.cell(), amended.opId, owner);
        amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
      }
      assert.equal(amended.outcome, "applied", JSON.stringify(amended));
      const second = (await f.complete(true)) as Record<string, unknown>;
      assert.equal(second.code, "review_missing", JSON.stringify(second));
      assert.notEqual(second.dispatchId, first.dispatchId);
      assert.equal(f.launches.length, 2);
      assert.equal(f.events().filter((event) => event.type === "review_recorded").length, 1);
      assert.equal(f.events().filter((event) => event.type === "review_consent_recorded").length, 0);
    } finally {
      await f.close();
    }
  },
);
test("completion with an unavailable declared model returns guidance without launching an ambient instance", async () => {
  const f = await fixture(false, true, false, false, false, undefined, { autoSubmit: false });
  try {
    await f.install();
    f.disableInstances();
    const submitted = await f.submit();
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const result = await f.complete();
    assert.equal(result.code, "review_missing", JSON.stringify(result));
    assert.match(JSON.stringify((result as Record<string, unknown>).next), /ready runtime instance matching/u);
    assert.deepEqual(result.diagnostic, { kind: "failure", code: "agent_model_unavailable" });
    assert.match(result.rejectionExplanation ?? "", /No enabled runtime instance declares model review-model/u);
    assert.equal(f.launches.length, 0);
    assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 0);
  } finally {
    await f.close();
  }
});

test(
  "artifact delivery reaches the same independent review and completion after reopening",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, true);
    try {
      await f.install();
      await f.reopen();
      const artifactPath = path.join(f.root, "harness", f.packagePath, "artifacts/delivery.md");
      writeFileSync(artifactPath, "Latest replacement must not be reviewed.\n");
      const republished = await f.run({ kind: "doc-submit", taskId });
      if (republished.outcome === "pending") await waitForFixturePublication(f.cell(), republished.opId, owner);
      else assert.equal(republished.outcome, "applied", JSON.stringify(republished));
      const dispatched = await f.complete();
      assert.equal(dispatched.code, "review_missing", JSON.stringify(dispatched));
      assert.equal(f.launches.length, 1);
      assert.match(f.launches[0]!.prompt, /Frozen artifact evidence/u);
      assert.match(f.launches[0]!.prompt, /Effective completion gates: none/u);
      const submitted = f
        .events()
        .filter((event) => event.type === "execution_submitted")
        .at(-1);
      assert.ok(submitted?.type === "execution_submitted" && submitted.payload.execution.submission);
      assert.equal(submitted.payload.execution.submission.commitSha, null);
      assert.deepEqual(submitted.payload.execution.submission.deliverables, [`${f.packagePath}/artifacts/delivery.md`]);
      assert.match(f.launches[0]!.prompt, /Declared gates not applicable.*code-doc-reconciliation/u);
      assert.doesNotMatch(f.launches[0]!.prompt, /Honor every gate declared by the task/u);
      assert.doesNotMatch(f.launches[0]!.prompt, /Latest replacement must not be reviewed/u);
      const submittedShow = JSON.parse(String((await f.run({ kind: "task-show", taskId })).evidence)) as {
        task: { completionGateIds: string[] };
      };
      assert.deepEqual(submittedShow.task.completionGateIds, []);
      const session = String((dispatched as unknown as Record<string, unknown>).runtimeSessionId);
      const reviewed = await f.review(session, "artifact-reviewed");
      if (reviewed.outcome === "pending") await waitForFixturePublication(f.cell(), reviewed.opId, owner);
      else assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      const complete = await f.complete(true);
      assert.equal(complete.outcome, "applied", JSON.stringify(complete));
      const final = f
        .events()
        .filter((event) => event.type === "task_completed")
        .at(-1);
      assert.equal(final?.payload.task.status, "done");
      await f.reopen();
      const shown = await f.run({ kind: "task-show", taskId });
      assert.equal(JSON.parse(String(shown.evidence)).task.status, "done");
    } finally {
      await f.close();
    }
  },
);

test(
  "commit delivery with an artifact anchor carries both the commit and frozen report through review",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, true);
    try {
      await f.install();
      const dispatched = (await f.complete()) as Record<string, unknown>;
      assert.equal(dispatched.code, "review_missing", JSON.stringify(dispatched));
      assert.equal(f.launches.length, 1);
      const submitted = f
        .events()
        .filter((event) => event.type === "execution_submitted")
        .at(-1);
      assert.ok(submitted?.type === "execution_submitted" && submitted.payload.execution.submission);
      const submission = submitted.payload.execution.submission;
      assert.match(submission.commitSha!, /^[0-9a-f]{40}$/u);
      assert.ok(submission.deliverables.includes("README.md"));
      assert.equal(submission.artifacts?.length, 1);
      assert.match(submission.outputs[0]!, /^Artifact-Anchor: .*hybrid\.md@[1-9][0-9]*$/u);
      assert.match(f.launches[0]!.prompt, /Frozen hybrid evidence/u);
      assert.match(f.launches[0]!.prompt, /Effective completion gates: code-doc-reconciliation/u);
      const shown = JSON.parse(String((await f.run({ kind: "task-show", taskId })).evidence)) as {
        task: { completionGateIds: string[] };
      };
      assert.deepEqual(shown.task.completionGateIds, ["code-doc-reconciliation"]);
      const reviewed = await f.review(String(dispatched.runtimeSessionId), "hybrid-reviewed");
      if (reviewed.outcome === "pending") await waitForFixturePublication(f.cell(), reviewed.opId, owner);
      else assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      const completed = await f.complete(true);
      assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    } finally {
      await f.close();
    }
  },
);

test(
  "completion provider fallback keeps reviewer role; each exhausted attempt is replaced by the next complete",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(true, true, false, false, false, undefined, { autoSubmit: false });
    try {
      await f.install();
      // Keep the first attempt inside the first complete: submit while no compatible instance is
      // enabled so the submit-time dispatch fails without recording an attempt, then re-enable.
      f.disableInstances();
      await f.submit();
      f.enableInstances();
      const first = (await f.complete()) as Record<string, unknown>;
      assert.equal(first.code, "review_missing", JSON.stringify(first));
      const exhaustedCount = () =>
        readDispatchStreamHeaders(f.root).filter(
          (header) => readDispatchStream(f.root, header.dispatchId)?.fallbackState === "exhausted",
        ).length;
      for (let attempt = 0; attempt < 500 && exhaustedCount() < 1; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(exhaustedCount(), 1, "fallback must durably settle exhaustion");
      assert.equal(f.launches.length, 2);
      const second = (await f.complete()) as Record<string, unknown>;
      assert.equal(second.code, "review_missing", JSON.stringify(second));
      assert.notEqual(second.dispatchId, first.dispatchId);
      for (let attempt = 0; attempt < 500 && exhaustedCount() < 2; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(exhaustedCount(), 2, "the replacement attempt must also settle its fallback chain");
      assert.equal(f.launches.length, 4);
      const dispatches = f.events().filter((event) => event.type === "runtime_dispatch_requested");
      assert.equal(dispatches.length, 4);
      assert.deepEqual(
        readDispatchStreamHeaders(f.root).map((header) => header.role),
        ["reviewer", "reviewer", "reviewer", "reviewer"],
      );
      assert.equal(dispatches.filter((event) => !event.payload.idempotencyKey.includes(":fallback:")).length, 2);
      assert.equal(f.events().filter((event) => event.type === "review_recorded").length, 0);
      assert.equal(f.events().filter((event) => event.type === "review_consent_recorded").length, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "a live fallback continuation still owns the cut; only full exhaustion lets complete re-dispatch",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(1, true, false, false, false, undefined, { autoSubmit: false });
    try {
      await f.install();
      // Keep the first attempt inside the first complete: submit while no compatible instance is
      // enabled so the submit-time dispatch fails without recording an attempt, then re-enable.
      f.disableInstances();
      await f.submit();
      f.enableInstances();
      const first = (await f.complete()) as Record<string, unknown>;
      assert.equal(first.code, "review_missing", JSON.stringify(first));
      // The root attempt failed; its fallback continuation launched and is still live.
      await f.waitForLaunches(2);
      const during = (await f.complete()) as Record<string, unknown>;
      assert.equal(during.code, "review_missing", JSON.stringify(during));
      assert.equal(f.launches.length, 2, "a live continuation must keep owning the cut");
      assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 2);
      f.failPending();
      const exhausted = () =>
        readDispatchStreamHeaders(f.root).some(
          (header) => readDispatchStream(f.root, header.dispatchId)?.fallbackState === "exhausted",
        );
      for (let attempt = 0; attempt < 500 && !exhausted(); attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(exhausted(), true, "the continuation chain must settle exhaustion");
      const second = (await f.complete()) as Record<string, unknown>;
      assert.equal(second.code, "review_missing", JSON.stringify(second));
      assert.notEqual(second.dispatchId, first.dispatchId);
      assert.equal(f.launches.length, 3);
      assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 3);
      // The replacement stays pending (failure budget spent): completion is idempotent against it.
      const stable = (await f.complete()) as Record<string, unknown>;
      assert.equal(stable.dispatchId, second.dispatchId);
      assert.equal(f.launches.length, 3);
    } finally {
      await f.close();
    }
  },
);

test(
  "fleet TLS completions share one reviewer dispatch per attempt, including the exhausted retry",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(1, true, false, false, false, undefined, { autoSubmit: false });
    let center: Awaited<ReturnType<typeof listenFleetTls>> | undefined;
    try {
      await f.install();
      // Keep the first attempt inside the first fleet completion: submit while no compatible
      // instance is enabled so the submit-time dispatch fails without recording an attempt.
      f.disableInstances();
      await f.submit();
      f.enableInstances();
      const keyFile = path.join(f.root, "tls.key"),
        certFile = path.join(f.root, "tls.crt");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyFile,
          "-out",
          certFile,
          "-subj",
          "/CN=localhost",
          "-days",
          "1",
          "-addext",
          "subjectAltName=DNS:localhost",
        ],
        { stdio: "ignore" },
      );
      const cert = readFileSync(certFile),
        writerEpochStateRoot = path.join(f.root, ".harness", "fixture-writer-epochs"),
        authority = openPersistentWriterEpoch({ stateRoot: writerEpochStateRoot });
      const lease = authority.current("completion-review");
      authority.close();
      assert.ok(lease);
      const assignments: FleetAssignmentRecord[] = ["edge-one", "edge-two"].map((nodeId) => ({
        nodeId,
        assignmentId: `assignment-${nodeId}`,
        repoId: "completion-review",
        viewId: `view-${nodeId}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
        actor: owner.actor,
        scope: { kind: "task", taskId, executionId, paths: [f.packagePath] },
      }));
      const host: FleetCenterOptions["host"] = {
        run: async (repoId, action, auth) => {
          assert.equal(repoId, "completion-review");
          return f.cell().run(action, await transportBinding(f.root, auth));
        },
        read: async () => {
          throw new Error("Unexpected read route");
        },
        runtimeIngress: async () => {
          throw new Error("Unexpected runtime ingress route");
        },
        replica: () => f.cell().replica,
        settleMaterialization: async (_repoId, context) => f.cell().settlePendingMaterialization(context),
        status: () => ({ repos: [f.cell().status()] }) as ReturnType<FleetCenterOptions["host"]["status"]>,
      };
      center = await listenFleetTls({
        host,
        stateRoot: path.join(f.root, "fleet-center"),
        writerEpochStateRoot,
        writerEpochLease: () => lease,
        key: readFileSync(keyFile),
        cert,
        authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
        resolveAssignment: (id) => assignments.find((assignment) => assignment.assignmentId === id) ?? null,
      });
      const results = await Promise.all(
        assignments.map((assignment) =>
          runFleetTaskCommandClient({
            port: center!.port,
            ca: cert,
            servername: "localhost",
            nodeId: assignment.nodeId,
            credential: `secret-${assignment.nodeId}`,
            assignmentId: assignment.assignmentId,
            opId: randomUUID(),
            repoId: assignment.repoId,
            taskId,
            action: { kind: "task-complete", taskId, executionId },
            waitMs: 5_000,
          }),
        ),
      );
      for (const result of results) assert.equal(result.code, "review_missing", JSON.stringify(result));
      assert.equal(results[0]!.receipt?.dispatchId, results[1]!.receipt?.dispatchId);
      assert.equal(typeof results[0]!.receipt?.dispatchId, "string");
      // The root attempt failed its one provider; its fallback continuation is live.
      await f.waitForLaunches(2);
      assert.equal(f.launches.length, 2);
      assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 2);
      // Once the whole attempt chain is exhausted, concurrent completions still share one replacement.
      f.failPending();
      const exhausted = () =>
        readDispatchStreamHeaders(f.root).some(
          (header) => readDispatchStream(f.root, header.dispatchId)?.fallbackState === "exhausted",
        );
      for (let attempt = 0; attempt < 500 && !exhausted(); attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(exhausted(), true, "the first attempt chain must settle exhaustion");
      const retried = await Promise.all(
        assignments.map((assignment) =>
          runFleetTaskCommandClient({
            port: center!.port,
            ca: cert,
            servername: "localhost",
            nodeId: assignment.nodeId,
            credential: `secret-${assignment.nodeId}`,
            assignmentId: assignment.assignmentId,
            opId: randomUUID(),
            repoId: assignment.repoId,
            taskId,
            action: { kind: "task-complete", taskId, executionId },
            waitMs: 5_000,
          }),
        ),
      );
      for (const result of retried) assert.equal(result.code, "review_missing", JSON.stringify(result));
      assert.equal(retried[0]!.receipt?.dispatchId, retried[1]!.receipt?.dispatchId);
      assert.notEqual(retried[0]!.receipt?.dispatchId, results[0]!.receipt?.dispatchId);
      assert.equal(f.launches.length, 3);
      assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 3);
      assert.equal(
        f
          .events()
          .filter(
            (event) =>
              event.type === "runtime_dispatch_requested" && !event.payload.idempotencyKey.includes(":fallback:"),
          ).length,
        2,
      );
    } finally {
      await center?.close();
      await f.close();
    }
  },
);

test(
  "remote reviewer admission uses the latest center cut before any edge provider starts",
  { timeout: 60_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, 1, { autoSubmit: false });
    let center: Awaited<ReturnType<typeof listenFleetTls>> | undefined;
    const edgeRuntimes: Array<ReturnType<typeof openFleetEdgeRuntime>> = [];
    try {
      await f.install();
      const keyFile = path.join(f.root, "remote-review-tls.key"),
        certFile = path.join(f.root, "remote-review-tls.crt");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyFile,
          "-out",
          certFile,
          "-subj",
          "/CN=localhost",
          "-days",
          "1",
          "-addext",
          "subjectAltName=DNS:localhost",
        ],
        { stdio: "ignore" },
      );
      const cert = readFileSync(certFile),
        writerEpochStateRoot = path.join(f.root, ".harness", "fixture-writer-epochs"),
        authority = openPersistentWriterEpoch({ stateRoot: writerEpochStateRoot });
      const lease = authority.current("completion-review");
      authority.close();
      assert.ok(lease);
      let assignedExecutionId = executionId;
      const assignment = (nodeId: string): FleetAssignmentRecord => ({
          nodeId,
          assignmentId: `assignment-${nodeId}`,
          repoId: "completion-review",
          viewId: "remote-review-view",
          expiresAt: "2099-01-01T00:00:00.000Z",
          actor: owner.actor,
          scope: { kind: "task", taskId, executionId: assignedExecutionId, paths: [f.packagePath] },
        }),
        host: FleetCenterOptions["host"] = {
          run: async (repoId, action, auth) => {
            assert.equal(repoId, "completion-review");
            return f.cell().run(action, await transportBinding(f.root, auth));
          },
          read: async (repoId, method, payload, auth) => {
            assert.equal(repoId, "completion-review");
            if (method === "repo.agentRuntime.overview") {
              const cut = f.cell().status();
              return {
                ok: true,
                status: "ready",
                installations: [],
                instances: [],
                sessions: [],
                page: {
                  limit: Number(payload.limit),
                  cursor: null,
                  nextCursor: null,
                  remainingCount: 0,
                },
                watermark: cut.projectionWatermark ?? 0,
                sourceRevision: cut.ledgerRevision ?? 0,
              } as never;
            }
            return f.cell().read(method, payload, await transportBinding(f.root, auth));
          },
          runtimeIngress: async (repoId, action, auth) => {
            assert.equal(repoId, "completion-review");
            return f.cell().runtimeIngress(action, await transportBinding(f.root, auth));
          },
          replica: () => f.cell().replica,
          settleMaterialization: async (_repoId, context) => f.cell().settlePendingMaterialization(context),
          status: () => ({ repos: [f.cell().status()] }) as ReturnType<FleetCenterOptions["host"]["status"]>,
        };
      center = await listenFleetTls({
        host,
        stateRoot: path.join(f.root, "remote-review-center"),
        writerEpochStateRoot,
        writerEpochLease: () => lease,
        key: readFileSync(keyFile),
        cert,
        replicaDiskQuotaBytes: 64 * 1024 * 1024,
        authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
        resolveAssignment: (id) => {
          const nodeId = id.startsWith("assignment-") ? id.slice("assignment-".length) : "";
          return nodeId ? assignment(nodeId) : null;
        },
      });
      const viewRoot = path.join(f.root, "remote-review-view");
      await f.cell().settlePendingMaterialization("prepare remote reviewer mirror");
      const pulled = await runFleetReplicaPullClient({
        port: center.port,
        ca: cert,
        servername: "localhost",
        nodeId: "edge-one",
        credential: "secret-edge-one",
        assignmentId: "assignment-edge-one",
        viewRoot,
        diskQuotaBytes: 64 * 1024 * 1024,
      });
      const installation = {
          installationId: "remote-review-installation",
          kindId: "codex" as const,
          executablePath: "/usr/bin/true",
          version: "1.0.0",
          observedAt: "2026-09-17T00:00:00.000Z",
        },
        definition: AgentDefinitionSnapshot = {
          schema: "agent-definition-snapshot/v1",
          configVersion: 1,
          instanceId: "remote-review-instance",
          installationId: installation.installationId,
          kindId: installation.kindId,
          providerId: "openai",
          model: "review-model",
          reasoningEffort: null,
          baseUrl: null,
          authMode: "subscription",
        },
        instance = {
          schemaVersion: 2,
          instanceId: definition.instanceId,
          name: "Remote Reviewer",
          kindId: definition.kindId,
          installationId: definition.installationId,
          providerId: definition.providerId,
          models: [definition.model],
          defaultModel: definition.model,
          enabled: true,
          permissionMode: "read-only",
          codex: {
            reasoningEffort: null,
            fast: false,
            baseUrl: null,
            baseUrlConfigured: false,
            wire_api: null,
            requires_openai_auth: null,
            http_headers: null,
          },
          authMode: "subscription",
          authState: "configured",
          authReadiness: { status: "ready", code: null, hint: null },
          isolationState: "enforced",
        } satisfies RuntimeInstanceSummary;
      let prepareBarrier: (() => Promise<void>) | undefined;
      const openEdge = (nodeId: string, launched: string[]) => {
        const edgeRoot = path.join(f.root, nodeId),
          edgeViewRoot = path.join(f.root, `${nodeId}-view`);
        // Each edge owns its replica and materialization marker, including on replay.
        cpSync(viewRoot, edgeViewRoot, { recursive: true });
        mkdirSync(path.join(edgeRoot, "harness"), { recursive: true });
        execFileSync("git", ["-C", edgeRoot, "init", "-q"]);
        execFileSync("git", ["-C", edgeRoot, "config", "user.name", "Remote Review Test"]);
        execFileSync("git", ["-C", edgeRoot, "config", "user.email", "review@example.invalid"]);
        writeFileSync(
          path.join(edgeRoot, "harness/harness.yaml"),
          readFileSync(path.join(f.root, "harness/harness.yaml"), "utf8"),
        );
        execFileSync("git", ["-C", edgeRoot, "add", "harness"]);
        execFileSync("git", ["-C", edgeRoot, "commit", "-qm", "test: edge root"]);
        assert.equal(
          applyFleetMirrorCut(edgeViewRoot, "completion-review", edgeRoot, "pull", {
            viewId: pulled.replica.viewId,
          }).outcome,
          "applied",
        );
        assert.match(
          readFileSync(path.join(edgeRoot, "harness", f.packagePath, "INDEX.md"), "utf8"),
          new RegExp(`task_id: ${taskId}|taskId: ${taskId}`, "u"),
        );
        const runtime = openFleetEdgeRuntime({
          request: {
            host: "127.0.0.1",
            port: center!.port,
            caPath: certFile,
            servername: "localhost",
            nodeId,
            credential: `secret-${nodeId}`,
            assignmentId: `assignment-${nodeId}`,
            repoId: "completion-review",
            viewRoot: edgeViewRoot,
            quotaBytes: 64 * 1024 * 1024,
            workspaceRoot: edgeRoot,
            method: "repo.agentRuntime.spawn",
            action: {},
          },
          daemonGeneration: 1,
          daemonRoute: {
            userRoot: path.join(f.root, `${nodeId}-user`),
            daemonId: nodeId,
            endpoint: path.join(f.root, `${nodeId}.sock`),
          },
          ports: {
            runtimeInstances: () => [instance],
            prepareRuntimeLaunch: async (_instanceId, request) => {
              await prepareBarrier?.();
              return {
                definition,
                installation,
                executablePath: installation.executablePath,
                args: request.providerSessionId ? ["resume", request.providerSessionId] : ["exec", "--json", "-"],
                env: {},
                cwd: request.cwd,
                prompt: request.prompt,
              };
            },
            prepareWorkerGitEnvironment: async () => null,
          },
          launch: (prepared) => {
            launched.push(nodeId);
            return {
              pid: 80_000 + launched.length,
              onOutput: (listener) => {
                if (prepared.args[0] === "resume")
                  queueMicrotask(() =>
                    listener(JSON.stringify({ type: "thread.started", thread_id: prepared.args[1] }) + "\n"),
                  );
              },
              onErrorOutput: () => undefined,
              onExit: () => undefined,
              terminate: () => undefined,
            };
          },
        });
        edgeRuntimes.push(runtime);
        return runtime;
      };
      const edgeOneLaunches: string[] = [],
        edgeOne = openEdge("edge-one", edgeOneLaunches),
        spawnReviewer = (
          runtime: ReturnType<typeof openFleetEdgeRuntime>,
          idempotencyKey: string,
          providerSessionId?: string,
        ) =>
          runtime.run("repo.agentRuntime.spawn", {
            runtimeInstanceId: definition.instanceId,
            role: "reviewer",
            taskId,
            cwd: { scope: "repo-root" },
            prompt: "Review the current submitted cut.",
            idempotencyKey,
            ...(providerSessionId === undefined ? {} : { providerSessionId }),
          });
      await assert.rejects(spawnReviewer(edgeOne, "remote-review-unsubmitted"), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "task_not_submitted");
        return true;
      });
      assert.equal(edgeOneLaunches.length, 0, "an unsubmitted task must not start an edge provider");
      assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 0);

      const submitted = await f.submit();
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      const first = (await f.complete()) as Record<string, unknown>,
        packet = `${f.packagePath}/artifacts/reports/remote-return.json`;
      mkdirSync(path.dirname(path.join(f.root, "harness", packet)), { recursive: true });
      writeFileSync(
        path.join(f.root, "harness", packet),
        JSON.stringify({
          verdict: "changes_requested",
          reason: "Exercise the next review iteration.",
          evidenceChecked: ["closeout.md"],
        }),
      );
      const returned = await f.cell().run(
        {
          kind: "task-review-execution",
          taskId,
          executionId,
          reviewId: "remote-return",
          fromFile: `harness/${packet}`,
        },
        {
          actor: {
            principal: owner.actor.principal,
            executor: { kind: "agent", id: `runtime-session:${String(first.runtimeSessionId)}` },
          },
          source: "local",
        },
      );
      assert.equal(returned.outcome, "applied", JSON.stringify(returned));
      assignedExecutionId = "execution-remote-review-two";
      assert.equal((await f.run({ kind: "task-start", taskId, executionId: assignedExecutionId })).outcome, "applied");
      assert.equal((await f.run({ kind: "task-submit", taskId, executionId: assignedExecutionId })).outcome, "applied");
      const dispatchesBeforeSpentProbe = f
        .events()
        .filter((event) => event.type === "runtime_dispatch_requested").length;
      await assert.rejects(spawnReviewer(edgeOne, "remote-review-spent"), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "review_return_budget_exhausted");
        return true;
      });
      await assert.rejects(
        spawnReviewer(edgeOne, "remote-review-spent-resume", "remote-existing-provider"),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "review_return_budget_exhausted");
          return true;
        },
      );
      assert.equal(edgeOneLaunches.length, 0, "a spent center budget must not start an edge provider");
      assert.equal(
        f.events().filter((event) => event.type === "runtime_dispatch_requested").length,
        dispatchesBeforeSpentProbe,
        "a spent center budget must not append a dispatch",
      );

      assert.equal(
        (
          await f.run({
            kind: "task-amend",
            taskId,
            patches: [{ field: "reviewReturnBudget", value: "2" }],
          })
        ).outcome,
        "applied",
      );
      const admitted = await spawnReviewer(edgeOne, "remote-review-admitted");
      assert.equal(admitted.outcome, "applied", JSON.stringify(admitted));
      assert.equal(edgeOneLaunches.length, 1, "the latest center budget admits the stale-mirror edge");
      const edgeTwoLaunches: string[] = [],
        edgeTwo = openEdge("edge-two", edgeTwoLaunches);
      let arrivals = 0,
        release!: () => void;
      const bothPrepared = new Promise<void>((resolve) => {
        release = resolve;
      });
      prepareBarrier = async () => {
        if (++arrivals === 2) release();
        await bothPrepared;
      };
      // Both edges already observed no existing op before either can ask the center to claim it.
      const concurrent = await Promise.all([
        spawnReviewer(edgeOne, "remote-review-race"),
        spawnReviewer(edgeTwo, "remote-review-race"),
      ]);
      prepareBarrier = undefined;
      assert.equal(concurrent[0]!.runtimeSessionId, concurrent[1]!.runtimeSessionId);
      assert.equal(edgeOneLaunches.length + edgeTwoLaunches.length, 2, "only one edge wins a new attempt");
      assert.equal(
        (
          await f.run({
            kind: "task-amend",
            taskId,
            patches: [{ field: "reviewReturnBudget", value: "1" }],
          })
        ).outcome,
        "applied",
      );
      const launchesBeforeReplay = edgeTwoLaunches.length,
        replay = await spawnReviewer(edgeTwo, "remote-review-admitted");
      assert.equal(replay.runtimeSessionId, admitted.runtimeSessionId);
      assert.equal(edgeTwoLaunches.length, launchesBeforeReplay, "the second edge reuses the center claim");
      assert.equal(
        f.events().filter((event) => event.type === "runtime_dispatch_requested").length,
        dispatchesBeforeSpentProbe + 2,
        "the shared cut and idempotency key own exactly one remote dispatch",
      );
    } finally {
      for (const runtime of edgeRuntimes) runtime.close();
      await center?.close();
      await f.close();
    }
  },
);

test(
  "a cancelled reviewer dispatch is replaced on the next complete and the replacement review completes the task",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    try {
      await f.install();
      const first = (await f.complete()) as Record<string, unknown>;
      assert.equal(first.code, "review_missing", JSON.stringify(first));
      assert.equal(f.launches.length, 1);
      // Bind the reviewer's provider session first, as a real reviewer has by the time it is cancelled.
      f.bindPending();
      await f.cancel(String(first.runtimeSessionId));
      assert.equal(await f.awaitOutcome(String(first.runtimeSessionId)), "cancelled");
      const second = (await f.complete()) as Record<string, unknown>;
      assert.equal(second.code, "review_missing", JSON.stringify(second));
      assert.notEqual(second.dispatchId, first.dispatchId);
      assert.notEqual(second.runtimeSessionId, first.runtimeSessionId);
      assert.equal(f.launches.length, 2);
      // The replacement stays pending (failure budget spent): completion is idempotent against it.
      const third = (await f.complete()) as Record<string, unknown>;
      assert.equal(third.dispatchId, second.dispatchId);
      assert.equal(f.launches.length, 2);
      assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 2);
      const reviewed = await f.review(String(second.runtimeSessionId), "review-replacement");
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      const completed = await f.complete(true);
      assert.equal(completed.outcome, "applied", JSON.stringify(completed));
      assert.equal(f.events().filter((event) => event.type === "task_completed").length, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  "a spent return budget refuses new review dispatches; raising it resumes review and approval completes",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    const reviewExecution = (
      sessionId: string,
      execution: string,
      reviewId: string,
      verdict: "changes_requested" | "approved",
    ) => {
      const packet = `${f.packagePath}/artifacts/reports/${reviewId}.json`;
      mkdirSync(path.dirname(path.join(f.root, "harness", packet)), { recursive: true });
      writeFileSync(
        path.join(f.root, "harness", packet),
        JSON.stringify({
          verdict,
          reason: verdict === "changes_requested" ? "Another pass is required." : "Cut approved.",
          evidenceChecked: ["closeout.md"],
        }),
      );
      return f.cell().run(
        { kind: "task-review-execution", taskId, executionId: execution, reviewId, fromFile: `harness/${packet}` },
        {
          actor: {
            principal: owner.actor.principal,
            executor: { kind: "agent", id: `runtime-session:${sessionId}` },
          },
          source: "local",
        },
      );
    };
    try {
      await f.install();
      assert.equal((await f.runPrincipal({ kind: "settings-update", reviewReturnBudget: 1 })).outcome, "applied");
      const first = (await f.complete()) as Record<string, unknown>;
      assert.equal(first.code, "review_missing", JSON.stringify(first));
      assert.doesNotMatch(JSON.stringify(first.next), /return budget/u);
      assert.equal(
        (await reviewExecution(String(first.runtimeSessionId), executionId, "review-budget-one", "changes_requested"))
          .outcome,
        "applied",
      );
      const roundTwo = "execution-budget-two";
      assert.equal((await f.run({ kind: "task-start", taskId, executionId: roundTwo })).outcome, "applied");
      assert.equal((await f.run({ kind: "task-submit", taskId, executionId: roundTwo })).outcome, "applied");
      // Budget spent: complete stops at the review gate without spawning a reviewer worker.
      const second = (await f.run({ kind: "task-complete", taskId, executionId: roundTwo })) as Record<string, unknown>;
      assert.equal(second.code, "review_missing", JSON.stringify(second));
      assert.match(JSON.stringify(second.next), /Return budget 1 is spent at iteration 1/u);
      assert.match(JSON.stringify(second.next), /--review-return-budget/u);
      assert.match(JSON.stringify(second.next), /escalate to the dispatching principal/u);
      assert.match(JSON.stringify(second.next), /ha task amend/u);
      assert.deepEqual(second.diagnostic, { kind: "failure", code: "review_return_budget_exhausted" });
      assert.equal(f.launches.length, 1, "no reviewer worker may spawn once the return budget is spent");
      assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 1);
      // Without a task-scoped override, inspection reports the repository setting as the source.
      const shown = (await f.run({ kind: "task-show", taskId })) as Record<string, unknown>,
        shownPayload = JSON.parse(String(shown.evidence)) as Record<string, unknown>;
      assert.equal(shownPayload.returnBudget, 1);
      assert.equal(shownPayload.returnBudgetSource, "repository");
      // The receipt's own exit is executable: raising the live budget unblocks the same cut.
      assert.equal((await f.runPrincipal({ kind: "settings-update", reviewReturnBudget: 2 })).outcome, "applied");
      const raised = (await f.run({ kind: "task-complete", taskId, executionId: roundTwo })) as Record<string, unknown>;
      assert.equal(raised.code, "review_missing", JSON.stringify(raised));
      assert.doesNotMatch(JSON.stringify(raised.next), /return budget/u);
      assert.equal(typeof raised.runtimeSessionId, "string", JSON.stringify(raised));
      assert.equal(f.launches.length, 2, "a raised budget dispatches a reviewer again");
      assert.equal(
        (await reviewExecution(String(raised.runtimeSessionId), roundTwo, "review-budget-three", "changes_requested"))
          .outcome,
        "applied",
      );
      const roundThree = "execution-budget-three";
      assert.equal((await f.run({ kind: "task-start", taskId, executionId: roundThree })).outcome, "applied");
      assert.equal((await f.run({ kind: "task-submit", taskId, executionId: roundThree })).outcome, "applied");
      const third = (await f.run({ kind: "task-complete", taskId, executionId: roundThree })) as Record<
        string,
        unknown
      >;
      assert.equal(third.code, "review_missing", JSON.stringify(third));
      assert.match(JSON.stringify(third.next), /Return budget 2 is spent at iteration 2/u);
      assert.equal(f.launches.length, 2, "the third round is also refused without a worker");
      // Raising the budget again admits a fresh reviewer whose approval completes the task.
      assert.equal((await f.runPrincipal({ kind: "settings-update", reviewReturnBudget: 3 })).outcome, "applied");
      const reopened = (await f.run({ kind: "task-complete", taskId, executionId: roundThree })) as Record<
        string,
        unknown
      >;
      assert.equal(reopened.code, "review_missing", JSON.stringify(reopened));
      assert.equal(typeof reopened.runtimeSessionId, "string", JSON.stringify(reopened));
      assert.equal(
        (await reviewExecution(String(reopened.runtimeSessionId), roundThree, "review-budget-approved", "approved"))
          .outcome,
        "applied",
      );
      const completed = await f.run({ kind: "task-complete", taskId, executionId: roundThree, consent: true });
      assert.equal(completed.outcome, "applied", JSON.stringify(completed));
      assert.equal(f.events().filter((event) => event.type === "task_completed").length, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  "a task-scoped return budget overrides the exhausted repository budget and is named in show",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, 2);
    const reviewExecution = (sessionId: string, execution: string, reviewId: string) => {
      const packet = `${f.packagePath}/artifacts/reports/${reviewId}.json`;
      mkdirSync(path.dirname(path.join(f.root, "harness", packet)), { recursive: true });
      writeFileSync(
        path.join(f.root, "harness", packet),
        JSON.stringify({
          verdict: "changes_requested",
          reason: "Another pass is required.",
          evidenceChecked: ["closeout.md"],
        }),
      );
      return f.cell().run(
        { kind: "task-review-execution", taskId, executionId: execution, reviewId, fromFile: `harness/${packet}` },
        {
          actor: {
            principal: owner.actor.principal,
            executor: { kind: "agent", id: `runtime-session:${sessionId}` },
          },
          source: "local",
        },
      );
    };
    try {
      await f.install();
      // The repository budget is already spent; the task-scoped override still admits a return.
      assert.equal((await f.runPrincipal({ kind: "settings-update", reviewReturnBudget: 1 })).outcome, "applied");
      const shown = (await f.run({ kind: "task-show", taskId })) as Record<string, unknown>,
        shownPayload = JSON.parse(String(shown.evidence)) as Record<string, unknown>;
      assert.equal(shownPayload.returnBudget, 2);
      assert.equal(shownPayload.returnBudgetSource, "task");
      // The amend write path adjusts the override in place; amend it back before the rounds.
      const amend = (value: string) =>
        f.run({ kind: "task-amend", taskId, patches: [{ field: "reviewReturnBudget", value }] });
      assert.equal((await amend("1")).outcome, "applied");
      const amended = (await f.run({ kind: "task-show", taskId })) as Record<string, unknown>,
        amendedPayload = JSON.parse(String(amended.evidence)) as Record<string, unknown>;
      assert.equal(amendedPayload.returnBudget, 1);
      assert.equal(amendedPayload.returnBudgetSource, "task");
      assert.equal((await amend("2")).outcome, "applied");
      const first = (await f.complete()) as Record<string, unknown>;
      assert.equal(first.code, "review_missing", JSON.stringify(first));
      assert.equal(
        (await reviewExecution(String(first.runtimeSessionId), executionId, "review-task-budget-one")).outcome,
        "applied",
      );
      const roundTwo = "execution-task-budget-two";
      assert.equal((await f.run({ kind: "task-start", taskId, executionId: roundTwo })).outcome, "applied");
      assert.equal((await f.run({ kind: "task-submit", taskId, executionId: roundTwo })).outcome, "applied");
      const second = (await f.run({ kind: "task-complete", taskId, executionId: roundTwo })) as Record<string, unknown>;
      assert.equal(second.code, "review_missing", JSON.stringify(second));
      // Iteration 1 exhausts the repository budget (1) but not the task budget (2): no spent note.
      assert.doesNotMatch(JSON.stringify(second.next), /return budget/u);
      assert.equal(
        (await reviewExecution(String(second.runtimeSessionId), roundTwo, "review-task-budget-two")).outcome,
        "applied",
      );
      const roundThree = "execution-task-budget-three";
      assert.equal((await f.run({ kind: "task-start", taskId, executionId: roundThree })).outcome, "applied");
      assert.equal((await f.run({ kind: "task-submit", taskId, executionId: roundThree })).outcome, "applied");
      const third = (await f.run({ kind: "task-complete", taskId, executionId: roundThree })) as Record<
        string,
        unknown
      >;
      assert.equal(third.code, "review_missing", JSON.stringify(third));
      // The refusal names the task-scoped budget, not the repository's, and spawns no worker.
      assert.match(JSON.stringify(third.next), /Return budget 2 is spent at iteration 2/u);
      assert.equal(f.launches.length, 2, "a spent task-scoped budget refuses the dispatch without a worker");
    } finally {
      await f.close();
    }
  },
);

test(
  "a changes_requested review returns the task to implementation instead of re-dispatching a reviewer",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    try {
      await f.install();
      const dispatched = (await f.complete()) as Record<string, unknown>;
      assert.equal(dispatched.code, "review_missing", JSON.stringify(dispatched));
      const packet = `${f.packagePath}/artifacts/reports/review-changes.json`;
      mkdirSync(path.dirname(path.join(f.root, "harness", packet)), { recursive: true });
      writeFileSync(
        path.join(f.root, "harness", packet),
        JSON.stringify({
          verdict: "changes_requested",
          reason: "The delivery needs another pass.",
          evidenceChecked: ["closeout.md"],
        }),
      );
      const reviewed = await f.cell().run(
        {
          kind: "task-review-execution",
          taskId,
          executionId,
          reviewId: "review-changes",
          fromFile: `harness/${packet}`,
        },
        {
          actor: {
            principal: owner.actor.principal,
            executor: { kind: "agent", id: `runtime-session:${String(dispatched.runtimeSessionId)}` },
          },
          source: "local",
        },
      );
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      const after = (await f.complete()) as Record<string, unknown>;
      assert.equal(after.code, "not_in_review", JSON.stringify(after));
      assert.equal(f.launches.length, 1, "a recorded review verdict must not be replaced by a fresh dispatch");
      assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 1);
    } finally {
      await f.close();
    }
  },
);

test("completion reaches its final event without adding I/O to repo status", { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const dispatched = (await f.complete()) as Record<string, unknown>;
    const reviewed = await f.review(String(dispatched.runtimeSessionId), "review-stall");
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const closeoutPath = path.join(f.root, "harness", f.packagePath, "closeout.md");
    writeFileSync(closeoutPath, `${readFileSync(closeoutPath, "utf8")}\nEdited after submit.\n`);
    const completed = await f.complete(true);
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    const events = f.events();
    assert.equal(events.at(-1)?.type, "task_completed");
    const status = f.cell().status();
    assert.equal(status.projectionWatermark, undefined);
    assert.equal(status.ledgerRevision, undefined);
  } finally {
    await f.close();
  }
});
