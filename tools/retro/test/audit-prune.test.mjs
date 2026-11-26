// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAudit, runAuditCli } from "../audit.mjs";
import { runCli } from "../cli.mjs";
import { findRetroPrivateLeakage } from "../lib/sanitize.mjs";
import {
  RETRO_AUDIT_REPORT_SCHEMA,
  RETRO_BASELINES_SCHEMA,
  RETRO_EVAL_REPORT_SCHEMA,
  RETRO_PRUNE_PLAN_SCHEMA,
  collectRetroAuditReportIssues,
  collectRetroBaselinesIssues,
  collectRetroPrunePlanIssues,
} from "../lib/schemas.mjs";
import { buildPrunePlan, runPruneCli } from "../prune.mjs";

function makeTempDir(prefix = "ha-retro-audit-prune-") {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFakeRepo(rootDir) {
  mkdirSync(path.join(rootDir, "packages", "kernel", "src"), { recursive: true });
  writeFileSync(path.join(rootDir, "packages", "kernel", "src", "live.ts"), "export const live = 1;\n", "utf8");
}

test("negative control 1: expired test-quarantine fixture triggers audit --strict exit 1 and flags closed ownerTask", async () => {
  const dir = makeTempDir();
  try {
    createFakeRepo(dir);
    const snapshot = {
      tasks: [{ taskId: "task_11111111111111111111111111", status: "done" }],
      quarantine: [
        {
          test: "packages/daemon/test/flaky-socket.test.ts",
          ownerTask: "task_11111111111111111111111111",
          quarantinedAt: "2026-10-01",
        },
      ],
      allowlists: [],
    };
    const snapPath = path.join(dir, "snapshot.json");
    writeFileSync(snapPath, JSON.stringify(snapshot), "utf8");

    const lines = [];
    const exitCode = await runAuditCli(
      ["--repo-root", dir, "--snapshot", snapPath, "--now", "2026-11-25T00:00:00.000Z", "--strict"],
      { stdout: (line) => lines.push(line), stderr: () => {} },
    );

    assert.equal(exitCode, 1, "expired quarantine must fail --strict with exit 1");
    const report = JSON.parse(lines.join("\n"));
    assert.equal(report.schema, RETRO_AUDIT_REPORT_SCHEMA);
    assert.equal(collectRetroAuditReportIssues(report).length, 0);
    assert.equal(report.quarantineAudit.expired.length, 1);
    assert.equal(report.quarantineAudit.closedOwnerTasks.length, 1);
    assert.equal(report.summary.strictViolations, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("negative control 2: zero-hit allowlist fixture triggers UNREACHED_ALLOW=0 exit 1 while unobservable sections stay non-blocking", async () => {
  const dir = makeTempDir();
  try {
    createFakeRepo(dir);
    const snapshot = {
      quarantine: [],
      allowlists: [
        {
          file: "check-import-boundaries.json",
          section: "cliAdapterKnownDebt",
          entry: "packages/cli/src/dead-debt.ts",
          relativePath: "packages/cli/src/dead-debt.ts",
          hitCount: 0,
        },
        {
          file: "check-schema-field-coverage.json",
          section: "expectedFields",
          entryCount: 4,
          observability: "unobservable",
        },
      ],
    };

    const result = runAudit({
      repoRoot: dir,
      snapshot,
      strict: true,
      now: "2026-11-25T00:00:00.000Z",
    });

    assert.equal(result.exitCode, 1, "UNREACHED_ALLOW > 0 must trigger exit 1 in --strict mode");
    assert.equal(result.report.unreachedAllowlists.unreached.length, 1);
    assert.equal(result.report.unreachedAllowlists.unreached[0].hitCount, 0);
    assert.equal(result.report.unreachedAllowlists.unobservable.length, 1);
    assert.equal(result.report.unreachedAllowlists.unobservable[0].observability, "unobservable");
    assert.equal(collectRetroAuditReportIssues(result.report).length, 0);

    const onlyUnobservable = runAudit({
      repoRoot: dir,
      snapshot: {
        quarantine: [],
        allowlists: [
          {
            file: "check-schema-field-coverage.json",
            section: "expectedFields",
            entryCount: 4,
            observability: "unobservable",
          },
        ],
      },
      strict: true,
      now: "2026-11-25T00:00:00.000Z",
    });
    assert.equal(onlyUnobservable.exitCode, 0, "unobservable sections alone must not fail --strict");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("negative control 3: hollow Decision and unfinalized-task / dangling-path Fact are accurately detected", () => {
  const dir = makeTempDir();
  try {
    createFakeRepo(dir);
    const result = runAudit({
      repoRoot: dir,
      now: "2026-11-25T00:00:00.000Z",
      snapshot: {
        tasks: [
          { taskId: "task_aaaaaaaaaaaaaaaaaaaaaaaaaa", status: "done" },
          { taskId: "task_bbbbbbbbbbbbbbbbbbbbbbbbbb", status: "active" },
        ],
        decisions: [
          {
            decisionId: "dec_HOLLOW001",
            title: "High risk decision with empty rejected",
            riskTier: "high",
            decisionClass: "ordinary",
            state: "in_effect",
            rejected: [],
          },
          {
            decisionId: "dec_HOLLOW002",
            title: "Standing policy with placeholder whyNot",
            riskTier: "medium",
            decisionClass: "standing_policy",
            state: "in_effect",
            rejected: [{ id: "RJ1", text: "Skip checks", whyNot: "TBD" }],
          },
          {
            decisionId: "dec_SOLID003",
            title: "Well-justified standing policy",
            riskTier: "high",
            decisionClass: "standing_policy",
            state: "in_effect",
            rejected: [
              {
                id: "RJ1",
                text: "Bypass storage port with direct sqlite",
                whyNot: "Violates import boundary and breaks projection rebuild determinism.",
              },
            ],
          },
        ],
        facts: [
          {
            factId: "F-DIRTY001",
            taskId: "task_bbbbbbbbbbbbbbbbbbbbbbbbbb",
            state: "standing",
            statement: "Workaround observed in packages/kernel/src/deleted-file.ts during WIP debugging",
          },
          {
            factId: "F-CLEAN002",
            taskId: "task_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            state: "standing",
            statement: "Verified behavior in packages/kernel/src/live.ts",
          },
          {
            factId: "F-ARCHIVED003",
            taskId: "task_bbbbbbbbbbbbbbbbbbbbbbbbbb",
            state: "archived",
            archived: true,
            statement: "Old note referencing packages/kernel/src/deleted-file.ts",
          },
        ],
        quarantine: [],
        allowlists: [],
      },
    });

    const hollowIds = result.report.decisionWhyNotAudit.hollowDecisions.map((entry) => entry.decisionId);
    assert.deepEqual(hollowIds, ["dec_HOLLOW001", "dec_HOLLOW002"]);
    assert.equal(result.report.decisionWhyNotAudit.highRiskAudited, 3);

    assert.equal(result.report.factContagionFlags.totalAudited, 2, "archived facts must be excluded");
    assert.equal(result.report.factContagionFlags.flaggedCount, 1);
    const [dirtyFact] = result.report.factContagionFlags.flags;
    assert.equal(dirtyFact.factId, "F-DIRTY001");
    assert.ok(dirtyFact.flags.includes("unfinalized_source_task"));
    assert.ok(dirtyFact.flags.includes("dangling_code_path"));
    assert.deepEqual(dirtyFact.danglingPaths, ["packages/kernel/src/deleted-file.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waiverExposure, taskBaselines, and --emit-baselines produce sanitized retro-baselines/v1 with 0 private leaks", () => {
  const dir = makeTempDir();
  try {
    createFakeRepo(dir);
    const baselinesOut = path.join(dir, "baselines.json");
    const result = runAudit({
      repoRoot: dir,
      now: "2026-11-25T00:00:00.000Z",
      emitBaselines: baselinesOut,
      snapshot: {
        tasks: [
          {
            taskId: "task_11111111111111111111111111",
            status: "done",
            iteration: 1,
            createdAt: "2026-11-20T00:00:00.000Z",
            completedAt: "2026-11-20T01:00:00.000Z",
            touchedFiles: ["packages/kernel/src/live.ts", "harness/tasks/task_11111111111111111111111111/plan.md"],
            gateWitnesses: [
              {
                witnessId: "wit_null_1",
                executionId: "exe_11111111111111111111111111",
                gateId: "test-fast",
                verifiedAt: "2026-11-20T00:55:00.000Z",
                actor: { principal: { personId: "person_reviewer" } },
                override: { waivedReceiptId: null, rationale: "Runner unavailable during outage" },
              },
            ],
          },
          {
            taskId: "task_22222222222222222222222222",
            status: "done",
            iteration: 2,
            createdAt: "2026-11-21T00:00:00.000Z",
            completedAt: "2026-11-21T03:00:00.000Z",
            touchedFiles: ["packages/kernel/src/live.ts", ".harness-private/secret.json"],
            gateWitnesses: [
              {
                witnessId: "wit_bound_2",
                executionId: "exe_22222222222222222222222222",
                gateId: "test-fast",
                verifiedAt: "2026-11-21T02:50:00.000Z",
                actor: { principal: { personId: "person_reviewer" } },
                override: { waivedReceiptId: "rcpt_fail_001", rationale: "Known upstream flake" },
              },
            ],
          },
        ],
        quarantine: [],
        allowlists: [],
      },
    });

    assert.equal(result.report.waiverExposure.totalWaivers, 2);
    assert.equal(result.report.waiverExposure.nullWaiverCount, 1);
    assert.equal(result.report.waiverExposure.receiptBoundWaiverCount, 1);
    assert.equal(result.report.waiverExposure.disputeDrafts.length, 1);

    assert.equal(result.report.taskBaselines.sampleSize, 2);
    assert.equal(result.report.taskBaselines.reworkedCount, 1);
    assert.equal(result.report.taskBaselines.reworkRate, 0.5);
    assert.equal(result.report.taskBaselines.p50DurationMs, 3_600_000);
    assert.equal(result.report.taskBaselines.p90DurationMs, 10_800_000);

    assert.ok(existsSync(baselinesOut));
    const baselinesDoc = JSON.parse(readFileSync(baselinesOut, "utf8"));
    assert.equal(baselinesDoc.schema, RETRO_BASELINES_SCHEMA);
    assert.equal(collectRetroBaselinesIssues(baselinesDoc).length, 0);
    assert.equal(findRetroPrivateLeakage(baselinesDoc).ok, true, "baselines must contain 0 private leaks");
    assert.deepEqual(baselinesDoc.topHotFiles, [{ path: "packages/kernel/src/live.ts", touchCount: 2 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("negative control 4: prune generates valid retro-prune-plan/v1 with eval history and zero unauthorized disk writes", async () => {
  const dir = makeTempDir();
  try {
    createFakeRepo(dir);
    const auditResult = runAudit({
      repoRoot: dir,
      now: "2026-11-25T00:00:00.000Z",
      snapshot: {
        tasks: [
          {
            taskId: "task_11111111111111111111111111",
            status: "done",
            gateWitnesses: [
              {
                witnessId: "wit_null_1",
                executionId: "exe_11111111111111111111111111",
                gateId: "lint",
                verifiedAt: "2026-11-24T00:00:00.000Z",
                actor: { principal: { personId: "person_lead" } },
                override: { waivedReceiptId: null, rationale: "Emergency hotfix" },
              },
            ],
          },
          { taskId: "task_22222222222222222222222222", status: "active" },
        ],
        quarantine: [
          {
            test: "packages/cli/test/stale.test.ts",
            ownerTask: "task_11111111111111111111111111",
            quarantinedAt: "2026-10-01",
          },
        ],
        allowlists: [
          {
            file: "check-import-boundaries.json",
            section: "cliAdapterKnownDebt",
            entry: "packages/cli/src/nonexistent.ts",
            hitCount: 0,
          },
        ],
        decisions: [
          {
            decisionId: "dec_HOLLOW999",
            title: "Hollow high risk",
            riskTier: "high",
            decisionClass: "ordinary",
            state: "in_effect",
            rejected: [],
          },
        ],
        facts: [
          {
            factId: "F-CONTAGION9",
            taskId: "task_22222222222222222222222222",
            state: "standing",
            statement: "Touches packages/kernel/src/missing.ts",
          },
        ],
      },
    });

    const evalReports = [1, 2].map((idx) => ({
      schema: RETRO_EVAL_REPORT_SCHEMA,
      version: 1,
      runId: `eval-${idx}`,
      outcomes: [
        { caseId: `c-${idx}-1`, category: "stale-style-rule", bucket: "positive", outcome: "fail" },
        { caseId: `c-${idx}-2`, category: "stale-style-rule", bucket: "negative", outcome: "fail" },
      ],
    }));

    const auditPath = path.join(dir, "audit-report.json");
    const evalDir = path.join(dir, "eval-history");
    mkdirSync(evalDir, { recursive: true });
    writeFileSync(auditPath, JSON.stringify(auditResult.report), "utf8");
    writeFileSync(path.join(evalDir, "eval-1.json"), JSON.stringify(evalReports[0]), "utf8");
    writeFileSync(path.join(evalDir, "eval-2.json"), JSON.stringify(evalReports[1]), "utf8");

    const beforeFiles = readdirSync(dir).sort();
    const stdoutLines = [];
    const code = await runPruneCli(["--audit", auditPath, "--eval-history", evalDir], {
      stdout: (line) => stdoutLines.push(line),
      stderr: () => {},
    });
    const afterFiles = readdirSync(dir).sort();

    assert.equal(code, 0);
    assert.deepEqual(afterFiles, beforeFiles, "prune without --out must perform zero disk writes");

    const plan = JSON.parse(stdoutLines.join("\n"));
    assert.equal(plan.schema, RETRO_PRUNE_PLAN_SCHEMA);
    assert.equal(plan.readOnly, true);
    assert.equal(collectRetroPrunePlanIssues(plan).length, 0);
    assert.equal(plan.sources.evalReportCount, 2);

    const actions = new Set(plan.proposals.map((p) => p.action));
    assert.ok(actions.has("remove_quarantine"));
    assert.ok(actions.has("remove_allowlist_entry"));
    assert.ok(actions.has("review_waiver_dispute"));
    assert.ok(actions.has("enrich_decision_whynot"));
    assert.ok(actions.has("quarantine_or_archive_fact"));
    assert.ok(actions.has("retire_stale_rule"));

    // Direct API check matches CLI output count
    const directPlan = buildPrunePlan(auditResult.report, evalReports, { now: "2026-11-25T00:00:00.000Z" });
    assert.equal(directPlan.summary.totalProposals, plan.summary.totalProposals);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli.mjs wires audit and prune help and fail-closed invalid argument codes", async () => {
  const out = [];
  const err = [];
  assert.equal(await runCli(["audit", "--help"], { stdout: (l) => out.push(l), stderr: (l) => err.push(l) }), 0);
  assert.ok(out.join("\n").includes("--emit-baselines"));
  assert.equal(await runCli(["prune", "--help"], { stdout: (l) => out.push(l), stderr: (l) => err.push(l) }), 0);
  assert.ok(out.join("\n").includes("--eval-history"));
  assert.equal(
    await runCli(["audit", "--unknown-flag"], { stdout: () => {}, stderr: (l) => err.push(l) }),
    2,
    "unknown CLI flag must exit 2",
  );
  assert.equal(
    await runCli(["prune", "--audit", path.join(os.tmpdir(), "nonexistent-audit-999999.json")], {
      stdout: () => {},
      stderr: (l) => err.push(l),
    }),
    2,
    "missing --audit file must exit 2",
  );
});
