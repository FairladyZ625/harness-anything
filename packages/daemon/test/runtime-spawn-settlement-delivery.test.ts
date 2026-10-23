// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { publishExit } from "../src/runtime-spawn-settlement.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import {
  deliveryProjection,
  fixtureArtifacts,
  fixtureTaskId,
  git,
  workerGitFixture,
  workerSettlementContext,
  workerSettlementRuntime,
} from "./runtime-spawn-settlement.fixtures.ts";

test("terminal settlement reports the branch and head its worker push published", async (context) => {
  const fixture = workerGitFixture(context, "settle-push", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, { finalText: "worker delivery" }),
    outcomeBodies: string[] = [],
    outcomes: Record<string, unknown>[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}, _opId?, _binding?, body?) => {
      if (type === "runtime_session_outcome_observed") {
        outcomes.push(payload);
        outcomeBodies.push(String(body));
      }
      return {};
    });
  await publishExit(settleContext, runtime, 0);
  const head = git(fixture.worker, "rev-parse", "HEAD").trim(),
    expectedBody = `worker delivery\n\nWorker branch pushed at settlement: ${fixtureTaskId} @ ${head}`;
  assert.deepEqual(outcomeBodies, [expectedBody]);
  assert.equal(outcomes[0]?.outcome, "succeeded");
  assert.equal(
    outcomes[0]?.resultRef,
    `artifact:runtime-result/sha256/${createHash("sha256").update(expectedBody).digest("hex")}`,
    "the push line must be inside the durable terminal result the CEO reads",
  );
  assert.ok(git(fixture.bare, "show-ref", "--verify", `refs/heads/${fixtureTaskId}`).trim().startsWith(`${head} `));
});

test("terminal settlement publishes the submitted commit when worker HEAD advances", async (context) => {
  const fixture = workerGitFixture(context, "settle-submission", { reachableRemote: true }),
    submittedCommitSha = git(fixture.worker, "rev-parse", "HEAD").trim();
  git(fixture.worker, "commit", "--allow-empty", "--quiet", "-m", "feat: post-submission change");
  const head = git(fixture.worker, "rev-parse", "HEAD").trim(),
    runtime = workerSettlementRuntime(fixture, { finalText: "worker delivery" }),
    outcomeBodies: string[] = [],
    settleContext = workerSettlementContext(
      fixture,
      async (type, _payload = {}, _opId?, _binding?, body?) => {
        if (type === "runtime_session_outcome_observed") outcomeBodies.push(String(body));
        return {};
      },
      "worker delivery",
      submittedCommitSha,
    );
  await publishExit(
    {
      ...settleContext,
      requiredRuntimeProjection: () => deliveryProjection(submittedCommitSha, "repository-diff", [], [], true),
    },
    runtime,
    0,
  );
  assert.deepEqual(outcomeBodies, [
    `worker delivery\n\nWorker branch pushed at settlement: ${fixtureTaskId} @ ${submittedCommitSha} (worker HEAD ${head})`,
  ]);
  assert.doesNotMatch(outcomeBodies[0]!, /is not submitted/u);
  assert.equal(git(fixture.bare, "rev-parse", `refs/heads/${fixtureTaskId}`).trim(), submittedCommitSha);
});

test("an edge settlement cannot overwrite the submit cut with a later worker HEAD", async (context) => {
  const fixture = workerGitFixture(context, "settle-edge", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, { finalText: "worker delivery" }),
    outcomeBodies: string[] = [],
    outcomes: Record<string, unknown>[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}, _opId?, _binding?, body?) => {
      if (type === "runtime_session_outcome_observed") {
        outcomes.push(payload);
        outcomeBodies.push(String(body));
      }
      return {};
    });
  const accepted = git(fixture.worker, "rev-parse", "HEAD").trim();
  git(fixture.worker, "push", "--quiet", "origin", `HEAD:refs/heads/${fixtureTaskId}`);
  git(fixture.worker, "commit", "--allow-empty", "-qm", "later unsubmitted work");
  await publishExit(
    {
      ...settleContext,
      input: { ...settleContext.input, projection: undefined },
      // What a remote-edge spawner's projection read does: it has none.
      requiredRuntimeProjection: () => {
        throw Object.assign(new Error("Local runtime projection is unavailable."), {
          code: "runtime_preconditions_unavailable",
        });
      },
    },
    runtime,
    0,
  );
  assert.notEqual(git(fixture.worker, "rev-parse", "HEAD").trim(), accepted);
  assert.deepEqual(outcomeBodies, ["worker delivery"]);
  assert.equal(outcomes[0]?.outcome, "succeeded");
  assert.equal(git(fixture.bare, "rev-parse", `refs/heads/${fixtureTaskId}`).trim(), accepted);
});

for (const closeoutRecorded of [false, true]) {
  test(`terminal settlement marks a pushed-branch exit without submission as stopped (closeout: ${closeoutRecorded})`, async (context) => {
    // The incident this pins: the worker pushed its branch mid-work, said "I will add one more test",
    // and exited; branch commits must not restate an undelivered stop as succeeded
    // (dec_614F7BBB18C8687E7EFC72173D RJ1).
    const fixture = workerGitFixture(context, "settle-unsubmitted-closeout", { reachableRemote: true }),
      runtime = workerSettlementRuntime(fixture, { finalText: "我会再加一个 admission 层回归测试，然后再跑一遍" }),
      outcomeBodies: string[] = [],
      outcomes: Record<string, unknown>[] = [],
      settleContext = workerSettlementContext(fixture, async (type, payload = {}, _opId?, _binding?, body?) => {
        if (type === "runtime_session_outcome_observed") {
          outcomes.push(payload);
          outcomeBodies.push(String(body));
        }
        return {};
      });
    const pushed = git(fixture.worker, "rev-parse", "HEAD").trim();
    git(fixture.worker, "push", "--quiet", "origin", `HEAD:refs/heads/${fixtureTaskId}`);
    git(fixture.worker, "commit", "--allow-empty", "-qm", "later unsubmitted work");
    await publishExit(
      {
        ...settleContext,
        requiredRuntimeProjection: () => deliveryProjection(null, "repository-diff", [], [], closeoutRecorded),
      },
      runtime,
      0,
    );
    assert.equal(outcomes[0]?.outcome, "stopped");
    assert.match(outcomeBodies[0]!, /Task task_0123456789abcdef01234567 is not submitted/u);
    assert.match(outcomeBodies[0]!, /ha task start task_0123456789abcdef01234567/u);
    assert.equal(
      git(fixture.bare, "rev-parse", `refs/heads/${fixtureTaskId}`).trim(),
      pushed,
      "an undelivered stop must not advance the published branch",
    );
  });
}

test("terminal settlement keeps a clean task exit unknown without its execution delivery", async (context) => {
  const fixture = workerGitFixture(context, "settle-no-delivery", { reachableRemote: true, delivery: false }),
    runtime = workerSettlementRuntime(fixture, { finalText: "worker stopped" }),
    outcomes: Record<string, unknown>[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}) => {
      if (type === "runtime_session_outcome_observed") outcomes.push(payload);
      return {};
    });
  await publishExit({ ...settleContext, requiredRuntimeProjection: () => deliveryProjection(null) }, runtime, 0);
  assert.equal(outcomes[0]?.outcome, "stopped");
  assert.equal(git(fixture.bare, "for-each-ref", "--format=%(refname)", `refs/heads/${fixtureTaskId}`), "");
});

test("task settlement archives a bounded, scrubbed conclusion and the worktree exit HEAD", async (context) => {
  const fixture = workerGitFixture(context, "settle-continuation-context", { reachableRemote: true }),
    conclusion = `Last conclusion secret=do-not-persist ${"x".repeat(9_000)}`,
    runtime = workerSettlementRuntime(fixture, { finalText: conclusion }),
    archived: Record<string, unknown>[] = [],
    baseContext = workerSettlementContext(fixture, async () => ({ outcome: "applied" })),
    settleContext = {
      ...baseContext,
      input: {
        ...baseContext.input,
        remote: {
          archive: async (value: Record<string, unknown>) => {
            archived.push(value);
            return { outcome: "applied" };
          },
        },
      },
    } as RuntimeSpawnerContext;
  await publishExit(settleContext, runtime, 0);
  assert.equal(archived.length, 1);
  assert.ok(String(archived[0]?.lastConclusion).startsWith("Last conclusion [REDACTED]"));
  assert.equal(String(archived[0]?.lastConclusion).length, 8_192);
  assert.doesNotMatch(String(archived[0]?.lastConclusion), /do-not-persist/u);
  assert.equal(archived[0]?.exitHead, git(fixture.worker, "rev-parse", "HEAD").trim());
});

test("terminal settlement accepts an already submitted commitless task delivery", async (context) => {
  const fixture = workerGitFixture(context, "settle-commitless-submission", { reachableRemote: true, delivery: false }),
    runtime = workerSettlementRuntime(fixture, { finalText: "analysis complete", publicationOwner: "commander" }),
    outcomes: Record<string, unknown>[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}) => {
      if (type === "runtime_session_outcome_observed") outcomes.push(payload);
      return {};
    });
  await publishExit(
    {
      ...settleContext,
      requiredRuntimeProjection: () => deliveryProjection(null, "repository-diff", [], [], false, true),
    },
    runtime,
    0,
  );
  assert.equal(outcomes[0]?.outcome, "succeeded");
});

test("terminal settlement accepts a center-accepted task-package artifact", async (context) => {
  const fixture = workerGitFixture(context, "settle-artifact-delivery", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, { finalText: "artifact delivered", publicationOwner: "commander" }),
    outcomes: Record<string, unknown>[] = [],
    outcomeBodies: string[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}, _opId?, _binding?, body?) => {
      if (type === "runtime_session_outcome_observed") {
        outcomes.push(payload);
        outcomeBodies.push(String(body));
      }
      return {};
    });
  await publishExit(
    {
      ...settleContext,
      requiredRuntimeProjection: () =>
        deliveryProjection(
          null,
          "task-package-artifact",
          [{ path: "artifacts/report.md", revision: 42, blobSha256: "a".repeat(64) }],
          [],
          true,
        ),
    },
    runtime,
    0,
  );
  assert.equal(outcomes[0]?.outcome, "succeeded");
  assert.doesNotMatch(outcomeBodies[0]!, /is not submitted/u);
});

test("terminal settlement accepts a review registered for the dispatch role", async (context) => {
  const fixture = workerGitFixture(context, "settle-review-delivery", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, {
      finalText: "review registered",
      publicationOwner: "commander",
      role: "reviewer",
    }),
    outcomes: Record<string, unknown>[] = [],
    outcomeBodies: string[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}, _opId?, _binding?, body?) => {
      if (type === "runtime_session_outcome_observed") {
        outcomes.push(payload);
        outcomeBodies.push(String(body));
      }
      return {};
    });
  await publishExit(
    {
      ...settleContext,
      requiredRuntimeProjection: () =>
        deliveryProjection(null, "repository-diff", [], [{ reviewId: `review-${runtime.dispatchId}` }], true),
    },
    runtime,
    0,
  );
  assert.equal(outcomes[0]?.outcome, "succeeded");
  assert.doesNotMatch(outcomeBodies[0]!, /is not submitted/u);
});

test("reviewer settlement does not prepare credentials or push a worker branch", async (context) => {
  const fixture = workerGitFixture(context, "settle-review-no-push", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, {
      finalText: "review registered",
      role: "reviewer",
      publicationOwner: "runtime",
    }),
    outcomes: Record<string, unknown>[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}) => {
      if (type === "runtime_session_outcome_observed") outcomes.push(payload);
      return {};
    });
  let credentialRequests = 0;
  await publishExit(
    {
      ...settleContext,
      requiredRuntimeProjection: () =>
        deliveryProjection(null, "repository-diff", [], [{ reviewId: `review-${runtime.dispatchId}` }], true),
      prepareWorkerGitEnvironment: async () => {
        credentialRequests += 1;
        return { GH_TOKEN: "reviewer-token" };
      },
    },
    runtime,
    0,
  );
  assert.equal(outcomes[0]?.outcome, "succeeded");
  assert.equal(credentialRequests, 0);
  assert.equal(git(fixture.bare, "for-each-ref", "--format=%(refname)", `refs/heads/${fixtureTaskId}`), "");
});

test("a reviewer's branch commit does not witness success without the registered review", async (context) => {
  // The git fixture leaves the worker branch one commit above the baseline, so the branch
  // witness alone would flip the outcome; the review list is empty (F-4C182EEE shape).
  const fixture = workerGitFixture(context, "settle-review-unregistered", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, {
      finalText: "no structured provider outcome",
      publicationOwner: "commander",
      role: "reviewer",
    }),
    outcomes: Record<string, unknown>[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}) => {
      if (type === "runtime_session_outcome_observed") outcomes.push(payload);
      return {};
    });
  await publishExit(
    {
      ...settleContext,
      requiredRuntimeProjection: () => deliveryProjection(null, "repository-diff", [], [], true),
    },
    runtime,
    0,
  );
  assert.equal(outcomes[0]?.outcome, "stopped");
});

test("an edge reviewer without a local projection settles stopped", async (context) => {
  const fixture = workerGitFixture(context, "settle-review-edge", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, {
      finalText: "review registered elsewhere",
      publicationOwner: "commander",
      role: "reviewer",
    }),
    outcomes: Record<string, unknown>[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}) => {
      if (type === "runtime_session_outcome_observed") outcomes.push(payload);
      return {};
    });
  await publishExit(
    {
      ...settleContext,
      input: { ...settleContext.input, projection: undefined },
      requiredRuntimeProjection: () => {
        throw Object.assign(new Error("Local runtime projection is unavailable."), {
          code: "runtime_preconditions_unavailable",
        });
      },
    },
    runtime,
    0,
  );
  assert.equal(outcomes[0]?.outcome, "stopped");
});

test("squad leader settlement preserves its machine-readable control result", async (context) => {
  const fixture = workerGitFixture(context, "squad-leader-control", { reachableRemote: true }),
    controlResult = JSON.stringify({
      schema: "runtime-batch/v1",
      dispatches: [{ to: "terra", prompt: "Review the runtime boundary." }],
    }),
    runtime = workerSettlementRuntime(fixture, {
      agent: { id: "fable", name: "Fable" },
      delegatedBy: null,
      squadId: "core-squad",
      finalText: controlResult,
    }),
    outcomeBodies: string[] = [],
    settleContext = workerSettlementContext(
      fixture,
      async (type, _payload = {}, _opId?, _binding?, body?) => {
        if (type === "runtime_session_outcome_observed") outcomeBodies.push(String(body));
        return {};
      },
      controlResult,
    );
  await publishExit(settleContext, runtime, 0);
  assert.deepEqual(outcomeBodies, [controlResult]);
});

test("commander-owned settlement keeps its commit local and reports an unsubmitted delivery", async (context) => {
  const fixture = workerGitFixture(context, "squad-child", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, {
      agent: { id: "terra", name: "Terra" },
      delegatedBy: { id: "fable", name: "Fable" },
      squadId: "core-squad",
      finalText: "worker delivery",
      publicationOwner: "commander",
    }),
    outcomeBodies: string[] = [],
    outcomes: Record<string, unknown>[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}, _opId?, _binding?, body?) => {
      if (type === "runtime_session_outcome_observed") {
        outcomes.push(payload);
        outcomeBodies.push(String(body));
      }
      return {};
    });
  let credentialRequests = 0;
  await publishExit(
    {
      ...settleContext,
      requiredRuntimeProjection: () => deliveryProjection(null, "repository-diff", [], [], true),
      prepareDaemonGitEnvironment: async () => {
        credentialRequests += 1;
        return {};
      },
    },
    runtime,
    0,
  );
  assert.equal(outcomes[0]?.outcome, "succeeded");
  assert.match(outcomeBodies[0]!, /Task task_0123456789abcdef01234567 is not submitted/u);
  assert.match(outcomeBodies[0]!, /ha task submit task_0123456789abcdef01234567 --as-owner/u);
  assert.equal(credentialRequests, 0);
  assert.equal(git(fixture.bare, "for-each-ref", "--format=%(refname)", `refs/heads/${fixtureTaskId}`), "");
  assert.equal(git(fixture.worker, "log", "-1", "--format=%s").trim(), "feat: worker change");
});

test("commander-owned settlement without a local commit does not report a delivery", async (context) => {
  const fixture = workerGitFixture(context, "squad-child-no-delivery", { reachableRemote: true, delivery: false }),
    runtime = workerSettlementRuntime(fixture, {
      agent: { id: "terra", name: "Terra" },
      delegatedBy: { id: "fable", name: "Fable" },
      squadId: "core-squad",
      finalText: "worker stopped",
      publicationOwner: "commander",
    }),
    outcomeBodies: string[] = [],
    settleContext = workerSettlementContext(fixture, async (type, _payload = {}, _opId?, _binding?, body?) => {
      if (type === "runtime_session_outcome_observed") outcomeBodies.push(String(body));
      return {};
    });
  await publishExit(
    {
      ...settleContext,
      requiredRuntimeProjection: () => deliveryProjection(null, "repository-diff", [], [], true),
    },
    runtime,
    0,
  );
  assert.doesNotMatch(outcomeBodies[0]!, /is not submitted/u);
});

test("a squad leader turn is witnessed by its structured control result", async (context) => {
  // The leader owes no repository artifacts (children deliver the commits), so without this
  // Without this witness a leader turn settles stopped and the coordinator retries instead of parsing
  // the decision — the squad loop itself depended on the removed unknown-to-succeeded restating.
  const fixture = workerGitFixture(context, "squad-leader-witness", { reachableRemote: true, delivery: false }),
    controlResult = JSON.stringify({
      schema: "squad-decision/v1",
      action: "converged",
      report: "# Synthesis\n\nChildren delivered.",
    }),
    runtime = workerSettlementRuntime(fixture, {
      agent: { id: "fable", name: "Fable" },
      delegatedBy: null,
      squadId: "core-squad",
      finalText: controlResult,
    }),
    outcomes: Record<string, unknown>[] = [],
    settleContext = workerSettlementContext(
      fixture,
      async (type, payload = {}) => {
        if (type === "runtime_session_outcome_observed") outcomes.push(payload);
        return {};
      },
      controlResult,
    );
  await publishExit(
    {
      ...settleContext,
      requiredRuntimeProjection: () => deliveryProjection(null, "repository-diff", [], [], false),
    },
    runtime,
    0,
  );
  assert.equal(outcomes[0]?.outcome, "succeeded");
});

test("a squad leader turn without the provider's structured success settles stopped", async (context) => {
  const fixture = workerGitFixture(context, "squad-leader-unstructured", { reachableRemote: true, delivery: false }),
    runtime = workerSettlementRuntime(fixture, {
      agent: { id: "fable", name: "Fable" },
      delegatedBy: null,
      squadId: "core-squad",
      providerOutcome: null,
      finalText: "converged without a provider result frame",
    }),
    outcomes: Record<string, unknown>[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}) => {
      if (type === "runtime_session_outcome_observed") outcomes.push(payload);
      return {};
    });
  await publishExit(
    {
      ...settleContext,
      requiredRuntimeProjection: () => deliveryProjection(null, "repository-diff", [], [], false),
    },
    runtime,
    0,
  );
  assert.equal(outcomes[0]?.outcome, "stopped");
});

test("a squad worker's delivery is the commits on its commander-cut branch", async (context) => {
  // Squad checkouts branch as `<commander>--squad-…`, never the child task id, so the task-branch
  // witness cannot name them; the commits beyond the commander branch are the child's delivery.
  const fixture = workerGitFixture(context, "squad-worker-branch", { reachableRemote: true }),
    commanderBranch = git(fixture.canonical, "branch", "--show-current").trim();
  git(fixture.worker, "branch", "-m", `${commanderBranch}--squad-0123456789ab-terra-1`);
  const runtime = workerSettlementRuntime(fixture, {
      agent: { id: "terra", name: "Terra" },
      delegatedBy: { id: "fable", name: "Fable" },
      squadId: "core-squad",
      finalText: "child delivery",
      publicationOwner: "commander",
    }),
    outcomes: Record<string, unknown>[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}) => {
      if (type === "runtime_session_outcome_observed") outcomes.push(payload);
      return {};
    });
  await publishExit(
    {
      ...settleContext,
      requiredRuntimeProjection: () => deliveryProjection(null, "repository-diff", [], [], true),
    },
    runtime,
    0,
  );
  assert.equal(outcomes[0]?.outcome, "succeeded");
});

test("terminal settlement names the branch when the worker push fails", async (context) => {
  const fixture = workerGitFixture(context, "settle-fail", { reachableRemote: false }),
    runtime = workerSettlementRuntime(fixture, { finalText: "worker delivery" }),
    outcomeBodies: string[] = [],
    outcomes: Record<string, unknown>[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}, _opId?, _binding?, body?) => {
      if (type === "runtime_session_outcome_observed") {
        outcomes.push(payload);
        outcomeBodies.push(String(body));
      }
      return {};
    });
  await publishExit(settleContext, runtime, 0);
  assert.equal(outcomeBodies.length, 1);
  assert.match(
    outcomeBodies[0],
    new RegExp(`^worker delivery\\n\\nWorker branch push failed \\(no retry\\): ${fixtureTaskId} @ [0-9a-f]+: .+`, "u"),
  );
  assert.equal(outcomes[0]?.outcome, "succeeded", "a push failure is reported, not turned into a task failure");
});

test("terminal settlement refuses to publish a worker commit outside the conventional identity", async (context) => {
  const fixture = workerGitFixture(context, "settle-identity", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, { finalText: "worker delivery" }),
    outcomeBodies: string[] = [],
    outcomes: Record<string, unknown>[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}, _opId?, _binding?, body?) => {
      if (type === "runtime_session_outcome_observed") {
        outcomes.push(payload);
        outcomeBodies.push(String(body));
      }
      return {};
    });
  git(
    fixture.worker,
    "-c",
    "user.name=Stale Worker",
    "-c",
    "user.email=stale-worker@example.invalid",
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "feat: stale worker change",
  );
  const staleHead = git(fixture.worker, "rev-parse", "HEAD").trim();
  await publishExit(settleContext, runtime, 0);
  assert.equal(outcomeBodies.length, 1);
  assert.match(
    outcomeBodies[0],
    new RegExp(
      `^worker delivery\\n\\nWorker branch push failed \\(no retry\\): ` +
        `${fixtureTaskId} @ ${staleHead}: commit ${staleHead} carries author ` +
        "<stale-worker@example.invalid> and committer <stale-worker@example.invalid>, " +
        "not the conventional identity <operator@users.noreply.github.com>",
      "u",
    ),
  );
  assert.equal(outcomes[0]?.outcome, "succeeded", "an identity refusal is reported, not turned into a task failure");
  assert.notEqual(
    spawnSync("git", ["-C", fixture.bare, "show-ref", "--verify", "--quiet", `refs/heads/${fixtureTaskId}`]).status,
    0,
    "the settlement refusal leaves the branch unpublished",
  );
});

test("settlement reads the worker's ruling from its own worktree and publishes it with the archive", async (context) => {
  // The measured production shape (task_936005e1): the worker writes the ruling into its worktree
  // package mirror, no doc sync reaches it, and the provider exits non-zero. Before this fix the
  // settlement read only the projection, so the file was invisible and the run settled
  // `gate_red`/failed; the ask then existed nowhere the CEO could read it.
  const fixture = workerGitFixture(context, "settle-ruling", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, {}),
    artifacts = fixtureArtifacts(fixture),
    rulingPath = path.join(
      fixture.worker,
      "harness",
      "tasks",
      "task_0123456789abcdef01234567-fixture",
      "artifacts",
      "rulings",
      `${runtime.dispatchId}.md`,
    ),
    archives: Record<string, unknown>[] = [],
    outcomes: Record<string, unknown>[] = [],
    outcomeBodies: string[] = [];
  mkdirSync(path.dirname(rulingPath), { recursive: true });
  writeFileSync(rulingPath, artifacts.body);
  const settleContext = {
    ...workerSettlementContext(fixture, async (type, payload = {}, _opId?, _binding?, body?) => {
      if (type === "runtime_session_outcome_observed") {
        outcomes.push(payload);
        outcomeBodies.push(String(body));
      }
      return {};
    }),
  } as unknown as RuntimeSpawnerContext;
  // Capture the archive instead of publishing it: the ruling's bytes must reach this object, which
  // is the only settlement publication path.
  (settleContext.input as { remote: { archive: (archive: unknown) => Promise<{ outcome: string }> } }).remote = {
    archive: async (archive) => {
      archives.push(archive as Record<string, unknown>);
      return { outcome: "applied" };
    },
  };
  await publishExit(settleContext, runtime, 2);
  assert.equal(archives.length, 1, "settlement still archives through the single existing path");
  assert.deepEqual(
    {
      outcome: outcomes[0]?.outcome,
      classification: (outcomes[0]?.attempt as { readonly classification?: string } | undefined)?.classification,
    },
    { outcome: "stopped", classification: "awaiting_ruling" },
  );
  assert.match(outcomeBodies[0]!, /Awaiting owner ruling: /u);
  assert.match(outcomeBodies[0]!, new RegExp(artifacts.question, "u"));
  for (const option of artifacts.options)
    assert.match(outcomeBodies[0]!, new RegExp(option.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.deepEqual(archives[0]?.ruling, {
    path: `tasks/task_0123456789abcdef01234567-fixture/artifacts/rulings/${runtime.dispatchId}.md`,
    body: artifacts.body,
  });
  // The same run without the artifact keeps the ordinary settled failure: the classification was
  // added at the existing branch, not as a second settlement path. Removing the file is the
  // before-state — this is exactly the dispatch a projection-only read saw.
  rmSync(rulingPath);
  const noRuling = workerSettlementRuntime(fixture, {}),
    bare: Record<string, unknown>[] = [],
    bareOutcomes: Record<string, unknown>[] = [],
    bareContext = {
      ...workerSettlementContext(fixture, async (type, payload = {}) => {
        if (type === "runtime_session_outcome_observed") bareOutcomes.push(payload);
        return {};
      }),
    } as unknown as RuntimeSpawnerContext;
  (bareContext.input as { remote: { archive: (archive: unknown) => Promise<{ outcome: string }> } }).remote = {
    archive: async (archive) => {
      bare.push(archive as Record<string, unknown>);
      return { outcome: "applied" };
    },
  };
  await publishExit(bareContext, noRuling, 2);
  assert.equal(
    (bareOutcomes[0]?.attempt as { readonly classification?: string } | undefined)?.classification,
    "gate_red",
  );
  assert.equal(bareOutcomes[0]?.outcome, "failed");
  assert.equal(bare[0]?.ruling, undefined);
});
