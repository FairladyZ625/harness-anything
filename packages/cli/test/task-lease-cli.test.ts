// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";
import { cliTestEnv } from "./helpers/cli-test-env.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;

test("task lease enforcement defaults off without configuration or environment", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);

    const write = runJson(rootDir, ["task", "progress", "append", taskId, "--text", "default off write"]);
    assert.equal(write.ok, true);
    assert.match(readFileSync(path.join(rootDir, `harness/tasks/${taskId}-task-one/progress.md`), "utf8"), /default off write/u);
  });
});

test("workspace lease configuration rejects unclaimed writes and permits the claimed writer", () => {
  withTempRoot((rootDir) => {
    writeHarnessLeaseEnforcement(rootDir, true);
    const created = runJson(rootDir, ["new-task", "--title", "Configured Lease"]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);
    const taskId = assertGeneratedTaskId(created.taskId);

    const rejected = runJson(rootDir, ["task", "progress", "append", taskId, "--text", "unclaimed write"], false);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "task_lease_required");
    assert.match(rejected.error?.hint ?? "", /requires an active lease/u);
    assert.match(rejected.error?.hint ?? "", new RegExp(`ha task start ${taskId}`, "u"));

    const claimed = runJson(rootDir, ["task", "claim", taskId]);
    assert.equal(claimed.ok, true);
    const accepted = runJson(rootDir, ["task", "progress", "append", taskId, "--text", "claimed write"]);
    assert.equal(accepted.ok, true);
  });
});

test("audited cancellation closes an unheld placeholder task and releases its temporary lease", () => {
  withTempRoot((rootDir) => {
    writeHarnessLeaseEnforcement(rootDir, true);
    const created = runJson(rootDir, [
      "task", "create", "--title", "Placeholder Cancellation",
      "--vertical", "software/coding", "--preset", "standard-task"
    ]);

    const startBlocked = runJson(rootDir, ["task", "start", created.taskId], false);
    assert.equal(startBlocked.error?.code, "task_plan_placeholder");
    const cancelled = runJson(rootDir, [
      "task", "transition", created.taskId, "cancelled",
      "--force", "--reason", "retire empty scaffold"
    ]);

    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.forced, true);
    assert.equal(cancelled.forceAudit.marker, "FORCE_STATUS_SET_AUDIT");
    assert.match(
      readFileSync(path.join(rootDir, created.packagePath, "task_plan.md"), "utf8"),
      /一句话说明任务目标与范围。/u
    );
    assert.match(
      readFileSync(path.join(rootDir, created.packagePath, "progress.md"), "utf8"),
      /FORCE_STATUS_SET_AUDIT: forced terminal status=cancelled; reason=retire empty scaffold/u
    );
    assert.equal(readTaskHolder(rootDir, created.taskId).holder, null);
  });
});

test("audited cancellation never displaces another live holder", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentityWithLeaseEnforcement(rootDir, "person_zeyu", "Zeyu Li", true);
    const created = runJson(rootDir, ["new-task", "--title", "Live Holder Cancellation"]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);
    runJson(rootDir, ["task", "start", created.taskId], true, { HARNESS_ACTOR: "agent:active-worker" });

    const rejected = runJson(rootDir, [
      "task", "transition", created.taskId, "cancelled",
      "--force", "--reason", "must not stop live work"
    ], false, { HARNESS_ACTOR: "agent:cleanup-worker" });

    assert.equal(rejected.error?.code, "task_lease_required");
    assert.match(rejected.error?.hint ?? "", /current holder principal=person_zeyu, executor=agent:active-worker/u);
    assert.match(readFileSync(path.join(rootDir, created.packagePath, "INDEX.md"), "utf8"), /^  status: active$/mu);
    assert.equal(existsSync(path.join(rootDir, created.packagePath, "progress.md")), false);
  });
});

test("configured writes recover the caller's orphaned lease but reject another principal", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentityWithLeaseEnforcement(rootDir, "person_zeyu", "Zeyu Li", true);
    const created = runJson(rootDir, ["new-task", "--title", "Recover Orphaned Lease"]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);
    const taskId = assertGeneratedTaskId(created.taskId);

    runJson(rootDir, ["task", "claim", taskId, "--ttl-ms", "60000"], true, {
      HARNESS_ACTOR: "agent:claude-code"
    });
    expireTaskHolder(rootDir, taskId);

    const reclaimed = runJson(rootDir, ["task", "claim", taskId], true, {
      HARNESS_ACTOR: "agent:codex"
    });
    assert.equal(reclaimed.status, "active");
    const recovered = runJson(rootDir, ["task", "progress", "append", taskId, "--text", "write recovered lease"], true, {
      HARNESS_ACTOR: "agent:codex"
    });
    assert.equal(recovered.ok, true);
    const holder = readTaskHolder(rootDir, taskId);
    assert.equal(holder.holder.principal.personId, "person_zeyu");
    assert.deepEqual(holder.holder.executor, { kind: "agent", id: "codex" });
    assert.ok(Date.parse(holder.leaseExpiresAt) > Date.now());

    writeHarnessIdentityWithLeaseEnforcement(rootDir, "person_alice", "Alice", true);
    const rejected = runJson(rootDir, ["task", "progress", "append", taskId, "--text", "must not cross principal"], false, {
      HARNESS_ACTOR: "agent:claude-code"
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error?.hint ?? "", /caller principal=person_alice, executor=agent:claude-code/u);
    assert.match(rejected.error?.hint ?? "", /current holder principal=person_zeyu, executor=agent:codex/u);
    assert.match(rejected.error?.hint ?? "", /lease status active/u);
  });
});

test("explicit false environment override disables configured lease enforcement", () => {
  withTempRoot((rootDir) => {
    writeHarnessLeaseEnforcement(rootDir, true);
    const created = runJson(rootDir, ["new-task", "--title", "Environment Disabled Lease"]);
    const taskId = assertGeneratedTaskId(created.taskId);

    const write = runJson(rootDir, ["task", "progress", "append", taskId, "--text", "env disabled write"], true, {
      HARNESS_TASK_LEASE_ENFORCEMENT: "0"
    });
    assert.equal(write.ok, true);
  });
});

test("explicit true environment override enables lease enforcement without configuration", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Environment Enabled Lease"]);
    const taskId = assertGeneratedTaskId(created.taskId);

    const rejected = runJson(rootDir, ["task", "progress", "append", taskId, "--text", "env enabled write"], false, {
      HARNESS_TASK_LEASE_ENFORCEMENT: "1"
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "task_lease_required");
  });
});

test("task claim defaults to a 24 hour lease when no TTL setting is present", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Default Lease TTL"]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);
    const claimed = runJson(rootDir, ["task", "claim", created.taskId]);

    assert.equal(leaseDurationMs(claimed.report), 86_400_000);
    assert.equal(claimed.status, "active");
    assert.match(claimed.executionId, /^exe_/u);
    assert.equal(
      claimed.warnings.some((warning: Record<string, unknown>) => warning.code === "task_still_planned"),
      false
    );
  });
});

test("task claim resolves YAML then environment TTL defaults while explicit --ttl-ms stays authoritative", () => {
  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "settings:",
      "  identity:",
      "    personId: person_tester",
      "    displayName: Harness Tester",
      "  tasks:",
      "    leaseTtlMs: 120000"
    ]);
    const created = runJson(rootDir, ["new-task", "--title", "Configured Lease TTL"]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);

    const fromYaml = runJson(rootDir, ["task", "claim", created.taskId]);
    assert.equal(leaseDurationMs(fromYaml.report), 120_000);
    runJson(rootDir, ["task", "release", created.taskId]);

    const fromEnv = runJson(rootDir, ["task", "claim", created.taskId], true, {
      HARNESS_TASK_LEASE_TTL_MS: "180000"
    });
    assert.equal(leaseDurationMs(fromEnv.report), 180_000);
    runJson(rootDir, ["task", "release", created.taskId]);

    const explicit = runJson(rootDir, ["task", "claim", created.taskId, "--ttl-ms", "60000"], true, {
      HARNESS_TASK_LEASE_TTL_MS: "180000"
    });
    assert.equal(leaseDurationMs(explicit.report), 60_000);
  });
});

test("task claim fails closed for invalid YAML and environment TTL defaults", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Invalid YAML Lease TTL"]);
    writeHarnessConfig(rootDir, [
      "settings:",
      "  identity:",
      "    personId: person_tester",
      "    displayName: Harness Tester",
      "  tasks:",
      "    leaseTtlMs: 0"
    ]);

    const rejected = runJson(rootDir, ["task", "claim", created.taskId], false);
    assert.equal(rejected.error?.code, "harness_settings_invalid");
    assert.match(rejected.error?.hint ?? "", /settings\.tasks\.leaseTtlMs must be a positive integer/u);
    assert.equal(existsTaskHolder(rootDir, created.taskId), false);
  });

  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Invalid Environment Lease TTL"]);
    const rejected = runJson(rootDir, ["task", "claim", created.taskId], false, {
      HARNESS_TASK_LEASE_TTL_MS: "not-a-duration"
    });

    assert.equal(rejected.error?.code, "harness_settings_invalid");
    assert.match(rejected.error?.hint ?? "", /HARNESS_TASK_LEASE_TTL_MS must be a positive integer/u);
    assert.equal(existsTaskHolder(rootDir, created.taskId), false);
  });
});

test("task claim fails closed when HARNESS_ACTOR names an agent but machine identity is missing", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentity(rootDir, "person_zeyu", "Zeyu Li");
    const created = runJson(rootDir, ["new-task", "--title", "Missing Identity Claim"]);
    writeHarnessConfig(rootDir);

    const rejected = runJson(rootDir, ["task", "claim", created.taskId], false, {
      HARNESS_ACTOR: "agent:claude-code"
    });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "AuthMissing");
    assert.match(rejected.error?.hint ?? "", /machine identity|people\.yaml/u);
    assert.equal(existsTaskHolder(rootDir, created.taskId), false);
    assert.equal(JSON.stringify(rejected).includes("person:claude-code"), false);
  });
});

test("lease enforcement reports missing machine identity instead of journal failure", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentity(rootDir, "person_zeyu", "Zeyu Li");
    const created = runJson(rootDir, ["new-task", "--title", "Missing Identity Lease"]);
    writeHarnessConfig(rootDir);

    const rejected = runJson(rootDir, ["task", "progress", "append", created.taskId, "--text", "guarded"], false, {
      HARNESS_ACTOR: "agent:claude-code",
      HARNESS_TASK_LEASE_ENFORCEMENT: "1"
    });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "write_rejected");
    assert.match(rejected.error?.hint ?? "", /machine identity|people\.yaml/u);
    assert.equal((rejected.error?.hint ?? "").includes("Journal is unavailable"), false);
  });
});

test("configured identity supplies principal while HARNESS_ACTOR supplies only agent executor", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentity(rootDir, "person_zeyu", "Zeyu Li");
    const created = runJson(rootDir, ["new-task", "--title", "Configured Agent Claim"]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);

    const claimed = runJson(rootDir, ["task", "claim", created.taskId], true, {
      HARNESS_ACTOR: "agent:claude-code"
    });
    const holder = claimed.report.actor;

    assert.equal(holder.principal.personId, "person_zeyu");
    assert.equal(holder.principal.displayName, "Zeyu Li");
    assert.deepEqual(holder.executor, { kind: "agent", id: "claude-code" });
    assert.equal(holder.responsibleHuman, "person:person_zeyu");
  });
});

test("configured identity supports direct human claim through --actor", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentity(rootDir, "person_zeyu", "Zeyu Li");
    const created = runJson(rootDir, ["new-task", "--title", "Configured Human Claim"]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);

    const claimed = runJson(rootDir, ["--actor", "human:person_zeyu", "task", "claim", created.taskId], true, {
      HARNESS_ACTOR: ""
    });
    const holder = claimed.report.actor;

    assert.equal(holder.principal.personId, "person_zeyu");
    assert.equal(holder.executor, null);
    assert.equal(holder.responsibleHuman, "person:person_zeyu");
  });
});

test("execution claim activates once and the Holder V2 actor can submit without replaying credentials", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentity(rootDir, "person_zeyu", "Zeyu Li");
    const created = runJson(rootDir, ["new-task", "--title", "Execution Saga"]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);
    const claimed = runJson(rootDir, ["task", "claim", created.taskId], true, { HARNESS_ACTOR: "agent:test", CODEX_THREAD_ID: "codex-primary-session", CODEX_SESSION_ID: "codex-primary-session" });

    assert.match(claimed.executionId, /^exe_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u);
    assert.match(claimed.report.leaseToken, /^[0-9a-f]{64}$/u);
    assert.deepEqual(claimed.report.actor.executor, { kind: "agent", id: "test" });
    const leaseLedgerBody = readFileSync(path.join(
      rootDir,
      `.harness/generated/runtime-events/lease-${claimed.executionId}.jsonl`
    ), "utf8");
    const leaseEvents = leaseLedgerBody.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(leaseEvents.map((event) => event.lease.action), ["reserved", "activated"]);
    assert.equal(leaseEvents.every((event) => event.schema === "runtime-event/v2" && event.kind === "lease"), true);
    assert.doesNotMatch(leaseLedgerBody, /token|hash|credential/iu);
    const execution = JSON.parse(readFileSync(path.join(
      rootDir,
      `harness/tasks/${created.taskId}-execution-saga/executions/${claimed.executionId}.md`
    ), "utf8"));
    assert.equal(execution.session_bindings[0]?.role, "primary");
    assert.equal(execution.session_bindings[0]?.session_ref, "session/codex-primary-session");
    assert.equal(execution.session_bindings[0]?.archive_status, "pending");
    const indexPath = path.join(rootDir, `harness/tasks/${created.taskId}-execution-saga/INDEX.md`);
    assert.match(readFileSync(indexPath, "utf8"), /^  status: active$/mu);

    // Compatibility: the former second step is now an idempotent no-op.
    const activated = runJson(rootDir, ["task", "transition", created.taskId, "active"], true, { HARNESS_ACTOR: "agent:test", CODEX_THREAD_ID: "codex-primary-session", CODEX_SESSION_ID: "codex-primary-session" });
    assert.equal(activated.status, "active");

    const otherHolder = runJson(rootDir, ["task", "claim", created.taskId], false, { HARNESS_ACTOR: "agent:other-worker", CODEX_THREAD_ID: "other-worker-session", CODEX_SESSION_ID: "other-worker-session" });
    assert.equal(otherHolder.ok, false);
    assert.equal(otherHolder.report.code, "execution_lease_collision");

    const renewed = runJson(rootDir, ["task", "claim", created.taskId], true, { HARNESS_ACTOR: "agent:test", CODEX_THREAD_ID: "codex-primary-session", CODEX_SESSION_ID: "codex-primary-session" });
    assert.equal(renewed.executionId, claimed.executionId);
    assert.notEqual(renewed.report.leaseToken, claimed.report.leaseToken);
    const renewedLeaseLedgerBody = readFileSync(path.join(
      rootDir,
      `.harness/generated/runtime-events/lease-${claimed.executionId}.jsonl`
    ), "utf8");
    const renewedLeaseEvents = renewedLeaseLedgerBody.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(renewedLeaseEvents.map((event) => event.lease.action), ["reserved", "activated", "renewed"]);
    assert.doesNotMatch(renewedLeaseLedgerBody, /token|hash|credential/iu);

    const staleToken = runJson(rootDir, [
      "task", "submit", created.taskId, "--json-input", JSON.stringify({
        completionClaim: "stale credential must be rejected",
        deliverables: [],
        outputs: [],
        verificationNotes: [],
        knownGaps: [],
        residualRisks: [],
        executionId: claimed.executionId,
        leaseToken: claimed.report.leaseToken
      })
    ], false, { HARNESS_ACTOR: "agent:test", CODEX_THREAD_ID: "codex-primary-session", CODEX_SESSION_ID: "codex-primary-session" });
    assert.equal(staleToken.ok, false);
    assert.match(staleToken.error.hint, /requires an active lease/u);

    const homeDir = path.join(rootDir, "home");
    const codexLogs = path.join(homeDir, ".codex/sessions");
    mkdirSync(codexLogs, { recursive: true });
    writeFileSync(path.join(codexLogs, "codex-primary-session.jsonl"), [
      JSON.stringify({
        timestamp: "2026-07-11T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "implement F4" }
      }),
      JSON.stringify({
        timestamp: "2026-07-11T00:00:02.000Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "F4 ready" }] }
      })
    ].join("\n"), "utf8");

    const submitted = runJson(rootDir, [
      "task", "submit", created.taskId, "--json-input", JSON.stringify({
        completionClaim: "ready for review",
        deliverables: [],
        outputs: ["commit:abc123"],
        verificationNotes: ["node:test"],
        knownGaps: [],
        residualRisks: []
      })
    ], true, { HARNESS_ACTOR: "agent:test", HOME: homeDir, CODEX_THREAD_ID: "codex-primary-session", CODEX_SESSION_ID: "codex-primary-session" });

    assert.equal(submitted.status, "in_review");
    assert.equal(submitted.report.leaseReleased, true);
    assert.deepEqual(submitted.report.cleanup, { status: "released", diagnostics: [] });
    const holder = runJson(rootDir, ["task", "holder", created.taskId]);
    assert.equal(holder.report.effectiveHolder, null);
  });
});

test("submit reports an unavailable binding when default runtime capture is absent without changing its Session ownership", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentity(rootDir, "person_zeyu", "Zeyu Li");
    const created = runJson(rootDir, ["new-task", "--title", "Unavailable Session"]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);
    const sessionId = "missing-codex-primary-session";
    const homeDir = path.join(rootDir, "empty-home");
    mkdirSync(homeDir, { recursive: true });
    const sessionEnv = {
      HARNESS_ACTOR: "agent:test",
      HOME: homeDir,
      CODEX_THREAD_ID: sessionId,
      CODEX_SESSION_ID: sessionId
    };
    const claimed = runJson(rootDir, ["task", "claim", created.taskId], true, sessionEnv);
    runJson(rootDir, ["task", "transition", created.taskId, "active"], true, sessionEnv);

    const submitted = runJson(rootDir, [
      "task", "submit", created.taskId, "--json-input", JSON.stringify({
        completionClaim: "ready with unavailable transcript",
        deliverables: [],
        outputs: ["commit:def456"],
        verificationNotes: ["node:test"],
        knownGaps: [],
        residualRisks: []
      })
    ], true, sessionEnv);

    assert.equal(submitted.status, "in_review");
    assert.deepEqual(submitted.report.unavailableBindings, [{
      bindingId: `primary:${sessionId}`,
      sessionRef: `session/${sessionId}`,
      archiveStatus: "unavailable"
    }]);
    const executionPath = path.join(
      rootDir,
      `harness/tasks/${created.taskId}-unavailable-session/executions/${claimed.executionId}.md`
    );
    const execution = JSON.parse(readFileSync(executionPath, "utf8"));
    assert.equal(execution.session_bindings[0].binding_id, `primary:${sessionId}`);
    assert.equal(execution.session_bindings[0].session_ref, `session/${sessionId}`);
    assert.equal(execution.session_bindings[0].session.sessionId, sessionId);
    assert.equal(execution.session_bindings[0].archive_status, "unavailable");
    assert.equal(existsSync(path.join(rootDir, "harness/sessions", `${sessionId}.md`)), false);
  });
});

test("decision relate records the missing CH3 CH4 CH5 edges without activating their planned tasks", () => {
  withTempRoot((rootDir) => {
    writeHarnessLeaseEnforcement(rootDir, true);
    const targets = [
      {
        anchor: "CH3",
        taskId: "task_01KWY509C588MGQMQRTQHC9NVN",
        title: "Adapter PB Slice 1",
        rationale: "Reopen after the governance line converges"
      },
      {
        anchor: "CH4",
        taskId: "task_01KXPZJ0Z22PEZSKXCFVK0NGET",
        title: "Dual scheduler shared budget",
        rationale: "Run a read-only bounded premise review before implementation"
      },
      {
        anchor: "CH5",
        taskId: "task_01KXMJDEXN3R6BBVN0CA2RNQDF",
        title: "ProdCutover root",
        rationale: "Keep the root while ground truth is exported again"
      }
    ] as const;
    for (const target of targets) {
      runJson(rootDir, [
        "new-task", "--id", target.taskId, "--migration", "--title", target.title
      ]);
    }

    runJson(rootDir, [
      "decision", "propose", "--id", "dec_01KZ9KHST9EM75R4ZKKXG2E2NE",
      "--title", "Active ledger disposition decisions",
      "--question", "Which ledger identity should each active line retain?",
      "--chosen", "Evolution root returns to planned until its plan is substantive",
      "--chosen", "Benchmark W6 is cancelled because stronger evidence replaced its premise",
      "--chosen", "Adapter PB Slice 1 reopens after governance convergence",
      "--chosen", "Dual scheduler runs a read-only bounded premise review first",
      "--chosen", "ProdCutover root stays active until ground truth is exported again",
      "--rejected", "Create placeholder children from the stale inventory",
      "--why-not", "The inventory conflicts with already completed work",
      "--claim", "Each active line receives an explicit ledger disposition."
    ]);

    for (const target of targets) {
      const related = runJson(rootDir, [
        "decision", "relate", "dec_01KZ9KHST9EM75R4ZKKXG2E2NE",
        "--anchor", target.anchor, "--type", "relates",
        "--target", `task/${target.taskId}`, "--rationale", target.rationale
      ]);
      assert.equal(related.ok, true);
      assert.equal(runJson(rootDir, [
        "relation", "list", "--source", `decision/dec_01KZ9KHST9EM75R4ZKKXG2E2NE/${target.anchor}`
      ]).rows, 1);
      assert.equal(runJson(rootDir, ["task", "show", target.taskId]).report.task.status, "planned");
    }
  });
});

test("task relate records a dependency without activating its planned source task", () => {
  withTempRoot((rootDir) => {
    writeHarnessLeaseEnforcement(rootDir, true);
    const source = runJson(rootDir, ["new-task", "--title", "Relation Source"]);
    const target = runJson(rootDir, ["new-task", "--title", "Relation Target"]);

    const related = runJson(rootDir, [
      "task", "relate", source.taskId, "depends-on", target.taskId,
      "--rationale", "Source requires target"
    ]);
    assert.equal(related.ok, true);
    assert.equal(runJson(rootDir, ["relation", "list", "--source", `task/${source.taskId}`]).rows, 1);
    assert.equal(runJson(rootDir, ["task", "show", source.taskId]).report.task.status, "planned");
    assert.equal(runJson(rootDir, ["task", "show", target.taskId]).report.task.status, "planned");
  });
});

test("an active Execution lease remains executor-bound across deprecated claim retries", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentity(rootDir, "person_zeyu", "Zeyu Li");
    const created = runJson(rootDir, ["new-task", "--title", "Agent Handoff Claim"]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);

    runJson(rootDir, ["task", "claim", created.taskId], true, { HARNESS_ACTOR: "agent:codex" });
    const rejected = runJson(rootDir, ["task", "claim", created.taskId], false, {
      HARNESS_ACTOR: "agent:claude-code"
    });

    assert.equal(rejected.ok, false);
    assert.match(rejected.error?.hint ?? "", /current holder principal=person_zeyu, executor=agent:codex/u);
  });
});

test("configured identity must match people.yaml when a roster is present", () => {
  withTempRoot((rootDir) => {
    writeHarnessIdentity(rootDir, "person_zeyu", "Zeyu Li");
    const created = runJson(rootDir, ["new-task", "--title", "Roster Checked Claim"]);
    writePeopleRoster(rootDir, "person_alice", "Alice");

    const rejected = runJson(rootDir, ["task", "claim", created.taskId], false, {
      HARNESS_ACTOR: "agent:claude-code"
    });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "AuthMissing");
    assert.match(rejected.error?.hint ?? "", /person_zeyu.*people\.yaml/u);
    assert.equal(existsTaskHolder(rootDir, created.taskId), false);
  });
});

function assertGeneratedTaskId(value: unknown): string {
  assert.equal(typeof value, "string");
  assert.match(value, taskIdPattern);
  return value;
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-lease-cli-"));
  ensureTestHarnessIdentity(rootDir);
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeHarnessIdentity(rootDir: string, personId: string, displayName: string): void {
  writeHarnessConfig(rootDir, [
    "settings:",
    "  identity:",
    `    personId: ${personId}`,
    `    displayName: ${displayName}`
  ]);
}

function writeHarnessLeaseEnforcement(rootDir: string, enabled: boolean): void {
  writeHarnessConfig(rootDir, [
    "settings:",
    "  identity:",
    "    personId: person_tester",
    "    displayName: Harness Tester",
    "  tasks:",
    `    leaseEnforcement: ${enabled}`
  ]);
}

function writeHarnessIdentityWithLeaseEnforcement(
  rootDir: string,
  personId: string,
  displayName: string,
  enabled: boolean
): void {
  writeHarnessConfig(rootDir, [
    "settings:",
    "  identity:",
    `    personId: ${personId}`,
    `    displayName: ${displayName}`,
    "  tasks:",
    `    leaseEnforcement: ${enabled}`
  ]);
}

function writeHarnessConfig(rootDir: string, extraLines: ReadonlyArray<string> = []): void {
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  writeFileSync(path.join(harnessRoot, "harness.yaml"), [
    "schema: harness-anything/v1",
    "layout:",
    "  authoredRoot: harness",
    ...extraLines,
    ""
  ].join("\n"), "utf8");
}

function existsTaskHolder(rootDir: string, taskId: string): boolean {
  try {
    readFileSync(path.join(rootDir, ".harness/task-holders", `${taskId}.json`), "utf8");
    return true;
  } catch {
    return false;
  }
}

function readTaskHolder(rootDir: string, taskId: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(rootDir, ".harness/task-holders", `${taskId}.json`), "utf8")) as Record<string, any>;
}

function leaseDurationMs(report: Record<string, any>): number {
  return Date.parse(report.leaseExpiresAt) - Date.parse(report.acquiredAt);
}

function expireTaskHolder(rootDir: string, taskId: string): void {
  const record = readTaskHolder(rootDir, taskId);
  writeFileSync(path.join(rootDir, ".harness/task-holders", `${taskId}.json`), JSON.stringify({
    ...record,
    leaseExpiresAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "1999-12-31T23:59:00.000Z"
  }), "utf8");
}

function writePeopleRoster(rootDir: string, personId: string, displayName: string): void {
  writeFileSync(path.join(rootDir, "harness/people.yaml"), JSON.stringify({
    schema: "harness-people/v1",
    people: [{ personId, displayName, roles: ["writer"], credentials: [] }],
    roles: [{ roleId: "writer", commandClasses: ["repo-write", "repo-read"] }]
  }), "utf8");
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true, env: Readonly<Record<string, string>> = {}): Record<string, any> {
  try {
    const childEnv = cliTestEnv({
      HARNESS_ACTOR: "agent:harness-test",
      HARNESS_GIT_AUTHOR_NAME: "Harness Tester",
      HARNESS_GIT_AUTHOR_EMAIL: "tester@example.test",
      HARNESS_DAEMON_MODE: "fixture",
      ...env
    });
    delete childEnv.HARNESS_TASK_LEASE_ENFORCEMENT;
    delete childEnv.HARNESS_TASK_LEASE_TTL_MS;
    if (env.HARNESS_TASK_LEASE_ENFORCEMENT !== undefined) {
      childEnv.HARNESS_TASK_LEASE_ENFORCEMENT = env.HARNESS_TASK_LEASE_ENFORCEMENT;
    }
    if (env.HARNESS_TASK_LEASE_TTL_MS !== undefined) {
      childEnv.HARNESS_TASK_LEASE_TTL_MS = env.HARNESS_TASK_LEASE_TTL_MS;
    }
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: childEnv
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}
